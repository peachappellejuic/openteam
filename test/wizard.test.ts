import test from "node:test";
import assert from "node:assert/strict";
import {
  ADD_FIELD_ORDER,
  ADD_PROVIDER,
  applyField,
  emptyDraft,
  isComplete,
  nextField,
  NO_KEY_WORDS,
  providerMenuOptions,
  suggestEnvName,
  validateField,
  wizardTitle,
  type ProviderSummary,
} from "../src/tui/wizard.js";
import { exactCommand, filterCommands } from "../src/tui/commands.js";

const provider = (over: Partial<ProviderSummary> = {}): ProviderSummary => ({
  id: "x",
  needsKey: false,
  authenticated: true,
  usable: true,
  kind: "agent cli",
  label: "x",
  ...over,
});

test("the menu lists every provider, with the usable ones first", () => {
  const rows = providerMenuOptions([
    provider({ id: "openai", needsKey: true, authenticated: false, usable: false, kind: "direct api" }),
    provider({ id: "claude", kind: "agent cli" }),
    provider({ id: "ollama", kind: "local" }),
  ]);
  // Hiding the unusable ones would leave the user unable to discover them.
  assert.deepEqual(
    rows.map((row) => row.value),
    ["claude", "ollama", "openai", ADD_PROVIDER],
  );
  const openai = rows.find((row) => row.value === "openai");
  assert.equal(openai?.usable, false);
  assert.match(String(openai?.usage), /needs a key/);
});

test("the menu marks a provider whose key is already stored", () => {
  const rows = providerMenuOptions([provider({ id: "groq", needsKey: true, authenticated: true, kind: "direct api" })]);
  assert.match(String(rows[0]?.usage), /key stored/);
});

test("adding a provider is always reachable from the menu", () => {
  const rows = providerMenuOptions([provider()]);
  assert.equal(rows[rows.length - 1]?.value, ADD_PROVIDER);
});

test("an id must be usable as a provider name, and must be new", () => {
  const context = { draft: emptyDraft(), existingIds: ["claude"] };
  assert.equal(validateField("id", "my-vllm", context).ok, true);
  assert.equal(validateField("id", "My VLLM", context).ok, false, "uppercase and spaces are rejected");
  assert.equal(validateField("id", "has space", context).ok, false);
  assert.equal(validateField("id", "claude", context).ok, false, "an existing id is refused");
  assert.match(validateField("id", "claude", context).message, /already exists/);
});

test("a base url must actually be one, so a typo fails now rather than at first use", () => {
  const context = { draft: emptyDraft(), existingIds: [] };
  assert.equal(validateField("url", "http://127.0.0.1:8000", context).ok, true);
  assert.equal(validateField("url", "https://api.example.com/v1", context).ok, true);
  assert.equal(validateField("url", "127.0.0.1:8000", context).ok, false);
  assert.equal(validateField("url", "localhost", context).ok, false);
});

test("the key variable must look like an environment variable", () => {
  const context = { draft: emptyDraft(), existingIds: [] };
  assert.equal(validateField("envName", "MY_VLLM_API_KEY", context).ok, true);
  assert.equal(validateField("envName", "lower", context).ok, false);
  assert.equal(validateField("envName", "1BAD", context).ok, false);
});

test("a local server can be declared to need no key at all", () => {
  const draft = { ...emptyDraft(), requiresKey: false };
  const result = validateField("envName", "", { draft, existingIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(NO_KEY_WORDS.includes("skip"), true);
});

test("the model is optional and the key variable is inferred from the id", () => {
  assert.equal(suggestEnvName("my-vllm"), "MY_VLLM_API_KEY");
  assert.equal(validateField("model", "", { draft: emptyDraft(), existingIds: [] }).ok, true);
});

test("the form asks id, wire, url, key variable, then model", () => {
  assert.deepEqual(ADD_FIELD_ORDER, ["id", "wire", "url", "envName", "model"]);
});

test("nextField walks the form and skips the key variable when none is needed", () => {
  const draft = emptyDraft();
  assert.equal(nextField(draft, "id"), "wire");
  assert.equal(nextField({ ...draft, wire: "openai" }, "wire"), "url");
  assert.equal(nextField(draft, "url"), "envName");
  assert.equal(nextField({ ...draft, requiresKey: false }, "url"), "model");
  assert.equal(nextField(draft, "model"), undefined, "the form ends after the model");
});

test("applyField records a value and suggests the key variable from the id", () => {
  const withId = applyField(emptyDraft(), "id", "my-vllm");
  assert.equal(withId.id, "my-vllm");
  assert.equal(withId.envName, "MY_VLLM_API_KEY");
  assert.equal(applyField(withId, "url", "http://127.0.0.1:8000").baseUrl, "http://127.0.0.1:8000");
  assert.equal(applyField(withId, "wire", "anthropic").wire, "anthropic");
});

test("a draft counts as complete only once it can actually be used", () => {
  let draft = emptyDraft();
  assert.equal(isComplete(draft), false);
  draft = applyField(applyField(draft, "id", "my-vllm"), "url", "http://127.0.0.1:8000");
  assert.equal(isComplete(draft), true, "the key variable was inferred");
  assert.equal(isComplete({ ...draft, requiresKey: false, envName: undefined }), true);
  assert.equal(isComplete({ ...draft, envName: undefined }), false, "a key is required but unset");
});

test("each wizard step says where it is, so the flow is never ambiguous", () => {
  assert.equal(wizardTitle({ kind: "providerMenu" }), "providers");
  assert.equal(
    wizardTitle({ kind: "credential", envName: "X_API_KEY", label: "x", value: "", message: "" }),
    "credential",
  );
  assert.equal(
    wizardTitle({ kind: "addText", field: "url", draft: emptyDraft(), value: "", message: "" }),
    "add provider \u2014 base url",
  );
});

// --- typing a command name outright -----------------------------------------

test("a typed command name runs on one Enter instead of completing to itself", () => {
  // The complaint this covers: `/provider` + Enter used to insert a trailing
  // space and wait for a second Enter, or append the name onto itself.
  assert.equal(exactCommand("/provider"), "provider");
  assert.equal(exactCommand("/provider "), "provider");
  assert.equal(exactCommand("/provider extra"), undefined, "a command with arguments is not a bare match");
  assert.equal(exactCommand("fix the flaky test"), undefined);
  assert.equal(exactCommand("/nope"), undefined);
});

test("an exact name is offered ahead of longer names sharing it", () => {
  const matches = filterCommands("provider").map((command) => command.name);
  // `/providers` is a different command; typing `/provider` must not offer it first.
  assert.equal(matches[0], "provider");
});

// --- a local server needs no key --------------------------------------------

test("a loopback url is recognised so the form can skip the key variable", async () => {
  const { isLoopbackUrl } = await import("../src/api/registry.js");
  assert.equal(isLoopbackUrl("http://127.0.0.1:8000"), true);
  assert.equal(isLoopbackUrl("http://localhost:9000/v1"), true);
  assert.equal(isLoopbackUrl("https://api.example.com/v1"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

test("nextField skips the key variable once a draft needs no key", () => {
  // The wizard sets this when the url is loopback; a local vllm or ollama should
  // not be asked for a credential it will never send.
  const local = { ...emptyDraft(), requiresKey: false };
  assert.equal(nextField(local, "url"), "model");
  assert.equal(isComplete({ ...local, id: "vllm", baseUrl: "http://127.0.0.1:8000" }), true);
});
