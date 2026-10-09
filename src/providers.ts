import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAgent } from "./api/agent.js";
import { ChatClient } from "./api/client.js";
import { apiProvider, resolveBaseUrl, type ApiProviderEntry } from "./api/registry.js";
import { providerRegistry } from "./providers-registry.js";
import { config } from "./config.js";
import { SecretStore, redact } from "./secrets.js";
import { terminate } from "./spawn.js";
import { CLI_PROVIDER_IDS, type ProviderId, type Task } from "./types.js";

export interface ProviderResult {
  output: string;
  exitCode: number;
}

export interface ProviderContext {
  task: Task;
  workspacePath: string;
  onOutput: (output: string) => void;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  id: ProviderId;
  command: string;
  isAvailable: () => Promise<boolean>;
  run: (context: ProviderContext) => Promise<ProviderResult>;
}

let secrets = SecretStore.open();

/** Points the provider layer at a different credentials file. Tests use this. */
export const setSecretStore = (store: SecretStore): void => {
  secrets = store;
};

export const secretStore = (): SecretStore => secrets;

export const buildPrompt = (task: Task): string => [
  "You are an AgentSwarm worker.",
  "Work only in the provided repository checkout.",
  "Do not push directly to the target branch.",
  "Make the requested change, run relevant checks, and leave the working tree ready for review.",
  "",
  `Task: ${task.title}`,
  "",
  task.description,
  "",
  `Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.join(", ") : "repository default"}`,
  `Acceptance checks: ${task.acceptanceTests.length ? task.acceptanceTests.join("; ") : "none supplied"}`,
].join("\n");

const runProcess = async (
  command: string,
  args: string[],
  context: ProviderContext,
  detectFailure?: (output: string) => string | undefined,
): Promise<ProviderResult> => {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    // Detached so the agent and everything it spawns share one process group and
    // can be signalled together; see terminate().
    const child = spawn(command, args, {
      cwd: context.workspacePath,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        // Keys held in the credentials file are handed to the agent so a CLI
        // that expects one in its environment finds it. They are deliberately
        // not added to verification commands, which run with a clean env.
        ...secrets.environment(),
        AGENTSWARM_TASK_ID: context.task.id,
        AGENTSWARM_PROJECT_ID: context.task.projectId,
        AGENTSWARM_PROVIDER: context.task.provider,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      terminate(child);
      finish(() => reject(new Error("agent run cancelled")));
    };

    const timer = setTimeout(() => {
      terminate(child);
      finish(() => reject(new Error("agent run timed out")));
    }, config.agentTimeoutMs);

    if (context.signal.aborted) {
      abort();
      return;
    }
    context.signal.addEventListener("abort", abort, { once: true });

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString().slice(-32_000);
      output = `${output}${text}`.slice(-128_000);
      context.onOutput(text);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => {
      const result = { output, exitCode: exitCode ?? 1 };
      // Checked even on a non-zero exit: a CLI that explains its failure is more
      // use than "exited with code 1", and Antigravity reports the reason (a bad
      // --model, for one) in the same envelope it exits with.
      const reported = detectFailure?.(result.output);
      finish(() => {
        if (reported) reject(new Error(reported));
        else if (result.exitCode === 0) resolve(result);
        else reject(new Error(`${command} exited with code ${result.exitCode}`));
      });
    });
  });
};

interface CommandAdapterOptions {
  promptFirst?: boolean;
  extraArgs?: string[];
  detectFailure?: (output: string) => string | undefined;
  /**
   * Treat any successful spawn as installed, whatever the exit code.
   *
   * Antigravity's documented flags do not include `--version`, and a client that
   * rejects an unknown flag would otherwise look absent on every machine where it
   * is in fact installed. Only a spawn failure counts as missing.
   */
  looseProbe?: boolean;
}

export const buildProviderArgs = (
  id: ProviderId,
  args: string[],
  prompt: string,
  model?: string,
  options: CommandAdapterOptions = {},
): string[] => {
  const modelArgs = model && id !== "custom" ? ["--model", model] : [];
  const extraArgs = options.extraArgs ?? [];
  if (options.promptFirst) return [...args, prompt, ...extraArgs, ...modelArgs];
  return [...args, ...extraArgs, ...modelArgs, prompt];
};

const commandAdapter = (
  id: Exclude<ProviderId, "mock">,
  command: string,
  args: string[],
  options: CommandAdapterOptions = {},
): ProviderAdapter => ({
  id,
  command,
  isAvailable: async () => {
    if (!command) return false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (available: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(available);
      };
      const probe = spawn(command, ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        probe.kill("SIGTERM");
        finish(false);
      }, 2_000);
      probe.once("error", () => finish(false));
      probe.once("close", (code) => finish(options.looseProbe ? true : code === 0));
    });
  },
  run: (context) => {
    const argv = buildProviderArgs(id, args, buildPrompt(context.task), context.task.model, options);
    return runProcess(command, argv, context, options.detectFailure);
  },
});

