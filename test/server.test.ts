import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/server.js";
import { JsonStore } from "../src/store.js";
import { config } from "../src/config.js";
import { createTestRepository } from "./helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listen = async (token = "") => {
  const previousToken = config.sharedToken;
  const previousRequired = config.sharedTokenRequired;
  config.sharedToken = token;
  config.sharedTokenRequired = token.length > 0;
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-server-"));
  const app = createAppServer(new JsonStore(join(stateDirectory, "state.json")));
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.orchestrator.shutdown();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await app.store.flush();
      await rm(stateDirectory, { recursive: true, force: true }).catch(() => undefined);
      config.sharedToken = previousToken;
      config.sharedTokenRequired = previousRequired;
    },
  };
};

test("health stays open while api routes require the shared token", async () => {
  const server = await listen("s3cret-token");
  try {
    const health = await fetch(`${server.base}/api/health`);
    assert.equal(health.status, 200);

    const anonymous = await fetch(`${server.base}/api/projects`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${server.base}/api/projects`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    const wrongLength = await fetch(`${server.base}/api/projects`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(wrongLength.status, 401, "a token prefix must not authenticate");

    const authorized = await fetch(`${server.base}/api/projects`, { headers: { authorization: "Bearer s3cret-token" } });
    assert.equal(authorized.status, 200);
    assert.deepEqual((await authorized.json()).projects, []);

    const headerForm = await fetch(`${server.base}/api/projects`, { headers: { "x-agentswarm-token": "s3cret-token" } });
    assert.equal(headerForm.status, 200);
  } finally {
    await server.close();
  }
});

test("routes stay open when no shared token is configured", async () => {
  const server = await listen("");
  try {
    const response = await fetch(`${server.base}/api/projects`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("static assets are served without a token so the ui can prompt for one", async () => {
  const server = await listen("s3cret-token");
  try {
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await server.close();
  }
});

test("assignee input is validated, trimmed, and can be assigned after creation", async () => {
  const server = await listen();
  const repository = await createTestRepository("agentswarm-inputs-repo-");
  try {
    const created = await fetch(`${server.base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Input test", repositoryPath: repository }),
    });
    assert.equal(created.status, 201);
    const { project } = (await created.json()) as { project: { id: string } };

    const withAssignee = await fetch(`${server.base}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Assigned work", description: "Do the thing", assignee: "  alice  " }),
    });
    assert.equal(withAssignee.status, 201);
    const task = ((await withAssignee.json()) as { task: { id: string; assignee?: string } }).task;
    assert.equal(task.assignee, "alice");

    const blank = await fetch(`${server.base}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Unassigned work", description: "Do the thing", assignee: "   " }),
    });
    assert.equal(blank.status, 201);
    const blankTask = ((await blank.json()) as { task: { assignee?: string } }).task;
    assert.equal(blankTask.assignee, undefined);

    const wrongType = await fetch(`${server.base}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad assignee", description: "Do the thing", assignee: 42 }),
    });
    assert.equal(wrongType.status, 400);

    const assigned = await fetch(`${server.base}/api/tasks/${task.id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "bob" }),
    });
    assert.equal(assigned.status, 200);
    assert.equal(((await assigned.json()) as { task: { assignee?: string } }).task.assignee, "bob");

    const cleared = await fetch(`${server.base}/api/tasks/${task.id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { task: { assignee?: string } }).task.assignee, undefined);
  } finally {
    await rm(repository, { recursive: true, force: true });
    await server.close();
  }
});
