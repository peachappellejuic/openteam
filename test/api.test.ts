import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { redact, SecretStore } from "../src/secrets.js";
import { API_PROVIDERS, apiProvider, resolveBaseUrl } from "../src/api/registry.js";
import { ApiError, ChatClient } from "../src/api/client.js";
import { resolveInside, runTool, ToolError } from "../src/api/tools.js";
import { runAgent } from "../src/api/agent.js";
import { normalisePlan, planWithModel } from "../src/api/planner.js";
import { JsonStore } from "../src/store.js";
import { createTestRepository, removeTestPath } from "./helpers.js";
import type { ChatResponse, ToolCall } from "../src/api/client.js";

const cliEntry = (): string => fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxCli = (): string => fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

// --- secrets ----------------------------------------------------------------

test("the environment wins over the stored file and values are redacted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-secrets-"));
  const store = SecretStore.open(join(directory, "keys.json"));
  try {
    store.set("GROQ_API_KEY", "gsk_file_value_0000");

    assert.equal(store.get("GROQ_API_KEY"), "gsk_file_value_0000");
    assert.equal(store.get("GROQ_API_KEY", { GROQ_API_KEY: "gsk_env_value_1111" }), "gsk_env_value_1111");
    assert.equal(store.status("GROQ_API_KEY", { GROQ_API_KEY: "gsk_env_value_1111" }).source, "env");
    assert.equal(store.status("GROQ_API_KEY").source, "file");

    assert.equal(store.get("MISSING_KEY"), undefined);
    assert.equal(store.status("MISSING_KEY").source, "missing");
    assert.throws(() => store.set("BLANK", "   "), /empty/);

    assert.ok(store.has("GROQ_API_KEY"));
    assert.equal(store.unset("GROQ_API_KEY"), true);
    assert.equal(store.unset("GROQ_API_KEY"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stored key is only ever readable in redacted form and stays unreadable to others", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-secrets-mode-"));
  const path = join(directory, "keys.json");
  const store = SecretStore.open(path);
  try {
    store.set("OPENAI_API_KEY", "sk-proj-abcdefghijklmnop");
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode.toString(8), "600", "credentials must not be group or world readable");

    const onDisk = await readFile(path, "utf8");
    assert.match(onDisk, /sk-proj-abcdefghijklmnop/, "the file does hold the real value");

    assert.equal(redact("sk-proj-abcdefghijklmnop"), "sk-…mnop");
    assert.equal(redact("short"), "set (5 chars)");

    // Reopening sees the value, but no listing or status exposes it in full.
    const reopened = SecretStore.open(path);
    assert.equal(reopened.get("OPENAI_API_KEY"), "sk-proj-abcdefghijklmnop");
    assert.equal(reopened.status("OPENAI_API_KEY").hint, "sk-…mnop");
    assert.deepEqual(reopened.names, ["OPENAI_API_KEY"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt credentials file is ignored rather than fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-secrets-corrupt-"));
  const path = join(directory, "keys.json");
  try {
    await writeFile(path, "{not json", "utf8");
    const store = SecretStore.open(path);
    assert.equal(store.get("ANY"), undefined);
    store.set("ANY", "recovered");
    assert.equal(SecretStore.open(path).get("ANY"), "recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- registry ---------------------------------------------------------------

test("every provider declares a key, an endpoint, and a default model", () => {
  assert.ok(API_PROVIDERS.length >= 8);
  for (const entry of API_PROVIDERS) {
    assert.ok(entry.id && entry.label, `${entry.id} needs an id and label`);
    assert.ok(entry.defaultModel, `${entry.id} needs a default model`);
    assert.ok(entry.freeTier, `${entry.id} should document its free tier`);
    assert.ok(entry.baseUrl.startsWith("http"), `${entry.id} needs an absolute base url`);
    assert.ok(entry.baseUrlEnv, `${entry.id} needs an override variable`);
    assert.ok(["openai", "anthropic", "gemini"].includes(entry.wire));
    if (entry.requiresKey) assert.ok(entry.envNames.length > 0, `${entry.id} needs an env var`);
  }
  assert.equal(apiProvider("groq")?.requiresKey, true);
  assert.equal(apiProvider("ollama")?.requiresKey, false);
  assert.equal(apiProvider("nope"), undefined);
});

test("a base url override wins and always ends up versioned for OpenAI-shaped APIs", () => {
  const openai = apiProvider("openai")!;
  assert.equal(resolveBaseUrl(openai, {}), "https://api.openai.com/v1");
  assert.equal(resolveBaseUrl(openai, { OPENAI_BASE_URL: "http://127.0.0.1:1234/" }), "http://127.0.0.1:1234/v1");
  assert.equal(resolveBaseUrl(openai, { OPENAI_BASE_URL: "http://127.0.0.1:1234/v1" }), "http://127.0.0.1:1234/v1");
  assert.equal(
    resolveBaseUrl(apiProvider("deepseek")!, { DEEPSEEK_BASE_URL: "https://proxy.internal" }),
    "https://proxy.internal/v1",
  );
});

test("the first non-empty environment alias wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-secrets-alias-"));
  try {
    const store = SecretStore.open(join(directory, "keys.json"));
    const gemini = apiProvider("gemini")!;
    assert.deepEqual(store.getAny(gemini.envNames, { GOOGLE_API_KEY: "second" }), {
      name: "GOOGLE_API_KEY",
      value: "second",
    });
    assert.deepEqual(store.getAny(gemini.envNames, { GEMINI_API_KEY: "  ", GOOGLE_API_KEY: "second" }), {
      name: "GOOGLE_API_KEY",
      value: "second",
    });
    assert.equal(store.getAny(gemini.envNames, { GEMINI_API_KEY: "first", GOOGLE_API_KEY: "second" })?.name, "GEMINI_API_KEY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- client -----------------------------------------------------------------

const stubFetch = (handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

const openaiToolReply = (name: string, args: Record<string, unknown>): unknown => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});

test("an OpenAI-shaped request carries tools and the reply parses back into calls", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = new ChatClient({
    baseUrl: "http://api.test/v1",
    model: "m",
    apiKey: "sk-test",
    wire: "openai",
    timeoutMs: 5_000,
    fetchImpl: stubFetch((url, init) => {
      seen = { url, init };
      return { status: 200, body: openaiToolReply("write_file", { path: "a.txt", content: "hi" }) };
    }),
  });

  const response = await client.complete({
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
    ],
    tools: [{ name: "write_file", description: "d", parameters: { type: "object", properties: {} } }],
    maxOutputTokens: 100,
  });

  assert.equal(seen?.url, "http://api.test/v1/chat/completions");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test");

  const body = JSON.parse(String(seen?.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
  ]);
  assert.ok(Array.isArray(body.tools));
  assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "write_file", arguments: { path: "a.txt", content: "hi" } }]);
});