// `hermes -z` reports provider and credential failures on stdout and still exits 0,
// so a failed run would otherwise look like a clean success. Only the first line is
// inspected, and only against hermes' own diagnostic prefixes, so ordinary agent
// prose that happens to mention an error is not mistaken for a failure.
export const hermesFailure = (output: string): string | undefined => {
  const firstLine = output.trimStart().split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine) return undefined;
  if (/^API call failed after \d+ retries:/i.test(firstLine)) return firstLine;
  if (/^hermes\b.*\bagent failed:/i.test(firstLine)) return firstLine;
  return undefined;
};

/**
 * Antigravity reports a terminal status in its JSON stream, and that is the only
 * place a failure is described: the run keeps going after a soft denial and can
 * still exit 0 having done less than it was asked. Reading `status` from the
 * final event turns that into a real failure the orchestrator can see.
 *
 * Only lines that parse as a whole JSON object are considered, so agent prose
 * that happens to mention ERROR, or a diff containing braces, cannot be mistaken
 * for one. Both shapes are handled because AGENTSWARM_ANTIGRAVITY_ARGS can
 * switch the output format away from the default.
 */
export const antigravityFailure = (output: string): string | undefined => {
  let result: Record<string, unknown> | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    // stream-json wraps the terminal state in a result event; the plain json
    // envelope puts it at the top level.
    const candidate =
      record.event === "result" && record.result && typeof record.result === "object"
        ? (record.result as Record<string, unknown>)
        : record;
    if (typeof candidate.status === "string") result = candidate;
  }

  // An unauthenticated headless run says so on stderr and stops.
  if (/authentication required/i.test(output)) return "antigravity: authentication required";

  if (!result) return undefined;
  const status = String(result.status).toUpperCase();
  if (status === "SUCCESS") return undefined;
  const error = typeof result.error === "string" ? result.error.trim() : "";
  const head = error ? error.split("\n", 1)[0] : "";
  // Antigravity fails loudly on a model it does not know rather than silently
  // falling back, which is correct but unhelpful without the list to check.
  const hint = /model/i.test(head) ? " (list them with `agy models`)" : "";
  return `antigravity: ${status.toLowerCase()}${head ? `: ${head}${hint}` : ""}`;
};

const mockAdapter: ProviderAdapter = {
  id: "mock",
  command: "mock",
  isAvailable: async () => true,
  run: async (context) => {
    const outputPath = join(context.workspacePath, ".agentswarm", "mock", `${context.task.id}.json`);
    await mkdir(dirname(outputPath), { recursive: true });
    const payload = JSON.stringify({
      taskId: context.task.id,
      title: context.task.title,
      provider: "mock",
      createdAt: new Date().toISOString(),
    }, null, 2);
    await writeFile(outputPath, `${payload}\n`, "utf8");
    const output = `Mock agent completed ${context.task.title}`;
    context.onOutput(`${output}\n`);
    return { output, exitCode: 0 };
  },
};

export const apiClientFor = (entry: ApiProviderEntry, model?: string): ChatClient => {
  const key = secrets.getAny(entry.envNames);
  return new ChatClient({
    baseUrl: resolveBaseUrl(entry),
    model: model?.trim() || entry.defaultModel,
    apiKey: entry.requiresKey ? key?.value : undefined,
    wire: entry.wire,
    timeoutMs: config.agentTimeoutMs,
  });
};

/**
 * Adapter for a provider openteam talks to directly. Availability is a local
 * credential check, never a network call, so listing providers stays instant;
 * `openteam keys test` is what reaches the network.
 */
export const apiAdapter = (entry: ApiProviderEntry): ProviderAdapter => ({
  id: entry.id as ProviderId,
  command: `api:${entry.id}`,
  isAvailable: async () => {
    if (!entry.requiresKey) return true;
    const key = secrets.getAny(entry.envNames);
    if (!key) return false;
    // A placeholder is not a credential; users paste these while writing config.
    return !/^(your|replace|changeme|todo|<)/i.test(key.value);
  },
  run: async (context) => {
    const client = apiClientFor(entry, context.task.model);
    if (entry.requiresKey && !secrets.getAny(entry.envNames)) {
      throw new Error(
        `No API key for ${entry.label}. Set one with \`openteam keys set ${entry.id}\` or export ${entry.envNames[0]}.`,
      );
    }
    const result = await runAgent({
      client,
      systemPrompt: `${buildPrompt(context.task)}\n\nYou have file and shell tools. Inspect before editing, make the change, verify it, then call finish.`,
      userPrompt: context.task.description || context.task.title,
      workspace: context.workspacePath,
      signal: context.signal,
      onProgress: (line) => context.onOutput(`${line}\n`),
    });
    const summary = result.summary || `Stopped after ${result.turns} turns (${result.stopReason})`;
    context.onOutput(`${summary}\n`);
    if (result.stopReason === "turn_limit" || result.stopReason === "time_limit") {
      // Partial work is still committed and reviewed; silence would hide it.
      return { output: summary, exitCode: 0 };
    }
    return { output: summary, exitCode: 0 };
  },
});

/** How each agent CLI is invoked, shared by running work and by reviewing it. */
interface CliShape {
  command: string;
  args: string[];
  options?: CommandAdapterOptions;
}

