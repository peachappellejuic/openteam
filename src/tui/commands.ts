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

  const prefix: TuiCommand[] = [];
  const contains: TuiCommand[] = [];
  for (const command of TUI_COMMANDS) {
    if (command.name.startsWith(query)) prefix.push(command);
    else if (command.name.includes(query)) contains.push(command);
  }
  // No truncation here: the renderer bounds what it can show and reports the
  // true total, so a list never quietly hides commands.
  return [...prefix, ...contains].slice(0, limit);
};

export const commandUsage = (name: string): string | undefined =>
  TUI_COMMANDS.find((command) => command.name === name)?.usage;

export const commandNames = (): string[] => TUI_COMMANDS.map((command) => command.name);