test("a Gemini request uses its own shape and strips schema keywords Gemini rejects", async () => {
  let seen: RequestInit | undefined;
  const client = new ChatClient({
    baseUrl: "http://gemini.test/v1beta",
    model: "gemini-2.0-flash",
    apiKey: "key",
    wire: "gemini",
    timeoutMs: 5_000,
    fetchImpl: stubFetch((_url, init) => {
      seen = init;
      return {
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ functionCall: { name: "finish", args: { summary: "done" } } }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
        },
      };
    }),
  });

  const response = await client.complete({
    model: "gemini-2.0-flash",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "d",
        parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      },
    ],
    maxOutputTokens: 64,
  });

  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], "key");
  const body = JSON.parse(String(seen?.body)) as Record<string, any>;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "sys" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  assert.deepEqual(response.toolCalls, [{ id: "call_0", name: "finish", arguments: { summary: "done" } }]);
  assert.equal(response.usage?.inputTokens, 10);
});

test("an Anthropic request puts the system prompt outside messages", async () => {
  let seen: RequestInit | undefined;
  const client = new ChatClient({
    baseUrl: "http://claude.test/v1",
    model: "claude-3-5-haiku-latest",
    apiKey: "sk-ant",
    wire: "anthropic",
    timeoutMs: 5_000,
    fetchImpl: stubFetch((_url, init) => {
      seen = init;
      return {
        status: 200,
        body: { content: [{ type: "text", text: "all done" }], usage: { input_tokens: 5, output_tokens: 2 } },
      };
    }),
  });

  const response = await client.complete({
    model: "claude-3-5-haiku-latest",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools: [],
    maxOutputTokens: 64,
  });

  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(seen?.body)) as Record<string, any>;
  assert.equal(body.system, "sys");
  assert.equal(body.messages.length, 1);
  assert.equal(response.content, "all done");
  assert.deepEqual(response.toolCalls, []);
});

