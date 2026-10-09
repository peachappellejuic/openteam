import type { PromptOption } from "./commands.js";

/** The entry that starts defining a new endpoint rather than configuring one. */
export const ADD_PROVIDER = "+ add a provider";

/** Shown after a provider is configured, so the loop can continue or end. */
export const DONE = "\u2714 done";

export interface ProviderSummary {
  id: string;
  /** A key is stored, or the provider needs none. */
  authenticated: boolean;
  /** The provider can run work at all: key present, or no key needed. */
  usable: boolean;
  needsKey: boolean;
  kind: "direct api" | "agent cli" | "local";
  label: string;
}

/**
 * The rows of the `/provider` menu.
 *
 * Everything is listed, including providers with no key, because seeing that a
 * provider exists and what it needs is the point of the menu; the ones you can
 * use are simply first.
 */
export const providerMenuOptions = (providers: ProviderSummary[]): PromptOption[] => {
  const rows: PromptOption[] = providers.map((provider) => ({
    value: provider.id,
    usage: provider.authenticated ? "key stored" : provider.needsKey ? "needs a key" : "",
    summary: provider.kind,
    usable: provider.usable,
  }));

  const ordered = [
    ...rows.filter((row) => row.usable),
    ...rows.filter((row) => !row.usable),
    { value: ADD_PROVIDER, usage: "", summary: "define a new endpoint", usable: true },
  ];
  return ordered;
};

export type WireChoice = "openai" | "anthropic" | "gemini";

export const WIRE_CHOICES: WireChoice[] = ["openai", "anthropic", "gemini"];

/** The fields collected when defining a new provider, in the order asked. */
export type AddField = "id" | "wire" | "url" | "envName" | "model";

export const ADD_FIELD_ORDER: AddField[] = ["id", "wire", "url", "envName", "model"];

export interface ProviderDraft {
  id?: string;
  wire: WireChoice;
  baseUrl?: string;
  envName?: string;
  defaultModel?: string;
  /** False once the user says the server needs no credential. */
  requiresKey: boolean;
}

export const emptyDraft = (): ProviderDraft => ({ wire: "openai", requiresKey: true });

export const FIELD_LABEL: Record<AddField, string> = {
  id: "id",
  wire: "wire format",
  url: "base url",
  envName: "key variable",
  model: "default model",
};

export const FIELD_HELP: Record<AddField, string> = {
  id: "lowercase, e.g. my-vllm",
  wire: "openai, anthropic, or gemini",
  url: "http://127.0.0.1:8000",
  envName: "uppercase variable that will hold the key",
  model: "used when a task does not name one",
};

/** Suggests a variable name from the id, the way the CLI would. */
export const suggestEnvName = (id: string): string =>
  `${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_API_KEY`;

export interface FieldProblem {
  ok: boolean;
  message: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validates one field before the wizard moves on.
 *
 * The id and variable name end up as shell-visible arguments and real environment
 * variables, so they are held to fixed shapes rather than accepted as typed.
 */
export const validateField = (
  field: AddField,
  value: string,
  context: { draft: ProviderDraft; existingIds: string[] },
): FieldProblem => {
  const trimmed = value.trim();
  switch (field) {
    case "id": {
      if (!ID_PATTERN.test(trimmed)) {
        return { ok: false, message: "1-32 characters of a-z, 0-9, dot, dash, underscore" };
      }
      if (context.existingIds.includes(trimmed)) {
        return { ok: false, message: `${trimmed} already exists; pick another name` };
      }
      return { ok: true, message: trimmed };
    }
    case "wire":
      return { ok: WIRE_CHOICES.includes(trimmed as WireChoice), message: trimmed };
    case "url": {
      if (!/^https?:\/\/\S+$/.test(trimmed)) {
        return { ok: false, message: "must start with http:// or https://" };
      }
      return { ok: true, message: trimmed };
    }
    case "envName": {
      if (!context.draft.requiresKey) return { ok: true, message: "" };
      if (!ENV_PATTERN.test(trimmed)) {
        return { ok: false, message: "uppercase, e.g. VLLM_API_KEY — or type skip for no key" };
      }
      return { ok: true, message: trimmed };
    }
    case "model":
      return { ok: true, message: trimmed };
    default:
      return { ok: false, message: "" };
  }
};

/** Words that mean "this server needs no credential". */
export const NO_KEY_WORDS = ["skip", "none", "no", "-"];

/** The key variable step is skippable, and saying so clears the requirement. */
export const fieldIsSkippable = (draft: ProviderDraft, field: AddField): boolean => field === "envName";

/** Applies a validated field to the draft. */
export const applyField = (draft: ProviderDraft, field: AddField, value: string): ProviderDraft => {
  switch (field) {
    case "id":
      return { ...draft, id: value, envName: draft.envName ?? suggestEnvName(value) };
    case "wire":
      return { ...draft, wire: value as WireChoice };
    case "url":
      return { ...draft, baseUrl: value };
    case "envName":
      return { ...draft, envName: value };
    case "model":
      return { ...draft, defaultModel: value };
    default:
      return draft;
  }
};

/** The next field to ask for, or undefined once the draft is complete. */
export const nextField = (draft: ProviderDraft, after: AddField): AddField | undefined => {
  const index = ADD_FIELD_ORDER.indexOf(after);
  for (const field of ADD_FIELD_ORDER.slice(index + 1)) {
    if (field === "envName" && !draft.requiresKey) continue;
    return field;
  }
  return undefined;
};

/** Whether a draft has everything the registry needs. */
export const isComplete = (draft: ProviderDraft): boolean =>
  Boolean(draft.id && draft.baseUrl) && (draft.requiresKey ? Boolean(draft.envName) : true);

export const draftSummary = (draft: ProviderDraft): Array<[string, string]> => [
  ["id", draft.id ?? ""],
  ["wire", draft.wire],
  ["url", draft.baseUrl ?? ""],
  ["key", draft.requiresKey ? draft.envName ?? "" : "none needed"],
  ["model", draft.defaultModel ?? "(provider default)"],
];

/**
 * Steps the wizard through typed fields and the single-choice wire format.
 * Kept as data so the rendering and the key handling stay independent of it.
 */
export type WizardStep =
  | { kind: "providerMenu" }
  | { kind: "credential"; envName: string; label: string; value: string; message: string }
  | { kind: "addText"; field: AddField; draft: ProviderDraft; value: string; message: string }
  | { kind: "addWire"; draft: ProviderDraft; selected: number }
  | { kind: "addKey"; draft: ProviderDraft; value: string; message: string };

export const wizardTitle = (step: WizardStep): string => {
  switch (step.kind) {
    case "providerMenu":
      return "providers";
    case "credential":
      return "credential";
    case "addText":
      return `add provider \u2014 ${FIELD_LABEL[step.field]}`;
    case "addWire":
      return "add provider \u2014 wire format";
    case "addKey":
      return "add provider \u2014 key";
    default:
      return "";
  }
};

/** True while the wizard owns the keyboard, so the prompt is not a free command. */
export const wizardActive = (step: WizardStep | undefined): boolean => Boolean(step);