import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { covers, Orchestrator, scopesOverlap } from "../src/orchestrator.js";
import { JsonStore } from "../src/store.js";
import { getBareHead } from "../src/git.js";
import { config } from "../src/config.js";
import type { Task } from "../src/types.js";
import { createTestRepository } from "./helpers.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("mock agents run in isolated workspaces and changes can be merged", async () => {
  const source = await createTestRepository("agentswarm-orchestrator-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  let project;
  try {
    project = await orchestrator.createProject({ name: "Test project", repositoryPath: source });
    const initialSync = await orchestrator.syncProject(project.id);
    assert.equal(initialSync.status, "up_to_date");
    const task = await orchestrator.createTask(project.id, { title: "Create a change", description: "Make a safe change", provider: "mock" });
    await waitFor(() => ["review", "completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
    assert.equal(store.getTask(task.id)?.status, "review");
    const change = store.listChanges(project.id)[0];
    assert.ok(change);
    assert.match(change.diff, /agentswarm\/mock/);
    await orchestrator.approveChange(change.id);
    const merged = await orchestrator.mergeChange(change.id);
    assert.equal(merged.status, "merged");
    assert.equal(store.getTask(task.id)?.status, "completed");
    assert.notEqual(await getBareHead(project.managedRepositoryPath, project.defaultBranch), change.baseSha);
    const scoped = await orchestrator.createTask(project.id, { title: "Scoped change", description: "This should be rejected", provider: "mock", allowedPaths: ["src/"] });
    await waitFor(() => store.getTask(scoped.id)?.status === "failed");
    assert.match(store.getTask(scoped.id)?.error ?? "", /outside allowed paths/);
  } finally {
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("allowed path patterns match the globs users actually write", () => {
  // src/** used to reject every file, which made --paths 'src/**' fail the task.
  assert.equal(covers("src/**", "src/index.ts"), true);
  assert.equal(covers("src/**", "src/a/b/c.ts"), true);
  assert.equal(covers("src/**", "lib/index.ts"), false);
  assert.equal(covers("src/**", "src"), false);

  assert.equal(covers("src", "src/index.ts"), true, "a bare directory covers everything beneath it");
  assert.equal(covers("src", "src"), true);
  assert.equal(covers("src", "srcish/x.ts"), false);

  assert.equal(covers("docs/*", "docs/a.md"), true);
  assert.equal(covers("docs/*", "docs/nested/a.md"), false, "a single star stays in one segment");

  assert.equal(covers("*.ts", "a.ts"), true);
  assert.equal(covers("*.ts", "src/a.ts"), false);
  assert.equal(covers("src/?.ts", "src/a.ts"), true);

  assert.equal(covers("*", "anything/at/all.ts"), true, "a bare star is the whole repository");
  assert.equal(covers("**", "anything/at/all.ts"), true);

  assert.equal(covers("./src/**", "src/a.ts"), true, "a leading ./ is ignored");
});

test("scope enforcement accepts the scope it was given and rejects edits outside it", async () => {
  const source = await createTestRepository("agentswarm-scope-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-scope-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  let project;
  try {
    project = await orchestrator.createProject({ name: "Scope", repositoryPath: source });

    // The mock agent writes .agentswarm/mock/<task>.json, so scoping to that
    // directory exercises the recursive glob end to end.
    const inside = await orchestrator.createTask(project.id, {
      title: "scope matches",
      description: "write under the allowed directory",
      provider: "mock",
      allowedPaths: [".agentswarm/**"],
    });
    await waitFor(() => ["review", "completed", "failed"].includes(store.getTask(inside.id)?.status ?? ""));
    assert.equal(
      store.getTask(inside.id)?.status,
      "review",
      `a recursive glob should permit the file the agent wrote, got: ${store.getTask(inside.id)?.error ?? "no error"}`,
    );

    const outside = await orchestrator.createTask(project.id, {
      title: "scope does not match",
      description: "write outside the allowed directory",
      provider: "mock",
      allowedPaths: ["src/**"],
    });
    await waitFor(() => store.getTask(outside.id)?.status === "failed");
    assert.match(store.getTask(outside.id)?.error ?? "", /outside allowed paths/);
  } finally {
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("scope overlap is judged only when both sides declare a scope", () => {
  assert.equal(scopesOverlap(["src/**"], ["src/**"]), true, "identical scopes collide");
  assert.equal(scopesOverlap(["src/**"], ["src/util"]), true, "a parent and its child collide");
  assert.equal(scopesOverlap(["src"], ["src/nested"]), true);
  assert.equal(scopesOverlap(["left/**"], ["right/**"]), false, "disjoint trees are independent");
  assert.equal(scopesOverlap(["left/**"], ["leftish/**"]), false, "a prefix is not a path segment");
  assert.equal(scopesOverlap([], ["src/**"]), true, "an unscoped task may touch anything");
  assert.equal(scopesOverlap(["src/**"], []), true);
  assert.equal(scopesOverlap(["*"], ["docs/**"]), true, "a bare * covers the repository");
});

test("an explicit dependency graph survives, including tasks meant to run in parallel", async () => {
  const source = await createTestRepository("agentswarm-dag-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-dag-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  let project;
  try {
    project = await orchestrator.createProject({ name: "Dag", repositoryPath: source });
    const tasks = await orchestrator.createPlan(project.id, {
      goal: "coordinator output",
      tasks: [
        { title: "cache", description: "Add caching", allowedPaths: ["src/api/**"], dependsOn: [] },
        { title: "docs", description: "Document it", allowedPaths: ["docs/**"], dependsOn: [] },
        { title: "wire", description: "Export it", allowedPaths: ["src/index.ts"], dependsOn: [0] },
      ],
    });

    assert.equal(tasks.length, 3);
    // An empty list means "no dependencies", not "use the default chain".
    assert.deepEqual(tasks[0].dependencies, [], "the first task starts immediately");
    assert.deepEqual(tasks[1].dependencies, [], "docs must stay parallel with the cache work");
    assert.deepEqual(tasks[2].dependencies, [tasks[0].id], "wiring waits for the cache");
  } finally {
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a plan without explicit dependencies still chains by default", async () => {
  const source = await createTestRepository("agentswarm-chain-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-chain-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  let project;
  try {
    project = await orchestrator.createProject({ name: "Chain", repositoryPath: source });
    const tasks = await orchestrator.createPlan(project.id, {
      goal: "a three step scaffold",
      tasks: [
        { title: "one", description: "First" },
        { title: "two", description: "Second" },
        { title: "three", description: "Third" },
      ],
    });
    assert.deepEqual(tasks[0].dependencies, []);
    assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);
    assert.deepEqual(tasks[2].dependencies, [tasks[1].id]);
  } finally {
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("the concurrency cap bounds simultaneous agents and queued work still completes", async () => {
  const source = await createTestRepository("agentswarm-cap-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-cap-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  const previous = config.maxConcurrentRuns;
  config.maxConcurrentRuns = 2;
  let project;
  try {
    project = await orchestrator.createProject({ name: "Cap", repositoryPath: source });

    // Recorded but not dispatched, so the cap is the only thing limiting them.
    const tasks: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      // No allowedPaths: scope checking is exercised elsewhere, and the mock
      // agent only ever writes under .agentswarm/ so a scope here would fail it.
      const task = await orchestrator.createTask(
        project.id,
        { title: `job ${index}`, description: "quick work", provider: "mock" },
        { dispatch: false },
      );
      tasks.push(task.id);
    }

    await orchestrator.dispatchReadyTasks(project.id);
    // Let the first wave claim its slots.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const peak = orchestrator.runningCount();
    assert.ok(peak <= 2, `expected at most 2 concurrent agents, saw ${peak}`);

    await waitFor(
      () => tasks.every((id) => ["review", "completed", "failed"].includes(store.getTask(id)?.status ?? "")),
      30_000,
    );
    const failures = tasks
      .map((id) => store.getTask(id))
      .filter((task): task is Task => task?.status === "failed");
    assert.deepEqual(
      failures.map((task) => `${task.title}: ${task.error}`),
      [],
      "capping must defer work, never lose it",
    );
  } finally {
    config.maxConcurrentRuns = previous;
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
