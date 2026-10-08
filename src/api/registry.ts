/**
 * Direct-API providers: openteam calls these over HTTP and runs the agent loop
 * itself, instead of handing the work to an installed agent CLI.
 *
 * The registry is the single source of truth for the three things that vary per
 * provider: which environment variable holds the key, where the endpoint is, and
 * which request/response shape to speak.
 */
export type WireFormat = "openai" | "anthropic" | "gemini";

export interface ApiProviderEntry {
  id: string;
  label: string;
  /** Environment variables checked in order. The first non-empty one wins. */
  envNames: string[];
  /** Endpoint used when no override is set. */
  baseUrl: string;
  /** Environment variable that overrides `baseUrl`, for gateways and local servers. */
  baseUrlEnv: string;
  wire: WireFormat;
  /** False for providers that serve models without authentication. */
  requiresKey: boolean;
  /** Default model when the task does not name one. */
  defaultModel: string;
  /** Free-tier reality check, shown by `openteam keys list`. */
  freeTier: string;
  /** Cheap endpoint used to check the key works. */
  probePath: string;
}

export const API_PROVIDERS: ApiProviderEntry[] = [
  {
    id: "openai",
    label: "OpenAI",
    envNames: ["OPENAI_API_KEY"],
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    wire: "openai",
    requiresKey: true,
    defaultModel: "gpt-4o-mini",
    freeTier: "no free tier, only trial credits",
    probePath: "/models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envNames: ["ANTHROPIC_API_KEY"],
    baseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    wire: "anthropic",
    requiresKey: true,
    defaultModel: "claude-3-5-haiku-latest",
    freeTier: "no free tier, only trial credits",
    probePath: "/models",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    baseUrlEnv: "GEMINI_BASE_URL",
    wire: "gemini",
    requiresKey: true,
    defaultModel: "gemini-2.0-flash",
    freeTier: "free tier with a per-minute rate limit",
    probePath: "/models",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envNames: ["OPENROUTER_API_KEY"],
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    wire: "openai",
    requiresKey: true,
    defaultModel: "deepseek/deepseek-chat-v3-0324:free",
    freeTier: "free models exist, marked :free; account needs a topped-up balance once",
    probePath: "/models",
  },
  {
    id: "groq",
    label: "Groq",
    envNames: ["GROQ_API_KEY"],
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEnv: "GROQ_BASE_URL",
    wire: "openai",
    requiresKey: true,
    defaultModel: "llama-3.3-70b-versatile",
    freeTier: "free tier, generous rate limits",
    probePath: "/models",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envNames: ["DEEPSEEK_API_KEY"],
    baseUrl: "https://api.deepseek.com",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    wire: "openai",
    requiresKey: true,
    defaultModel: "deepseek-chat",
    freeTier: "very cheap, no standing free tier",
    probePath: "/models",
  },
  {
    id: "mistral",
    label: "Mistral",
    envNames: ["MISTRAL_API_KEY"],
    baseUrl: "https://api.mistral.ai/v1",
    baseUrlEnv: "MISTRAL_BASE_URL",
    wire: "openai",
    requiresKey: true,
    defaultModel: "mistral-small-latest",
    freeTier: "free tier on the experiment tier",
    probePath: "/models",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    envNames: ["OLLAMA_API_KEY"],
    baseUrl: "http://127.0.0.1:11434",
    baseUrlEnv: "OLLAMA_BASE_URL",
    wire: "openai",
    requiresKey: false,
    defaultModel: "qwen2.5-coder",
    freeTier: "free and offline; needs the model pulled with `ollama pull`",
    probePath: "/models",
  },
];

const byId = new Map(API_PROVIDERS.map((entry) => [entry.id, entry]));

export const apiProvider = (id: string): ApiProviderEntry | undefined => byId.get(id);

export const isApiProviderId = (id: string): boolean => byId.has(id);

export const apiProviderIds = (): string[] => API_PROVIDERS.map((entry) => entry.id);

/** Resolves the endpoint, honouring a gateway or local-server override. */
export const resolveBaseUrl = (entry: ApiProviderEntry, env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[entry.baseUrlEnv]?.trim();
  const base = (override || entry.baseUrl).replace(/\/+$/, "");
  return base.endsWith("/v1") || !entry.wire ? base : `${base}/v1`;
};

// --- user-defined providers ------------------------------------------------

/** Where a user registry lives inside the data directory. */
export const providerFileName = "providers.json";