const cliShapes: Record<string, CliShape> = {
  codex: { command: config.commands.codex, args: ["exec", "--json", "--sandbox", "workspace-write"] },
  claude: {
    command: config.commands.claude,
    args: ["-p", "--permission-mode", "acceptEdits", "--no-session-persistence"],
  },
  opencode: { command: config.commands.opencode, args: ["run"] },
  // `hermes -z PROMPT` binds PROMPT to the -z flag, so the prompt must precede
  // --model or argparse errors with "argument -z/--oneshot: expected one argument".
  // --accept-hooks keeps headless runs from blocking on unseen hooks in config.yaml.
  hermes: {
    command: config.commands.hermes,
    args: ["-z"],
    options: { promptFirst: true, extraArgs: ["--accept-hooks"], detectFailure: hermesFailure },
  },
  // `agy -p PROMPT` is its headless mode. The prompt is bound to -p, so it has to
  // come immediately after it, before --model.
  antigravity: {
    command: config.commands.antigravity,
    args: ["-p"],
    options: {
      promptFirst: true,
      extraArgs: config.antigravityArgs,
      detectFailure: antigravityFailure,
      looseProbe: true,
    },
  },
  custom: { command: config.commands.custom, args: [] },
};

const cliAdapters: Record<string, ProviderAdapter> = {
  mock: mockAdapter,
  ...Object.fromEntries(
    Object.entries(cliShapes).map(([id, shape]) => [
      id,
      commandAdapter(id as Exclude<ProviderId, "mock">, shape.command, shape.args, shape.options ?? {}),
    ]),
  ),
};

/**
 * Runs one prompt through an agent CLI and returns what it printed.
 *
 * Used to let a CLI act as the reviewer. The prompt is a judgement request, not
 * work: whatever the CLI would do with tools is left to it, and the reply is read
 * as text, so a model that starts editing is not silently accepted.
 */
export const runCliPrompt = async (
  id: string,
  prompt: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; exitCode: number }> => {
  const shape = cliShapes[id];
  if (!shape || !shape.command) throw new Error(`No command configured for ${id}`);
  const argv = buildProviderArgs(id as ProviderId, shape.args, prompt, undefined, {
    ...(shape.options ?? {}),
    // A review must not inherit the writer's sandbox or auto-approval flags.
    extraArgs: (shape.options?.extraArgs ?? []).filter(
      (arg) => !arg.startsWith("--dangerously") && arg !== "--sandbox" && !arg.startsWith("--permission-mode"),
    ),
  });

  return new Promise((resolve, reject) => {
    const child = spawn(shape.command, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...secrets.environment() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${id} did not answer within ${options.timeoutMs ?? config.agentTimeoutMs}ms`));
    }, options.timeoutMs ?? config.agentTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk}`.slice(-64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      // Some CLIs print the answer on stderr (codex's --json does).
      resolve({ stdout: `${stdout}\n${stderr}`.trim(), exitCode: code ?? 1 });
    });
  });
};

/** Whether an agent id is one of the agent CLIs that can also review. */
export const isCliReviewer = (id: string): boolean => Boolean(cliShapes[id]?.command);

const apiAdapterCache = new Map<string, ProviderAdapter>();

/** Adapters are built from the merged registry, so added providers just work. */
const allAdapters = (): ProviderAdapter[] => {
  const seen = new Set<string>();
  const out: ProviderAdapter[] = [];
  for (const entry of providerRegistry().entries()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    let adapter = apiAdapterCache.get(entry.id);
    if (!adapter) {
      adapter = apiAdapter(entry);
      apiAdapterCache.set(entry.id, adapter);
    }
    out.push(adapter);
  }
  for (const id of CLI_PROVIDER_IDS) {
    if (seen.has(id)) continue;
    const adapter = cliAdapters[id];
    if (adapter) out.push(adapter);
  }
  return out;
};

export const knownProviderIds = (): string[] => allAdapters().map((adapter) => adapter.id);

export const getAdapter = (id: ProviderId): ProviderAdapter => {
  const found = allAdapters().find((adapter) => adapter.id === id);
  if (found) return found;
  throw new Error(`Unknown provider "${id}". Run \`openteam providers\` to see the list.`);
};

export const listProviders = async (): Promise<Array<{ id: ProviderId; command: string; available: boolean }>> =>
  Promise.all(
    allAdapters().map(async (adapter) => ({
      id: adapter.id,
      command: adapter.command,
      available: await adapter.isAvailable(),
    })),
  );

export const ensureProviderAvailable = async (id: ProviderId): Promise<void> => {
  const adapter = getAdapter(id);
  if (!(await adapter.isAvailable())) {
    const entry = providerRegistry().get(id);
    if (entry) {
      throw new Error(
        entry.requiresKey
          ? `No usable API key for ${entry.label}. Set one with \`openteam keys set ${entry.id}\` or export ${entry.envNames[0]}.`
          : `${entry.label} is unavailable. Set ${entry.baseUrlEnv} to a reachable endpoint.`,
      );
    }
    throw new Error(`${adapter.command || id} is not available on PATH`);
  }
};

export { redact as redactSecret };