test("a rejected key is reported as a credential problem, not retried", async () => {
  let calls = 0;
  const client = new ChatClient({
    baseUrl: "http://api.test/v1",
    model: "m",
    apiKey: "bad",
    wire: "openai",
    timeoutMs: 5_000,
    fetchImpl: stubFetch(() => {
      calls += 1;
      return { status: 401, body: { error: { message: "Incorrect API key provided" } } };
    }),
  });

  await assert.rejects(
    client.complete({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [], maxOutputTokens: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.match(error.message, /rejected/);
      assert.doesNotMatch(error.message, /bad/, "the key must not leak into the error");
      return true;
    },
  );
  assert.equal(calls, 1, "an auth failure must not be retried");
});

test("a rate limit is retried and then surfaces", async () => {
  let calls = 0;
  const client = new ChatClient({
    baseUrl: "http://api.test/v1",
    model: "m",
    apiKey: "k",
    wire: "openai",
    timeoutMs: 5_000,
    fetchImpl: stubFetch(() => {
      calls += 1;
      if (calls < 3) return { status: 429, body: { error: { message: "slow down" } } };
      return { status: 200, body: { choices: [{ message: { content: "recovered" } }] } };
    }),
  });

  const response = await client.complete({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxOutputTokens: 1,
  });
  assert.equal(response.content, "recovered");
  assert.equal(calls, 3);
});

// --- tools ------------------------------------------------------------------

test("paths that leave the workspace are refused", async () => {
  const workspace = join(tmpdir(), "agentswarm-sandbox-root");
  assert.equal(resolveInside(workspace, "src/a.ts"), join(workspace, "src/a.ts"));
  assert.equal(resolveInside(workspace, "./a.ts"), join(workspace, "a.ts"));
  assert.throws(() => resolveInside(workspace, "../escape"), ToolError);
  assert.throws(() => resolveInside(workspace, "src/../../escape"), ToolError);
  assert.throws(() => resolveInside(workspace, "/etc/passwd"), ToolError);
  assert.throws(() => resolveInside(workspace, ".."), ToolError);
  assert.throws(() => resolveInside(workspace, "  "), /path is required/);
  assert.throws(() => resolveInside(workspace, "a\u0000b"), /null bytes/);
});

test("a model cannot read or write outside the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-sandbox-"));
  const workspace = join(directory, "repo");
  const outside = join(directory, "secret.txt");
  await writeFile(outside, "top secret", "utf8");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });

  try {
    await assert.rejects(runTool("read_file", { path: "../secret.txt" }, { workspace }), /escapes the workspace/);
    await assert.rejects(runTool("write_file", { path: "../evil.txt", content: "x" }, { workspace }), /escapes the workspace/);
    await assert.rejects(runTool("edit_file", { path: "/etc/hosts", old_string: "a", new_string: "b" }, { workspace }), /escapes the workspace/);
    assert.equal(await readFile(outside, "utf8"), "top secret");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the file tools read, write, and edit within the workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-tools-"));
  try {
    const deps = { workspace: directory };

    assert.deepEqual(await runTool("list_files", {}, deps), {
      output: "(empty)",
    });

    const created = await runTool("write_file", { path: "src/deep/a.ts", content: "one\ntwo\n" }, deps);
    assert.match(created.output, /Created src\/deep\/a\.ts/);

    assert.equal((await runTool("read_file", { path: "src/deep/a.ts" }, deps)).output, "one\ntwo\n");

    const edited = await runTool("edit_file", { path: "src/deep/a.ts", old_string: "two", new_string: "three" }, deps);
    assert.match(edited.output, /1 replacement/);
    assert.equal((await runTool("read_file", { path: "src/deep/a.ts" }, deps)).output, "one\nthree\n");

    // An ambiguous edit is refused so a model cannot silently hit the wrong line.
    await writeFile(join(directory, "dup.txt"), "x\nx\n", "utf8");
    await assert.rejects(
      runTool("edit_file", { path: "dup.txt", old_string: "x", new_string: "y" }, deps),
      /appears 2 times/,
    );
    const all = await runTool("edit_file", { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true }, deps);
    assert.match(all.output, /2 replacements/);
    assert.equal((await readFile(join(directory, "dup.txt"), "utf8")).trim(), "y\ny");

    // A missing match tells the model to re-read rather than guessing.
    await assert.rejects(
      runTool("edit_file", { path: "dup.txt", old_string: "nope", new_string: "z" }, deps),
      /was not found/,
    );

    const command = await runTool("run_command", { command: "echo hello from the shell" }, deps);
    assert.match(command.output, /hello from the shell/);
    assert.match(command.output, /exit 0/);

    const failed = await runTool("run_command", { command: "exit 3" }, deps);
    assert.match(failed.output, /exit 3/);

    assert.deepEqual((await runTool("finish", { summary: "all good" }, deps)), {
      output: "Task marked complete.",
      finished: true,
      summary: "all good",
    });
    await assert.rejects(runTool("nope", {}, deps), /Unknown tool/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- agent loop -------------------------------------------------------------

const scriptedClient = (replies: ChatResponse[]): { client: ChatClient; prompts: unknown[] } => {
  const prompts: unknown[] = [];
  let index = 0;
  const client = {
    model: "scripted",
    ping: async () => undefined,
    complete: async (request: Parameters<ChatClient["complete"]>[0]) => {
      prompts.push(JSON.parse(JSON.stringify(request.messages)));
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return reply;
    },
  } as unknown as ChatClient;
  return { client, prompts };
};

const toolReply = (calls: ToolCall[], content = ""): ChatResponse => ({ content, toolCalls: calls });

test("the agent loop drives tools until the model finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-agent-"));
  try {
    const { client, prompts } = scriptedClient([
      toolReply([{ id: "c1", name: "write_file", arguments: { path: "out.txt", content: "generated" } }]),
      toolReply([{ id: "c2", name: "finish", arguments: { summary: "wrote out.txt" } }], "done"),
    ]);

    const progress: string[] = [];
    const result = await runAgent({
      client,
      systemPrompt: "sys",
      userPrompt: "make a file",
      workspace: directory,
      onProgress: (line) => progress.push(line),
    });

    assert.equal(result.stopReason, "finish");
    assert.equal(result.summary, "wrote out.txt");
    assert.equal(result.turns, 2);
    assert.equal(await readFile(join(directory, "out.txt"), "utf8"), "generated");

    // The tool result is fed back so the model can see what happened.
    const second = prompts[1] as Array<{ role: string; content: string }>;
    assert.ok(second.some((message) => message.role === "tool" && message.content.includes("Created out.txt")));
    assert.ok(progress.some((line) => line.startsWith("write_file:")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tool error is fed back as an observation instead of ending the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-agent-error-"));
  try {
    const { client, prompts } = scriptedClient([
      toolReply([{ id: "c1", name: "edit_file", arguments: { path: "a.txt", old_string: "x", new_string: "y" } }]),
      toolReply([{ id: "c2", name: "finish", arguments: { summary: "recovered" } }]),
    ]);

    const result = await runAgent({ client, systemPrompt: "s", userPrompt: "u", workspace: directory });
    assert.equal(result.stopReason, "finish");

    const second = prompts[1] as Array<{ role: string; content: string }>;
    assert.ok(
      second.some((message) => message.role === "tool" && message.content.includes("does not exist")),
      "the model must see a readable reason the tool failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sandbox escape stops the run rather than being retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-agent-escape-"));
  try {
    const { client } = scriptedClient([
      toolReply([{ id: "c1", name: "read_file", arguments: { path: "../../etc/passwd" } }]),
    ]);
    await assert.rejects(
      runAgent({ client, systemPrompt: "s", userPrompt: "u", workspace: directory }),
      /escapes the workspace/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the turn budget and an abort both stop the loop cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-agent-budget-"));
  try {
    const looping = toolReply([{ id: "c", name: "list_files", arguments: {} }]);
    const { client } = scriptedClient([looping]);
    const result = await runAgent({
      client,
      systemPrompt: "s",
      userPrompt: "u",
      workspace: directory,
      budget: { maxTurns: 3 },
    });
    assert.equal(result.stopReason, "turn_limit");
    assert.equal(result.turns, 3);

    const controller = new AbortController();
    controller.abort();
    const aborted = await runAgent({
      client: scriptedClient([looping]).client,
      systemPrompt: "s",
      userPrompt: "u",
      workspace: directory,
      signal: controller.signal,
    });
    assert.equal(aborted.stopReason, "aborted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reply with no tool call is treated as the model finishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-agent-done-"));
  try {
    const { client } = scriptedClient([{ content: "I did nothing", toolCalls: [] }]);
    const result = await runAgent({ client, systemPrompt: "s", userPrompt: "u", workspace: directory });
    assert.equal(result.stopReason, "no_tool_calls");
    assert.equal(result.summary, "I did nothing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- against a real local endpoint -------------------------------------------

interface FakeApi {
  url: string;
  close: () => Promise<void>;
  calls: Array<{ path: string; auth: string | undefined; body: string }>;
}

/** A minimal OpenAI-shaped server, so the direct provider is exercised for real. */
const startFakeApi = async (script: Array<{ tool?: { name: string; arguments: Record<string, unknown> }; content?: string }>): Promise<FakeApi> => {
  const calls: FakeApi["calls"] = [];
  let turn = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: request.url ?? "", auth: request.headers.authorization, body });

      if ((request.url ?? "").endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
        return;
      }

      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      const message = step.tool
        ? {
            content: null,
            tool_calls: [
              { id: `call_${turn}`, function: { name: step.tool.name, arguments: JSON.stringify(step.tool.arguments) } },
            ],
          }
        : { content: step.content ?? "done" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test("the keys probe verifies a credential against a live endpoint", async () => {
  const api = await startFakeApi([]);
  try {
    const ok = new ChatClient({
      baseUrl: `${api.url}/v1`,
      model: "fake",
      apiKey: "k",
      wire: "openai",
      timeoutMs: 5_000,
    });
    await ok.ping();
    assert.ok(api.calls.some((call) => call.path.endsWith("/models")));

    const rejected = new ChatClient({
      baseUrl: `${api.url}/v1`,
      model: "fake",
      apiKey: "bad",
      wire: "openai",
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "no" } }), { status: 401 }),
    });
    await assert.rejects(rejected.ping(), /rejected/);
  } finally {
    await api.close();
  }
});

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

const runCli = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): Promise<RunResult> =>
  new Promise((resolveRun) => {
    const child = spawn(process.execPath, [...args, "--no-pager"], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.once("close", (code) => resolveRun({ code, out, err }));
    child.stdin.end(options.stdin ?? "");
  });

test("a direct-API provider runs the agent loop and puts the result up for review", async () => {
  const source = await createTestRepository("agentswarm-direct-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-direct-data-"));
  const api = await startFakeApi([
    { tool: { name: "write_file", arguments: { path: "generated.js", content: "export const generated = true;\n" } } },
    { tool: { name: "finish", arguments: { summary: "wrote generated.js" } } },
  ]);

  try {
    const result = await runCli(
      [tsxCli(), cliEntry(), "create a module", "--provider", "groq"],
      {
        cwd: source,
        env: {
          AGENTSWARM_DATA_DIR: dataDirectory,
          GROQ_API_KEY: "gsk_test_key_1234567890",
          GROQ_BASE_URL: api.url,
        },
      },
    );

    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /review/);

    // The fake endpoint saw an authenticated chat request carrying tools.
    const chat = api.calls.find((call) => call.path.endsWith("/chat/completions"));
    assert.ok(chat, "expected a chat request");
    assert.equal(chat?.auth, "Bearer gsk_test_key_1234567890");
    assert.match(chat?.body ?? "", /write_file/);

    const store = new JsonStore(join(dataDirectory, "state.json"));
    const project = store.listProjects()[0];
    const task = store.listTasks(project.id)[0];
    assert.equal(task.status, "review");
    const change = store.listChanges(project.id)[0];
    assert.match(change.diff, /generated\.js/);

    // The agent's file exists only in the managed workspace, never in the checkout.
    assert.equal(await readFile(join(source, "generated.js"), "utf8").catch(() => ""), "");
  } finally {
    await api.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await removeTestPath(source);
  }
});

test("a direct-API task fails with actionable advice when no key is set", async () => {
  const source = await createTestRepository("agentswarm-nokey-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-nokey-data-"));
  try {
    const result = await runCli([tsxCli(), cliEntry(), "do work", "--provider", "groq"], {
      cwd: source,
      env: { AGENTSWARM_DATA_DIR: dataDirectory, GROQ_API_KEY: "" },
    });

    assert.equal(result.code, 1);
    assert.match(result.out, /openteam keys set groq/);
    assert.doesNotMatch(result.out, /gsk_/, "no key material may appear");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await removeTestPath(source);
  }
});

test("openteam keys reports, stores, and probes keys", async () => {
  const source = await createTestRepository("agentswarm-keys-cli-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-keys-cli-data-"));
  const api = await startFakeApi([]);
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}, stdin?: string): Promise<RunResult> =>
    runCli([tsxCli(), cliEntry(), ...args, "--data-dir", dataDirectory, "--no-color"], {
      cwd: source,
      env: { AGENTSWARM_DATA_DIR: dataDirectory, ...env },
      stdin,
    });

  try {
    const empty = await cli(["keys"], { GROQ_API_KEY: "" });
    assert.match(empty.out, /OPENAI_API_KEY/);
    assert.match(empty.out, /still need a key/);
    assert.equal(/sk-[A-Za-z0-9]/.test(empty.out), false, "no key material may be printed");

    const stored = await cli(["keys", "set", "groq"], { GROQ_API_KEY: "" }, "gsk_secret_9999\n");
    assert.match(stored.out, /stored GROQ_API_KEY/);
    assert.doesNotMatch(stored.out, /gsk_secret_9999/, "the key must never be echoed");
    assert.match(stored.out, /…9999/, "a recognisable hint is still shown");

    const after = await cli(["keys"], { GROQ_API_KEY: "" });
    assert.match(after.out, /file/);

    const mode = (await stat(join(dataDirectory, "keys.json"))).mode & 0o777;
    assert.equal(mode.toString(8), "600");

    const probed = await cli(["keys", "test", "groq"], { GROQ_BASE_URL: api.url });
    assert.match(probed.out, /ok/);
    assert.ok(api.calls.some((call) => call.path.endsWith("/models")));

    const removed = await cli(["keys", "unset", "groq"], { GROQ_API_KEY: "" });
    assert.match(removed.out, /removed/);

    const missing = await cli(["keys", "test", "groq"], { GROQ_BASE_URL: api.url, GROQ_API_KEY: "" });
    assert.match(missing.out, /no key/);
  } finally {
    await api.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await removeTestPath(source);
  }
});

