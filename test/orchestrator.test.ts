import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.js";
import { JsonStore } from "../src/store.js";
import { getBareHead } from "../src/git.js";
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
