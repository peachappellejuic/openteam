import { config } from "../config.js";
import { diffStat, fail, followTasks, resolveChange, resolveTask, say, titleFromPrompt, type Session } from "../cli/core.js";
import { providerRegistry } from "../providers-registry.js";
import { isLoopbackUrl } from "../api/registry.js";
import { knownProviderIds } from "../providers.js";
import { redact } from "../secrets.js";
import { apiClientFor } from "../providers.js";
import {
  ADD_PROVIDER,
  FIELD_HELP,
  applyField,
  isComplete,
  draftSummary,
  emptyDraft,
  fieldIsSkippable,
  NO_KEY_WORDS,
  nextField,
  providerMenuOptions,
  suggestEnvName,
  validateField,
  wizardActive,
  wizardTitle,
  WIRE_CHOICES,
  type AddField,
  type ProviderDraft,
  type ProviderSummary,
  type WizardStep,
} from "./wizard.js";
import { flagBool, flagString, parseArgs, tokenize, UsageError, type ParsedArgs } from "../cli/args.js";
import { bold, cyan, dim, red } from "../cli/format.js";
import { PROVIDER_COLUMNS, changeHeader, colorizeDiff, renderProviderRows } from "../cli/render.js";
import { absolutePath } from "../cli/current.js";
import {
  detectCompletion,
  exactCommand,
  filterCommands,
  filterPromptOptions,
  type CompletionRequest,
  type PromptOption,
} from "./commands.js";
import { connectRepository, selectProject } from "../cli/project.js";
import { table } from "../cli/format.js";

import { startRepl } from "../cli/repl.js";
import { clip, fit, isTextKey, Screen, wrap, type Key, type Size } from "./screen.js";
import {
  changeRow,
  commandHint,
  emptyState,
  optionPalette,
  footer,
  header,
  panelTitle,
  sideBySide,
  splitWidths,
  summarise,
  taskRow,
  window_,
  type Pane,
} from "./layout.js";
import type { Change, Project, Task } from "../types.js";

const HINTS = {
  idle: "type an instruction  \u2022  \u2191\u2193 move  \u2192 detail  tab switch  enter run  ctrl-c quit",
  detail: "esc back  \u2022  j/k scroll  \u2022  a approve  \u2022  m merge  \u2022  d diff  \u2022  esc back",
  busy: "agents running \u2022  ctrl-c stops watching",
};

interface State {
  pane: Pane;
  selected: number;
  detail: boolean;
  scroll: number;
  input: string;
  busy: boolean;
  message: string;
  messageKind: "info" | "error";
  /** Tasks being followed, so a second run cannot start on top of one. */
  following: string[];
  /** Index into whichever dropdown the prompt is completing. */
  completionIndex: number;
  completion: () => CompletionRequest | undefined;
  options: () => PromptOption[];
  /** Set while a multi-step flow owns the keyboard, such as `/provider`. */
  wizard?: WizardStep;
}

const PANE_TASKS: Pane = "tasks";

