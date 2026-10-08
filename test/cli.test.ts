import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { flagBool, flagList, flagNumber, flagString, isLikelyTypo, parseArgs, tokenize, UsageError } from "../src/cli/args.js";
import { diffStat, titleFromPrompt } from "../src/cli/core.js";
import { LineWriter, Spinner, renderEvent } from "../src/cli/events.js";
import { colorizeDiff, renderChangeRows, renderTaskRows } from "../src/cli/render.js";
import { paint, pad, relativeTime, setColor, table, truncate } from "../src/cli/format.js";
import { getBareHead, getRepositoryInfo, pushMirrorBranch, syncBareMirror } from "../src/git.js";
import { JsonStore } from "../src/store.js";
import { Orchestrator } from "../src/orchestrator.js";
import { run } from "../src/cli.js";
import { createTestRepository, removeTestPath } from "./helpers.js";
import type { AppEvent, Change, Task } from "../src/types.js";

const execFileAsync = promisify(execFile);

const cliEntry = (): string => fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxCli = (): string => fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

// --- argument parsing -------------------------------------------------------

test("flags are parsed by long, short, and inline forms", () => {
  const args = parseArgs(["tasks", "--status", "review", "-n", "5", "--all", "--json", "--assignee=alice"]);
  assert.deepEqual(args.positionals, ["tasks"]);
  assert.equal(flagString(args, "status"), "review");
  assert.equal(flagNumber(args, "limit", 50), 5);
  assert.equal(flagBool(args, "all"), true);
  assert.equal(flagBool(args, "json"), true);
  assert.equal(flagBool(args, "no-color"), false);
  assert.equal(flagString(args, "assignee"), "alice");
});

test("comma separated flags split into a list", () => {
  const args = parseArgs(["--paths", "src/**, tests/**", "prompt words"]);
  assert.deepEqual(flagList(args, "paths"), ["src/**", "tests/**"]);
  assert.equal(args.prompt, "prompt words");
});

test("an instruction becomes the prompt and stays intact", () => {
  const args = parseArgs(["add", "retry", "to", "the", "fetch", "client"]);
  assert.equal(args.prompt, "add retry to the fetch client");
  assert.equal(args.explicitPrompt, false);
});

test("--prompt supplies the instruction explicitly", () => {
  const args = parseArgs(["--prompt", "delete the word --json from the parser", "--json"]);
  assert.equal(args.prompt, "delete the word --json from the parser");
  assert.equal(args.explicitPrompt, true);
});

test("a double dash stops flag parsing", () => {
  const args = parseArgs(["task", "add", "--", "--not-a-flag"]);
  assert.equal(args.prompt, "task add --not-a-flag");
});

test("bad arguments are rejected with a usage error", () => {
  assert.throws(() => parseArgs(["--nope"]), UsageError);
  assert.throws(() => parseArgs(["--status"]), UsageError);
  assert.throws(() => parseArgs(["-z"]), UsageError);
});

test("only a single-edit slip is treated as a definite typo", () => {
  const commands = ["tasks", "approve", "merge", "push", "sync", "diff", "help"];
  assert.deepEqual(isLikelyTypo("tasl", commands), { word: "tasl", suggestion: "tasks", confident: false });
  assert.equal(isLikelyTypo("aprove", commands)?.confident, true);
  assert.equal(isLikelyTypo("reticulate", commands), undefined);

  // "hello" is two edits from "help" but is a perfectly good instruction, so it
  // must never be blocked.
  const verdict = isLikelyTypo("hello", commands);
  assert.equal(verdict?.confident, false, "an ambiguous match may not block a real instruction");
  assert.equal(isLikelyTypo("x", commands), undefined);
});

// --- formatting -------------------------------------------------------------

test("titles are derived from the first sentence of an instruction", () => {
  assert.equal(titleFromPrompt("add retry to the client. Keep it small"), "add retry to the client.");
  assert.equal(titleFromPrompt("\n  make it fast  \nsecond line"), "make it fast");
  assert.equal(titleFromPrompt("x".repeat(200)).length, 72);
  assert.equal(titleFromPrompt("   "), "Untitled task");
});

