import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPrompt, MAX_REVIEW_DIFF, parseVerdict } from "../src/api/reviewer.js";
import { Orchestrator } from "../src/orchestrator.js";
import { JsonStore } from "../src/store.js";
import { createTestRepository } from "./helpers.js";
import { setProviderRegistryPath } from "../src/providers-registry.js";

// --- reading a verdict -------------------------------------------------------

test("a plain JSON verdict is read as written", () => {
  const parsed = parseVerdict('{"verdict":"approve","reasons":["looks right"]}');
  assert.equal(parsed.verdict, "approve");
  assert.deepEqual(parsed.reasons, ["looks right"]);
});

test("a verdict inside a code fence is still found", () => {
  const output = "Here is my review.\n\n```json\n{\"verdict\":\"request-changes\",\"reasons\":[\"swallows the error\"]}\n```";
  const parsed = parseVerdict(output);
  assert.equal(parsed.verdict, "request-changes");
  assert.deepEqual(parsed.reasons, ["swallows the error"]);
});

test("prose around the JSON does not stop it being found", () => {
  const output = 'I read the diff carefully. {"verdict":"approve","reasons":["ok"]} Hope that helps.';
  assert.equal(parseVerdict(output).verdict, "approve");
});

test("the last object in a long answer is the verdict", () => {
  const output = [
    'Example: {"verdict":"abstain","reasons":["nope"]}',
    "But for this diff specifically:",
    '{"verdict":"approve","reasons":["the real one"]}',
  ].join("\n");
  const parsed = parseVerdict(output);
  assert.equal(parsed.verdict, "approve");
  assert.deepEqual(parsed.reasons, ["the real one"]);
});

test("casing and spacing in the verdict are tolerated", () => {
  assert.equal(parseVerdict('{"verdict":"Request Changes","reasons":[]}').verdict, "request-changes");
  assert.equal(parseVerdict('{"verdict":"request_changes","reasons":[]}').verdict, "request-changes");
});

test("anything unrecognised abstains rather than approving", () => {
  // The failure that must never happen: a chatty or truncated reply being read
  // as permission to merge.
  for (const output of [
    "",
    "I think it looks pretty good to me!",
    "The diff changes three files.",
    '{"verdict":"looks great to me"}',
    '{"verdict":42}',
    "not json {oops",
    '{"verdict":"approve"', // truncated mid-object
    '["verdict","approve"]',
  ]) {
    assert.equal(parseVerdict(output).verdict, "abstain", JSON.stringify(output));
  }
});

test("reasons survive being a bare string, and are trimmed and capped", () => {
  assert.deepEqual(parseVerdict('{"verdict":"approve","reasons":"because"}').reasons, ["because"]);
  assert.deepEqual(parseVerdict('{"verdict":"approve"}').reasons, []);
  const many = parseVerdict(
    `{"verdict":"approve","reasons":[${Array.from({ length: 9 }, (_, i) => `"r${i}"`).join(",")}]}`,
  );
  assert.equal(many.reasons.length, 5, "a wall of reasons is not a summary");
  const long = parseVerdict(`{"verdict":"approve","reasons":["${"x".repeat(900)}"]}`);
  assert.ok(long.reasons[0]!.length <= 300);
});

test("a diff containing braces is not mistaken for a verdict", () => {
  const output = 'Here is the patch:\n```diff\n- if (x) { return 1; }\n+ if (x) { return 2; }\n```\nAll good.';
  assert.equal(parseVerdict(output).verdict, "abstain");
});

// --- the prompt sent to a reviewer ------------------------------------------

const sampleTask = {
  title: "add caching",
  description: "cache the user lookup",
  allowedPaths: ["src/user.ts"],
  acceptanceTests: ["npm test"],
};

test("the reviewer is told what was asked and what the scope was", () => {
  const prompt = buildReviewPrompt({ task: sampleTask, diff: "@@ -1 +1 @@\n+cache" });
  assert.match(prompt, /add caching/);
  assert.match(prompt, /cache the user lookup/);
  assert.match(prompt, /src\/user\.ts/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /\+cache/);
});

test("a missing scope and missing checks say so rather than looking empty", () => {
  const prompt = buildReviewPrompt({
    task: { ...sampleTask, allowedPaths: [], acceptanceTests: [] },
    diff: "",
  });
  assert.match(prompt, /not restricted/);
  assert.match(prompt, /none supplied/);
});

test("an enormous diff is truncated so the request still goes out", () => {
  const prompt = buildReviewPrompt({ task: sampleTask, diff: "y".repeat(MAX_REVIEW_DIFF + 5_000) });
  assert.ok(prompt.length < MAX_REVIEW_DIFF + 20_000, `prompt was ${prompt.length}`);
  assert.match(prompt, /diff truncated/);
});

// --- the review in the pipeline ---------------------------------------------

