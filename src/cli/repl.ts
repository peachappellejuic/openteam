import { createInterface } from "node:readline";
import { pushMirrorBranch } from "../git.js";
import type { Change, Project, Task } from "../types.js";
import { absolutePath } from "./current.js";
import { selectProject } from "./project.js";
import { flagString, parseArgs, UsageError, type ParsedArgs } from "./args.js";
import {
  changeForTask,
  count,
  diffStat,
  emit,
  followTasks,
  note,
  agentIsAvailable,
  fanoutCaveats,
  parseProviderId,
  queueSummary,
  resolveChange,
  resolveTask,
  say,
  splitList,
  submitInstruction,
  titleFromPrompt,
  type Session,
} from "./core.js";
import { bold, cyan, dim, gray, green, red, shortSha, table, TERMINAL_TASK_STATUSES, yellow } from "./format.js";
import { VERSION } from "./help.js";
import {
  CHANGE_COLUMNS,
  PROVIDER_COLUMNS,
  TASK_COLUMNS,
  changeHeader,
  KEY_COLUMNS,
  colorizeDiff,
  keyRows,
  renderChangeRows,
  renderKeyRows,
  renderProviderRows,
  renderTaskRows,
  taskDetail,
} from "./render.js";

interface Defaults {
  provider?: string;
  model?: string;
  reviewer?: string;
  assignee?: string;
  paths: string[];
  verify?: string;
}

const RUNNING = ["queued", "running", "blocked"];

const statusLabel = (status: string): string =>
  ({
    queued: dim("○ queued"),
    running: cyan("● running"),
    review: yellow("○ review"),
    completed: green("✔ done"),
    failed: red("✖ failed"),
    cancelled: gray("✖ cancelled"),
    blocked: yellow("○ blocked"),
  })[status] ?? status;

const helpLines = (defaults: Defaults): string =>
  [
    "",
    bold("plain text") + dim("     queue a task and follow it"),
    bold("/help") + dim("               this list"),
    bold("/status") + dim("             project, running tasks, review queue"),
    bold("/init [path]") + dim("        connect a repository"),
    bold("/projects") + dim("           list connected repositories"),
    bold("/use <name>") + dim("         switch to another repository"),
    bold("/show <id>") + dim("         one task in full"),
    bold("/plan <goal>") + dim("       queue a three-step chain"),
    bold("/changes") + dim("            list changes awaiting review"),
    bold("/diff [id]") + dim("         show a diff"),
    bold("/approve <id>") + dim("       approve for merge"),
    bold("/merge <id>") + dim("         merge into the managed mirror"),
    bold("/cancel <id>") + dim("        abort a running task"),
    bold("/sync") + dim("               fetch the source branch"),
    bold("/push [branch]") + dim("      publish the mirror branch to origin"),
    bold("/providers") + dim("          agents available on PATH"),
    "",
    bold("session defaults"),
    bold("  /agent <id> [model]") + dim(" set the agent"),
    bold("  /paths <globs>") + dim("       set the allow list"),
    bold("  /verify <command>") + dim("    set the verification command"),
    bold("  /assignee <name>") + dim("     set the owner"),
    bold("  /clear") + dim("                forget the defaults"),
    "",
    dim(
      defaults.provider
        ? `now: agent=${defaults.provider}${defaults.model ? `/${defaults.model}` : ""}`
        : "now: agent=mock (no default set — mock is always available)",
    ),
    "",
  ].join("\n");

