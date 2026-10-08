import { spawn } from "node:child_process";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./client.js";

export interface ToolOutcome {
  /** Fed back to the model; shown in the activity log. */
  output: string;
  /** Set when the agent has decided it is finished. */
  finished?: boolean;
  summary?: string;
}

const MAX_READ_BYTES = 200_000;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_BYTES = 64_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const SCHEMA_STRING = { type: "string" };

/**
 * Resolves a model-supplied path inside the workspace and refuses anything that
 * escapes it. Every path in this module goes through here, so a model cannot read
 * or write outside the isolated checkout it was given.
 */
export const resolveInside = (workspace: string, candidate: string): string => {
  const trimmed = candidate.trim();
  if (!trimmed) throw new ToolError("A path is required");
  if (trimmed.includes("\u0000")) throw new ToolError("Paths may not contain null bytes");

  const root = resolve(workspace);
  const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new ToolError(`Path escapes the workspace: ${candidate}`);
  }
  return target;
};

export class ToolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDeps {
  workspace: string;
  commandTimeoutMs?: number;
  onCommand?: (command: string) => void;
}

export const toolDefinitions = (): ToolDefinition[] => [
  {
    name: "list_files",
    description:
      "List files and directories. Use a path relative to the workspace root; omit it for the root.",
    parameters: {
      type: "object",
      properties: { path: { ...SCHEMA_STRING, description: "Directory to list, relative to the workspace." } },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 file from the workspace. Use start and end for large files (1-based lines).",
    parameters: {
      type: "object",
      properties: {
        path: { ...SCHEMA_STRING, description: "File to read, relative to the workspace." },
        start: { type: "integer", description: "First line to return, 1-based." },
        end: { type: "integer", description: "Last line to return, inclusive." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create a file or replace its entire contents. Parent directories are created as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { ...SCHEMA_STRING, description: "File to write, relative to the workspace." },
        content: { ...SCHEMA_STRING, description: "Full new contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact substring of a file. old_string must appear exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { ...SCHEMA_STRING, description: "File to edit, relative to the workspace." },
        old_string: { ...SCHEMA_STRING, description: "Exact text to replace." },
        new_string: { ...SCHEMA_STRING, description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace and return its combined output. Long commands may be cut off by a timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { ...SCHEMA_STRING, description: "Shell command to run in the workspace." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "Call this when the task is complete. Summarise what changed and stop.",
    parameters: {
      type: "object",
      properties: { summary: { ...SCHEMA_STRING, description: "What you did and anything left undone." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

export const runTool = async (name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  switch (name) {
    case "list_files":
      return listFiles(args, deps);
    case "read_file":
      return readFileTool(args, deps);
    case "write_file":
      return writeFileTool(args, deps);
    case "edit_file":
      return editFileTool(args, deps);
    case "run_command":
      return runCommandTool(args, deps);
    case "finish":
      return { output: "Task marked complete.", finished: true, summary: stringArg(args, "summary") };
    default:
      // Naming the alternatives matters: a model handed a tool from another
      // harness otherwise retries the same call until the turn budget runs out.
      throw new ToolError(
        `Unknown tool "${name}". Available tools: ${toolDefinitions().map((tool) => tool.name).join(", ")}.`,
      );
  }
};

const listFiles = async (args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  const directory = resolveInside(deps.workspace, optionalString(args, "path") ?? ".");
  const entries = await readdir(directory, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.name === ".git") continue;
    lines.push(`${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`);
  }
  if (entries.length > MAX_LIST_ENTRIES) lines.push(`… ${entries.length - MAX_LIST_ENTRIES} more`);
  if (!lines.length) lines.push("(empty)");
  return { output: lines.join("\n") };
};

const readFileTool = async (args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  const target = resolveInside(deps.workspace, stringArg(args, "path"));
  await requireFile(target, deps.workspace);
  const raw = await readFile(target, "utf8");
  const start = numberArg(args, "start");
  const end = numberArg(args, "end");
  let text = raw;
  if (start !== undefined || end !== undefined) {
    const lines = raw.split("\n");
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? lines.length);
    text = lines.slice(from - 1, to).map((line, index) => `${from + index}\t${line}`).join("\n");
    text = `${text}\n(${from}-${to} of ${lines.length} lines)`;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_READ_BYTES) {
    text = `${text.slice(0, MAX_READ_BYTES)}\n… truncated at ${MAX_READ_BYTES} bytes`;
  }
  return { output: text || "(empty file)" };
};

const writeFileTool = async (args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  const target = resolveInside(deps.workspace, stringArg(args, "path"));
  const content = typeof args.content === "string" ? args.content : "";
  const existed = await exists(target);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
  return { output: `${existed ? "Updated" : "Created"} ${relative(deps.workspace, target)} (${content.length} bytes)` };
};

const editFileTool = async (args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  const target = resolveInside(deps.workspace, stringArg(args, "path"));
  const oldString = stringArg(args, "old_string");
  const newString = typeof args.new_string === "string" ? args.new_string : "";
  const replaceAll = args.replace_all === true;
  await requireFile(target, deps.workspace);
  const current = await readFile(target, "utf8");

  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new ToolError(`old_string was not found in ${relative(deps.workspace, target)}. Read the file and copy the exact text.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new ToolError(
      `old_string appears ${occurrences} times in ${relative(deps.workspace, target)}. Include more context or set replace_all.`,
    );
  }
  const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
  await writeFile(target, next, "utf8");
  return {
    output: `Edited ${relative(deps.workspace, target)} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 ? "s" : ""})`,
  };
};

const runCommandTool = async (args: Record<string, unknown>, deps: ToolDeps): Promise<ToolOutcome> => {
  const command = stringArg(args, "command");
  deps.onCommand?.(command);
  return runShell(command, deps.workspace, deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
};

/**
 * Runs a command in the workspace. The command is not filtered: an agent that can
 * edit files can already run arbitrary code, so the meaningful boundary is the
 * throwaway checkout, not the command string.
 */
export const runShell = (
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<ToolOutcome> =>
  new Promise((resolvePromise) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exitCode: number, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = `${output}${extra}`.trim() || "(no output)";
      resolvePromise({
        output: `exit ${exitCode}\n${Buffer.byteLength(body, "utf8") > MAX_COMMAND_BYTES ? `${body.slice(0, MAX_COMMAND_BYTES)}\n… truncated` : body}`,
      });
    };
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_COMMAND_BYTES);
    };
    timer = setTimeout(() => {
      killGroup(child);
      finish(124, `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`);
    }, timeoutMs);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("close", (code) => finish(code ?? 1));
    child.once("error", (error) => finish(127, `\n${error.message}`));
  });

const killGroup = (child: ReturnType<typeof spawn>): void => {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      /* fall through to the direct kill */
    }
  }
  child.kill("SIGTERM");
};

/**
 * Turns a missing file into something the model can act on. A bare ENOENT tends
 * to produce a retry of the same call rather than a corrected one.
 */
const requireFile = async (target: string, workspace: string): Promise<void> => {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      throw new ToolError(`${relative(workspace, target)} is a directory. Use list_files to see what is inside.`);
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`${relative(workspace, target)} does not exist. Use list_files to find the right path.`);
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const stringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${name} must be a non-empty string`);
  return value;
};

const optionalString = (args: Record<string, unknown>, name: string): string | undefined => {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value : undefined;
};

const numberArg = (args: Record<string, unknown>, name: string): number | undefined => {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${name} must be a number`);
  return Math.trunc(value);
};

