import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderArgs, getAdapter, hermesFailure, listProviders } from "../src/providers.js";
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
