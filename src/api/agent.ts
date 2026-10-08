import { ApiError, ChatClient, type ChatMessage } from "./client.js";
import { runTool, toolDefinitions, ToolError } from "./tools.js";

export interface AgentBudget {
  maxTurns: number;
  maxWallClockMs: number;
  maxOutputTokens: number;
  commandTimeoutMs?: number;
}

export const DEFAULT_BUDGET: AgentBudget = {
  maxTurns: 24,
  maxWallClockMs: 20 * 60 * 1000,
  maxOutputTokens: 8_000,
};

export interface AgentRunOptions {
  client: ChatClient;
  systemPrompt: string;
  userPrompt: string;
  workspace: string;
  budget?: Partial<AgentBudget>;
  /** Called for each step so the caller can stream progress. */
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** Injected in tests. */
  now?: () => number;
}

export interface AgentRunResult {
  summary: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: "finish" | "turn_limit" | "time_limit" | "no_tool_calls" | "aborted" | "error";
}

const truncate = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length)}\n… truncated, ${value.length - length} more characters`;

/**
 * Runs the tool-calling loop until the model calls finish, stops asking for tools,
 * or a budget is exhausted. The model only ever mutates the workspace; committing,
 * verifying, and diffing stay with the orchestrator.
 */
export const runAgent = async (options: AgentRunOptions): Promise<AgentRunResult> => {
  const budget = { ...DEFAULT_BUDGET, ...options.budget };
  const now = options.now ?? (() => Date.now());
  const started = now();
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];
  const tools = toolDefinitions();

  let inputTokens = 0;
  let outputTokens = 0;
  let summary = "";
  let turns = 0;
  let stopReason: AgentRunResult["stopReason"] = "no_tool_calls";

  while (turns < budget.maxTurns) {
    if (options.signal?.aborted) return { summary, turns, inputTokens, outputTokens, stopReason: "aborted" };
    if (now() - started > budget.maxWallClockMs) return { summary, turns, inputTokens, outputTokens, stopReason: "time_limit" };

    turns += 1;
    let response: Awaited<ReturnType<ChatClient["complete"]>>;
    try {
      response = await options.client.complete({
        model: options.client.model,
        messages,
        tools,
        maxOutputTokens: budget.maxOutputTokens,
      });
    } catch (error) {
      if (options.signal?.aborted) return { summary, turns, inputTokens, outputTokens, stopReason: "aborted" };
      throw error;
    }

    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;
    if (response.content.trim()) options.onProgress?.(response.content.trim());

    if (!response.toolCalls.length) {
      // A plain answer with no tool call is the model saying it is done.
      summary = response.content.trim() || summary;
      stopReason = "no_tool_calls";
      return { summary, turns, inputTokens, outputTokens, stopReason };
    }

    messages.push({ role: "assistant", content: response.content, toolCall: response.toolCalls[0] });

    for (const call of response.toolCalls) {
      if (options.signal?.aborted) return { summary, turns, inputTokens, outputTokens, stopReason: "aborted" };
      const outcome = await invoke(call.name, call.arguments, options, budget);
      if (outcome.finished) {
        summary = outcome.summary ?? outcome.output;
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.output });
        return { summary, turns, inputTokens, outputTokens, stopReason: "finish" };
      }
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.output });
    }
  }

  return { summary, turns, inputTokens, outputTokens, stopReason: "turn_limit" };
};

const invoke = async (
  name: string,
  args: Record<string, unknown>,
  options: AgentRunOptions,
  budget: AgentBudget,
) => {
  try {
    const outcome = await runTool(name, args, {
      workspace: options.workspace,
      commandTimeoutMs: budget.commandTimeoutMs,
      onCommand: (command) => options.onProgress?.(`$ ${command}`),
    });
    const label = name === "read_file" && typeof args.path === "string" ? `read ${args.path}` : name;
    options.onProgress?.(`${label}: ${firstLine(outcome.output)}`);
    return outcome;
  } catch (error) {
    // Tool failures are fed back as observations so the model can correct itself,
    // except for a sandbox refusal, which is a hard stop.
    const message = error instanceof ToolError ? error.message : error instanceof Error ? error.message : String(error);
    if (error instanceof ToolError && message.startsWith("Path escapes the workspace")) {
      throw error;
    }
    if (error instanceof ApiError) throw error;
    options.onProgress?.(`${name} failed: ${firstLine(message)}`);
    return { output: `Error: ${truncate(message, 2_000)}` };
  }
};

const firstLine = (value: string): string => {
  const line = value.split("\n").find((candidate) => candidate.trim()) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};
