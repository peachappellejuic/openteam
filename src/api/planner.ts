import { ChatClient, type ChatMessage, type ToolDefinition } from "./client.js";
import { runTool, ToolError } from "./tools.js";

export interface PlannedTask {
  title: string;
  description: string;
  allowedPaths: string[];
  dependsOn: number[];
  verifyCommand?: string;
}

export interface PlanResult {
  goal: string;
  tasks: PlannedTask[];
  notes?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PlanOptions {
  client: ChatClient;
  goal: string;
  /** Read-only root the coordinator may inspect. */
  repositoryPath: string;
  maxTasks?: number;
  maxTurns?: number;
  onProgress?: (line: string) => void;
}

const PLAN_TOOL: ToolDefinition = {
  name: "submit_plan",
  description:
    "Submit the final task breakdown. Call this exactly once, when you have inspected enough of the repository.",
  parameters: {
    type: "object",
    properties: {
      notes: { type: "string", description: "Anything the implementer should know about your choices." },
      tasks: {
        type: "array",
        description: "The tasks, in the order they should be done.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "One line; becomes the commit subject." },
            description: { type: "string", description: "Full instructions for the agent that will do this work." },
            allowedPaths: {
              type: "array",
              items: { type: "string" },
              description:
                "Files or directories this task may change, e.g. src/api. Empty means the whole repository. " +
                "Keep tasks disjoint where you can so they can run in parallel.",
            },
            dependsOn: {
              type: "array",
              items: { type: "integer" },
              description: "Zero-based indices of tasks that must finish first.",
            },
            verifyCommand: { type: "string", description: "Shell command that must exit 0, e.g. npm test." },
          },
          required: ["title", "description", "allowedPaths", "dependsOn"],
        },
      },
    },
    required: ["tasks"],
  },
};

const SYSTEM_PROMPT = [
  "You are the coordinator for a team of coding agents that work on a git repository.",
  "You do not write the code. You inspect the repository and break the goal into tasks.",
  "",
  "Rules:",
  "- Inspect first. Use list_files and read_file to understand the structure before deciding anything.",
  "- You may NOT write, edit, or run anything. Only list_files and read_file are permitted.",
  "- Give every task an explicit allowedPaths list. Tasks that touch disjoint paths can run in parallel.",
  "- Prefer tasks that can run at the same time: only make task B depend on task A when B genuinely needs A's output.",
  "- Each description must be self-contained. The agent doing that task cannot see your other tasks or their results.",
  "- Choose a verifyCommand only where the repository has a command that covers that task.",
].join("\n");

/**
 * Asks a model to turn a goal into a task plan.
 *
 * This is the one place a model is allowed to steer the pipeline, and it is
 * deliberately limited to producing a description of work. Scheduling,
 * concurrency, isolation and merging stay in the deterministic orchestrator,
 * because a model choosing which branch to merge would be a security problem.
 */
export const planWithModel = async (options: PlanOptions): Promise<PlanResult> => {
  const maxTasks = options.maxTasks ?? 8;
  const maxTurns = options.maxTurns ?? 12;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Goal: ${options.goal}`,
        "",
        `The repository is at ${options.repositoryPath} and you are already in it.`,
        `Produce at most ${maxTasks} tasks.`,
      ].join("\n"),
    },
  ];

  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await options.client.complete({
      model: options.client.model,
      messages,
      tools: [PLAN_TOOL],
      maxOutputTokens: 4_000,
    });
    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;
    if (response.content.trim()) options.onProgress?.(response.content.trim());

    const call = response.toolCalls[0];
    if (!call) {
      throw new Error("The coordinator answered without submitting a plan. Ask for it with --decompose again.");
    }

    if (call.name === "submit_plan") {
      const plan = normalisePlan(call.arguments, options.goal);
      return { goal: options.goal, tasks: plan.tasks, notes: plan.notes, inputTokens, outputTokens };
    }

    // Inspection only. The coordinator has no way to change the repository.
    const outcome = await inspect(call.name, call.arguments, options.repositoryPath, options.onProgress);
    messages.push({ role: "assistant", content: response.content, toolCall: call });
    messages.push({ role: "tool", toolCallId: call.id, content: outcome });
  }

  throw new Error(`The coordinator did not produce a plan within ${maxTurns} turns`);
};

const inspect = async (
  name: string,
  args: Record<string, unknown>,
  repositoryPath: string,
  onProgress?: (line: string) => void,
): Promise<string> => {
  if (name !== "list_files" && name !== "read_file") {
    return `Error: ${name} is not available to the coordinator. It may only inspect with list_files and read_file.`;
  }
  try {
    const outcome = await runTool(name, args, { workspace: repositoryPath });
    onProgress?.(`${name}: ${outcome.output.split("\n").length} lines`);
    return outcome.output.slice(0, 20_000);
  } catch (error) {
    if (error instanceof ToolError) return `Error: ${error.message}`;
    return `Error: ${error instanceof Error ? error.message : "inspection failed"}`;
  }
};

/**
 * Validates whatever the model returned into a usable plan.
 *
 * A model is untrusted input here: missing fields are filled, non-string entries
 * are dropped, dependency indices are clamped, and cycles are broken, because a
 * malformed plan should never be able to stall the dispatch loop.
 */
export const normalisePlan = (
  raw: Record<string, unknown>,
  goal: string,
  maxTasks = 8,
): { tasks: PlannedTask[]; notes?: string } => {
  const list = Array.isArray(raw.tasks) ? raw.tasks : [];
  const tasks: PlannedTask[] = [];

  // One pass, so the index a dependency refers to is the index in the *output*.
  // Filtering malformed entries in a separate pass would shift every later
  // index and silently rewire the graph.
  for (const entry of list.slice(0, maxTasks)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!title || !description) continue;

    const allowedPaths = Array.isArray(item.allowedPaths)
      ? [
          ...new Set(
            item.allowedPaths
              .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
              .map((path) => path.trim()),
          ),
        ]
      : [];

    // Only earlier tasks, so a forward or self reference cannot form a cycle.
    const declared = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    const dependsOn = [
      ...new Set(
        declared.filter(
          (value): value is number => Number.isInteger(value) && value >= 0 && value < tasks.length,
        ),
      ),
    ];

    tasks.push({
      title: title.slice(0, 120),
      description: description.slice(0, 8_000),
      allowedPaths,
      dependsOn,
      verifyCommand:
        typeof item.verifyCommand === "string" && item.verifyCommand.trim()
          ? item.verifyCommand.trim().slice(0, 500)
          : undefined,
    });
  }

  if (!tasks.length) throw new Error("The coordinator returned no usable tasks");

  return {
    tasks,
    notes:
      typeof raw.notes === "string" && raw.notes.trim()
        ? raw.notes.trim().slice(0, 2_000)
        : `Plan generated for: ${goal}`,
  };
};

/** Exposed for tests: the tool the coordinator is allowed to call. */
export const plannerToolName = (): string => PLAN_TOOL.name;
