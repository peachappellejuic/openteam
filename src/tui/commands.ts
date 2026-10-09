/**
 * The commands the interactive board accepts after `/`.
 *
 * This list exists to be shown, not to be dispatched: `app.ts` still switches on
 * the name. A test runs every entry with no arguments and fails if any is
 * reported as unknown, so the palette cannot quietly drift from what works.
 */
export interface TuiCommand {
  name: string;
  /** Shown dimmed after the name, so the shape of the argument is obvious. */
  usage: string;
  summary: string;
  group: "work" | "review" | "setup" | "leave";
}

export const TUI_COMMANDS: TuiCommand[] = [
  { name: "help", usage: "", summary: "list commands", group: "work" },
  { name: "tasks", usage: "", summary: "show tasks, back to the task pane", group: "work" },
  { name: "changes", usage: "", summary: "show changes, back to the change pane", group: "review" },
  { name: "diff", usage: "[change-id]", summary: "show a diff", group: "review" },
  { name: "approve", usage: "<change-id>", summary: "approve a change for merge", group: "review" },
  { name: "merge", usage: "<change-id>", summary: "merge into the managed mirror", group: "review" },
  { name: "cancel", usage: "<task-id>", summary: "abort a running task", group: "work" },
  { name: "sync", usage: "", summary: "fetch the source branch", group: "work" },
  { name: "push", usage: "[branch]", summary: "publish the mirror branch to origin", group: "work" },
  { name: "init", usage: "[path]", summary: "connect a repository", group: "setup" },
  { name: "providers", usage: "", summary: "agents available on PATH", group: "setup" },
  { name: "provider", usage: "", summary: "set a key, or add a provider", group: "setup" },
  { name: "keys", usage: "", summary: "provider keys and their free tiers", group: "setup" },
  { name: "repl", usage: "", summary: "switch to the line-based session", group: "setup" },
  { name: "quit", usage: "", summary: "leave the board", group: "leave" },
];

export const GROUP_LABEL: Record<TuiCommand["group"], string> = {
  work: "work",
  review: "review",
  setup: "setup",
  leave: "leave",
};

/**
 * Matches a partially typed command.
 *
 * A prefix match is what you almost always want, so it sorts first; a substring
 * match still finds `/cancel` from `/ance`. Ranking is stable so the list does
 * not shuffle between keystrokes.
 */
export const filterCommands = (typed: string, limit = 100): TuiCommand[] => {
  const query = typed.replace(/^\//, "").trim().toLowerCase();
  if (!query) return TUI_COMMANDS.slice(0, limit);

  const exact: TuiCommand[] = [];
  const prefix: TuiCommand[] = [];
  const contains: TuiCommand[] = [];
  for (const command of TUI_COMMANDS) {
    if (command.name === query) exact.push(command);
    else if (command.name.startsWith(query)) prefix.push(command);
    else if (command.name.includes(query)) contains.push(command);
  }
  // An exact name wins outright: typing `/provider` must not offer `/providers`
  // first. No truncation here — the renderer bounds what it can show and reports
  // the true total, so a list never quietly hides commands.
  return [...exact, ...prefix, ...contains].slice(0, limit);
};

export const commandUsage = (name: string): string | undefined =>
  TUI_COMMANDS.find((command) => command.name === name)?.usage;

export const commandNames = (): string[] => TUI_COMMANDS.map((command) => command.name);

/** The command a line names outright, if any. */
export const exactCommand = (input: string): string | undefined => {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return undefined;
  const name = trimmed.slice(1);
  return commandNames().includes(name) ? name : undefined;
};

// --- completion detection ----------------------------------------------------

/** Flags whose value is a provider id, so one list serves both. */
export const PROVIDER_FLAGS = ["--provider", "--coordinator"] as const;

export type CompletionKind = "command" | "provider";

export interface CompletionRequest {
  kind: CompletionKind;
  /** The part of the input kept when a value is inserted. */
  keep: string;
  /** What the user has typed of the value, without the flag. */
  query: string;
  /** Index in the input where the chosen value replaces from. */
  replaceFrom: number;
}

/**
 * Works out what the prompt is asking for and where the answer belongs.
 *
 * Two contexts: a leading `/` names a command, and a trailing `--provider` or
 * `--coordinator` names a provider. Returning a replacement offset rather than a
 * rewritten string keeps the caller from re-parsing, which is where completion
 * usually goes wrong.
 */
export const detectCompletion = (input: string): CompletionRequest | undefined => {
  if (input.startsWith("/") && !input.slice(1).includes(" ")) {
    return { kind: "command", keep: "", query: input.slice(1), replaceFrom: 0 };
  }

  // The last flag on the line wins, and the query is the last token after it, so
  // completing `--provider groq` and then typing more keeps filtering instead of
  // closing the dropdown.
  const pattern = new RegExp(`(${PROVIDER_FLAGS.join("|")})(?!\\S)`);
  let found: RegExpExecArray | null = null;
  for (const match of input.matchAll(new RegExp(pattern.source, "g"))) found = match;
  if (found) {
    const tail = input.slice((found.index ?? 0) + found[1].length).trim();
    const query = tail ? (tail.split(/\s+/).pop() ?? "") : "";
    const replaceFrom = input.length - query.length;
    const keep = input.slice(0, replaceFrom);
    return {
      kind: "provider",
      // The flag may have been typed with no trailing space yet; the inserted
      // value must not run into it.
      keep: keep.endsWith(" ") ? keep : `${keep} `,
      query,
      replaceFrom,
    };
  }

  return undefined;
};

export interface PromptOption {
  /** The text inserted when chosen. */
  value: string;
  /** Dimmed after the value, to show the shape of the argument. */
  usage: string;
  summary: string;
  /** False when the option cannot be used right now. */
  usable: boolean;
}

/** Usable options first, stable order within each group so nothing reshuffles. */
export const filterPromptOptions = (options: PromptOption[], query: string): PromptOption[] => {
  const needle = query.trim().toLowerCase();
  const matches = needle ? options.filter((option) => option.value.toLowerCase().includes(needle)) : options;
  return [...matches.filter((option) => option.usable), ...matches.filter((option) => !option.usable)];
};