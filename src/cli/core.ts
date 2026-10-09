import type { Change, Task, AppEvent } from "../types.js";
import type { JsonStore } from "../store.js";
import type { Orchestrator } from "../orchestrator.js";
import type { SecretStore } from "../secrets.js";
import type { ProjectPointer } from "./current.js";
import type { ProviderId } from "../types.js";
import { LineWriter, Spinner, renderEvent, waitForTasks } from "./events.js";
import { UsageError } from "./args.js";
import { getAdapter, knownProviderIds } from "../providers.js";
import { CLI_PROVIDER_SET } from "../types.js";
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

/**
 * The one provider a command takes.
 *
 * Used where there can only be one: a plan already splits the work into several
 * tasks, so fanning each of those out again would multiply both.
 */
export const parseProviderId = (value: string | undefined): ProviderId | undefined => {
  if (!value) return undefined;
  if (value.trim() === PROVIDER_ALL || value.includes(",")) {
    throw new UsageError(
      `\`--provider ${value.trim()}\` applies to a single instruction, not to \`openteam plan\`. Name one provider there, and use the list form when queueing an instruction.`,
    );
  }
  const known = knownProviderIds();
  if (!known.includes(value)) {
    throw new UsageError(
      `Unknown provider "${value}". Known: ${known.join(", ")}. Add one with \`openteam provider add\`.`,
    );
  }
  return value;
};

/**
 * Checks a `--provider` value without probing anything.
 *
 * Used for the up-front validation of every command, where spawning `--version`
 * per agent would be rude. `resolveProviders` does the real work, including
 * finding out who is installed.
 */
export const validateProviderValue = (value: string | undefined): void => {
  if (!value) return;
  if (value.trim() === PROVIDER_ALL) return;
  const names = splitList(value);
  if (!names.length) {
    throw new UsageError(`\`--provider ${value}\` names no provider.`);
  }
  const known = knownProviderIds();
  for (const name of names) {
    if (!known.includes(name)) {
      throw new UsageError(
        `Unknown provider "${name}". Known: ${known.join(", ")}. Add one with \`openteam provider add\`.`,
      );
    }
  }
};

/** `--provider all`: run one copy of the instruction on every installed agent. */
export const PROVIDER_ALL = "all";

/**
 * Agents excluded from `--provider all`.
 *
 * `mock` writes a placeholder instead of doing any work, so fanning it out would
 * just produce several copies of nothing. `custom` is whatever command the user
 * already pointed at, which is very often one of the others; they name it when
 * they mean it.
 */
const NOT_FANOUT: ReadonlySet<string> = new Set(["mock", "custom"]);

/**
 * Turns a `--provider` value into the concrete ids to run.
 *
 * Accepts one id, a comma-separated list, or `all`. `all` means every installed
 * agent CLI: the direct API providers are left out because each one is billed per
 * token and does not run the same tool loop, so they stay opt-in by name. Listing
 * which agents are installed costs one `--version` probe each, so the result is
 * worth caching and callers pass a memoised probe.
 */
export const resolveProviders = async (
  value: string | undefined,
  probe: (id: ProviderId) => Promise<boolean>,
): Promise<ProviderId[]> => {
  if (!value) return [];
  const known = knownProviderIds();
  const unknown = (name: string): never => {
    throw new UsageError(
      `Unknown provider "${name}". Known: ${known.join(", ")}. Add one with \`openteam provider add\`.`,
    );
  };

  if (value.trim() === PROVIDER_ALL) {
    const candidates = known.filter((id) => CLI_PROVIDER_SET.has(id) && !NOT_FANOUT.has(id));
    const available = await Promise.all(
      candidates.map(async (id) => ((await probe(id)) ? id : undefined)),
    );
    const installed = available.filter((id): id is string => Boolean(id));
    if (!installed.length) {
      throw new UsageError(
        `No agent CLI is installed, so \`--provider all\` has nothing to run. Install one (codex, claude, opencode, hermes, antigravity) or name a provider with \`--provider <id>\`.`,
      );
    }
    return installed;
  }

  const names = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!names.length) return [];
  return names.map((name) => {
    if (!known.includes(name)) return unknown(name);
    return name;
  });
};

