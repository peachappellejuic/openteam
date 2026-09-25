import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/store.js";
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
