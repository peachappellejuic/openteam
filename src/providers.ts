import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { ProviderId, Task } from "./types.js";

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

const buildPrompt = (task: Task): string => [
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
): Promise<ProviderResult> => {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const child = spawn(command, args, {
      cwd: context.workspacePath,
      env: {
        ...process.env,
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
      child.kill("SIGTERM");
      finish(() => reject(new Error("agent run cancelled")));
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
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
      finish(() => {
        if (result.exitCode === 0) resolve(result);
        else reject(new Error(`${command} exited with code ${result.exitCode}`));
      });
    });
  });
};

const commandAdapter = (id: Exclude<ProviderId, "mock">, command: string, args: string[]): ProviderAdapter => ({
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
    const modelArgs = context.task.model && id !== "custom" ? ["--model", context.task.model] : [];
    return runProcess(command, [...args, ...modelArgs, buildPrompt(context.task)], context);
  },
});

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

const adapters: Record<ProviderId, ProviderAdapter> = {
  mock: mockAdapter,
  codex: commandAdapter("codex", config.commands.codex, ["exec", "--json", "--sandbox", "workspace-write"]),
  claude: commandAdapter("claude", config.commands.claude, ["-p", "--permission-mode", "acceptEdits", "--no-session-persistence"]),
  opencode: commandAdapter("opencode", config.commands.opencode, ["run"]),
  custom: commandAdapter("custom", config.commands.custom, []),
};

export const getAdapter = (id: ProviderId): ProviderAdapter => adapters[id];

export const listProviders = async (): Promise<Array<{ id: ProviderId; command: string; available: boolean }>> =>
  Promise.all(Object.values(adapters).map(async (adapter) => ({
    id: adapter.id,
    command: adapter.command,
    available: await adapter.isAvailable(),
  })));

export const ensureProviderAvailable = async (id: ProviderId): Promise<void> => {
  const adapter = getAdapter(id);
  if (!(await adapter.isAvailable())) {
    throw new Error(`${adapter.command || id} is not available on PATH`);
  }
};
