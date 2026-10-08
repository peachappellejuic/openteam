import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_PROVIDERS,
  isLoopbackUrl,
  mergeProviders,
  ProviderDefinitionError,
  validateUserProvider,
} from "../src/api/registry.js";
import { ProviderRegistry } from "../src/providers-registry.js";
import { SecretStore } from "../src/secrets.js";

const file = async (prefix: string): Promise<{ path: string; release: () => Promise<void> }> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { path: join(directory, "providers.json"), release: () => rm(directory, { recursive: true, force: true }) };
};

test("a definition is validated before it can be stored", () => {
  const ok = validateUserProvider({ id: "my-vllm", wire: "openai", baseUrl: "http://127.0.0.1:8000", envName: "VLLM_API_KEY" });
  assert.equal(ok.id, "my-vllm");
  assert.equal(ok.requiresKey, true);

  assert.throws(() => validateUserProvider({ id: "", wire: "openai", baseUrl: "http://x" }), ProviderDefinitionError);
  assert.throws(() => validateUserProvider({ id: "a b;rm -rf /", wire: "openai", baseUrl: "http://x" }), /id must be/);
  assert.throws(() => validateUserProvider({ id: "claude", wire: "openai", baseUrl: "http://x" }), /agent CLI/);
  assert.throws(() => validateUserProvider({ id: "ok", wire: "smtp", baseUrl: "http://x" }), /wire must be/);
  assert.throws(() => validateUserProvider({ id: "ok", wire: "openai", baseUrl: "ftp://x" }), /http/);
  assert.throws(() => validateUserProvider({ id: "ok", wire: "openai", baseUrl: "http://x", envName: "lower case" }), /envName/);
  assert.throws(() => validateUserProvider({ id: "ok", wire: "openai", baseUrl: "http://x" }), /envName/, "a new provider must say where its key is");
  assert.doesNotThrow(
    () => validateUserProvider({ id: "openai", wire: "openai", baseUrl: "http://x" }),
    "overriding a built-in inherits its key variable",
  );
  assert.doesNotThrow(
    () => validateUserProvider({ id: "local", wire: "openai", baseUrl: "http://127.0.0.1:1", requiresKey: false }),
    "a keyless server is allowed",
  );
});

test("an unnamed field is left unset so an override does not reset it", () => {
  const only = validateUserProvider({ id: "openai", wire: "openai", baseUrl: "http://127.0.0.1:8000" });
  assert.equal(only.defaultModel, undefined);
  assert.equal(only.freeTier, undefined);
  assert.equal(only.label, undefined);

  const merged = mergeProviders([only]).find((entry) => entry.id === "openai");
  assert.equal(merged?.baseUrl, "http://127.0.0.1:8000", "the endpoint is overridden");
  assert.equal(merged?.defaultModel, "gpt-4o-mini", "the built-in model survives");
  assert.equal(merged?.envNames[0], "OPENAI_API_KEY", "the built-in key variable survives");
});

test("merging adds new ids and never loses a built-in", () => {
  const merged = mergeProviders([
    { id: "my-vllm", wire: "openai", baseUrl: "http://127.0.0.1:8000", envName: "VLLM_API_KEY", defaultModel: "qwen" },
  ]);
  assert.equal(merged.length, API_PROVIDERS.length + 1);
  assert.ok(merged.some((entry) => entry.id === "my-vllm"));
  for (const entry of API_PROVIDERS) {
    assert.ok(merged.some((candidate) => candidate.id === entry.id), `${entry.id} survives`);
  }
  const keyless = mergeProviders([{ id: "l", wire: "openai", baseUrl: "http://127.0.0.1:1", requiresKey: false }])
    .find((entry) => entry.id === "l");
  assert.equal(keyless?.requiresKey, false);
  assert.deepEqual(keyless?.envNames, [], "a keyless provider carries no key variable");
});

test("loopback endpoints are recognised so egress can be warned about", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8000"), true);
  assert.equal(isLoopbackUrl("http://localhost:11434"), true);
  assert.equal(isLoopbackUrl("https://api.openai.com/v1"), false);
  assert.equal(isLoopbackUrl("nonsense"), false);
});

test("providers round trip through the file", async () => {
  const { path, release } = await file("agentswarm-provfile-");
  try {
    const registry = new ProviderRegistry(path);
    assert.equal(registry.get("my-vllm"), undefined);

    registry.add({ id: "my-vllm", wire: "openai", baseUrl: "http://127.0.0.1:8000", envName: "VLLM_API_KEY" });
    assert.equal(registry.get("my-vllm")?.baseUrl, "http://127.0.0.1:8000");
    assert.equal(registry.isUserDefined("my-vllm"), true);
    assert.equal(registry.isUserDefined("openai"), false);

    // A fresh instance must see it, and adding twice replaces rather than duplicates.
    const reopened = new ProviderRegistry(path);
    assert.equal(reopened.get("my-vllm")?.envNames[0], "VLLM_API_KEY");
    reopened.add({ id: "my-vllm", wire: "openai", baseUrl: "http://127.0.0.1:9000", envName: "VLLM_API_KEY" });
    assert.equal(new ProviderRegistry(path).definitions().filter((entry) => entry.id === "my-vllm").length, 1);
    assert.equal(new ProviderRegistry(path).get("my-vllm")?.baseUrl, "http://127.0.0.1:9000");

    assert.equal(reopened.remove("my-vllm")?.id, "my-vllm");
    assert.equal(reopened.remove("my-vllm"), undefined);
    assert.equal(new ProviderRegistry(path).get("my-vllm"), undefined);
  } finally {
    await release();
  }
});

test("a corrupt registry hides only the bad entries", async () => {
  const { path, release } = await file("agentswarm-provcorrupt-");
  try {
    await writeFile(path, "{ not json", "utf8");
    assert.deepEqual(new ProviderRegistry(path).definitions(), []);
    assert.equal(new ProviderRegistry(path).entries().length, API_PROVIDERS.length, "built-ins still work");

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        providers: [{ id: "good", wire: "openai", baseUrl: "http://127.0.0.1:1", requiresKey: false }, { id: "bad" }],
      }),
      "utf8",
    );
    const registry = new ProviderRegistry(path);
    assert.deepEqual(registry.definitions().map((entry) => entry.id), ["good"], "one bad entry does not hide the rest");
  } finally {
    await release();
  }
});

test("a key for an added provider resolves like any other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-provkey-"));
  try {
    const store = SecretStore.open(join(directory, "keys.json"));
    const registry = new ProviderRegistry(join(directory, "providers.json"));
    const entry = registry.add({ id: "my-vllm", wire: "openai", baseUrl: "http://127.0.0.1:8000", envName: "VLLM_API_KEY" });
    const merged = registry.get(entry.id);

    assert.equal(store.getAny(merged!.envNames), undefined, "no key yet");
    store.set(merged!.envNames[0], "vllm-secret-value");
    assert.equal(store.getAny(merged!.envNames)?.value, "vllm-secret-value");
    assert.equal(store.status(merged!.envNames[0]).source, "file");
    // It is handed to agents like every other stored key.
    assert.equal(store.environment().VLLM_API_KEY, "vllm-secret-value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
