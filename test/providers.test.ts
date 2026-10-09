import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { antigravityFailure, buildProviderArgs, getAdapter, hermesFailure, listProviders } from "../src/providers.js";
import { knownProviderIds } from "../src/providers.js";
import { config } from "../src/config.js";

const prompt = "PROMPT";

test("hermes receives the prompt directly after -z so argparse can bind it", () => {
  const argv = buildProviderArgs("hermes", ["-z"], prompt, undefined, { promptFirst: true, extraArgs: ["--accept-hooks"] });
  assert.equal(argv[0], "-z");
  assert.equal(argv[1], prompt, "the token after -z must be the prompt, not a flag");
  assert.deepEqual(argv, ["-z", prompt, "--accept-hooks"]);
});

test("hermes appends the model flag after the prompt", () => {
  const argv = buildProviderArgs("hermes", ["-z"], prompt, "tencent/hy3:free", { promptFirst: true, extraArgs: ["--accept-hooks"] });
  assert.deepEqual(argv, ["-z", prompt, "--accept-hooks", "--model", "tencent/hy3:free"]);
  const oneshotIndex = argv.indexOf("-z");
  assert.equal(argv[oneshotIndex + 1], prompt, "--model must never sit between -z and its prompt");
});

test("other providers keep flags ahead of the prompt", () => {
  assert.deepEqual(buildProviderArgs("codex", ["exec", "--json"], prompt), ["exec", "--json", prompt]);
  assert.deepEqual(buildProviderArgs("claude", ["-p"], prompt, "sonnet"), ["-p", "--model", "sonnet", prompt]);
  assert.deepEqual(buildProviderArgs("opencode", ["run"], prompt), ["run", prompt]);
});

test("the custom provider never receives a model flag", () => {
  assert.deepEqual(buildProviderArgs("custom", [], prompt, "some-model"), [prompt]);
});

test("every provider id has an adapter", () => {
  for (const id of knownProviderIds()) {
    assert.ok(getAdapter(id), `missing adapter for ${id}`);
  }
  assert.ok(knownProviderIds().includes("hermes"));
});

test("providers report availability by probing the command", async () => {
  const providers = await listProviders();
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.get("mock")?.available, true);
  assert.equal(byId.get("custom")?.available, false, "custom has no default command");
  assert.equal(byId.get("hermes")?.command, config.commands.hermes);
});

test("hermes failures are detected even though hermes exits 0", () => {
  const quota = "API call failed after 3 retries: HTTP 404: This model's free period has ended.";
  assert.equal(hermesFailure(quota), quota);
  const noCreds = "hermes -z: agent failed: No usable credentials found for provider 'kimi-coding'.";
  assert.equal(hermesFailure(noCreds), noCreds);
  const noProvider = "hermes -z: agent failed: No LLM provider configured.";
  assert.equal(hermesFailure(noProvider), noProvider);
});

test("normal agent output is not mistaken for a hermes failure", () => {
  assert.equal(hermesFailure("I updated NOTES.md and ran the tests."), undefined);
  assert.equal(hermesFailure("The API call failed after 3 retries: was fixed by adding a retry wrapper."), undefined);
  assert.equal(hermesFailure("I fixed a failing test in error handling."), undefined);
  assert.equal(hermesFailure(""), undefined);
});

// --- antigravity -------------------------------------------------------------

test("antigravity binds the prompt to -p before any other flag", () => {
  // `-p` takes the prompt as its value, so a flag in between would leave it
  // unbound and the CLI would treat the flag as the prompt.
  const argv = buildProviderArgs("antigravity", ["-p"], prompt, "gemini-3.8-flash-medium", {
    promptFirst: true,
    extraArgs: ["--output-format", "stream-json", "--dangerously-skip-permissions"],
  });
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], prompt);
  assert.equal(argv.indexOf("--model") > 1, true);
  assert.equal(argv.at(-1), "gemini-3.8-flash-medium");
});

test("antigravity is offered as an agent and wired to its command", () => {
  assert.ok(knownProviderIds().includes("antigravity"), "listed among the agents");
  assert.equal(config.commands.antigravity, "agy", "the client ships as agy");
});

test("antigravity is reported missing rather than installed when agy is absent", async () => {
  // The probe must not claim a CLI that is not on PATH.
  const providers = await listProviders();
  const agy = providers.find((provider) => provider.id === "antigravity");
  const onPath = await new Promise<boolean>((resolve) => {
    const probe = spawn("agy", ["--version"], { stdio: "ignore" });
    probe.once("error", () => resolve(false));
    probe.once("close", () => resolve(true));
  });
  assert.equal(agy?.available, onPath);
});

test("antigravity reports a terminal ERROR status as a failure", () => {
  // The exit code can still be 0 after a soft denial, so the stream status is
  // the only thing that distinguishes a real run from an empty one.
  const stream = [
    '{"event":"init","conversation_id":"c3","init":{"cwd":"/w","permission_mode":"request-review"}}',
    '{"event":"result","result":{"conversation_id":"c3","status":"ERROR","response":"","error":"invalid model selection (--model \\"nope\\"): not recognized"}}',
  ].join("\n");
  assert.match(String(antigravityFailure(stream)), /invalid model selection/);
  assert.match(String(antigravityFailure(stream)), /agy models/, "a bad model says how to list the real ones");
});

test("antigravity reads the plain json envelope too", () => {
  const envelope = '{"conversation_id":"c3","status":"ERROR","response":"","error":"model does-not-exist is not recognized"}';
  assert.match(String(antigravityFailure(envelope)), /does-not-exist/);
});

test("antigravity accepts a successful run, in either output shape", () => {
  assert.equal(
    antigravityFailure('{"event":"result","result":{"status":"SUCCESS","response":"done","num_turns":2}}'),
    undefined,
  );
  assert.equal(antigravityFailure('{"conversation_id":"c3","status":"SUCCESS","response":"done"}'), undefined);
});

test("antigravity surfaces an unauthenticated run", () => {
  assert.match(String(antigravityFailure("Error: authentication required")), /authentication required/);
});

test("antigravity names a non-success status even without an error message", () => {
  assert.match(String(antigravityFailure('{"event":"result","result":{"status":"WAITING"}}')), /waiting/);
});

test("antigravity output that merely mentions failure is not a failure", () => {
  // Agent prose and diffs share the stream; neither should fail a good run.
  assert.equal(antigravityFailure("I fixed the error handling and removed the ERROR branch."), undefined);
  assert.equal(antigravityFailure('{"event":"step_update","step_update":{"step_index":4,"tool_name":"run_command","text_delta":"ERROR: no tests found"}}'), undefined);
  assert.equal(antigravityFailure("{\\n  broken json\n}"), undefined, "an unparseable line is not an envelope");
  assert.equal(antigravityFailure(""), undefined);
  assert.equal(antigravityFailure('["status","ERROR"]'), undefined, "an array is not an envelope");
});
