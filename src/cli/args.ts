export const VALUE_FLAGS = [
  "project",
  "provider",
  "model",
  "reviewer",
  "review-model",
  "assignee",
  "paths",
  "verify",
  "depends",
  "data-dir",
  "status",
  "limit",
  "branch",
  "name",
  "prompt",
  "title",
  "from",
  "to",
  "coordinator",
  "tasks",
  "wire",
  "base-url",
  "env-name",
  "label",
  "free-tier",
] as const;

export const BOOLEAN_FLAGS = [
  "json",
  "no-color",
  "no-pager",
  "no-follow",
  "all",
  "clear",
  "decompose",
  "no-key",
  "quiet",
  "help",
  "version",
] as const;

const SHORT_FLAGS: Record<string, string> = {
  p: "project",
  a: "assignee",
  m: "model",
  h: "help",
  v: "version",
  n: "limit",
  j: "json",
};

const valueFlagSet = new Set<string>(VALUE_FLAGS);
const booleanFlagSet = new Set<string>(BOOLEAN_FLAGS);

/** True when a token names a flag this program knows, so it cannot be a value. */
const isKnownFlag = (token: string): boolean => {
  if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) return false;
  const name = token.startsWith("--")
    ? token.slice(2).split("=", 1)[0]
    : token.slice(1, 2);
  return valueFlagSet.has(name) || booleanFlagSet.has(name);
};

export interface ParsedArgs {
  /** Non-flag words, in order. */
  positionals: string[];
  /** Repeated flag values, last wins. */
  flags: Map<string, string | true>;
  /** Everything that was not a recognised flag, rejoined. Used as a one-shot prompt. */
  prompt: string;
  /** True when the prompt came from `--prompt` or an explicit positional list. */
  explicitPrompt: boolean;
}

/**
 * Splits typed text into arguments the way a shell would, so an instruction
 * containing quotes survives: `fix the "foo bar" bug` stays one phrase.
 * The CLI normally gets this from argv; the board has to do it itself.
 */
export const tokenize = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const character of input) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started || current) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
  }
  if (started || current) tokens.push(current);
  return tokens;
};

export class UsageError extends Error {}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const promptParts: string[] = [];
  let explicitPrompt = false;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (passthrough) {
      positionals.push(argument);
      promptParts.push(argument);
      continue;
    }
    if (argument === "--") {
      passthrough = true;
      continue;
    }

    if (argument.startsWith("--") && argument.length > 2) {
      const body = argument.slice(2);
      const equals = body.indexOf("=");
      const name = equals === -1 ? body : body.slice(0, equals);
      const inline = equals === -1 ? undefined : body.slice(equals + 1);
      if (valueFlagSet.has(name)) {
        const next = argv[index + 1];
        const inline = equals === -1 ? undefined : body.slice(equals + 1);
        // A recognised flag name is never another flag's value: swallowing it
        // turns `--provider --paths src` into a provider called "--paths".
        if (inline === undefined && next !== undefined && isKnownFlag(next)) {
          throw new UsageError(`--${name} needs a value`);
        }
        const value = inline ?? next;
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        if (inline === undefined) index += 1;
        flags.set(name, value);
        continue;
      }
      if (booleanFlagSet.has(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
        flags.set(name, true);
        continue;
      }
      throw new UsageError(`Unknown option --${name}`);
    }

    if (argument.length > 1 && argument.startsWith("-") && !/^-\d/.test(argument)) {
      const letters = argument.slice(1).split("");
      for (const [index2, letter] of letters.entries()) {
        const name = SHORT_FLAGS[letter];
        if (!name) throw new UsageError(`Unknown option -${letter}`);
        if (booleanFlagSet.has(name)) {
          flags.set(name, true);
          continue;
        }
        const rest = letters.slice(index2 + 1).join("");
        const following = argv[index + 1];
        if (!rest && following !== undefined && isKnownFlag(following)) {
          throw new UsageError(`-${letter} needs a value`);
        }
        const value = rest || following;
        if (value === undefined) throw new UsageError(`-${letter} needs a value`);
        if (!rest) index += 1;
        flags.set(name, value);
        break;
      }
      continue;
    }

    positionals.push(argument);
    promptParts.push(argument);
  }

  const promptFlag = flags.get("prompt");
  if (typeof promptFlag === "string") {
    promptParts.unshift(promptFlag);
    explicitPrompt = true;
  }

  return { positionals, flags, prompt: promptParts.join(" ").trim(), explicitPrompt };
};

export const flagString = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

export const flagBool = (args: ParsedArgs, name: string): boolean => args.flags.get(name) === true;

export const flagList = (args: ParsedArgs, name: string): string[] => {
  const value = args.flags.get(name);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

export const flagNumber = (args: ParsedArgs, name: string, fallback: number): number => {
  const value = args.flags.get(name);
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new UsageError(`--${name} must be a number`);
  return parsed;
};

const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
};

/**
 * Scores a first word against the command names, so a typo can be pointed out.
 *
 * Only a single-edit slip is treated as certain: "hello" is two edits from
 * "help", and refusing to run a legitimate instruction over that would be worse
 * than saying nothing. Anything further is ambiguous, so the caller warns and
 * carries on rather than blocking real work.
 */
export type TypoVerdict = { word: string; suggestion: string; confident: boolean } | undefined;

export const isLikelyTypo = (word: string, candidates: Iterable<string>): TypoVerdict => {
  if (word.length < 4) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = distance(word, candidate);
    if (score < bestDistance) {
      bestDistance = score;
      best = candidate;
    }
  }
  // Beyond two edits the resemblance is coincidence, not a slip.
  if (!best || bestDistance > 2) return undefined;
  return { word, suggestion: best, confident: bestDistance === 1 };
};