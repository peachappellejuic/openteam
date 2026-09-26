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

export const isLoopbackHost = (value: string): boolean => value === "127.0.0.1" || value === "localhost" || value === "::1";

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
  agentTimeoutMs: 30 * 60 * 1000,
  commandTimeoutMs: 10 * 60 * 1000,
  commands: {
    codex: process.env.CODEX_COMMAND ?? "codex",
    claude: process.env.CLAUDE_COMMAND ?? "claude",
    opencode: process.env.OPENCODE_COMMAND ?? "opencode",
    custom: process.env.AGENTSWARM_AGENT_COMMAND ?? "",
  },
};

mkdirSync(config.dataDir, { recursive: true });
