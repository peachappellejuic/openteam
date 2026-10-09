#!/usr/bin/env node
import { mkdirSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planWithModel } from "./api/planner.js";
import { providerRegistry } from "./providers-registry.js";
import { API_PROVIDERS, isLoopbackUrl, type ApiProviderEntry } from "./api/registry.js";
import { config } from "./config.js";
import { getRepositoryInfo, pushMirrorBranch, syncBareMirror } from "./git.js";
import { Orchestrator } from "./orchestrator.js";
import { apiClientFor } from "./providers.js";
import { startAppServer } from "./server.js";
import { createStore } from "./store.js";
import { redact, SecretStore } from "./secrets.js";
import { type Change, type PlanTaskInput, type Project, type ProviderId, type Task } from "./types.js";
import { flagBool, flagList, flagNumber, flagString, isLikelyTypo, parseArgs, UsageError, type ParsedArgs } from "./cli/args.js";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  changeForTask,
  count,
  diffStat,
  emit,
  fail,
  followTasks,
  agentIsAvailable,
  fanoutCaveats,
  note,
  parseProviderId,
  queueSummary,
  resolveChange,
  resolveTask,
  submitInstruction,
  titleFromPrompt,
  validateProviderValue,
  type Session,
} from "./cli/core.js";
import {
  badge,
  bold,
  colorEnabledForStream,
  cyan,
  dim,
  green,
  gray,
  red,
  relativeTime,
  setColor,
  shortSha,
  table,
  TERMINAL_TASK_STATUSES,
  truncate,
  yellow,
} from "./cli/format.js";
import { helpText, VERSION } from "./cli/help.js";
import { connectRepository, ProjectNotFoundError, resolveExplicitProject, selectProject } from "./cli/project.js";
import { pointerPath, ProjectPointer } from "./cli/current.js";
import {
  CHANGE_COLUMNS,
  KEY_COLUMNS,
  PROVIDER_COLUMNS,
  TASK_COLUMNS,
  changeHeader,
  colorizeDiff,
  hint,
  page,
  renderChangeRows,
  keyRows,
  renderKeyRows,
  renderProviderRows,
  renderTaskRows,
  taskDetail,
  type KeyRow,
} from "./cli/render.js";
import { startRepl } from "./cli/repl.js";
import { runTui } from "./tui/app.js";

type CommandHandler = (session: Session, args: ParsedArgs, rest: string[], signal: AbortSignal) => Promise<number>;

const ACTIVE_STATUSES = ["queued", "running", "blocked", "review"];
const REVIEWABLE = ["pending", "approved", "conflict"];

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(process.cwd(), path));

/**
 * The project a command acts on: the working directory when it holds a
 * repository, otherwise the pinned default. Acting outside the current checkout
 * says so, and using a repository from its own directory remembers it.
 */
const requireProject = async (session: Session, args: ParsedArgs): Promise<Project> => {
  const explicit = flagString(args, "project");
  const outcome = await selectProject(session.orchestrator, {
    explicit,
    cwd: process.cwd(),
    create: true,
    pinned: session.pointer?.pinned,
    log: (message) => note(session, message),
  });
  if (outcome.note) note(session, outcome.note);
  if (!explicit && outcome.source === "cwd" && session.pointer) session.pointer.pin(outcome.project.id);
  return outcome.project;
};