test("openteam doctor reports key status without failing", async () => {
  const source = await createTestRepository("agentswarm-doctor-");
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentswarm-doctor-data-"));
  try {
    const result = await runCli(
      [tsxCli(), cliEntry(), "doctor", "--data-dir", dataDirectory, "--no-color"],
      { cwd: source, env: { AGENTSWARM_DATA_DIR: dataDirectory } },
    );
    assert.equal(result.code, 0);
    assert.match(result.out, /api keys/);
    assert.match(result.out, /keys\.json/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await removeTestPath(source);
  }
});
// --- coordinator ------------------------------------------------------------

test("a malformed plan is repaired rather than trusted", () => {
  const { tasks } = normalisePlan({
    notes: "two tracks",
    tasks: [
      { title: "First", description: "do the first thing", allowedPaths: ["src/api/**"], dependsOn: [] },
      { title: "", description: "no title, dropped", allowedPaths: [], dependsOn: [] },
      { title: "No description", description: "   ", allowedPaths: [], dependsOn: [] },
      { title: "Second", description: "do the second", allowedPaths: ["docs/**", "docs/**"], dependsOn: [0] },
      { title: "Forward reference", description: "depends on something later", allowedPaths: [], dependsOn: [9] },
      { title: "Nonsense deps", description: "bad indices", allowedPaths: [], dependsOn: ["x", null, 1.5, -2] },
      "not an object",
    ],
  }, "goal", 10);

  assert.deepEqual(tasks.map((task) => task.title), ["First", "Second", "Forward reference", "Nonsense deps"]);
  assert.deepEqual(tasks[0].allowedPaths, ["src/api/**"]);
  assert.deepEqual(tasks[1].allowedPaths, ["docs/**"], "duplicate paths are collapsed");
  assert.deepEqual(tasks[0].dependsOn, [], "an explicit empty list stays empty");
  assert.deepEqual(tasks[1].dependsOn, [0]);
  assert.deepEqual(tasks[2].dependsOn, [], "a forward reference is dropped, not kept as a cycle");
  assert.deepEqual(tasks[3].dependsOn, [], "non-integer and negative indices are dropped");
});

test("a plan with nothing usable is an error, not an empty queue", () => {
  assert.throws(() => normalisePlan({ tasks: [] }, "goal"), /no usable tasks/);
  assert.throws(() => normalisePlan({}, "goal"), /no usable tasks/);
  assert.throws(() => normalisePlan({ tasks: [{ title: "x" }] }, "goal"), /no usable tasks/);
});

test("the coordinator may inspect but cannot change the repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-coord-"));
  try {
    const { client } = scriptedClient([
      toolReply([{ id: "c1", name: "list_files", arguments: {} }]),
      toolReply([{ id: "c2", name: "write_file", arguments: { path: "injected.ts", content: "nope" } }]),
      toolReply([
        {
          id: "c3",
          name: "submit_plan",
          arguments: { tasks: [{ title: "Real task", description: "Do the work", allowedPaths: ["src/**"], dependsOn: [] }] },
        },
      ]),
    ]);

    const progress: string[] = [];
    const result = await planWithModel({
      client,
      goal: "add a module",
      repositoryPath: directory,
      onProgress: (line) => progress.push(line),
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].title, "Real task");
    // The write was refused, so nothing was created.
    assert.equal(await readFile(join(directory, "injected.ts"), "utf8").catch(() => ""), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the coordinator refuses to run shell commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-coord-cmd-"));
  try {
    const { client, prompts } = scriptedClient([
      toolReply([{ id: "c1", name: "run_command", arguments: { command: "rm -rf /" } }]),
      toolReply([
        { id: "c2", name: "submit_plan", arguments: { tasks: [{ title: "T", description: "D", allowedPaths: [], dependsOn: [] }] } },
      ]),
    ]);
    await planWithModel({ client, goal: "g", repositoryPath: directory });

    const second = prompts[1] as Array<{ content: string }>;
    assert.ok(
      second.some((message) => message.content.includes("not available to the coordinator")),
      "a shell attempt must be refused by name",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a coordinator that never submits fails with a usable message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-coord-idle-"));
  try {
    const { client } = scriptedClient([toolReply([{ id: "c1", name: "list_files", arguments: {} }])]);
    await assert.rejects(
      planWithModel({ client, goal: "g", repositoryPath: directory, maxTurns: 2 }),
      /did not produce a plan/,
    );

    const { client: silent } = scriptedClient([{ content: "I think that is enough.", toolCalls: [] }]);
    await assert.rejects(
      planWithModel({ client: silent, goal: "g", repositoryPath: directory }),
      /without submitting a plan/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
