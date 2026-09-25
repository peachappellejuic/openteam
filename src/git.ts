import { execFile, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  public constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const runGit = async (args: string[], cwd?: string): Promise<string> => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string; message?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "git command failed";
    throw new GitError(detail, typeof failure.code === "number" ? failure.code : undefined);
  }
};

export interface RepositoryInfo {
  root: string;
  branch: string;
  head: string;
  bare: boolean;
}

export const getRepositoryInfo = async (repositoryPath: string): Promise<RepositoryInfo> => {
  const path = resolve(repositoryPath);
  const bare = (await runGit(["rev-parse", "--is-bare-repository"], path)) === "true";
  const root = bare ? path : (await runGit(["rev-parse", "--show-toplevel"], path));
  const branch = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], path)) || "main";
  const head = await runGit(["rev-parse", "HEAD"], path);
  return { root, branch, head, bare };
};

export const createBareMirror = async (sourcePath: string, destination: string, defaultBranch?: string): Promise<RepositoryInfo> => {
  const source = await getRepositoryInfo(sourcePath);
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  await runGit(["clone", "--bare", source.root, target]);
  const branch = defaultBranch || source.branch;
  try {
    await runGit(["rev-parse", `refs/heads/${branch}`], target);
  } catch {
    throw new GitError(`Branch ${branch} does not exist in ${source.root}`);
  }
  await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], target);
  return { ...source, root: target, branch, bare: true };
};

export const getBareHead = async (mirrorPath: string, branch: string): Promise<string> => runGit(["rev-parse", `refs/heads/${branch}`], mirrorPath);

export interface SyncResult {
  status: "up_to_date" | "updated" | "ahead" | "diverged";
  localSha: string;
  remoteSha: string;
}

export const syncBareMirror = async (mirrorPath: string, branch: string): Promise<SyncResult> => {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await runGit(["fetch", "origin", `+refs/heads/${branch}:${remoteRef}`], mirrorPath);
  const localSha = await getBareHead(mirrorPath, branch);
  const remoteSha = await runGit(["rev-parse", remoteRef], mirrorPath);
  if (localSha === remoteSha) return { status: "up_to_date", localSha, remoteSha };
  try {
    await runGit(["merge-base", "--is-ancestor", localSha, remoteSha], mirrorPath);
    await runGit(["update-ref", `refs/heads/${branch}`, remoteSha, localSha], mirrorPath);
    return { status: "updated", localSha, remoteSha };
  } catch {
    try {
      await runGit(["merge-base", "--is-ancestor", remoteSha, localSha], mirrorPath);
      return { status: "ahead", localSha, remoteSha };
    } catch {
      return { status: "diverged", localSha, remoteSha };
    }
  }
};

export const getWorkspace = async (
  mirrorPath: string,
  workspacePath: string,
  baseSha: string,
  branch: string,
): Promise<void> => {
  const target = resolve(workspacePath);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  await runGit(["clone", "--no-hardlinks", mirrorPath, target]);
  await runGit(["checkout", "-B", branch, baseSha], target);
};

export const getWorkspaceHead = async (workspacePath: string): Promise<string> => runGit(["rev-parse", "HEAD"], workspacePath);

export const publishWorkspaceBranch = async (workspacePath: string, branch: string): Promise<void> => {
  await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], workspacePath);
};

export const getWorkspaceStatus = async (workspacePath: string): Promise<string> => runGit(["status", "--porcelain"], workspacePath);

export const commitWorkspace = async (workspacePath: string, message: string): Promise<string> => {
  await runGit(["add", "-A"], workspacePath);
  const staged = await runGit(["diff", "--cached", "--quiet"], workspacePath).then(
    () => false,
    () => true,
  );
  if (staged) {
    await runGit(["-c", "user.name=AgentSwarm", "-c", "user.email=agentswarm@localhost", "commit", "-m", message], workspacePath);
  }
  return getWorkspaceHead(workspacePath);
};

export const getCommitSubject = async (workspacePath: string, commitSha: string): Promise<string> =>
  (await runGit(["show", "-s", "--format=%s", commitSha], workspacePath)) || "Agent change";

export const getChangedFiles = async (workspacePath: string, baseSha: string, headSha: string): Promise<string[]> => {
  const output = await runGit(["diff", "--name-only", `${baseSha}..${headSha}`], workspacePath);
  return output.split("\n").map((file) => file.trim()).filter(Boolean);
};

export const getDiff = async (workspacePath: string, baseSha: string, headSha: string): Promise<string> => {
  const diff = await runGit(["diff", "--binary", `${baseSha}..${headSha}`], workspacePath);
  if (Buffer.byteLength(diff, "utf8") <= config.maxDiffBytes) return diff;
  return `${diff.slice(0, config.maxDiffBytes)}\n\n[diff truncated by AgentSwarm]\n`;
};

export interface MergeResult {
  status: "merged" | "conflict";
  mergeSha?: string;
  error?: string;
}

export const mergeChange = async (
  mirrorPath: string,
  targetBranch: string,
  baseSha: string,
  changeBranch: string,
  mergeId: string,
): Promise<MergeResult> => {
  const stagingPath = join(config.dataDir, "merge", `${mergeId}`);
  const mergeBranch = `agentswarm/merge/${mergeId}`;
  rmSync(stagingPath, { recursive: true, force: true });
  mkdirSync(dirname(stagingPath), { recursive: true });

  try {
    await getWorkspace(mirrorPath, stagingPath, baseSha, mergeBranch);
    await runGit(["fetch", "origin", changeBranch], stagingPath);
    try {
      await runGit(["merge", "--no-ff", "--no-commit", "FETCH_HEAD"], stagingPath);
    } catch (error) {
      await runGit(["merge", "--abort"], stagingPath).catch(() => undefined);
      return { status: "conflict", error: error instanceof Error ? error.message : "merge conflict" };
    }

    const mergeSha = await commitWorkspace(stagingPath, `Merge AgentSwarm change ${mergeId}`);
    await publishWorkspaceBranch(stagingPath, mergeBranch);
    await runGit(["update-ref", `refs/heads/${targetBranch}`, mergeSha, baseSha], mirrorPath);
    return { status: "merged", mergeSha };
  } finally {
    rmSync(stagingPath, { recursive: true, force: true });
  }
};

export const removeWorkspace = async (workspacePath: string): Promise<void> => {
  rmSync(resolve(workspacePath), { recursive: true, force: true });
};

export const verifyWorkspace = async (workspacePath: string, command: string): Promise<{ exitCode: number; output: string }> => {
  return new Promise((resolvePromise) => {
    const child = spawn("/bin/sh", ["-lc", command], { cwd: workspacePath, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: { exitCode: number; output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-64_000);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: 124, output: `${output}\nVerification timed out` });
    }, config.commandTimeoutMs);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("close", (exitCode) => finish({ exitCode: exitCode ?? 1, output }));
    child.on("error", (error) => finish({ exitCode: 1, output: `${output}${error.message}` }));
  });
};