const visibleTasks = (tasks: Task[], args: ParsedArgs): Task[] => {
  const status = flagString(args, "status");
  let filtered = status ? tasks.filter((task) => task.status === status) : tasks;
  if (!status && !flagBool(args, "all")) filtered = filtered.filter((task) => ACTIVE_STATUSES.includes(task.status));
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

const visibleChanges = (changes: Change[], args: ParsedArgs): Change[] => {
  const status = flagString(args, "status");
  let filtered = status ? changes.filter((change) => change.status === status) : changes;
  if (!status && !flagBool(args, "all")) filtered = filtered.filter((change) => REVIEWABLE.includes(change.status));
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

const diffHeader = (change: Change, project: Project): string => {
  const stat = diffStat(change.diff);
  return [
    changeHeader(change, project.name),
    `${dim("files")}  ${stat.files.length ? stat.files.join(", ") : "-"}`,
    `${dim("lines")}  ${green(`+${stat.added}`)} ${red(`-${stat.removed}`)}`,
  ].join("\n");
};

interface RunOptions {
  showDiff: boolean;
  signal?: AbortSignal;
}

/**
 * Follows tasks to completion and reports each outcome.
 * Tasks that land in review print their diff so the work can be judged in the terminal.
 */
/** How a change stands right now, so nothing is described as pending once merged. */
const changeStatusLabel = (change: Change): string => {
  if (change.status === "merged") return green(`merged ${shortSha(change.mergedSha ?? "")}`);
  if (change.status === "approved") return yellow("approved, ready to merge");
  if (change.status === "conflict") return red(`conflict  ${change.error ?? ""}`.trimEnd());
  return yellow("review");
};

const runTasks = async (session: Session, tasks: Task[], options: RunOptions): Promise<number> => {
  // A plan step is only unblocked once its dependency has been merged, so the
  // chain stops following at the first step that needs a human decision.
  const parked = (task: Task): boolean =>
    task.dependencies.some((dependency) => session.store.getTask(dependency)?.status !== "completed");

  await followTasks(session, tasks.map((task) => task.id), {
    quiet: session.json,
    signal: options.signal,
    parked,
  });
  if (!session.json) session.out.write("\n");

  // Re-read from the store: an interrupted follow leaves the snapshots above stale.
  const finalTasks = tasks.map((task) => session.store.getTask(task.id) ?? task);
  let exitCode = EXIT_OK;

  for (const task of finalTasks) {
    // Looked up by task, not by status: merging completes the task, so a change
    // that has already been merged would otherwise be reported as "no changes".
    const change = changeForTask(session, task);
    emit(session, { task, change: change ?? null }, () => {
      const lines = [`${bold(task.title)}  ${dim(task.id)}`];
      if (change) {
        const stat = diffStat(change.diff);
        lines.push(`${changeStatusLabel(change)}  ${change.summary}`);
        lines.push(`${dim("branch")} ${change.branch}  ${dim(`${shortSha(change.baseSha)} → ${shortSha(change.commitSha)}`)}`);
        lines.push(`${dim("files")} ${count(stat.files.length, "file")}  ${green(`+${stat.added}`)} ${red(`-${stat.removed}`)}`);
        if (change.review) {
          const who = `${change.review.provider}${change.review.model ? `/${change.review.model}` : ""}`;
          lines.push(`${dim("review")} ${change.review.verdict} by ${who}${change.review.autoApproved ? " (auto-approved)" : ""}`);
          for (const reason of change.review.reasons) lines.push(dim(`  ${reason}`));
        }
      } else if (task.status === "completed") {
        lines.push(`${green("done")}  the agent reported no file changes`);
      } else if (task.status === "failed") {
        lines.push(`${red("failed")}  ${task.error ?? "unknown error"}`);
      } else if (task.status === "cancelled") {
        lines.push(gray("cancelled"));
      } else {
        lines.push(`${badge(task.status)}  ${dim("waiting for an earlier change to be merged")}`);
      }
      return lines.join("\n");
    });

    if (task.status === "failed" || task.status === "cancelled") exitCode = EXIT_FAILURE;
    if (change && options.showDiff) {
      const project = session.store.getProject(task.projectId);
      if (project && !session.json) {
        await page(colorizeDiff(`\n${diffHeader(change, project)}\n\n${change.diff}`));
        // Only suggest a merge that has not happened: an auto-approved change is
        // already in the mirror by the time anyone reads this.
        if (change.status === "pending") {
          note(session, `next  openteam approve ${change.id} && openteam merge ${change.id}`);
        } else if (change.status === "approved") {
          note(session, `next  openteam merge ${change.id}`);
        } else if (change.status === "merged") {
          note(session, `merged as ${shortSha(change.mergedSha ?? "")}  \u00b7  publish with: openteam push`);
        }
      }
    }
  }

  const waiting = finalTasks.filter(
    (task) =>
      !TERMINAL_TASK_STATUSES.has(task.status) &&
      task.dependencies.some((dependency) => session.store.getTask(dependency)?.status !== "completed"),
  );
  if (waiting.length && !session.json) {
    note(
      session,
      `${count(waiting.length, "task")} waiting on an earlier change: merge it, then run \`openteam watch\` to continue the chain.`,
    );
  }
  reportDeferrals(session, finalTasks);
  return exitCode;
};

/**
 * Explains work that was held back rather than started, so a task sitting in
 * `queued` is never silently waiting on a slot or a colliding peer.
 *
 * Read from the persisted event log rather than the orchestrator's live map: a
 * deferral is usually recorded before the client subscribes to follow the run,
 * and the in-memory reason is cleared as soon as the task finally completes.
 */
const reportDeferrals = (session: Session, tasks: Task[]): void => {
  if (session.json) return;
  const projectId = tasks[0]?.projectId;
  if (!projectId) return;
  const wanted = new Set(tasks.map((task) => task.id));
  const latest = new Map<string, string>();
  for (const event of session.store.listEvents(projectId)) {
    if (event.type !== "task.deferred" || !event.taskId || !wanted.has(event.taskId)) continue;
    latest.set(event.taskId, event.message);
  }
  if (!latest.size) return;

  // Still-waiting tasks get their specific reason; the rest only get a count,
  // because a wait that resolved needs no individual explanation.
  const stuck = [...latest].filter(([taskId]) => {
    const task = session.store.getTask(taskId);
    return task && !TERMINAL_TASK_STATUSES.has(task.status);
  });
  for (const [taskId, reason] of stuck) {
    note(session, `${gray("waiting")} ${session.store.getTask(taskId)?.title}: ${reason}`);
  }
  const resolved = latest.size - stuck.length;
  if (resolved > 0) {
    note(session, gray(`${resolved} of ${tasks.length} tasks waited for a free slot or a conflicting peer`));
  }
  for (const { left, right } of session.orchestrator.collisions(projectId)) {
    note(session, `${gray("note")} ${left.title} and ${right.title} share files; only one runs at a time`);
  }
};


const taskInput = (args: ParsedArgs, prompt: string) => ({
  title: flagString(args, "title") ?? titleFromPrompt(prompt),
  description: prompt,
  provider: flagString(args, "provider"),
  model: flagString(args, "model"),
  reviewer: flagString(args, "reviewer"),
  reviewModel: flagString(args, "review-model"),
  assignee: flagString(args, "assignee"),
  dependencies: flagList(args, "depends"),
  allowedPaths: flagList(args, "paths"),
  acceptanceTests: [] as string[],
  verifyCommand: flagString(args, "verify"),
});

const oneShot = async (session: Session, args: ParsedArgs, prompt: string, signal: AbortSignal): Promise<number> => {
  const project = await requireProject(session, args);
  note(session, `${project.name} on ${project.defaultBranch}`);
  // Without follow-up there is nothing to supervise, so the task stays queued
  // for `openteam run` or `openteam watch` instead of starting and being cancelled.
  const detach = flagBool(args, "no-follow");
  const tasks = await submitInstruction(session, project.id, taskInput(args, prompt), agentIsAvailable, {
    dispatch: !detach,
  });
  note(session, queueSummary(tasks));
  for (const warning of fanoutCaveats(tasks, taskInput(args, prompt))) note(session, warning);
  if (detach) {
    emit(session, { tasks }, () => tasks.map((task) => `${task.id}  ${task.title}`).join("\n"));
    note(
      session,
      tasks.length === 1
        ? `start it later with: openteam run ${tasks[0]!.id}`
        : `start them later with: openteam watch   (or one at a time: openteam run ${tasks[0]!.id})`,
    );
    return EXIT_OK;
  }
  return runTasks(session, tasks, { showDiff: true, signal });
};

/** Queued, blocked, or already running work that a merge has just unblocked. */
const continuingTasks = (session: Session, projectId: string): Task[] =>
  session.store
    .listTasks(projectId)
    .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * Asks a model to turn a goal into a scoped task plan.
 *
 * Only decomposition is delegated: the returned plan is data, and the
 * deterministic orchestrator still decides what runs when. Requires a direct-API
 * provider, because an agent CLI cannot be asked for a structured plan.
 */
const decomposeGoal = async (
  session: Session,
  project: Project,
  goal: string,
  args: ParsedArgs,
): Promise<{ tasks: PlanTaskInput[]; notes?: string }> => {
  const providerId = flagString(args, "provider") ?? flagString(args, "coordinator") ?? "";
  const entry = providerRegistry().get(providerId);
  if (!entry) {
    throw new UsageError(
      `--decompose needs a direct API provider, for example: openteam plan "add caching" --decompose --provider groq`,
    );
  }
  if (entry.requiresKey && !session.secrets.getAny(entry.envNames)) {
    throw new UsageError(
      `No API key for ${entry.label}. Run \`openteam keys set ${entry.id}\`, or export ${entry.envNames[0]}.`,
    );
  }

  note(session, `${entry.label} is inspecting ${project.repositoryPath}`);
  const plan = await planWithModel({
    client: apiClientFor(entry, flagString(args, "model")),
    goal,
    repositoryPath: project.repositoryPath,
    maxTasks: flagNumber(args, "tasks", 8),
    onProgress: (line) => note(session, dim(line)),
  });

  emit(session, { plan }, () =>
    table(
      [{ header: "" }, { header: "TASK" }, { header: "SCOPE" }, { header: "AFTER" }],
      plan.tasks.map((task, index) => [
        index === 0 ? green("*") : " ",
        truncate(task.title, 56),
        dim(task.allowedPaths.join(" ") || "whole repository"),
        dim(task.dependsOn.map((value) => value + 1).join(", ") || "-"),
      ]),
    ),
  );

  return {
    tasks: plan.tasks.map((task) => ({
      title: task.title,
      description: task.description,
      allowedPaths: task.allowedPaths,
      dependsOn: task.dependsOn,
      verifyCommand: task.verifyCommand,
    })),
    notes: plan.notes,
  };
};

const need = (rest: string[], command: string): string => {
  const value = rest[0];
  if (!value) throw new UsageError(`${command} needs an id, for example: ${command} task_1234abcd`);
  return value;
};

/**
 * Reads a credential without echoing it. Values typed as arguments are refused
 * in favour of a prompt so keys stay out of shell history and the scrollback.
 */
const readSecretValue = async (prompt: string): Promise<string> => {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = internal._writeToOutput?.bind(rl);
    internal._writeToOutput = (text: string): void => {
      // Keep the prompt itself and the newline, echo nothing else.
      if (!original) return;
      original(text.includes("\n") ? text : "*");
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
  });
};

const unavailableDetail = (entry: ApiProviderEntry | undefined, id: string): string => {
  if (entry) {
    return entry.requiresKey
      ? `no key; set ${entry.envNames[0]}`
      : `${entry.baseUrlEnv} is unreachable or unset`;
  }
  return `${id} is not on PATH`;
};

const providerCommand = async (session: Session, args: ParsedArgs, rest: string[]): Promise<number> => {
  const registry = providerRegistry();
  const [subcommand = "list", ...rest2] = rest;

  if (subcommand === "add") {
    const reference = rest2[0];
    if (!reference) {
      return fail(
        session,
        "provider add needs a definition. Try: openteam provider add my-vllm --base-url http://127.0.0.1:8000 --wire openai",
        EXIT_USAGE,
      );
    }
    const definition = {
      id: reference,
      label: flagString(args, "label"),
      wire: flagString(args, "wire") ?? "openai",
      baseUrl: flagString(args, "base-url") ?? "",
      envName: flagString(args, "env-name"),
      defaultModel: flagString(args, "model"),
      freeTier: flagString(args, "free-tier"),
      requiresKey: !flagBool(args, "no-key"),
    };
    let saved;
    try {
      saved = registry.add(definition);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid definition";
      return fail(session, `${message}\n  Example: openteam provider add my-vllm --wire openai --base-url http://127.0.0.1:8000 --env-name VLLM_API_KEY`, EXIT_USAGE);
    }

    const overriding = API_PROVIDERS.some((entry) => entry.id === saved.id);
    // Show the merged entry, not the saved definition, so an override reports
    // the model and key variable it inherited.
    const merged = registry.get(saved.id);
    if (!merged) return fail(session, `\`${saved.id}\` was saved but could not be read back`, EXIT_FAILURE);
    emit(session, { provider: merged, path: registry.filePath, overriding }, () =>
      [
        `${green(overriding ? "updated" : "added")} ${bold(merged.id)}`,
        `${dim("wire")}    ${merged.wire}`,
        `${dim("url")}     ${merged.baseUrl}`,
        `${dim("key")}     ${merged.requiresKey ? merged.envNames[0] ?? "unset" : dim("not required")}`,
        `${dim("model")}   ${merged.defaultModel}`,
        "",
        dim(`saved in ${registry.filePath}`),
        merged.requiresKey
          ? dim(`set the key with: openteam keys set ${merged.id}`)
          : dim("no key needed"),
      ].join("\n"),
    );
    if (merged.requiresKey) {
      note(session, `to use it: openteam keys set ${merged.id} then openteam "task" --provider ${merged.id}`);
    }
    if (!isLoopbackUrl(merged.baseUrl)) {
      note(session, `note: ${merged.baseUrl} is not on this machine, so task output and source the agent reads will leave this computer`);
    }
    return EXIT_OK;
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const reference = rest2[0];
    if (!reference) return fail(session, `provider ${subcommand} needs an id`, EXIT_USAGE);
    const builtIn = API_PROVIDERS.some((entry) => entry.id === reference);
    const removed = registry.remove(reference);
    if (!removed) {
      return fail(
        session,
        builtIn
          ? `"${reference}" is built in and cannot be removed. Override it instead: openteam provider add ${reference} --base-url ...`
          : `No added provider called "${reference}"`,
        EXIT_USAGE,
      );
    }
    emit(session, { removed }, () => `${green("removed")} ${removed.id}`);
    if (builtIn) note(session, `"${removed.id}" is back to its built-in configuration`);
    return EXIT_OK;
  }

  if (subcommand !== "list" && subcommand !== "show") {
    return fail(session, `Unknown provider subcommand "${subcommand}". Try: list, add, remove`, EXIT_USAGE);
  }

  const entries = registry.entries();
  emit(session, { providers: entries, path: registry.filePath }, () =>
    table(
      [{ header: "" }, { header: "PROVIDER" }, { header: "SOURCE" }, { header: "WIRE" }, { header: "URL" }],
      entries.map((entry) => [
        registry.isUserDefined(entry.id) ? cyan("+") : " ",
        bold(entry.id),
        registry.isUserDefined(entry.id) ? cyan("added") : dim("built in"),
        dim(entry.wire),
        dim(isLoopbackUrl(entry.baseUrl) ? entry.baseUrl : `${entry.baseUrl} (remote)`),
      ]),
    ),
  );
  return EXIT_OK;
};

const keysCommand = async (session: Session, args: ParsedArgs, rest: string[]): Promise<number> => {
  const [subcommand = "list", ...rest2] = rest;
  const store = session.secrets;

  if (subcommand === "path") {
    emit(session, { path: store.filePath }, () => store.filePath);
    return EXIT_OK;
  }

  if (subcommand === "set") {
    const name = rest2[0];
    if (!name) {
      return fail(
        session,
        `keys set needs a provider, for example: openteam keys set ${providerRegistry().ids()[0]}`,
        EXIT_USAGE,
      );
    }
    const entry = providerRegistry().get(name);
    if (!entry) {
      return fail(
        session,
        `Unknown provider "${name}". Known: ${providerRegistry().ids().join(", ")}. Add one with \`openteam provider add\`.`,
        EXIT_USAGE,
      );
    }
    if (!entry.requiresKey) {
      return fail(session, `${entry.label} needs no key. Point ${entry.baseUrlEnv} at your server instead.`, EXIT_USAGE);
    }
    const value = rest2[1] ?? (await readSecretValue(`${entry.label} API key: `));
    try {
      store.set(entry.envNames[0], value);
    } catch (error) {
      return fail(session, error instanceof Error ? error.message : "could not store the key");
    }
    emit(session, { provider: entry.id, name: entry.envNames[0], value: redact(value), path: store.filePath }, () =>
      [
        `${green("stored")} ${entry.envNames[0]} ${dim(`(${redact(value)})`)}`,
        dim(`in ${store.filePath} (mode 0600); run \`openteam keys test ${entry.id}\` to check it`),
      ].join("\n"),
    );
    return EXIT_OK;
  }

  if (subcommand === "unset" || subcommand === "remove") {
    const name = rest2[0];
    if (!name) return fail(session, `keys ${subcommand} needs a provider name`, EXIT_USAGE);
    const entry = providerRegistry().get(name);
    if (!entry) return fail(session, `Unknown provider "${name}"`, EXIT_USAGE);
    const removed = [entry.envNames[0], ...entry.envNames.slice(1)].some((variable) => store.unset(variable));
    if (!removed) {
      return fail(session, `No stored key for ${entry.id}. Nothing to remove.`, EXIT_USAGE);
    }
    emit(session, { provider: entry.id, removed: true }, () => `${green("removed")} stored key for ${entry.id}`);
    note(session, `an exported ${entry.envNames[0]} still takes precedence`);
    return EXIT_OK;
  }

  if (subcommand === "test") {
    const requested = rest2.length ? rest2 : providerRegistry().ids();
    const results: Array<{ id: string; ok: boolean; detail: string }> = [];
    for (const id of requested) {
      const entry = providerRegistry().get(id);
      if (!entry) {
        results.push({ id, ok: false, detail: "unknown provider" });
        continue;
      }
      const found = store.getAny(entry.envNames);
      if (entry.requiresKey && !found) {
        results.push({ id, ok: false, detail: `no key; export ${entry.envNames[0]} or run \`openteam keys set ${id}\`` });
        continue;
      }
      const started = Date.now();
      try {
        await apiClientFor(entry).ping();
        results.push({ id, ok: true, detail: `${Date.now() - started}ms` });
      } catch (error) {
        results.push({ id, ok: false, detail: error instanceof Error ? error.message : "probe failed" });
      }
    }
    const failed = results.filter((result) => !result.ok);
    emit(session, { results }, () =>
      table(
        [{ header: "" }, { header: "PROVIDER" }, { header: "RESULT" }],
        results.map((result) => [
          result.ok ? green("ok") : yellow("!"),
          bold(result.id),
          dim(result.detail),
        ]),
      ),
    );
    return failed.length ? EXIT_FAILURE : EXIT_OK;
  }

  if (subcommand !== "list" && subcommand !== "show") {
    return fail(session, `Unknown keys subcommand "${subcommand}". Try: list, set, unset, path, test`, EXIT_USAGE);
  }

  const rows = keyRows(store);
  emit(session, { keys: rows, path: store.filePath }, () => {
    const table_ = table(KEY_COLUMNS, renderKeyRows(rows));
    const missing = rows.filter((row) => row.source === "missing" && !row.optional);
    return [
      table_,
      "",
      missing.length
        ? dim(`${missing.length} provider${missing.length === 1 ? "" : "s"} still need a key`)
        : dim("every provider that needs a key has one"),
      dim(`stored in ${store.filePath}; keys are also passed to agent CLIs (codex, claude, opencode, hermes, antigravity)`),
    ].join("\n");
  });
  return EXIT_OK;
};

const commands: Record<string, CommandHandler> = {
  async help(session) {
    session.out.write(helpText());
    return EXIT_OK;
  },

  async version(session) {
    emit(session, { version: VERSION }, () => VERSION);
    return EXIT_OK;
  },

  async repl(session, args) {
    if (!process.stdin.isTTY) {
      return fail(session, "repl needs a terminal", EXIT_USAGE);
    }
    return await startRepl(session, args);
  },

  async provider(session, args, rest) {
    return providerCommand(session, args, rest);
  },

  async keys(session, args, rest) {
    return keysCommand(session, args, rest);
  },

  async init(session, args, rest) {
    const project = await connectRepository(session.orchestrator, rest[0] ?? process.cwd(), {
      name: flagString(args, "name"),
      defaultBranch: flagString(args, "branch"),
      log: (message) => note(session, message),
    });
    // Explicitly connecting a repository makes it the default, so the next bare
    // `openteam` from anywhere acts on it.
    session.pointer?.pin(project.id);
    emit(session, { project, path: project.repositoryPath }, () =>
      [
        `${green("connected")} ${bold(project.name)}`,
        `${dim("path")}    ${project.repositoryPath}`,
        `${dim("mirror")}  ${project.managedRepositoryPath}`,
        `${dim("branch")}  ${project.defaultBranch}`,
        dim(`now the default; run \`openteam "${project.name}" work\` from anywhere`),
      ].join("\n"),
    );
    return EXIT_OK;
  },

  async use(session, args, rest) {
    const pointer = session.pointer;
    if (!pointer) return fail(session, "No data directory to record a default in", EXIT_FAILURE);

    if (flagBool(args, "clear") || rest[0] === "--clear" || rest[0] === "none") {
      pointer.clear();
      emit(session, { pinned: null }, () => "cleared; openteam now follows your working directory");
      return EXIT_OK;
    }

    if (flagBool(args, "all") || !rest.length) {
      const projects = session.orchestrator.listProjects();
      if (!projects.length) return fail(session, "No repositories are connected yet. Try `openteam init <path>`.", EXIT_USAGE);
      const pinned = pointer.pinned;
      emit(session, { pinned, projects }, () =>
        table(
          [{ header: "" }, { header: "NAME" }, { header: "BRANCH" }, { header: "PATH" }, { header: "ID" }],
          projects.map((project) => [
            pinned === project.id ? green("*") : " ",
            bold(project.name),
            dim(project.defaultBranch),
            dim(project.repositoryPath),
            dim(project.id),
          ]),
        ),
      );
      note(session, pinned ? `default is ${pinned}` : "no default set; the working directory is used when it holds a repository");
      return EXIT_OK;
    }

    const project = resolveExplicitProject(session.orchestrator, rest.join(" "));
    pointer.pin(project.id);
    emit(session, { project }, () =>
      [
        `${green("default")} ${bold(project.name)} ${dim(project.repositoryPath)}`,
        dim("openteam will use this when your working directory is not a repository"),
      ].join("\n"),
    );
    return EXIT_OK;
  },

  async projects(session) {
    const projects = session.orchestrator.listProjects();
    emit(session, { projects }, () =>
      projects.length
        ? table(
            [{ header: "NAME" }, { header: "BRANCH" }, { header: "CREATED" }, { header: "PATH" }, { header: "ID" }],
            projects.map((project) => [
              bold(project.name),
              dim(project.defaultBranch),
              dim(relativeTime(project.createdAt)),
              dim(project.repositoryPath),
              dim(project.id),
            ]),
          )
        : "",
    );
    return EXIT_OK;
  },

  async providers(session) {
    const providers = await session.orchestrator.getProviders();
    emit(session, { providers }, () => table(PROVIDER_COLUMNS, renderProviderRows(providers)));
    return EXIT_OK;
  },

  async plan(session, args, rest, signal) {
    const goal = rest.join(" ").trim() || args.prompt;
    if (!goal) throw new UsageError('plan needs a goal, for example: openteam plan "add caching to the resolver"');
    const project = await requireProject(session, args);

    let supplied: PlanTaskInput[] | undefined;
    let notes: string | undefined;
    if (flagBool(args, "decompose")) {
      const outcome = await decomposeGoal(session, project, goal, args);
      supplied = outcome.tasks;
      notes = outcome.notes;
    }

    const tasks = await session.orchestrator.createPlan(project.id, {
      goal,
      tasks: supplied,
      provider: parseProviderId(flagString(args, "provider")),
      model: flagString(args, "model"),
      reviewer: parseProviderId(flagString(args, "reviewer")),
      reviewModel: flagString(args, "review-model"),
      assignee: flagString(args, "assignee"),
      allowedPaths: flagList(args, "paths"),
      verifyCommand: flagString(args, "verify"),
    });
    note(session, `${count(tasks.length, "task")} queued in ${project.name}`);
    if (notes) note(session, notes);
    if (flagBool(args, "no-follow")) {
      emit(session, { tasks }, () => table(TASK_COLUMNS, renderTaskRows(tasks)));
      return EXIT_OK;
    }
    return runTasks(session, tasks, { showDiff: true, signal });
  },

  async tasks(session, args) {
    const project = await requireProject(session, args);
    const tasks = visibleTasks(session.store.listTasks(project.id), args).slice(0, flagNumber(args, "limit", 50));
    emit(session, { tasks }, () => table(TASK_COLUMNS, renderTaskRows(tasks)));
    if (!tasks.length && !session.json) {
      session.out.write(`${dim(`no active tasks — try: openteam "your instruction"`)}\n`);
    }
    return EXIT_OK;
  },

  async show(session, _args, rest) {
    const task = resolveTask(session, need(rest, "show"));
    const changes = session.store.listChanges(task.projectId).filter((change) => change.taskId === task.id);
    emit(session, { task, changes }, () => {
      const detail = taskDetail(task);
      return changes.length ? `${detail}\n\n${table(CHANGE_COLUMNS, renderChangeRows(changes))}` : detail;
    });
    return EXIT_OK;
  },

  async run(session, _args, rest, signal) {
    const task = resolveTask(session, need(rest, "run"));
    if (["queued", "blocked", "failed", "cancelled"].includes(task.status)) {
      await session.orchestrator.dispatchTask(task.id);
    }
    return runTasks(session, [task], { showDiff: false, signal });
  },

  async watch(session, args, _rest, signal) {
    const project = await requireProject(session, args);
    // Start anything ready first: collecting queued tasks and merely waiting on
    // them would block forever, since nothing else dispatches them.
    await session.orchestrator.dispatchReadyTasks(project.id);
    const active = session.store
      .listTasks(project.id)
      .filter((task) => ["queued", "running", "blocked"].includes(task.status));
    if (!active.length) {
      note(session, "nothing is running");
      return EXIT_OK;
    }
    return runTasks(session, active, { showDiff: false, signal });
  },

  async cancel(session, _args, rest) {
    const cancelled = await session.orchestrator.cancelTask(resolveTask(session, need(rest, "cancel")).id);
    emit(session, { task: cancelled }, () => `${cancelled.id}  ${cancelled.status}`);
    return EXIT_OK;
  },

  async dispatch(session, _args, rest) {
    const dispatched = await session.orchestrator.dispatchTask(resolveTask(session, need(rest, "dispatch")).id);
    emit(session, { task: dispatched }, () => `${dispatched.id}  ${dispatched.status}`);
    return EXIT_OK;
  },

  async assign(session, _args, rest) {
    const updated = await session.orchestrator.assignTask(resolveTask(session, need(rest, "assign")).id, rest[1]);
    emit(session, { task: updated }, () => `${updated.id}  ${updated.assignee ?? "unassigned"}`);
    return EXIT_OK;
  },

  async changes(session, args) {
    const project = await requireProject(session, args);
    const changes = visibleChanges(session.store.listChanges(project.id), args).slice(0, flagNumber(args, "limit", 50));
    emit(session, { changes }, () => table(CHANGE_COLUMNS, renderChangeRows(changes)));
    if (!changes.length && !session.json) session.out.write(`${dim("nothing awaiting review")}\n`);
    return EXIT_OK;
  },

  async diff(session, args, rest) {
    const project = await requireProject(session, args);
    let change: Change;
    if (rest[0]) {
      change = resolveChange(session, rest[0]);
    } else {
      const latest = visibleChanges(session.store.listChanges(project.id), args).find((candidate) =>
        REVIEWABLE.includes(candidate.status),
      );
      if (!latest) {
        note(session, "no changes awaiting review");
        return EXIT_OK;
      }
      change = latest;
    }
    if (session.json) emit(session, { change, stat: diffStat(change.diff) }, () => "");
    else await page(colorizeDiff(`${diffHeader(change, project)}\n\n${change.diff}`));
    return EXIT_OK;
  },

  async approve(session, _args, rest) {
    const approved = await session.orchestrator.approveChange(resolveChange(session, need(rest, "approve")).id);
    emit(session, { change: approved }, () => `${green("approved")} ${approved.id}  ${approved.summary}`);
    note(session, `next  openteam merge ${approved.id}`);
    return EXIT_OK;
  },

  async merge(session, _args, rest, signal) {
    const change = resolveChange(session, need(rest, "merge"));
    const merged = await session.orchestrator.mergeChange(change.id);
    if (merged.status !== "merged") {
      emit(session, { change: merged }, () => `${red(merged.status)} ${merged.id}  ${merged.error ?? ""}`);
      return EXIT_FAILURE;
    }
    const project = session.store.getProject(merged.projectId);
    emit(session, { change: merged, project }, () =>
      [
        `${green("merged")} ${merged.id} as ${shortSha(merged.mergedSha ?? "")}`,
        project ? hint(`still only in the mirror — publish it with: openteam push ${project.defaultBranch}`) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    // Merging a plan step unblocks the next one. Follow it here rather than
    // leaving it queued for a command the user has to remember.
    const continuing = project ? continuingTasks(session, project.id) : [];
    if (!continuing.length || session.json) return EXIT_OK;
    note(session, `continuing with ${count(continuing.length, "task")}`);
    return runTasks(session, continuing, { showDiff: true, signal });
  },

  async sync(session, args) {
    const project = await requireProject(session, args);
    const result = await syncBareMirror(project.managedRepositoryPath, project.defaultBranch);
    emit(session, { project, sync: result }, () => {
      const label =
        result.status === "up_to_date"
          ? `${project.defaultBranch} is already up to date`
          : result.status === "updated"
            ? `advanced to ${shortSha(result.remoteSha)}`
            : result.status === "ahead"
              ? `${project.defaultBranch} carries local merges; publish them with: openteam push`
              : "diverged — the mirror and origin both moved; reconcile the mirror by hand";
      return `${cyan("sync")} ${label}  ${dim(`${shortSha(result.localSha)} → ${shortSha(result.remoteSha)}`)}`;
    });
    return result.status === "diverged" ? EXIT_FAILURE : EXIT_OK;
  },

  async push(session, args, rest) {
    const project = await requireProject(session, args);
    const source = rest[0] ?? flagString(args, "branch") ?? project.defaultBranch;
    const slug = basename(project.repositoryPath).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
    const destination = rest[1] ?? flagString(args, "to") ?? `agentswarm/${slug}`;
    const result = await pushMirrorBranch(
      project.managedRepositoryPath,
      source,
      destination.startsWith("refs/") ? destination : `refs/heads/${destination}`,
    );
    emit(session, { push: result, project }, () =>
      [
        `${green("pushed")} ${source === project.defaultBranch ? source : `${source} →`} ${destination}`,
        dim("open a pull request from that branch; your own checkout was never touched"),
      ].join("\n"),
    );
    return EXIT_OK;
  },

  async doctor(session, args) {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [
      {
        name: "node",
        ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20,
        detail: process.version,
      },
      { name: "data dir", ok: true, detail: config.dataDir },
    ];

    try {
      checks.push({ name: "git repository", ok: true, detail: (await getRepositoryInfo(process.cwd())).root });
    } catch {
      checks.push({ name: "git repository", ok: false, detail: "not inside a git repository" });
    }

    const reference = flagString(args, "project");
    if (reference) {
      try {
        const project = resolveExplicitProject(session.orchestrator, reference);
        checks.push({ name: "project", ok: true, detail: `${project.name} (${project.id})` });
      } catch (error) {
        checks.push({ name: "project", ok: false, detail: error instanceof Error ? error.message : "unresolved" });
      }
    }

    for (const provider of await session.orchestrator.getProviders()) {
      const entry = providerRegistry().get(provider.id);
      checks.push({
        name: `${entry ? "api" : "agent"} ${provider.id}`,
        ok: provider.available,
        detail: provider.available ? provider.command : unavailableDetail(entry, provider.id),
      });
    }

    const rows = keyRows(session.secrets);
    const missing = rows.filter((row) => row.source === "missing" && !row.optional);
    const configured = rows.filter((row) => row.source !== "missing" && row.source !== "not required");
    checks.push({
      name: "api keys",
      // Keys are optional: the mock agent and any installed agent CLI work without one.
      ok: true,
      detail: missing.length
        ? `${configured.length} set, ${missing.length} missing (${session.secrets.filePath})`
        : configured.length
          ? `${configured.length} set (${session.secrets.filePath})`
          : `none set; stored in ${session.secrets.filePath}`,
    });

    emit(session, { checks }, () =>
      table(
        [{ header: "" }, { header: "CHECK" }, { header: "DETAIL" }],
        checks.map((check) => [check.ok ? green("ok") : yellow("!"), check.name, dim(check.detail)]),
      ),
    );
    return EXIT_OK;
  },

  async serve(session) {
    const { close } = await startAppServer(session.store, session.orchestrator);
    note(session, `web control plane on http://${config.host}:${config.port}`);
    await new Promise<void>((resolvePromise) => {
      const stop = (): void => {
        void close().then(resolvePromise);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return EXIT_OK;
  },
};

const ALIASES: Record<string, string> = {
  task: "tasks",
  ls: "tasks",
  change: "changes",
  new: "oneShot",
  rm: "cancel",
};

export const run = async (argv: string[] = process.argv.slice(2)): Promise<number> => {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${red("error")} ${error instanceof Error ? error.message : "bad arguments"}\n`);
    return EXIT_USAGE;
  }

  setColor(!flagBool(args, "no-color") && colorEnabledForStream(process.stdout));
  try {
    validateProviderValue(flagString(args, "provider"));
    flagNumber(args, "limit", 50);
  } catch (error) {
    process.stderr.write(`${red("error")} ${error instanceof Error ? error.message : "bad arguments"}\n`);
    return EXIT_USAGE;
  }
  const dataDir = flagString(args, "data-dir");
  if (dataDir) {
    config.dataDir = absolute(dataDir);
    mkdirSync(config.dataDir, { recursive: true });
  }
  if (process.env.OPENTEAM_PAGER === "0") process.env.OPENTEAM_NO_PAGER = "1";

  const store = createStore();
  const session: Session = {
    store,
    orchestrator: new Orchestrator(store),
    out: process.stdout,
    err: process.stderr,
    json: flagBool(args, "json"),
    pager: process.env.OPENTEAM_NO_PAGER !== "1",
    secrets: SecretStore.open(join(config.dataDir, "keys.json")),
    pointer: new ProjectPointer(pointerPath(config.dataDir)),
  };

  const abort = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    if (interrupted) process.exit(EXIT_FAILURE);
    interrupted = true;
    note(session, "stopped following; the task keeps running");
    abort.abort();
  };
  process.on("SIGINT", onInterrupt);

  const [first, ...rest] = args.positionals;
  const name = ALIASES[first ?? ""] ?? first ?? "";
  try {
    if (flagBool(args, "version")) return await commands.version(session, args, [], abort.signal);
    if (flagBool(args, "help")) return await commands.help(session, args, [], abort.signal);

    if (!first) {
      if (args.prompt) return await oneShot(session, args, args.prompt, abort.signal);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return fail(
          session,
          "no command given and this is not a terminal. Try `openteam help`, or `openteam repl` for a line-based session.",
          EXIT_USAGE,
        );
      }
      return await runTui(session, args);
    }

    if (name === "oneShot") {
      if (!args.prompt) throw new UsageError(`${first} needs an instruction, for example: openteam new "add logging"`);
      return await oneShot(session, args, args.prompt, abort.signal);
    }
    const command = commands[name];
    if (!command) {
      const verdict = isLikelyTypo(first ?? "", [...Object.keys(commands), ...Object.keys(ALIASES)]);
      if (verdict?.confident) {
        return fail(
          session,
          `Unknown command "${verdict.word}". Did you mean "${verdict.suggestion}"? Or pass your instruction as \`openteam "${verdict.word} ..."\`.`,
          EXIT_USAGE,
        );
      }
      if (args.prompt) {
        // A two-edit resemblance is a coincidence often enough — "hello" against
        // "help" — that it must not stop real work.
        if (verdict) {
          note(session, `\`${verdict.word}\` looks like \`${verdict.suggestion}\`; running it as an instruction`);
        }
        return await oneShot(session, args, args.prompt, abort.signal);
      }
      return fail(session, `Unknown command "${first}". Run \`openteam help\`.`, EXIT_USAGE);
    }
    return await command(session, args, rest, abort.signal);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProjectNotFoundError) {
      return fail(session, error.message, EXIT_USAGE);
    }
    return fail(session, error instanceof Error ? error.message : "unexpected failure");
  } finally {
    process.off("SIGINT", onInterrupt);
    // An in-flight agent dies with this process; settle its tasks instead of
    // leaving them stuck in `running` where nothing can dispatch them again.
    if (name !== "serve") {
      await session.orchestrator.shutdown({ cancelPending: true }).catch(() => undefined);
    }
    await store.flush();
  }
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // Installed bins are symlinks into node_modules, so both sides must be
    // resolved before they can be compared.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(absolute(entry));
  } catch {
    return false;
  }
};

if (invokedDirectly() || process.env.OPENTEAM_FORCE_CLI === "1") {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${red("error")} ${error instanceof Error ? (error.stack ?? error.message) : "failed"}\n`);
      process.exitCode = EXIT_FAILURE;
    },
  );
}