test("diff statistics count files and line changes", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    "diff --git a/b.txt b/b.txt",
    "+++ b/b.txt",
    "+one",
    "+two",
  ].join("\n");
  assert.deepEqual(diffStat(diff), { files: ["a.txt", "b.txt"], added: 3, removed: 1 });
  assert.deepEqual(diffStat(""), { files: [], added: 0, removed: 0 });
});

test("colour can be turned off and table columns line up", () => {
  setColor(false);
  assert.equal(paint("red", "boom"), "boom");
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(truncate("abcdef", 4), "abc…");
  const rendered = table([{ header: "A" }, { header: "LONGER" }], [["1", "2"], ["333", "4"]]);
  assert.match(rendered, /A\s+LONGER/);
  assert.equal(relativeTime(new Date(Date.now() - 60_000).toISOString()), "1m ago");
});

test("a wide character counts as two columns so tables stay aligned", () => {
  setColor(false);
  const rendered = table([{ header: "TASK" }], [["\u00e9\u4e2d"], ["ok"]]);
  const [first, second] = rendered.split("\n").slice(2);
  assert.equal([...first].length, [...second].length);
});

test("list rows keep the status badge and the identifiers", () => {
  setColor(false);
  const task = {
    id: "task_abcdef123456",
    projectId: "prj_1",
    title: "Do the thing",
    description: "",
    status: "review",
    provider: "codex",
    model: "gpt-5",
    assignee: "alice",
    dependencies: [],
    allowedPaths: [],
    acceptanceTests: [],
    branch: "agentswarm/task/task_abcdef123456",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies Task;
  const rows = renderTaskRows([task]);
  assert.equal(rows.length, 1);
  assert.match(rows[0][0], /review/);
  assert.match(rows[0][1], /Do the thing/);
  assert.equal(rows[0][2], "codex/gpt-5");
  assert.ok(rows[0][5].includes(task.id));

  const change = {
    id: "chg_1",
    projectId: "prj_1",
    taskId: "task_1",
    runId: "run_1",
    branch: "agentswarm/task/task_abcdef123456",
    baseSha: "a".repeat(40),
    commitSha: "b".repeat(40),
    status: "pending",
    summary: "AgentSwarm: Do the thing",
    diff: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies Change;
  assert.match(renderChangeRows([change])[0][2], /task\/task_abcdef123456/);
});

test("diffs colour additions, removals, and hunk headers", () => {
  setColor(true);
  const coloured = colorizeDiff("@@ -1 +1 @@\n-old\n+new");
  assert.match(coloured, /\u001b\[36m@@/);
  assert.match(coloured, /\u001b\[31m-old/);
  assert.match(coloured, /\u001b\[32m\+new/);
  setColor(false);
});

// --- event rendering --------------------------------------------------------

test("every event type renders a line except streamed agent output", () => {
  setColor(false);
  const base = { id: "evt_1", timestamp: new Date().toISOString(), message: "hello" };
  const event = (type: string): AppEvent => ({ ...base, type });
  assert.match(renderEvent(event("task.started"))!, /hello/);
  assert.match(renderEvent(event("task.failed"))!, /hello/);
  assert.match(renderEvent(event("task.review"))!, /hello/);
  assert.equal(renderEvent(event("agent.output")), undefined);
});

test("streamed agent output is buffered until a line completes", () => {
  const lines: string[] = [];
  const writer = new LineWriter((line) => lines.push(line));
  writer.push("hello\nwor");
  assert.deepEqual(lines, ["hello"]);
  writer.push("ld\n");
  assert.deepEqual(lines, ["hello", "world"]);
  writer.flush();
  assert.deepEqual(lines, ["hello", "world"]);
});

test("the spinner is silent without a terminal", () => {
  const stream = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
  const spinner = new Spinner(stream, "working");
  spinner.start(0);
  spinner.update("still working");
  assert.equal(spinner.spinning, false);
  spinner.stop();
});

// --- git --------------------------------------------------------------------

test("a merged mirror branch can be pushed back to origin", async () => {
  const source = await createTestRepository("agentswarm-push-");
  const mirror = await mkdtemp(join(tmpdir(), "agentswarm-push-mirror-"));
  const mirrorPath = join(mirror, "mirror.git");
  try {
    const repository = await getRepositoryInfo(source);
    await execFileAsync("git", ["clone", "--bare", repository.root, mirrorPath]);

    await writeFile(join(source, "feature.txt"), "hello\n", "utf8");
    await execFileAsync("git", ["-C", source, "add", "-A"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "Add feature"]);
    const head = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);

    const sync = await syncBareMirror(mirrorPath, "main");
    assert.equal(sync.status, "updated");
    assert.equal(await getBareHead(mirrorPath, "main"), head.stdout.trim());

    const pushed = await pushMirrorBranch(mirrorPath, "main", "refs/heads/agentswarm/from-cli");
    assert.equal(pushed.destinationRef, "refs/heads/agentswarm/from-cli");

    const branches = await execFileAsync("git", ["-C", source, "branch", "--list", "agentswarm/from-cli"]);
    assert.match(branches.stdout, /agentswarm\/from-cli/);
  } finally {
    await removeTestPath(source);
    await removeTestPath(mirror);
  }
});

// --- shutdown ownership -----------------------------------------------------

test("shutdown settles only the running work this instance started", async () => {
  const source = await createTestRepository("agentswarm-shutdown-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-shutdown-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  const timestamp = new Date().toISOString();
  const seed = async (id: string, status: Task["status"]): Promise<void> => {
    const [project] = store.listProjects();
    await store.createTask({
      id,
      projectId: project.id,
      title: id,
      description: "",
      status,
      provider: "mock",
      dependencies: [],
      allowedPaths: [],
      acceptanceTests: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };

  try {
    const project = await orchestrator.createProject({ name: "Shutdown", repositoryPath: source });

    // Another process owns this one; this instance must never touch it.
    await seed("task_foreign_running", "running");
    // Queued work is left for a later `watch`, not thrown away on exit.
    const detached = await orchestrator.createTask(
      project.id,
      { title: "Queued for later", description: "Do not auto-dispatch", provider: "mock" },
      { dispatch: false },
    );

    await orchestrator.shutdown({ cancelPending: true });

    assert.equal(store.getTask("task_foreign_running")?.status, "running");
    assert.equal(store.getTask(detached.id)?.status, "queued");
  } finally {
    await orchestrator.shutdown();
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

const agentScript = async (path: string, body: string): Promise<string> => {
  // Answer the availability probe instantly so the run is not judged unavailable.
  await writeFile(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake 1.0; exit 0; fi\n${body}\n`, {
    mode: 0o755,
  });
  return path;
};

const readTask = (dataDirectory: string): Task | undefined => {
  const store = new JsonStore(join(dataDirectory, "state.json"));
  const projects = store.listProjects();
  return projects.length ? store.listTasks(projects[0].id)[0] : undefined;
};

test("a real agent binary is followed, committed, and put up for review", async () => {
  const source = await createTestRepository("agentswarm-agent-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-agent-data-"));
  const agentPath = await agentScript(
    join(dataDirectory, "agent.sh"),
    'echo "thinking about it"\nprintf "export const mul = (a, b) => a * b;\\n" > math.js\n',
  );

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli(), cliEntry(), "add multiplication", "--provider", "custom", "--no-pager"],
      {
        cwd: source,
        env: {
          ...process.env,
          AGENTSWARM_DATA_DIR: dataDirectory,
          AGENTSWARM_AGENT_COMMAND: agentPath,
          NO_COLOR: "1",
        },
        timeout: 25_000,
      },
    );

    assert.match(stdout, /thinking about it/, "agent output should be streamed");
    assert.match(stdout, /review/);
    assert.match(stdout, /math\.js/);

    const task = readTask(dataDirectory);
    assert.equal(task?.status, "review");

    // The agent's file exists in the mirror's workspace branch, not in the user's checkout.
    const status = await execFileAsync("git", ["-C", source, "status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "", "the original checkout must stay clean");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("interrupting a run cancels the agent instead of stranding the task", async () => {
  const source = await createTestRepository("agentswarm-abandon-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-abandon-data-"));
  const agentPath = await agentScript(join(dataDirectory, "slow-agent.sh"), "sleep 60");

  const child = spawn(
    process.execPath,
    [tsxCli(), cliEntry(), "work slowly", "--provider", "custom", "--no-pager"],
    {
      cwd: source,
      env: {
        ...process.env,
        AGENTSWARM_DATA_DIR: dataDirectory,
        AGENTSWARM_AGENT_COMMAND: agentPath,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    // Wait until the agent is actually running before interrupting.
    await waitUntil(() => readTask(dataDirectory)?.status === "running", 20_000);
    child.kill("SIGINT");

    const code = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(null), 20_000);
      child.once("exit", (value) => {
        clearTimeout(timer);
        resolveExit(value);
      });
    });

    assert.notEqual(code, null, "the cli must exit after an interrupt rather than wait out the agent");
    assert.equal(readTask(dataDirectory)?.status, "cancelled");
  } finally {
    child.kill("SIGKILL");
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
};

test("the built cli runs through a symlinked bin path", async () => {
  const source = await createTestRepository("agentswarm-bin-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-bin-data-"));
  const workspace = await mkdtemp(join(tmpdir(), "agentswarm-bin-work-"));

  try {
    await execFileAsync("npm", ["run", "--silent", "build"], { cwd: projectRoot() });

    // npm installs bin entries as symlinks, so the entry point must survive one.
    const link = join(workspace, "openteam");
    await symlink(join(projectRoot(), "dist", "cli.js"), link);

    const { stdout } = await execFileAsync(process.execPath, [link, "version"], {
      cwd: source,
      env: { ...process.env, AGENTSWARM_DATA_DIR: dataDirectory },
    });
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

const projectRoot = (): string => fileURLToPath(new URL("..", import.meta.url));

// --- end to end -------------------------------------------------------------

test("watch starts queued tasks instead of waiting on them forever", async () => {
  const source = await createTestRepository("agentswarm-watch-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-watch-data-"));
  const agentDirectory = await mkdtemp(join(tmpdir(), "agentswarm-watch-agent-"));
  const script = join(agentDirectory, "agent.sh");
  await writeFile(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake 1.0; exit 0; fi\nprintf "done\\n" > work.txt\n', { mode: 0o755 });

  try {
    // Tasks recorded with --no-follow stay queued; only `watch` should start them.
    for (const title of ["first job", "second job"]) {
      await capture(["--data-dir", dataDirectory, "--no-color", title, "--provider", "custom", "--no-follow"], source);
    }

    const timed = Date.now();
    const child = spawn(
      process.execPath,
      [tsxCli(), cliEntry(), "watch", "--data-dir", dataDirectory, "--no-color", "--no-pager"],
      {
        cwd: source,
        env: {
          ...process.env,
          AGENTSWARM_DATA_DIR: dataDirectory,
          AGENTSWARM_AGENT_COMMAND: script,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });

    const code = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit(null);
      }, 25_000);
      child.once("exit", (value) => {
        clearTimeout(timer);
        resolveExit(value);
      });
    });

    assert.notEqual(code, null, "watch hung on tasks it never dispatched");
    assert.ok(Date.now() - timed < 25_000);
    const store = new JsonStore(join(dataDirectory, "state.json"));
    const project = store.listProjects()[0];
    const tasks = store.listTasks(project.id);
    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.ok(
        ["completed", "review"].includes(task.status),
        `watch should have run the task, but it is ${task.status}: ${task.error ?? ""}`,
      );
      assert.ok(task.startedAt, "a dispatched task records when it started");
    }
    assert.equal(store.listChanges(project.id).length, 2, "both agents produced a change");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(agentDirectory, { recursive: true, force: true });
    await removeTestPath(source);
  }
});

const capture = async (argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> => {
  const previousCwd = process.cwd();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    outChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.chdir(cwd);
  try {
    const code = await run(argv);
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.chdir(previousCwd);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
};

test("the cli connects a repository, runs an agent, reviews, and merges", async () => {
  const source = await createTestRepository("agentswarm-cli-e2e-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-cli-data-"));
  const common = ["--data-dir", dataDirectory, "--no-color", "--no-pager"];

  try {
    const doctor = await capture(["doctor", ...common], source);
    assert.equal(doctor.code, 0);
    assert.match(doctor.out, /git repository/);

    const queued = await capture(["add a multiply function", "--provider", "mock", ...common], source);
    assert.equal(queued.code, 0, queued.err);
    assert.match(queued.out, /review/, "the mock agent writes a file, so a change should await review");

    const changes = await capture(["changes", ...common], source);
    const changeId = changes.out.match(/chg_[a-f0-9]{12}/)?.[0];
    assert.ok(changeId, `expected a change id in:\n${changes.out}`);

    const merged = await capture(["merge", changeId, ...common], source);
    assert.equal(merged.code, 1, "merging without approving must fail");
    assert.match(merged.err, /approved/);

    const approved = await capture(["approve", changeId, ...common], source);
    assert.equal(approved.code, 0, approved.err);

    const diffed = await capture(["diff", changeId, ...common], source);
    assert.equal(diffed.code, 0);
    assert.match(diffed.out, /agentswarm\/mock/);

    const integrated = await capture(["merge", changeId, ...common], source);
    assert.equal(integrated.code, 0, integrated.err);
    assert.match(integrated.out, /merged/);

    // The user's own checkout is never touched; only the mirror moved.
    const original = await getRepositoryInfo(source);
    const status = await execFileAsync("git", ["-C", source, "status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]).then((r) => r.stdout.trim()),
      original.head);

    // The mirror is now ahead of origin, which the CLI must say out loud.
    const synced = await capture(["sync", ...common], source);
    assert.match(synced.out, /local merges/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("the cli fails cleanly on a task that does not exist", async () => {
  const source = await createTestRepository("agentswarm-cli-missing-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-cli-missing-data-"));
  try {
    const result = await capture(
      ["show", "task_does_not_exist", "--data-dir", dataDirectory, "--no-color"],
      source,
    );
    assert.equal(result.code, 2);
    assert.match(result.err, /No match/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
test("typed instructions keep their quoting when tokenised", () => {
  // A naive whitespace split corrupts instructions that contain quoted phrases.
  assert.deepEqual(tokenize('fix the "foo bar" parser'), ["fix", "the", "foo bar", "parser"]);
  assert.deepEqual(tokenize("fix the 'foo bar' parser"), ["fix", "the", "foo bar", "parser"]);
  assert.deepEqual(tokenize('add --paths "src/**, tests/**"'), ["add", "--paths", "src/**, tests/**"]);
  assert.deepEqual(tokenize("plain words here"), ["plain", "words", "here"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize('keep "" together'), ["keep", "", "together"], "an explicit empty quote survives");
});

test("a flag missing its value is a usage error the caller can catch", () => {
  // This threw out of the interactive submit path and killed the terminal.
  assert.throws(() => parseArgs(tokenize("--provider")), UsageError);
  assert.throws(() => parseArgs(tokenize("--provider --paths src")), UsageError);
  const parsed = parseArgs(tokenize("--paths src --provider groq"));
  assert.equal(flagString(parsed, "provider"), "groq");
});
