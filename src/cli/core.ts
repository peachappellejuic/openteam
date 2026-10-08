import type { Change, Task, AppEvent } from "../types.js";
import type { JsonStore } from "../store.js";
import type { Orchestrator } from "../orchestrator.js";
import type { SecretStore } from "../secrets.js";
import type { ProjectPointer } from "./current.js";
import type { ProviderId } from "../types.js";
import { LineWriter, Spinner, renderEvent, waitForTasks } from "./events.js";
import { UsageError } from "./args.js";
import { knownProviderIds } from "../providers.js";
import { TERMINAL_TASK_STATUSES, dim, gray, red } from "./format.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface Session {
  store: JsonStore;
  orchestrator: Orchestrator;
  out: NodeJS.WriteStream;
  err: NodeJS.WriteStream;
  json: boolean;
  pager: boolean;
  secrets: SecretStore;
  /** Which repository to use when the working directory holds none. */
  pointer?: ProjectPointer;
}

/** stdout is reserved for results; progress and diagnostics go to stderr. */
export const note = (session: Session, message: string): void => {
  if (!session.json) session.err.write(`${gray(message)}\n`);
};

export const say = (session: Session, text: string): void => {
  if (text) session.out.write(`${text}\n`);
};

/** Emits JSON when the session is in machine mode, otherwise the rendered text. */
export const emit = (session: Session, payload: unknown, render: () => string): void => {
  if (session.json) {
    session.out.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  say(session, render());
};

export const fail = (session: Session, message: string, code: number = EXIT_FAILURE): number => {
  if (session.json) session.out.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  else session.err.write(`${red("error")} ${message}\n`);
  return code;
};

export interface DiffStat {
  files: string[];
  added: number;
  removed: number;
}

export const diffStat = (diff: string): DiffStat => {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    // The +++/--- header lines are not content changes and must not be counted.
    if (line.startsWith("+++ b/")) files.push(line.slice(6));
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { files, added, removed };
};

/**
 * Streams events for the given tasks until every one of them settles.
 * `parked` marks a task that cannot progress on its own — a plan step waiting on
 * an upstream change that still needs review — so following a chain terminates
 * instead of blocking on work only a human can unblock.
 */
export const followTasks = async (
  session: Session,
  taskIds: string[],
  options: { quiet?: boolean; signal?: AbortSignal; parked?: (task: Task) => boolean } = {},
): Promise<Map<string, Task>> => {
  const lines = new LineWriter((line) => session.out.write(`${dim(line)}\n`));
  const spinner = new Spinner(session.out, "agents are working");
  let streaming = false;

  const onEvent = (event: AppEvent): void => {
    if (event.type === "agent.output") {
      spinner.pause();
      lines.push(`${event.message}\n`);
      streaming = true;
      return;
    }
    if (streaming) {
      lines.flush();
      streaming = false;
    }
    spinner.pause();
    if (options.quiet) return;
    const rendered = renderEvent(event);
    if (rendered) session.out.write(`${rendered}\n`);
  };

  const settled = options.parked
    ? (task: Task): boolean => TERMINAL_TASK_STATUSES.has(task.status) || options.parked!(task)
    : undefined;

  spinner.start();
  try {
    return await waitForTasks(session.store, taskIds, { onEvent, signal: options.signal, settled });
  } finally {
    lines.flush();
    spinner.stop();
  }
};

const fuzzyMatch = <T extends { id: string }>(
  candidates: T[],
  reference: string,
  describe: (item: T) => string,
): T => {
  const needle = reference.toLowerCase();
  const matches = candidates.filter(
    (item) => item.id.startsWith(reference) || describe(item).toLowerCase().includes(needle),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UsageError(`"${reference}" matches ${matches.length}: ${matches.map((item) => item.id).join(", ")}`);
  }
  throw new UsageError(`No match for "${reference}"`);
};

const allTasks = (session: Session): Task[] =>
  session.store.listProjects().flatMap((project) => session.store.listTasks(project.id));

const allChanges = (session: Session): Change[] =>
  session.store.listProjects().flatMap((project) => session.store.listChanges(project.id));

export const resolveTask = (session: Session, reference: string): Task => {
  const direct = session.store.getTask(reference);
  if (direct) return direct;
  return fuzzyMatch(allTasks(session), reference, (task) => task.title);
};

export const resolveChange = (session: Session, reference: string): Change => {
  const direct = session.store.getChange(reference);
  if (direct) return direct;
  return fuzzyMatch(allChanges(session), reference, (change) => change.summary);
};

export const changeForTask = (session: Session, task: Task): Change | undefined =>
  session.store.listChanges(task.projectId).find((change) => change.taskId === task.id);

/** Derives a one-line task title from a free-form instruction. */
export const titleFromPrompt = (prompt: string): string => {
  const firstLine = prompt.split("\n").map((line) => line.trim()).find(Boolean) ?? prompt.trim();
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const candidate = firstSentence.length > 72 ? `${firstSentence.slice(0, 71)}…` : firstSentence;
  return candidate.trim() || "Untitled task";
};

export const parseProviderId = (value: string | undefined): ProviderId | undefined => {
  if (!value) return undefined;
  const known = knownProviderIds();
  if (!known.includes(value)) {
    throw new UsageError(
      `Unknown provider "${value}". Known: ${known.join(", ")}. Add one with \`openteam provider add\`.`,
    );
  }
  return value;
};

export const count = (total: number, singular: string, pluralForm = `${singular}s`): string =>
  `${total} ${total === 1 ? singular : pluralForm}`;