/** Answers every chat request with one verdict. */
const reviewerServer = async (
  verdict: string,
  reasons: string[] = ["reviewed"],
): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> => {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        for (const message of JSON.parse(body).messages ?? []) if (message.content) seen.push(message.content);
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ verdict, reasons }) } }],
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        // The chat client keeps connections alive, and close() waits for them.
        server.closeAllConnections();
        server.close(() => done());
      }),
    seen,
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A project, a store and a reviewer provider registered against the test endpoint. */
const withProject = async (
  run: (context: {
    orchestrator: Orchestrator;
    store: JsonStore;
    projectId: string;
    cleanup: () => Promise<void>;
  }) => Promise<void>,
  provider: { id: string; verdict: string },
): Promise<void> => {
  const source = await createTestRepository("agentswarm-review-");
  const stateDirectory = await mkdtemp(join(tmpdir(), "agentswarm-review-state-"));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  const stub = await reviewerServer(provider.verdict);
  const registryFile = join(stateDirectory, "providers.json");
  await writeFile(
    registryFile,
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: provider.id,
          label: provider.id,
          wire: "openai",
          baseUrl: stub.url,
          requiresKey: false,
        },
      ],
    }),
  );
  // The data directory is fixed when config loads, so the registry is pointed at
  // the test's providers file directly.
  setProviderRegistryPath(registryFile);
  let project;
  try {
    project = await orchestrator.createProject({ name: "Review project", repositoryPath: source });
    await run({
      orchestrator,
      store,
      projectId: project.id,
      cleanup: async () => {
        await stub.close();
      },
    });
  } finally {
    setProviderRegistryPath(undefined);
    // A listening socket keeps the event loop alive, so this has to happen even
    // when the test itself failed part way through.
    await stub.close();
    await orchestrator.shutdown();
    if (project) await rm(project.managedRepositoryPath, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
};

test("an approving reviewer approves and merges without a human", async () => {
  await withProject(
    async ({ orchestrator, store, projectId }) => {
      const task = await orchestrator.createTask(projectId, {
        title: "Create a change",
        description: "Make a safe change",
        provider: "mock",
        reviewer: "gate",
      });
      await waitFor(() => ["completed", "review", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      const change = store.listChanges(projectId)[0];
      assert.ok(change, "a change was recorded");
      assert.equal(change.review?.verdict, "approve");
      assert.equal(change.review?.autoApproved, true);
      assert.equal(change.review?.completed, true);
      assert.equal(change.status, "merged", "it went into the mirror by itself");
      assert.equal(store.getTask(task.id)?.status, "completed");
      // Still only in the mirror: publishing remains a human step.
      assert.ok(change.mergedSha);
    },
    { id: "gate", verdict: "approve" },
  );
});

test("an objecting reviewer leaves the change for a human", async () => {
  await withProject(
    async ({ orchestrator, store, projectId }) => {
      const task = await orchestrator.createTask(projectId, {
        title: "Create a change",
        description: "Make a safe change",
        provider: "mock",
        reviewer: "gate",
      });
      await waitFor(() => ["review", "completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      const change = store.listChanges(projectId)[0];
      assert.ok(change);
      assert.equal(change.review?.verdict, "request-changes");
      assert.equal(change.review?.autoApproved, undefined, "nothing was auto-approved");
      assert.equal(change.status, "pending", "it waits in the review queue");
      assert.equal(store.getTask(task.id)?.status, "review");
    },
    { id: "gate", verdict: "request-changes" },
  );
});

test("a reviewer that will not commit to a verdict never approves", async () => {
  await withProject(
    async ({ orchestrator, store, projectId }) => {
      const task = await orchestrator.createTask(projectId, {
        title: "Create a change",
        description: "Make a safe change",
        provider: "mock",
        reviewer: "gate",
      });
      await waitFor(() => ["review", "completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      const change = store.listChanges(projectId)[0];
      assert.ok(change);
      assert.equal(change.review?.verdict, "abstain");
      assert.equal(change.status, "pending");
    },
    { id: "gate", verdict: "abstain" },
  );
});

test("a reviewer never sees a change that failed verification", async () => {
  await withProject(
    async ({ orchestrator, store, projectId }) => {
      // The verification command fails, so there is nothing to review.
      const task = await orchestrator.createTask(projectId, {
        title: "Create a change",
        description: "Make a safe change",
        provider: "mock",
        reviewer: "gate",
        verifyCommand: "exit 3",
      });
      await waitFor(() => store.getTask(task.id)?.status === "failed");
      assert.match(store.getTask(task.id)?.error ?? "", /Verification command failed/);
      assert.deepEqual(store.listChanges(projectId), [], "no change was created, so none was reviewed");
    },
    { id: "gate", verdict: "approve" },
  );
});

test("a reviewer cannot be the agent that wrote the change", async () => {
  await withProject(
    async ({ orchestrator, store, projectId }) => {
      const task = await orchestrator.createTask(projectId, {
        title: "Create a change",
        description: "Make a safe change",
        provider: "mock",
        reviewer: "mock",
      });
      await waitFor(() => ["review", "completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      const change = store.listChanges(projectId)[0];
      assert.ok(change);
      assert.equal(change.review?.completed, false);
      assert.match(change.review?.error ?? "", /must differ/);
      assert.equal(change.status, "pending", "self-review never approves");
    },
    { id: "gate", verdict: "approve" },
  );
});