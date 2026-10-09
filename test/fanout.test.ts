import test from "node:test";
import assert from "node:assert/strict";
import {
  fanoutCaveats,
  fanoutTitle,
  parseProviderId,
  queueSummary,
  resolveProviders,
  submitInstruction,
  validateProviderValue,
  type InstructionInput,
  type Session,
} from "../src/cli/core.js";
import { UsageError } from "../src/cli/args.js";
import type { Task } from "../src/types.js";

/** Every installed agent answers the probe except the named ones. */
const probe =
  (...missing: string[]) =>
  async (id: string): Promise<boolean> =>
    !missing.includes(id);

test("naming no provider leaves the choice to the orchestrator", async () => {
  assert.deepEqual(await resolveProviders(undefined, probe()), []);
  assert.deepEqual(await resolveProviders("", probe()), []);
});

test("a single provider resolves to itself", async () => {
  assert.deepEqual(await resolveProviders("claude", probe()), ["claude"]);
  assert.deepEqual(await resolveProviders("mock", probe()), ["mock"]);
});

test("a comma list fans out to exactly those providers", async () => {
  assert.deepEqual(await resolveProviders("codex, claude", probe()), ["codex", "claude"]);
  // Order is the order asked for, so the board lists them predictably.
  assert.deepEqual(await resolveProviders("claude,codex", probe()), ["claude", "codex"]);
});

test("all means every installed agent, and only installed ones", async () => {
  const agents = await resolveProviders("all", probe("hermes"));
  assert.ok(agents.includes("codex"));
  assert.ok(agents.includes("antigravity"));
  assert.equal(agents.includes("hermes"), false, "an agent that is not installed is not offered");
});

test("all leaves out the mock and custom providers", async () => {
  // The mock does no work, so five copies of it would be five copies of nothing,
  // and `custom` is very often one of the others by another name.
  const agents = await resolveProviders("all", probe());
  assert.equal(agents.includes("mock"), false);
  assert.equal(agents.includes("custom"), false);
});

test("all skips the direct API providers, which are billed per token", async () => {
  const agents = await resolveProviders("all", probe());
  for (const agent of agents) {
    assert.equal(["openai", "anthropic", "gemini", "groq"].includes(agent), false, agent);
  }
});

test("all with nothing installed says what to do about it", async () => {
  const nothing = async (): Promise<boolean> => false;
  await assert.rejects(resolveProviders("all", nothing), (error: Error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /No agent CLI is installed/);
    assert.match(error.message, /codex, claude/, "it lists what could be installed");
    return true;
  });
});

test("an unknown provider is refused by name", async () => {
  await assert.rejects(resolveProviders("bogus", probe()), /Unknown provider "bogus"/);
  await assert.rejects(resolveProviders("codex,bogus", probe()), /Unknown provider "bogus"/);
});

test("up-front validation checks names without probing", () => {
  validateProviderValue("all");
  validateProviderValue("codex,claude");
  validateProviderValue(undefined);
  assert.throws(() => validateProviderValue("bogus"), UsageError);
  assert.throws(() => validateProviderValue(" , "), /names no provider/);
});

test("a plan cannot fan out, and says why", () => {
  // A plan already splits the goal into several tasks; fanning each of those out
  // again would multiply the work rather than parallelise it.
  assert.throws(() => parseProviderId("all"), /not to .*openteam plan/s);
  assert.throws(() => parseProviderId("codex,claude"), /not to .*openteam plan/s);
  assert.equal(parseProviderId("claude"), "claude");
  assert.equal(parseProviderId(undefined), undefined);
});

test("copies are labelled so the board can tell them apart", () => {
  assert.equal(fanoutTitle("add caching", "claude", 1), "add caching", "one task needs no suffix");
  assert.equal(fanoutTitle("add caching", "claude", 3), "add caching (claude)");
});

test("a labelled title still fits the board", () => {
  const long = "x".repeat(200);
  const titled = fanoutTitle(long, "antigravity", 5);
  assert.ok(titled.length <= 72, `${titled.length} characters`);
  assert.match(titled, /\(antigravity\)$/);
});

test("the queue says how many and who", () => {
  const task = (id: string, provider: string): Task =>
    ({ id, provider, title: "t" }) as unknown as Task;
  assert.equal(queueSummary([task("task_1", "claude")]), "queued task_1");
  assert.equal(
    queueSummary([task("task_1", "claude"), task("task_2", "codex")]),
    "queued 2 tasks across claude, codex",
  );
});