export const startRepl = async (session: Session, args: ParsedArgs): Promise<number> => {
  const defaults: Defaults = {
    provider: flagString(args, "provider"),
    model: flagString(args, "model"),
    reviewer: flagString(args, "reviewer"),
    assignee: flagString(args, "assignee"),
    paths: splitList(flagString(args, "paths")),
    verify: flagString(args, "verify"),
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
    historySize: 200,
    terminal: Boolean(process.stdin.isTTY),
  });

  const preferred = flagString(args, "project");

  // Identical resolution to one-shot mode: the working directory when it holds a
  // repository, otherwise the pinned default, so the session can be started from
  // anywhere rather than only from inside a checkout.
  const connect = async (cwd: string): Promise<{ project: Project; note?: string } | undefined> => {
    try {
      const outcome = await selectProject(session.orchestrator, {
        explicit: preferred,
        cwd,
        create: true,
        pinned: session.pointer?.pinned,
        log: (message) => note(session, message),
      });
      if (!preferred && outcome.source === "cwd" && session.pointer) session.pointer.pin(outcome.project.id);
      return { project: outcome.project, note: outcome.note };
    } catch {
      return undefined;
    }
  };

  const opened = await connect(process.cwd());
  let activeProject: Project | undefined = opened?.project;
  if (opened?.note) say(session, opened.note);
  const currentProject = (): Promise<Project | undefined> => Promise.resolve(activeProject);

  const requireProject = async (): Promise<Project> => {
    const project = activeProject;
    if (!project) throw new UsageError("no project yet — run /init inside a git repository");
    return project;
  };

  const taskOverrides = (parsed: ParsedArgs) => ({
    provider: parseProviderId(flagString(parsed, "provider") ?? defaults.provider),
    dependencies: [] as string[],
    model: flagString(parsed, "model") ?? defaults.model,
    reviewer: flagString(parsed, "reviewer") ?? defaults.reviewer,
    assignee: flagString(parsed, "assignee") ?? defaults.assignee,
    allowedPaths: splitList(flagString(parsed, "paths") ?? defaults.paths.join(",")),
    verifyCommand: flagString(parsed, "verify") ?? defaults.verify,
  });

  const reviewable = (all: boolean): Change[] =>
    session.store
      .listProjects()
      .flatMap((project) => session.store.listChanges(project.id))
      .filter((change) => all || ["pending", "approved", "conflict"].includes(change.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const reportOutcome = (task: Task): void => {
    const change = task.status === "review" ? changeForTask(session, task) : undefined;
    if (change) {
      const stat = diffStat(change.diff);
      say(session, `${yellow("review")} ${change.summary}`);
      say(session, dim(`  ${count(stat.files.length, "file")}  +${stat.added} -${stat.removed}  ${change.branch}`));
      say(session, dim(`  /diff ${change.id}`));
    } else if (task.status === "completed") {
      say(session, `${green("done")} the agent reported no file changes`);
    } else if (task.status === "failed") {
      say(session, `${red("failed")} ${task.error ?? "unknown error"}`);
    } else if (task.status === "cancelled") {
      say(session, gray("cancelled"));
    } else {
      say(session, `${statusLabel(task.status)} ${dim("waiting for an earlier change to be merged")}`);
    }
  };

  const follow = async (tasks: Task[]): Promise<void> => {
    // Mirrors the one-shot behaviour: stop at the first plan step that needs a
    // merge decision rather than waiting on a chain that cannot advance.
    const parked = (task: Task): boolean =>
      task.dependencies.some((dependency) => session.store.getTask(dependency)?.status !== "completed");
    await followTasks(session, tasks.map((task) => task.id), { parked });
    say(session, "");

    const finalTasks = tasks.map((task) => session.store.getTask(task.id) ?? task);
    for (const task of finalTasks) reportOutcome(task);

    const waiting = finalTasks.filter(
      (task) =>
        !TERMINAL_TASK_STATUSES.has(task.status) &&
        task.dependencies.some((dependency) => session.store.getTask(dependency)?.status !== "completed"),
    );
    if (waiting.length) {
      say(
        session,
        dim(
          `${count(waiting.length, "task")} waiting on an earlier change: /merge it, then /status to continue the chain.`,
        ),
      );
    }
  };

  const showStatus = async (): Promise<void> => {
    const project = await currentProject();
    const tasks = session.store.listTasks(project?.id ?? "__none__");
    const running = tasks.filter((task) => RUNNING.includes(task.status));
    const queue = reviewable(false).filter((change) => project && change.projectId === project.id);

    say(session, bold("project"));
    say(session, project ? `  ${project.name}  ${dim(project.defaultBranch)}  ${dim(project.repositoryPath)}` : "  none");
    say(session, `\n${bold(`running (${running.length})`)}`);
    say(session, running.length ? table(TASK_COLUMNS, renderTaskRows(running)) : `  ${dim("nothing")}`);
    say(session, `\n${bold(`review queue (${queue.length})`)}`);
    say(session, queue.length ? table(CHANGE_COLUMNS, renderChangeRows(queue)) : `  ${dim("empty")}`);
  };

  const runInstruction = async (instruction: string, parsed: ParsedArgs): Promise<void> => {
    const project = await requireProject();
    const input = {
      ...taskOverrides(parsed),
      title: flagString(parsed, "title") ?? titleFromPrompt(instruction),
      description: instruction,
      // The list form is only valid for a single instruction, so it is resolved
      // here rather than in taskOverrides, which is shared with plans.
      provider: flagString(parsed, "provider") ?? defaults.provider,
      reviewer: flagString(parsed, "reviewer") ?? defaults.reviewer,
      reviewModel: flagString(parsed, "review-model"),
      dependencies: splitList(flagString(parsed, "depends")),
      allowedPaths: splitList(flagString(parsed, "paths") ?? defaults.paths.join(",")),
      acceptanceTests: [],
    };
    const tasks = await submitInstruction(session, project.id, input, agentIsAvailable);
    say(session, dim(queueSummary(tasks)));
    for (const warning of fanoutCaveats(tasks, input)) say(session, dim(`  ${warning}`));
    await follow(tasks);
  };

  const runPlan = async (goal: string): Promise<void> => {
    const project = await requireProject();
    const tasks = await session.orchestrator.createPlan(project.id, {
      goal,
      provider: parseProviderId(defaults.provider),
      model: defaults.model,
      assignee: defaults.assignee,
      allowedPaths: defaults.paths.length ? defaults.paths : undefined,
      verifyCommand: defaults.verify,
    });
    say(session, dim(`queued ${count(tasks.length, "task")}`));
    await follow(tasks);
  };

  const showDiff = (change: Change): void => {
    const project = session.store.getProject(change.projectId);
    say(session, changeHeader(change, project?.name ?? ""));
    say(session, "");
    say(session, colorizeDiff(change.diff));
    say(session, "");
    say(session, dim(`/approve ${change.id}  then  /merge ${change.id}`));
  };

  const handle = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed) return true;

    if (!trimmed.startsWith("/")) {
      const parsed = parseArgs(trimmed.split(/\s+/).filter(Boolean));
      await runInstruction(trimmed, parsed);
      return true;
    }

    const [command = "", ...words] = trimmed.slice(1).split(/\s+/);
    const parsed = parseArgs(words.filter((word) => word.startsWith("-")));
    const positional = words.filter((word) => !word.startsWith("-"));
    const rest = positional.join(" ");
    const argument = positional[0] ?? "";

    switch (command) {
      case "exit":
      case "quit":
        return false;

      case "help":
        say(session, helpLines(defaults));
        return true;

      case "init": {
        const target = absolutePath(rest || process.cwd());
        const connected = await connect(target);
        if (!connected) {
          say(session, `${red("error")} ${target} is not a git repository`);
          return true;
        }
        activeProject = connected.project;
        say(session, `${green("connected")} ${bold(activeProject.name)} ${dim(activeProject.defaultBranch)}`);
        return true;
      }

      case "projects": {
        const projects = session.orchestrator.listProjects();
        if (!projects.length) {
          say(session, dim("no repositories connected yet"));
          return true;
        }
        say(
          session,
          table(
            [{ header: "" }, { header: "NAME" }, { header: "BRANCH" }, { header: "PATH" }, { header: "ID" }],
            projects.map((project) => [
              activeProject?.id === project.id ? green("*") : " ",
              bold(project.name),
              dim(project.defaultBranch),
              dim(project.repositoryPath),
              dim(project.id),
            ]),
          ),
        );
        return true;
      }

      case "use": {
        if (!argument) throw new UsageError("/use needs a project name or id");
        const chosen = session.orchestrator.listProjects().find(
          (project) => project.id.startsWith(argument) || project.name === argument,
        );
        if (!chosen) {
          say(session, `${red("error")} no project matches "${argument}"`);
          return true;
        }
        activeProject = chosen;
        session.pointer?.pin(chosen.id);
        say(session, `${green("using")} ${chosen.name} ${dim(chosen.repositoryPath)}`);
        say(session, dim("remembered as the default for when you start outside a repository"));
        return true;
      }

      case "status":
        await showStatus();
        return true;

      case "changes":
        say(session, (() => {
          const changes = reviewable(rest === "all");
          return changes.length ? table(CHANGE_COLUMNS, renderChangeRows(changes)) : dim("nothing awaiting review");
        })());
        return true;

      case "show":
        say(session, taskDetail(resolveTask(session, argument)));
        return true;

      case "plan":
        if (!rest) throw new UsageError("/plan needs a goal, for example: /plan add caching");
        await runPlan(rest);
        return true;

      case "diff": {
        const change = argument ? resolveChange(session, argument) : reviewable(false)[0];
        if (!change) say(session, dim("no changes awaiting review"));
        else showDiff(change);
        return true;
      }

      case "approve": {
        const approved = await session.orchestrator.approveChange(resolveChange(session, argument).id);
        say(session, `${green("approved")} ${approved.id}`);
        say(session, dim(`/merge ${approved.id}`));
        return true;
      }

      case "merge": {
        const merged = await session.orchestrator.mergeChange(resolveChange(session, argument).id);
        const project = session.store.getProject(merged.projectId);
        if (merged.status !== "merged") say(session, `${red(merged.status)} ${merged.error ?? ""}`);
        else {
          say(session, `${green("merged")} ${merged.id} as ${shortSha(merged.mergedSha ?? "")}`);
          if (project) say(session, dim(`only in the mirror — /push ${project.defaultBranch} to publish it`));
        }
        return true;
      }

      case "cancel": {
        const cancelled = await session.orchestrator.cancelTask(resolveTask(session, argument).id);
        say(session, `${gray("cancelled")} ${cancelled.id}`);
        return true;
      }

      case "providers": {
        const providers = await session.orchestrator.getProviders();
        emit(session, { providers }, () => table(PROVIDER_COLUMNS, renderProviderRows(providers)));
        return true;
      }

      case "keys": {
        const rows = keyRows(session.secrets);
        emit(session, { keys: rows, path: session.secrets.filePath }, () =>
          [
            table(KEY_COLUMNS, renderKeyRows(rows)),
            "",
            dim(`stored in ${session.secrets.filePath}; set one outside the session with \`openteam keys set <id>\``),
          ].join("\n"),
        );
        return true;
      }

      case "sync": {
        const project = await requireProject();
        const result = await session.orchestrator.syncProject(project.id);
        say(session, `${cyan("sync")} ${result.status}  ${dim(`${shortSha(result.localSha)} → ${shortSha(result.remoteSha)}`)}`);
        return true;
      }

      case "push": {
        const project = await requireProject();
        const branch = argument || project.defaultBranch;
        await pushMirrorBranch(
          project.managedRepositoryPath,
          branch,
          `refs/heads/agentswarm/${project.name}`,
        );
        say(session, `${green("pushed")} ${branch} → agentswarm/${project.name}`);
        return true;
      }

      case "agent":
        if (positional[0]) defaults.provider = positional[0];
        defaults.model = positional[1];
        say(session, dim(`agent=${defaults.provider ?? "mock"}${defaults.model ? ` model=${defaults.model}` : ""}`));
        return true;

      case "paths":
        defaults.paths = splitList(rest);
        say(session, dim(`allowed paths=${defaults.paths.join(",") || "none"}`));
        return true;

      case "verify":
        defaults.verify = rest || undefined;
        say(session, dim(`verify=${defaults.verify ?? "none"}`));
        return true;

      case "assignee":
        defaults.assignee = rest || undefined;
        say(session, dim(`assignee=${defaults.assignee ?? "none"}`));
        return true;

      case "clear":
        Object.assign(defaults, { provider: undefined, model: undefined, assignee: undefined, paths: [], verify: undefined });
        say(session, dim("defaults cleared"));
        return true;

      default:
        say(session, `${red("unknown command")} /${command} — try /help`);
        return true;
    }
  };

  const ask = (query: string): Promise<string> =>
    new Promise((resolveQuestion) => {
      rl.question(query, resolveQuestion);
    });

  const promptFor = async (): Promise<string> => {
    const project = await currentProject().catch(() => undefined);
    const where = project ? project.name : "no project";
    const agent = defaults.provider ? ` ${defaults.provider}${defaults.model ? `/${defaults.model}` : ""}` : "";
    return ask(`${cyan("›")} ${dim(`${where}${agent}`)}${dim(" › ")}`);
  };

  const project = await currentProject().catch(() => undefined);
  say(
    session,
    [
      "",
      `${bold("openteam")} ${dim(`v${VERSION}`)}  ${
        project ? `${bold(project.name)} ${dim(project.defaultBranch)}` : dim("no project — run /init in a repository")
      }`,
      // The path stays visible because the session may be acting on a repository
      // that is not the one being stood in.
      project ? dim(project.repositoryPath) : "",
      dim("/help for commands, /exit to quit"),
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  while (true) {
    let line: string;
    try {
      line = await promptFor();
    } catch {
      break;
    }
    if (!line.trim()) continue;
    try {
      if (!(await handle(line))) break;
    } catch (error) {
      say(session, `${red("error")} ${error instanceof Error ? error.message : "command failed"}`);
    }
  }

  rl.close();
  return 0;
};
