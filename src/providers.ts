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
      const reported = result.exitCode === 0 ? detectFailure?.(result.output) : undefined;
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
      probe.once("close", (code) => finish(code === 0));
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

const cliAdapters: Record<string, ProviderAdapter> = {
  mock: mockAdapter,
  codex: commandAdapter("codex", config.commands.codex, ["exec", "--json", "--sandbox", "workspace-write"]),
  claude: commandAdapter("claude", config.commands.claude, ["-p", "--permission-mode", "acceptEdits", "--no-session-persistence"]),
  opencode: commandAdapter("opencode", config.commands.opencode, ["run"]),
  // `hermes -z PROMPT` binds PROMPT to the -z flag, so the prompt must precede
  // --model or argparse errors with "argument -z/--oneshot: expected one argument".
  // --accept-hooks keeps headless runs from blocking on unseen hooks in config.yaml.
  hermes: commandAdapter("hermes", config.commands.hermes, ["-z"], {
    promptFirst: true,
    extraArgs: ["--accept-hooks"],
    detectFailure: hermesFailure,
  }),
  custom: commandAdapter("custom", config.commands.custom, []),
};

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