/** One task's worth of instruction, before providers are chosen. */
export interface InstructionInput {
  title: string;
  description: string;
  provider?: string;
  model?: string;
  /** A second opinion on the diff; must differ from `provider`. */
  reviewer?: string;
  reviewModel?: string;
  assignee?: string;
  allowedPaths: string[];
  dependencies?: string[];
  acceptanceTests?: string[];
  verifyCommand?: string;
}

/**
 * Whether an agent is installed.
 *
 * Memoised because it costs one `--version` spawn per agent, and a fan-out asks
 * the same question for every candidate while building one instruction.
 */
const availability = new Map<ProviderId, Promise<boolean>>();

export const agentIsAvailable = (id: ProviderId): Promise<boolean> => {
  const cached = availability.get(id);
  if (cached) return cached;
  const probe = Promise.resolve(getAdapter(id)?.isAvailable() ?? false).catch(() => false);
  availability.set(id, probe);
  return probe;
};

/** Forgets cached probes, so a newly installed agent is noticed without a restart. */
export const forgetAvailability = (): void => availability.clear();

export const queueSummary = (tasks: Task[]): string => {
  if (tasks.length === 1) return `queued ${tasks[0]!.id}`;
  const agents = [...new Set(tasks.map((task) => task.provider))];
  return `queued ${tasks.length} tasks across ${agents.join(", ")}`;
};

/**
 * What a fan-out will not do the way the user might expect.
 *
 * Copies that declare the same paths collide by design, so the orchestrator runs
 * them one at a time; worth saying now rather than letting them wait on a
 * concurrency limit that is really a scope conflict.
 */
export const fanoutCaveats = (tasks: Task[], input: InstructionInput): string[] => {
  if (tasks.length < 2) return [];
  const warnings: string[] = [];
  if (input.allowedPaths.length) {
    warnings.push(
      `every copy declares --paths ${input.allowedPaths.join(", ")}, so they will run one at a time to avoid clashing; drop --paths to have them work in parallel`,
    );
  }
  if (input.dependencies?.length) {
    warnings.push("only the first copy waits on --depends");
  }
  warnings.push("review each diff and merge the one you want; merging two will conflict");
  return warnings;
};

/** How a fan-out is labelled, so the copies are tellable apart in the board. */
export const fanoutTitle = (title: string, provider: string, total: number): string => {
  if (total === 1) return title;
  const suffix = ` (${provider})`;
  const room = Math.max(12, 72 - suffix.length);
  return `${title.length > room ? `${title.slice(0, room - 1)}…` : title}${suffix}`;
};

/**
 * Queues one instruction, on as many agents as it names.
 *
 * This is the single place a task is created from typed text, so the CLI, the
 * line-based session, and the TUI all fan out identically instead of each
 * growing its own idea of what `--provider all` means.
 */
export const submitInstruction = async (
  session: Session,
  projectId: string,
  input: InstructionInput,
  probe: (id: ProviderId) => Promise<boolean>,
  options: { dispatch?: boolean } = {},
): Promise<Task[]> => {
  const providers = await resolveProviders(input.provider, probe);
  // One task when nothing was named, so an unqualified instruction behaves as it
  // always did: the orchestrator picks the default.
  const chosen = providers.length ? providers : [undefined];
  // A reviewer must not be asked to review its own work; with a fan-out that
  // applies to whichever copy the reviewer happens to have written.
  if (input.reviewer) {
    const same = chosen.filter((provider) => provider === input.reviewer);
    if (same.length === chosen.length && chosen.length === 1) {
      throw new UsageError(
        `\`--reviewer ${input.reviewer}\` is the same as \`--provider ${input.reviewer}\`, so it would be reviewing its own work. Pick another reviewer, or run the agent without one.`,
      );
    }
  }

  const tasks: Task[] = [];
  for (const provider of chosen) {
    const task = await session.orchestrator.createTask(
      projectId,
      {
        ...input,
        title: fanoutTitle(input.title, provider ?? "", chosen.length),
        provider: provider as Task["provider"],
        dependencies: provider === chosen[0] ? input.dependencies : [],
      },
      { dispatch: options.dispatch ?? true },
    );
    tasks.push(task);
  }
  return tasks;
};

/** Splits a comma separated flag value, trimming blanks away. */
export const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const count = (total: number, singular: string, pluralForm = `${singular}s`): string =>
  `${total} ${total === 1 ? singular : pluralForm}`;