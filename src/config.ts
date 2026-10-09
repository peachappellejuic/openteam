import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile?.();
} catch {}

const port = Number.parseInt(process.env.PORT ?? "4317", 10);
const host = process.env.HOST ?? "127.0.0.1";
const sharedToken = (process.env.AGENTSWARM_SHARED_TOKEN ?? "").trim();
const maxConcurrentRuns = Number.parseInt(process.env.AGENTSWARM_MAX_CONCURRENCY ?? "4", 10);
const agentTimeoutMs = 30 * 60 * 1000;

export const isLoopbackHost = (value: string): boolean => value === "127.0.0.1" || value === "localhost" || value === "::1";

/**
 * Flags for `agy`, beyond the prompt itself.
 *
 * In headless mode Antigravity has nobody to ask, so anything set to Ask is
 * soft-denied: the run still exits 0 having quietly done less than asked. An
 * agent that cannot run the test suite would report success anyway, which is
 * worse than being explicit about the trade, so runs are auto-approved by
 * default. The mirror is a private clone reviewed before anything merges.
 * AGENTSWARM_ANTIGRAVITY_PERMISSIONS=ask turns that off for anyone who would
 * rather see the denials, and AGENTSWARM_ANTIGRAVITY_ARGS adds anything else
 * (for example `--effort high`, `--agent reviewer`, or `--sandbox`).
 */
const antigravityArgs = (agentTimeoutMs: number): string[] => {
  const permissions = process.env.AGENTSWARM_ANTIGRAVITY_PERMISSIONS?.trim().toLowerCase();
  const autoApprove = permissions !== "ask" && permissions !== "none";
  // Let the CLI report its own timeout before the harness kills it, so the
  // failure arrives as a readable status rather than a signal.
  const budget = `${Math.max(1, Math.floor((agentTimeoutMs - 15_000) / 60_000))}m`;
  const extra = (process.env.AGENTSWARM_ANTIGRAVITY_ARGS ?? "").trim().split(/\s+/).filter(Boolean);
  return [
    "--output-format",
    "stream-json",
    "--print-timeout",
    budget,
    ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
    ...extra,
  ];
};

export const config = {
  port: Number.isFinite(port) ? port : 4317,
  host,
  sharedToken,
  sharedTokenRequired: sharedToken.length > 0,
  sharedTokenMissing: !isLoopbackHost(host) && sharedToken.length === 0,
  dataDir: resolve(process.env.AGENTSWARM_DATA_DIR ?? join(projectRoot, "data")),
  publicDir: resolve(join(projectRoot, "public")),
  maxBodyBytes: 2 * 1024 * 1024,
  maxDiffBytes: 512 * 1024,
  maxEvents: 5000,
  agentTimeoutMs,
  commandTimeoutMs: 10 * 60 * 1000,
  /** Simultaneous agents per process. Every agent clones the repo and spends tokens. */
  maxConcurrentRuns: Number.isFinite(maxConcurrentRuns) && maxConcurrentRuns > 0 ? maxConcurrentRuns : 4,
  commands: {
    codex: process.env.CODEX_COMMAND ?? "codex",
    claude: process.env.CLAUDE_COMMAND ?? "claude",
    opencode: process.env.OPENCODE_COMMAND ?? "opencode",
    hermes: process.env.HERMES_COMMAND ?? "hermes",
    // Antigravity ships its terminal client as `agy`, not `antigravity`.
    antigravity: process.env.ANTIGRAVITY_COMMAND ?? "agy",
    custom: process.env.AGENTSWARM_AGENT_COMMAND ?? "",
  },
  antigravityArgs: antigravityArgs(agentTimeoutMs),
};

mkdirSync(config.dataDir, { recursive: true });