// --- the fan-out itself ------------------------------------------------------

const fakeSession = (): { session: Session; created: InstructionInput[] } => {
  const created: InstructionInput[] = [];
  let counter = 0;
  const session = {
    json: true,
    err: { write: () => true } as unknown as NodeJS.WriteStream,
    orchestrator: {
      createTask: async (_projectId: string, input: InstructionInput) => {
        counter += 1;
        created.push(input);
        return {
          id: `task_${counter}`,
          title: input.title,
          provider: input.provider ?? "mock",
          dependencies: input.dependencies ?? [],
          allowedPaths: input.allowedPaths,
        } as unknown as Task;
      },
    },
  } as unknown as Session;
  return { session, created };
};

const baseInput = (over: Partial<InstructionInput> = {}): InstructionInput => ({
  title: "add caching",
  description: "add caching",
  allowedPaths: [],
  ...over,
});

test("one instruction without a provider still makes exactly one task", async () => {
  const { session, created } = fakeSession();
  const tasks = await submitInstruction(session, "p", baseInput(), probe());
  assert.equal(tasks.length, 1);
  assert.equal(created[0]?.provider, undefined, "left to the orchestrator, as before");
});

test("a fan-out makes one task per provider, each titled with its agent", async () => {
  const { session, created } = fakeSession();
  const tasks = await submitInstruction(session, "p", baseInput({ provider: "codex,claude" }), probe());
  assert.deepEqual(tasks.map((task) => task.provider), ["codex", "claude"]);
  assert.deepEqual(created.map((input) => input.title), ["add caching (codex)", "add caching (claude)"]);
});

test("the copies are dispatched together, so the cap is what limits them", async () => {
  const { session } = fakeSession();
  const tasks = await submitInstruction(session, "p", baseInput({ provider: "all" }), probe());
  assert.ok(tasks.length >= 4, `expected several agents, got ${tasks.length}`);
});

test("only the first copy inherits dependencies", async () => {
  // Six copies all waiting on the same change would serialise the whole fan-out
  // behind one gate, which is the opposite of the point.
  const { session, created } = fakeSession();
  await submitInstruction(session, "p", baseInput({ provider: "codex,claude", dependencies: ["task_gate"] }), probe());
  assert.deepEqual(created[0]?.dependencies, ["task_gate"]);
  assert.deepEqual(created[1]?.dependencies, []);
});

test("the caveats explain the two things a fan-out cannot do", () => {
  const task = (id: string): Task => ({ id, provider: "claude" }) as unknown as Task;
  assert.deepEqual(fanoutCaveats([task("a")], baseInput({ allowedPaths: ["src"] })), []);

  const warnings = fanoutCaveats([task("a"), task("b")], baseInput({ allowedPaths: ["src"] }));
  assert.match(warnings.join(" "), /one at a time/, "overlapping scopes serialise");
  assert.match(warnings.join(" "), /merge the one you want/);

  const free = fanoutCaveats([task("a"), task("b")], baseInput());
  assert.equal(free.some((warning) => /one at a time/.test(warning)), false, "without --paths they run in parallel");
  assert.match(free.join(" "), /merge the one you want/);
});
test("a reviewer cannot be asked to review the agent's own work", async () => {
  // Caught before anything is queued, rather than after a wasted agent run.
  const { session, created } = fakeSession();
  await assert.rejects(
    submitInstruction(session, "p", baseInput({ provider: "claude", reviewer: "claude" }), probe()),
    /same as/,
  );
  assert.equal(created.length, 0, "nothing was queued");
});

test("a reviewer is fine when it differs from the agent", async () => {
  const { session, created } = fakeSession();
  await submitInstruction(session, "p", baseInput({ provider: "claude", reviewer: "gemini" }), probe());
  assert.equal(created[0]?.reviewer, "gemini");
});

test("with a fan-out, only the copy the reviewer wrote is a problem", async () => {
  // Every other copy is still reviewed; the clash is confined to one task.
  const { session, created } = fakeSession();
  const tasks = await submitInstruction(
    session,
    "p",
    baseInput({ provider: "codex,claude,opencode", reviewer: "claude" }),
    probe(),
  );
  assert.equal(tasks.length, 3);
  assert.equal(created.filter((input) => input.reviewer === "claude").length, 3);
});