export const runTui = async (session: Session, args: ParsedArgs): Promise<number> => {
  const screen = new Screen();
  if (!screen.interactive) {
    return fail(session, "The interface needs a terminal. Try `openteam repl`.", 2);
  }

  let project: Project | undefined;
  const explicit = flagString(args, "project");
  try {
    const outcome = await selectProject(session.orchestrator, {
      explicit,
      cwd: process.cwd(),
      create: true,
      pinned: session.pointer?.pinned,
      log: () => undefined,
    });
    project = outcome.project;
    if (!explicit && outcome.source === "cwd" && session.pointer) session.pointer.pin(outcome.project.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "no project";
    screen.enter();
    say(session, `${red("error")} ${message}`);
    screen.exit();
    return 2;
  }

  const state: State = {
    pane: PANE_TASKS,
    selected: 0,
    detail: false,
    scroll: 0,
    input: "",
    busy: false,
    message: "",
    messageKind: "info",
    following: [],
    completionIndex: 0,
    completion: () => undefined,
    options: () => [],
  };

  const provider = flagString(args, "provider");
  let dirty = true;
  let repaint: (() => void) | undefined;

  const tasks = (): Task[] =>
    (project ? session.store.listTasks(project.id) : [])
      .filter((task) => flagBool(args, "all") || ["queued", "running", "blocked", "review"].includes(task.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const changes = (): Change[] =>
    (project ? session.store.listChanges(project.id) : [])
      .filter((change) => flagBool(args, "all") || ["pending", "approved", "conflict"].includes(change.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  /** Changes that have not been merged, newest first. */
  const reviewableChanges = (): Change[] => changes().filter((change) => change.status !== "merged");

  const rows = (): Array<Task | Change> => (state.pane === PANE_TASKS ? tasks() : changes());

  const current = (): Task | Change | undefined => rows()[state.selected];

  // Declared before any handler is registered so `bail` can never observe it in
  // the temporal dead zone.
  let quitting = false;
  const quit = (): void => {
    quitting = true;
  };

  /**
   * Runs a handler without letting it escape. A rejection here would reach the
   * process, where the only recovery is killing the terminal mid-frame.
   */
  const launch = (work: () => Promise<void>): void => {
    void work().catch((error: unknown) => {
      note(error instanceof Error ? error.message : "command failed", "error");
      dirty = true;
    });
  };

  const completionHint = (request: CompletionRequest | undefined, matches: PromptOption[]): string => {
    if (!request) return "";
    const noun = request.kind === "command" ? "command" : "provider";
    if (!matches.length) return `no matching ${noun}  \u2022  esc to dismiss`;
    const plural = matches.length === 1 ? "" : "s";
    return `${matches.length} ${noun}${plural}  \u2022  \u2191\u2193 choose  \u2022  enter or tab to complete  \u2022  esc to dismiss`;
  };

  // Availability probes spawn `--version` per agent CLI, so the result is cached
  // rather than recomputed on every keystroke.
  let providerCache: { at: number; options: PromptOption[] } | undefined;
  const PROVIDER_CACHE_MS = 5_000;

  const describeProvider = (id: string): string => {
    const entry = providerRegistry().get(id);
    if (!entry) return "agent cli";
    return entry.requiresKey ? "direct api" : "local, no key needed";
  };

  const refreshProviders = async (force = false): Promise<void> => {
    if (!force && providerCache && Date.now() - providerCache.at < PROVIDER_CACHE_MS) return;
    const listed = await session.orchestrator.getProviders();
    providerCache = {
      at: Date.now(),
      options: listed.map((provider) => ({
        value: provider.id,
        usage: provider.available ? "" : "not available",
        summary: provider.available ? describeProvider(provider.id) : "set a key or install it",
        usable: provider.available,
      })),
    };
    dirty = true;
  };

  // --- provider wizard ------------------------------------------------------

  const providerSummaries = (): ProviderSummary[] => {
    const registry = providerRegistry();
    return knownProviderIds().map((id) => {
      const entry = registry.get(id);
      const needsKey = Boolean(entry?.requiresKey);
      const hasKey = needsKey && session.secrets.getAny(entry?.envNames ?? []) !== undefined;
      return {
        id,
        needsKey,
        authenticated: hasKey,
        usable: hasKey || !needsKey,
        kind: entry ? (entry.requiresKey ? "direct api" : "local") : "agent cli",
        label: entry?.label ?? id,
      };
    });
  };

  const menuOptions = (): PromptOption[] => providerMenuOptions(providerSummaries());

  const wireHelp = (wire: string): string =>
    wire === "openai"
      ? "OpenAI-compatible chat completions"
      : wire === "anthropic"
        ? "Anthropic messages api"
        : "Google generateContent";

  const openWizard = (step: WizardStep): void => {
    state.wizard = step;
    state.input = "";
    state.completionIndex = 0;
    dirty = true;
  };

  /** Leaves the wizard, keeping whatever message it produced. */
  const closeWizard = (message: string, kind: "info" | "error"): void => {
    state.wizard = undefined;
    state.input = "";
    note(message, kind);
  };

  const saveCredential = async (envName: string, label: string, value: string): Promise<void> => {
    try {
      session.secrets.set(envName, value);
    } catch (error) {
      closeWizard(error instanceof Error ? error.message : "could not store that key", "error");
      return;
    }

    const entry = providerSummaries().find((candidate) => {
      const registryEntry = providerRegistry().get(candidate.id);
      return registryEntry?.envNames.includes(envName);
    });
    let detail = `${label}: stored ${redact(value)}`;
    let kind: "info" | "error" = "info";

    if (entry) {
      const registryEntry = providerRegistry().get(entry.id);
      if (registryEntry) {
        try {
          await apiClientFor(registryEntry).ping();
          detail += " — accepted by the provider";
        } catch (error) {
          detail += ` — ${error instanceof Error ? error.message : "the provider did not accept it"}`;
          kind = "error";
        }
      }
    } else {
      detail += " (not attached to a provider yet)";
    }

    openWizard({ kind: "providerMenu" });
    note(detail, kind);
  };

  const addProviderFromDraft = async (draft: ProviderDraft, key: string): Promise<void> => {
    let saved;
    try {
      saved = providerRegistry().add({
        id: draft.id,
        label: draft.id,
        wire: draft.wire,
        baseUrl: draft.baseUrl,
        envName: draft.requiresKey ? draft.envName : undefined,
        defaultModel: draft.defaultModel,
        requiresKey: draft.requiresKey,
      });
    } catch (error) {
      closeWizard(error instanceof Error ? error.message : "could not add that provider", "error");
      return;
    }

    await refreshProviders(true);
    if (!draft.requiresKey || !key.trim()) {
      openWizard({ kind: "providerMenu" });
      note(`added ${bold(saved.id)} — no key needed`, "info");
      return;
    }
    try {
      session.secrets.set(draft.envName!, key.trim());
    } catch (error) {
      openWizard({ kind: "providerMenu" });
      note(`added ${saved.id}, but ${error instanceof Error ? error.message : "the key was not stored"}`, "error");
      return;
    }
    openWizard({ kind: "providerMenu" });
    note(`added ${bold(saved.id)} — key stored, run \`openteam keys test ${saved.id}\` to confirm`, "info");
  };

  /** Advances the add-provider form after a field validates. */
  const advanceAdd = (draft: ProviderDraft, field: AddField, value: string): void => {
    let next = applyField(draft, field, value);
    if (field === "id") next = { ...next, envName: next.envName ?? suggestEnvName(value) };

    if (field === "id" && isLoopbackUrl(value)) next = { ...next, requiresKey: false };

    const following = nextField(next, field);
    if (following === "wire") {
      openWizard({ kind: "addWire", draft: next, selected: 0 });
      return;
    }
    if (!following) {
      openWizard({ kind: "addKey", draft: next, value: "", message: "" });
      return;
    }
    openWizard({ kind: "addText", field: following, draft: next, value: "", message: "" });
  };

  state.completion = (): CompletionRequest | undefined =>
    state.detail || wizardActive(state.wizard) ? undefined : detectCompletion(state.input);

  state.options = (): PromptOption[] => {
    const request = state.completion();
    if (!request) return [];
    if (request.kind === "command") {
      return filterCommands(request.query).map((command) => ({
        value: `/${command.name}`,
        usage: command.usage,
        summary: command.summary,
        usable: true,
      }));
    }
    return filterPromptOptions(providerCache?.options ?? [], request.query);
  };

  const note = (message: string, kind: State["messageKind"] = "info"): void => {
    state.message = message;
    state.messageKind = kind;
    dirty = true;
  };

  const clampSelection = (): void => {
    state.selected = Math.max(0, Math.min(state.selected, rows().length - 1));
    if (state.scroll > 0) state.scroll = 0;
  };

  const detailBody = (item: Task | Change | undefined, size: Size, inner: number): string[] => {
    if (!item) return emptyState("nothing selected", inner);
    if ("branch" in item && "diff" in item) {
      const stat = diffStat(item.diff);
      return [
        panelTitle("change", inner),
        ...wrap(changeHeader(item, project?.name ?? ""), inner, 8).map((line) => clip(line, inner)),
        "",
        panelTitle("diff", inner),
        ...clipLines(item.diff, inner, 40),
        "",
        dim(`${stat.files.length} file(s)  +${stat.added} -${stat.removed}`),
      ];
    }
    const task = item as Task;
    return [
      panelTitle("task", inner),
      ...wrap(`${task.title}`, inner, 3).map((line) => clip(line, inner)),
      "",
      ...summarise(
        [
          `status  ${task.status}`,
          `agent   ${task.provider}${task.model ? ` (${task.model})` : ""}`,
          `branch  ${task.branch ?? "-"}`,
          `owner   ${task.assignee ?? "-"}`,
          `updated ${task.updatedAt}`,
          task.dependencies.length ? `needs   ${task.dependencies.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        inner,
        10,
      ),
      "",
      panelTitle("instructions", inner),
      ...clipLines(task.description, inner, 14),
      task.error ? `\n${red("error")} ${clip(task.error, inner - 6)}` : "",
      task.result ? `\n${panelTitle("agent said", inner)}\n${clipLines(task.result, inner, 10).join("\n")}` : "",
    ].filter((line) => line !== "") as string[];
  };

  const draw = (): void => {
    const size = screen.size;
    const items = rows();
    clampSelection();

    const top = header(
      size,
      project,
      {
        running: tasks().filter((task) => task.status === "running").length,
        review: changes().filter((change) => change.status !== "merged").length,
        queued: tasks().filter((task) => task.status === "queued").length,
      },
      config.maxConcurrentRuns,
    );

    // The palette has to be reserved from the body, not appended after it:
    // the body is otherwise sized to fill the screen and leaves no room.
    const step = state.wizard;
    const request = state.completion();
    const matches = request ? state.options() : [];
    const dropdownTitle = request?.kind === "provider" ? "providers" : "commands";

    // A wizard step and the prompt dropdown both claim the rows above the
    // prompt, so exactly one of them is ever drawn.
    let dropdownLines: string[] = [];
    let paletteHint: string[] = [];
    let footerHint = state.busy ? HINTS.busy : state.detail ? HINTS.detail : HINTS.idle;

    if (step) {
      const inner = Math.max(30, size.columns - 8);
      if (step.kind === "providerMenu") {
        const options = menuOptions();
        dropdownLines = optionPalette(options, state.completionIndex, size, "providers");
        paletteHint = [commandHint(`${options.length} entries  \u2022  \u2191\u2193 choose  \u2022  enter to configure  \u2022  esc to leave`, size.columns)];
        footerHint = "providers";
      } else if (step.kind === "addWire") {
        const options = WIRE_CHOICES.map((wire) => ({ value: wire, usage: "", summary: wireHelp(wire), usable: true }));
        dropdownLines = optionPalette(options, step.selected, size, "wire format");
        paletteHint = [commandHint("\u2191\u2193 choose  \u2022  enter to confirm  \u2022  esc to cancel", size.columns)];
        footerHint = `${step.draft.id ?? "new provider"} — wire format`;
      } else if (step.kind === "addText") {
        paletteHint = [commandHint(`${FIELD_HELP[step.field]}  \u2022  enter to continue  \u2022  esc to cancel`, size.columns)];
        footerHint = wizardTitle(step);
      } else if (step.kind === "credential") {
        paletteHint = [
          ...(step.message ? [commandHint(step.message, size.columns)] : []),
          commandHint("the value is not echoed  \u2022  enter saves and tests it  \u2022  esc to cancel", size.columns),
        ];
        footerHint = `${wizardTitle(step)} \u2014 ${step.envName}`;
      } else {
        paletteHint = [commandHint("the value is not echoed  \u2022  enter saves it  \u2022  esc to finish without a key", size.columns)];
        footerHint = wizardTitle(step);
      }
    } else if (request) {
      dropdownLines = optionPalette(matches, state.completionIndex, size, dropdownTitle);
      paletteHint = [commandHint(completionHint(request, matches), size.columns)];
    }

    const { left: listWidth, right: detailWidth } = splitWidths(size);
    const listLines: string[] = [panelTitle(state.pane === PANE_TASKS ? "tasks" : "changes", listWidth, items.length)];

    const footerRows = 3;
    const messageRows = state.message ? 1 : 0;
    const bodyHeight = Math.max(
      1,
      size.rows - top.length - footerRows - messageRows - dropdownLines.length - paletteHint.length,
    );

    if (!items.length) {
      listLines.push(...emptyState(state.pane === PANE_TASKS ? "no active tasks" : "nothing awaiting review", listWidth));
    } else {
      const perPage = Math.max(1, bodyHeight);
      const window_ = Math.max(0, Math.min(state.selected - Math.floor(perPage / 2), items.length - perPage));
      for (const [index, item] of items.slice(window_, window_ + perPage).entries()) {
        const absolute = window_ + index;
        const selected = absolute === state.selected;
        listLines.push(
          "diff" in item
            ? changeRow(item as Change, selected, listWidth)
            : taskRow(item as Task, selected, listWidth),
        );
      }
    }

    const right = state.detail
      ? window_(detailBody(current(), size, detailWidth), bodyHeight, state.scroll)
      : window_(
          [
            "",
            panelTitle("next", detailWidth),
            "",
            ...wrap(
              [
                "Queued work runs in parallel up to a limit.",
                "Two tasks declaring the same --paths are run",
                "one at a time so a conflict is never discovered",
                "after a full agent run.",
                "",
                provider ? `Agent for this session: ${provider}` : "Set one with --provider",
                "",
                "a  approve the selected change",
                "m  merge it into the managed mirror",
                "p  push the mirror branch to origin",
                "/  type a slash command",
              ].join("\n"),
              detailWidth,
              Math.max(6, size.rows - top.length - 6),
            ),
          ],
          bodyHeight,
          0,
        );

    const frames = state.detail ? [...top, ...right] : [...top, ...sideBySide(listLines, right, size)];

    if (state.message) {
      frames.push(fit(state.messageKind === "error" ? red(state.message) : dim(state.message), size.columns));
    }

    frames.push(...dropdownLines, ...paletteHint);
    frames.push(
      ...footer(
        size,
        // Credentials are never drawn; the length is enough to show progress.
        state.wizard?.kind === "credential" || state.wizard?.kind === "addKey"
          ? "*".repeat(Math.min(state.input.length, 12))
          : state.input,
        footerHint,
        state.busy,
      ),
    );

    screen.render(frames);
  };

  const runSelected = async (): Promise<void> => {
    const item = current();
    if (!item) return;
    if ("branch" in item) {
      state.detail = true;
      state.scroll = 0;
      dirty = true;
      return;
    }
    const task = item as Task;
    if (["running"].includes(task.status)) {
      state.detail = true;
      dirty = true;
      return;
    }
    note(`starting ${task.id}`);
    dirty = true;
    await dispatch([task]);
  };

  const dispatch = async (tasks: Task[]): Promise<void> => {
    if (state.following.length) return;
    state.following = tasks.map((task) => task.id);
    state.busy = true;
    state.input = "";
    dirty = true;
    try {
      await followTasks(session, state.following, { quiet: true });
      note("finished", "info");
    } catch (error) {
      note(error instanceof Error ? error.message : "run failed", "error");
    } finally {
      state.following = [];
      state.busy = false;
      dirty = true;
    }
  };

  /** Inserts the highlighted choice, leaving room for any further argument. */
  const completeFromPalette = (): void => {
    const request = state.completion();
    if (!request) return;
    const matches = state.options();
    const chosen = matches[state.completionIndex] ?? matches[0];
    if (!chosen) {
      state.input = request.keep;
      return;
    }
    state.input = `${request.keep}${chosen.value} `;
    state.completionIndex = 0;
  };

  const submit = async (): Promise<void> => {
    const text = state.input.trim();
    state.input = "";
    if (!text) return;

    if (text.startsWith("/")) return slash(text);
    if (!project) {
      note("no project connected", "error");
      dirty = true;
      return;
    }

    try {
      const parsed = parseArgs(tokenize(text));
      const task = await session.orchestrator.createTask(project.id, {
        title: flagString(parsed, "title") ?? titleFromPrompt(text),
        description: text,
        provider: flagString(parsed, "provider") as Task["provider"],
        model: flagString(parsed, "model"),
        assignee: flagString(parsed, "assignee"),
        allowedPaths: (flagString(parsed, "paths") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      });
      state.pane = PANE_TASKS;
      state.selected = 0;
      note(`queued ${task.id}`);
      dirty = true;
    } catch (error) {
      note(error instanceof Error ? error.message : "could not queue that", "error");
      dirty = true;
    }
  };

  const slash = async (text: string): Promise<void> => {
    const [command = "", ...rest] = text.slice(1).split(/\s+/);
    const target = rest.join(" ");
    // An empty reference would otherwise match every task and report that.
    const needTarget = (): string => {
      if (!target) throw new UsageError(`/${command} needs a task or change id; press tab to list them`);
      return target;
    };
    try {
      switch (command) {
        case "quit":
        case "exit":
          quit();
          return;
        case "help":
          state.detail = true;
          state.scroll = 0;
          note("esc to go back");
          break;
        case "changes":
          state.pane = "changes";
          state.selected = 0;
          state.detail = false;
          break;
        case "tasks":
          state.pane = PANE_TASKS;
          state.selected = 0;
          state.detail = false;
          break;
        case "cancel": {
          const task = resolveTask(session, needTarget());
          await session.orchestrator.cancelTask(task.id);
          note(`cancelled ${task.id}`);
          break;
        }
        case "diff": {
          // Open the change in the detail pane, which already renders the diff.
          const candidates = reviewableChanges();
          const chosen = target ? resolveChange(session, target) : candidates[0];
          if (!chosen) throw new UsageError("no changes awaiting review; press tab to see the queue");
          state.pane = "changes";
          const order = candidates.map((change) => change.id);
          state.selected = Math.max(0, order.indexOf(chosen.id));
          state.detail = true;
          state.scroll = 0;
          break;
        }

        case "approve": {
          const change = resolveChange(session, needTarget());
          await session.orchestrator.approveChange(change.id);
          note(`approved ${change.id}`);
          break;
        }
        case "merge": {
          const change = resolveChange(session, needTarget());
          const merged = await session.orchestrator.mergeChange(change.id);
          note(
            merged.status === "merged" ? `merged ${merged.id}` : `${merged.status}: ${merged.error ?? ""}`,
            merged.status === "merged" ? "info" : "error",
          );
          break;
        }
        case "sync": {
          if (!project) throw new UsageError("no project");
          const result = await session.orchestrator.syncProject(project.id);
          note(`sync ${result.status}`);
          break;
        }
        case "push": {
          if (!project) throw new UsageError("no project");
          const { pushMirrorBranch } = await import("../git.js");
          const branch = target || project.defaultBranch;
          await pushMirrorBranch(project.managedRepositoryPath, branch, `refs/heads/agentswarm/${project.name}`);
          note(`pushed ${branch} to agentswarm/${project.name}`);
          break;
        }
        case "init": {
          project = await connectRepository(session.orchestrator, absolutePath(target || process.cwd()), {
            log: () => undefined,
          });
          session.pointer?.pin(project.id);
          note(`connected ${project.name}`);
          break;
        }
        case "providers":
          note(table(PROVIDER_COLUMNS, renderProviderRows(await session.orchestrator.getProviders())), "info");
          state.detail = true;
          break;

        case "provider":
          await refreshProviders(true);
          openWizard({ kind: "providerMenu" });
          return;
        case "keys": {
          const { keyRows } = await import("../cli/render.js");
          const { KEY_COLUMNS, renderKeyRows } = await import("../cli/render.js");
          const rows = keyRows(session.secrets);
          note(table(KEY_COLUMNS, renderKeyRows(rows)), "info");
          state.detail = true;
          break;
        }
        case "repl":
          await screen.exit();
          await startRepl(session, args);
          return;
        default:
          note(`unknown command /${command}`, "error");
      }
    } catch (error) {
      note(error instanceof Error ? error.message : "command failed", "error");
    }
    dirty = true;
  };

  screen.enter();
  repaint = screen.onResize(() => {
    dirty = true;
  });

  // Screen.enter installs its own restore on exit and on signals; these catch the
  // case where the failure never reaches either of those.
  const bail = (error: unknown): void => {
    screen.exit();
    process.stderr.write(
      `\r\n${red("openteam stopped")} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\r\n`,
    );
    process.exitCode = 1;
    quitting = true;
  };
  process.on("unhandledRejection", bail);
  process.on("uncaughtException", bail);

  const unsubscribe = session.store.subscribe(() => {
    dirty = true;
  });

  const release = screen.onKey((key) => {
    if (quitting) return;
    handleKey(key);
  });

  const handleWizardKey = (key: Key): boolean => {
    const step = state.wizard;
    if (!step) return false;

    if (key.name === "escape") {
      closeWizard("cancelled", "info");
      return true;
    }
    if (key.ctrl && key.name === "u") {
      state.input = "";
      dirty = true;
      return true;
    }
    if (key.name === "backspace") {
      state.input = state.input.slice(0, -1);
      dirty = true;
      return true;
    }

    if (step.kind === "providerMenu" || step.kind === "addWire") {
      const options = step.kind === "providerMenu"
        ? menuOptions()
        : WIRE_CHOICES.map((wire) => ({ value: wire, usage: "", summary: wireHelp(wire), usable: true }));
      const count = step.kind === "providerMenu" ? options.length : WIRE_CHOICES.length;

      if (key.name === "up") {
        state.completionIndex = Math.max(0, state.completionIndex - 1);
        dirty = true;
        return true;
      }
      if (key.name === "down") {
        state.completionIndex = Math.min(count - 1, state.completionIndex + 1);
        dirty = true;
        return true;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        if (step.kind === "providerMenu") {
          const chosen = options[state.completionIndex] ?? options[0];
          if (!chosen) return true;
          if (chosen.value === ADD_PROVIDER) {
            openWizard({ kind: "addText", field: "id", draft: emptyDraft(), value: "", message: "" });
            return true;
          }
          const summary = providerSummaries().find((candidate) => candidate.id === chosen.value);
          const entry = providerRegistry().get(chosen.value);
          if (!summary || !entry) {
            // An agent CLI, not a direct API provider: nothing to authenticate.
            note(`${chosen.value} authenticates through its own CLI, not a key here`, "info");
            return true;
          }
          if (!summary.needsKey) {
            note(`${entry.label} needs no key`, "info");
            return true;
          }
          openWizard({
            kind: "credential",
            envName: entry.envNames[0],
            label: entry.label,
            value: "",
            message: summary.authenticated ? "replacing the stored key" : "",
          });
          return true;
        }
        const wire = WIRE_CHOICES[state.completionIndex] ?? "openai";
        const following = nextField({ ...step.draft, wire }, "wire");
        openWizard({ kind: "addText", field: following ?? "envName", draft: { ...step.draft, wire }, value: "", message: "" });
        return true;
      }
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      if (step.kind === "credential") {
        const value = state.input.trim();
        if (!value) {
          state.input = "";
          note("nothing entered; the key is unchanged", "error");
          return true;
        }
        launch(() => saveCredential(step.envName, step.label, value));
        return true;
      }
      if (step.kind === "addKey") {
        launch(() => addProviderFromDraft(step.draft, state.input));
        return true;
      }
      if (step.kind === "addText") {
        const value = step.field === "envName" && NO_KEY_WORDS.includes(state.input.trim().toLowerCase())
          ? ""
          : state.input.trim();
        const draft = value === "" && fieldIsSkippable(step.draft, step.field)
          ? { ...step.draft, requiresKey: false, envName: undefined }
          : step.draft;
        const check = validateField(step.field, value, {
          draft,
          existingIds: knownProviderIds(),
        });
        if (!check.ok) {
          note(check.message, "error");
          dirty = true;
          return true;
        }
        advanceAdd(draft, step.field, check.message);
        dirty = true;
        return true;
      }
    }

    if (isTextKey(key)) {
      state.input += key.sequence;
      dirty = true;
      return true;
    }
    return true;
  };

  const handleKey = (key: Key): void => {
    if (handleWizardKey(key)) return;
    // Control keys work even while busy; text entry does not, so a keystroke
    // typed during a run cannot become part of the next instruction.
    if (key.ctrl && key.name === "c") {
      if (state.busy) {
        note("still running \u2014 press ctrl-c again to quit", "error");
        dirty = true;
        return;
      }
      quit();
      return;
    }
    if (key.name === "up") {
      if (state.completion() !== undefined) {
        state.completionIndex = Math.max(0, state.completionIndex - 1);
        dirty = true;
        return;
      }
      state.selected = Math.max(0, state.selected - 1);
      state.scroll = Math.max(0, state.scroll - 1);
      dirty = true;
      return;
    }
    if (key.name === "down") {
      if (state.completion() !== undefined) {
        state.completionIndex = Math.min(state.options().length - 1, state.completionIndex + 1);
        dirty = true;
        return;
      }
      state.selected = Math.min(rows().length - 1, state.selected + 1);
      state.scroll = Math.min(state.scroll + 1, 5);
      dirty = true;
      return;
    }
    if (key.name === "tab") {
      if (state.completion() !== undefined) {
        completeFromPalette();
        dirty = true;
        return;
      }
      state.pane = state.pane === PANE_TASKS ? "changes" : PANE_TASKS;
      state.selected = 0;
      state.detail = false;
      dirty = true;
      return;
    }
    if (key.name === "escape") {
      if (state.completion() !== undefined) {
        // Dismiss without losing the rest of what was typed.
        state.input = "";
        dirty = true;
        return;
      }
      state.detail = false;
      state.scroll = 0;
      dirty = true;
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      // Enter completes a palette choice rather than running it, so a
      // half-typed command never fires with the wrong argument. The one
      // exception: the highlighted row already is the name that was typed, so
      // completing would only add a space and demand a second Enter. Arrowing
      // to a longer name still completes normally.
      const named = exactCommand(state.input);
      if (state.completion() !== undefined && state.options().length) {
        // Option values keep the leading slash; exactCommand does not.
        const highlighted = state.options()[state.completionIndex]?.value.replace(/^\//, "");
        if (!named || highlighted !== named) {
          completeFromPalette();
          dirty = true;
          return;
        }
      }
      if (state.detail && state.selected >= 0) {
        launch(runSelected);
        return;
      }
      if (named) {
        launch(slash.bind(null, `/${named}`));
        return;
      }
      launch(submit);
      return;
    }
    if (state.busy) return;

    if (key.name === "backspace") {
      state.input = state.input.slice(0, -1);
      state.completionIndex = 0;
      dirty = true;
      return;
    }
    if (key.ctrl && key.name === "u") {
      state.input = "";
      dirty = true;
      return;
    }
    if (key.ctrl && key.name === "w") {
      state.input = state.input.replace(/\S+\s*$/, "");
      dirty = true;
      return;
    }
    if (key.ctrl && key.name === "n") {
      state.input += "\n";
      dirty = true;
      return;
    }
    // No bare letter shortcuts. `k`/`j` used to navigate and silently swallowed
    // those letters from every instruction, and `a`/`m` meant "add caching" would
    // approve a change instead of typing. Arrows navigate; `/` gives commands.
    if (isTextKey(key)) {
      state.input += key.sequence;
      state.completionIndex = 0;
      if (detectCompletion(state.input)?.kind === "provider") {
        void refreshProviders().catch(() => undefined);
      }
      dirty = true;
    }
  };

  // Repaint on a timer so bursts of events coalesce into one frame, and so
  // input feels immediate without a render per keystroke.
  const timer = setInterval(() => {
    if (dirty && !quitting) {
      dirty = false;
      draw();
    }
  }, 60);
  draw();

  // Warm the provider list in the background so opening the dropdown is instant.
  void refreshProviders().catch(() => undefined);

  await new Promise<void>((resolvePromise) => {
    const poll = setInterval(() => {
      if (quitting) {
        clearInterval(poll);
        resolvePromise();
      }
    }, 40);
  });

  clearInterval(timer);
  release();
  unsubscribe();
  process.off("unhandledRejection", bail);
  process.off("uncaughtException", bail);
  repaint?.();
  screen.exit();
  await session.orchestrator.shutdown({ cancelPending: true }).catch(() => undefined);
  return 0;
};

/** Colourize a diff for the detail pane while keeping it inside the pane. */
const clipLines = (text: string, width: number, max: number): string[] => {
  const coloured = colorizeDiff(text || dim("(no diff)"));
  const rows: string[] = [];
  for (const line of coloured.split("\n")) {
    if (rows.length >= max) break;
    rows.push(clip(line, width));
  }
  return rows.length ? rows : [dim("(no diff)")];
};
