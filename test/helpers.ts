import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const createTestRepository = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "AgentSwarm Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@agentswarm.local"]);
  await writeFile(join(root, "README.md"), "# Test repository\n", "utf8");
  await execFileAsync("git", ["-C", root, "add", "README.md"]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "Initial commit"]);
  return root;
};

export const removeTestPath = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true });
};