/** A provider the user defined, or an override of a built-in one. */
export interface UserProviderInput {
  id: string;
  label?: string;
  wire: WireFormat;
  baseUrl: string;
  /** Environment variable holding the key, e.g. VLLM_API_KEY. */
  envName?: string;
  defaultModel?: string;
  freeTier?: string;
  /** False for servers that need no credential. */
  requiresKey?: boolean;
}

export class ProviderDefinitionError extends Error {}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validates a definition before it is written.
 *
 * The id becomes a shell-visible flag value and the env name becomes a real
 * environment variable handed to agents, so both are constrained to safe shapes
 * rather than accepted as typed.
 */
export const validateUserProvider = (input: unknown): UserProviderInput => {
  if (!input || typeof input !== "object") throw new ProviderDefinitionError("a provider definition must be an object");
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  if (!ID_PATTERN.test(id)) {
    throw new ProviderDefinitionError(
      "An id must be 1-32 characters of lowercase letters, digits, dot, dash, or underscore, starting with a letter or digit",
    );
  }
  if (!API_PROVIDERS.some((entry) => entry.id === id) && CLI_PROVIDER_NAMES.has(id)) {
    throw new ProviderDefinitionError(`"${id}" is an agent CLI, not an API provider`);
  }

  const wire = raw.wire;
  if (wire !== "openai" && wire !== "anthropic" && wire !== "gemini") {
    throw new ProviderDefinitionError('wire must be one of: openai, anthropic, gemini');
  }

  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    throw new ProviderDefinitionError("baseUrl must start with http:// or https://");
  }

  const builtin = API_PROVIDERS.find((entry) => entry.id === id);
  const requiresKey = raw.requiresKey !== false;
  const envName = raw.envName === undefined || raw.envName === null ? "" : String(raw.envName).trim();
  if (envName && !ENV_PATTERN.test(envName)) {
    throw new ProviderDefinitionError(
      "envName must be an uppercase environment variable name such as VLLM_API_KEY",
    );
  }
  // Overriding a built-in inherits its variable, so only a brand new provider
  // has to be told where its key lives.
  if (requiresKey && !envName && !builtin?.envNames.length) {
    throw new ProviderDefinitionError(
      "envName must be an uppercase environment variable name such as VLLM_API_KEY",
    );
  }

  const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : undefined;
  // Only fields that were actually given are returned. Leaving the rest
  // undefined is what lets an override of a built-in keep its model and label
  // instead of resetting them to a placeholder.
  return {
    id,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined,
    wire,
    baseUrl,
    envName: envName || undefined,
    defaultModel: defaultModel || undefined,
    freeTier: typeof raw.freeTier === "string" && raw.freeTier.trim() ? raw.freeTier.trim() : undefined,
    requiresKey,
  };
};

/** Ids that belong to agent CLIs, which cannot be redefined as API providers. */
export const CLI_PROVIDER_NAMES = new Set(["mock", "codex", "claude", "opencode", "hermes", "custom"]);

/** True when the endpoint is on this machine, so repository content stays local. */
export const isLoopbackUrl = (baseUrl: string): boolean => {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0";
  } catch {
    return false;
  }
};

/**
 * Merges user definitions over the built-ins.
 *
 * A user entry with a built-in id overrides only what it names, so pointing
 * OpenAI at a gateway does not lose its default model. A new id is added.
 */
export const mergeProviders = (user: UserProviderInput[]): ApiProviderEntry[] => {
  const merged = new Map(API_PROVIDERS.map((entry) => [entry.id, entry]));
  for (const definition of user) {
    const existing = merged.get(definition.id);
    // Naming envName replaces it; not naming it keeps the built-in's, so
    // overriding an endpoint does not orphan an existing key.
    const envNames = definition.requiresKey === false
      ? []
      : definition.envName
        ? [definition.envName]
        : existing?.envNames ?? [];
    merged.set(definition.id, {
      id: definition.id,
      label: definition.label ?? existing?.label ?? definition.id,
      envNames,
      baseUrl: definition.baseUrl,
      baseUrlEnv: existing?.baseUrlEnv ?? `${toEnvName(definition.id)}_BASE_URL`,
      wire: definition.wire,
      requiresKey: definition.requiresKey ?? existing?.requiresKey ?? true,
      defaultModel: definition.defaultModel ?? existing?.defaultModel ?? "default",
      freeTier: definition.freeTier ?? existing?.freeTier ?? "yours to configure",
      probePath: existing?.probePath ?? "/models",
    });
  }
  return [...merged.values()];
};

const toEnvName = (id: string): string => `${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_BASE_URL`;