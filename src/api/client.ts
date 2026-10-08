import type { WireFormat } from "./registry.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call the assistant asked for; only on assistant messages. */
  toolCall?: ToolCall;
  /** The assistant's call this message answers; only on tool messages. */
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  wire: WireFormat;
  timeoutMs: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ChatClient {
  public constructor(private readonly options: ClientOptions) {}

  public get model(): string {
    return this.options.model;
  }

  /** A single minimal round trip, used by `openteam keys test`. */
  public async ping(): Promise<void> {
    const response = await this.send("/models", { method: "GET" }, "models");
    if (!response.ok) throw await toError(response, "models");
    await response.arrayBuffer();
  }

  public async complete(request: ChatRequest): Promise<ChatResponse> {
    const attempt = async (): Promise<ChatResponse> => {
      const payload = this.encode(request);
      const response = await this.send(payload.path, payload.init, "chat");
      if (!response.ok) throw await toError(response, "chat");
      const body = (await response.json()) as unknown;
      return this.decode(body);
    };

    let lastError: unknown;
    for (let attemptNumber = 0; attemptNumber <= 2; attemptNumber += 1) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ApiError && error.retryable;
        if (!retryable || attemptNumber === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attemptNumber));
      }
    }
    throw lastError;
  }

  private async send(
    path: string,
    init: RequestInit,
    operation: string,
  ): Promise<Response> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await doFetch(`${this.options.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "unreachable";
      throw new ApiError(`${this.options.baseUrl} ${operation} ${reason}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (!this.options.apiKey) return headers;
    if (this.options.wire === "anthropic") {
      headers["x-api-key"] = this.options.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (this.options.wire === "gemini") {
      headers["x-goog-api-key"] = this.options.apiKey;
    } else {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    return headers;
  }

  private encode(request: ChatRequest): { path: string; init: RequestInit } {
    const model = request.model;
    if (this.options.wire === "anthropic") {
      const system = request.messages.filter((message) => message.role === "system");
      const rest = request.messages.filter((message) => message.role !== "system");
      return {
        path: "/messages",
        init: {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            system: system.map((message) => message.content).join("\n\n"),
            messages: rest.map(anthropicMessage),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }),
        },
      };
    }
    if (this.options.wire === "gemini") {
      return {
        path: `/models/${encodeURIComponent(model)}:generateContent`,
        init: {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: joinSystem(request.messages) }] },
            contents: request.messages.filter((message) => message.role !== "system").map(geminiContent),
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: stripSchemaKeywords(tool.parameters),
                })),
              },
            ],
            generationConfig: { maxOutputTokens: request.maxOutputTokens },
          }),
        },
      };
    }
    return {
      path: "/chat/completions",
      init: {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map(openaiMessage),
          tools: request.tools.length
            ? request.tools.map((tool) => ({ type: "function", function: tool }))
            : undefined,
          tool_choice: request.tools.length ? "auto" : undefined,
        }),
      },
    };
  }

  private decode(body: unknown): ChatResponse {
    if (this.options.wire === "anthropic") return decodeAnthropic(body);
    if (this.options.wire === "gemini") return decodeGemini(body);
    return decodeOpenAi(body);
  }
}

const joinSystem = (messages: ChatMessage[]): string =>
  messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");

const openaiMessage = (message: ChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCall) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: [
        {
          id: message.toolCall.id,
          type: "function",
          function: { name: message.toolCall.name, arguments: JSON.stringify(message.toolCall.arguments) },
        },
      ],
    };
  }
  return { role: message.role, content: message.content };
};

const anthropicMessage = (message: ChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
    };
  }
  if (message.role === "assistant" && message.toolCall) {
    return {
      role: "assistant",
      content: [
        { type: "text", text: message.content || " " },
        { type: "tool_use", id: message.toolCall.id, name: message.toolCall.name, input: message.toolCall.arguments },
      ],
    };
  }
  return { role: "user", content: message.content };
};

const geminiContent = (message: ChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return { role: "user", parts: [{ functionResponse: { name: message.toolCall?.name ?? "tool", response: { result: message.content } } }] };
  }
  if (message.role === "assistant" && message.toolCall) {
    return {
      role: "model",
      parts: [{ functionCall: { name: message.toolCall.name, args: message.toolCall.arguments } }],
    };
  }
  return { role: "user", parts: [{ text: message.content }] };
};

/** Gemini rejects JSON Schema keywords it does not implement. */
const stripSchemaKeywords = (parameters: Record<string, unknown>): Record<string, unknown> => {
  const drop = new Set(["additionalProperties", "$schema", "default", "examples"]);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !drop.has(key))
        .map(([key, item]) => [key, walk(item)]),
    );
  };
  return walk(parameters) as Record<string, unknown>;
};

const decodeOpenAi = (body: unknown): ChatResponse => {
  const payload = body as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = payload.choices?.[0]?.message;
  return {
    content: choice?.content ?? "",
    toolCalls: (choice?.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: parseArguments(call.function?.arguments),
    })),
    usage: { inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens },
  };
};

const decodeAnthropic = (body: unknown): ChatResponse => {
  const payload = body as {
    content?: Array<
      | { type: "text"; text?: string }
      | { type: "tool_use"; id?: string; name?: string; input?: Record<string, unknown> }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const parts = payload.content ?? [];
  return {
    content: parts
      .filter((part): part is { type: "text"; text?: string } => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
    toolCalls: parts
      .filter((part): part is { type: "tool_use"; id?: string; name?: string; input?: Record<string, unknown> } => part.type === "tool_use")
      .map((part, index) => ({
        id: part.id ?? `call_${index}`,
        name: part.name ?? "",
        arguments: part.input ?? {},
      })),
    usage: { inputTokens: payload.usage?.input_tokens, outputTokens: payload.usage?.output_tokens },
  };
};

const decodeGemini = (body: unknown): ChatResponse => {
  const payload = body as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return {
    content: parts.map((part) => part.text ?? "").join(""),
    toolCalls: parts
      .map((part, index) => {
        const call = part.functionCall;
        if (!call?.name) return undefined;
        return { id: `call_${index}`, name: call.name, arguments: call.args ?? {} };
      })
      .filter((call): call is ToolCall => call !== undefined),
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount,
      outputTokens: payload.usageMetadata?.candidatesTokenCount,
    },
  };
};

const parseArguments = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toError = async (response: Response, operation: string): Promise<ApiError> => {
  const body = await response.text().catch(() => "");
  const detail = extractMessage(body) || response.statusText || "request failed";
  const retryable = RETRYABLE_STATUSES.has(response.status);
  if (response.status === 401 || response.status === 403) {
    return new ApiError(`${operation} rejected: check the API key for this provider`, response.status, false);
  }
  return new ApiError(`${operation} failed with ${response.status}: ${truncate(detail, 300)}`, response.status, retryable);
};

const extractMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? "";
  } catch {
    return "";
  }
};

const truncate = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length)}…`;