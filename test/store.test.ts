import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/store.js";
import { waitForTasks } from "../src/cli/events.js";
import type { Project, Task } from "../src/types.js";

const project = (id: string): Project => ({
  id,
  name: id,
  repositoryPath: "/tmp/repo",
  managedRepositoryPath: "/tmp/repo.git",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const task = (id: string, projectId: string): Task => ({
  id,
  projectId,
  title: id,
  description: id,
  status: "queued",
  provider: "mock",
  dependencies: [],
  allowedPaths: [],
  acceptanceTests: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test("JsonStore persists projects, tasks, and events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-store-"));
  const filePath = join(directory, "state.json");
  const store = new JsonStore(filePath);
  const updates: string[] = [];
  const unsubscribe = store.subscribe((event) => updates.push(event.type));
  await store.createProject(project("p1"));
  await store.createTask(task("t1", "p1"));
  await store.appendEvent({ projectId: "p1", taskId: "t1", type: "task.created", message: "created" });
  unsubscribe();
  await store.flush();

  const reloaded = new JsonStore(filePath);
  assert.equal(reloaded.getProject("p1")?.name, "p1");
  assert.equal(reloaded.getTask("t1")?.title, "t1");
  assert.equal(reloaded.listEvents("p1").length, 1);
  assert.deepEqual(updates, ["task.created"]);
  await rm(directory, { recursive: true, force: true });
});

// --- following a task -------------------------------------------------------

test("following finishes on a status change that emits no event", async () => {
  // A store update does not notify subscribers; only orchestrator events do. If the
  // waiter relied on an event arriving afterwards, a task that settled silently
  // would be followed forever, and the process would never exit.
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-follow-"));
  const store = new JsonStore(join(directory, "state.json"));
  try {
    const projectId = "proj";
    await store.createProject(project(projectId));
    const created = await store.createTask({ ...task("task_1", projectId), status: "running" });

    const settled = waitForTasks(store, [created.id]);
    await store.updateTask(created.id, { status: "review" });

    const result = await Promise.race([
      settled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "the wait finished without waiting for an event");
    assert.equal(result!.get(created.id)?.status, "review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("following several tasks finishes when they settle at different times", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-follow-many-"));
  const store = new JsonStore(join(directory, "state.json"));
  try {
    const projectId = "proj";
    await store.createProject(project(projectId));
    const first = await store.createTask({ ...task("task_1", projectId), status: "running" });
    const second = await store.createTask({ ...task("task_2", projectId), status: "running" });

    const settled = waitForTasks(store, [first.id, second.id]);
    await store.updateTask(first.id, { status: "review" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await store.updateTask(second.id, { status: "failed" });

    const result = await Promise.race([
      settled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "both tasks were followed to the end");
    assert.equal(result!.size, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an abort stops the wait and hands back what it has", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-follow-abort-"));
  const store = new JsonStore(join(directory, "state.json"));
  try {
    const projectId = "proj";
    await store.createProject(project(projectId));
    const created = await store.createTask({ ...task("task_1", projectId), status: "running" });
    const controller = new AbortController();
    const settled = waitForTasks(store, [created.id], { signal: controller.signal });
    controller.abort();
    const result = await Promise.race([
      settled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
    assert.ok(result, "aborting does not leave the caller waiting");
    assert.equal(result!.size, 0, "an unfinished task is reported as unfinished");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
