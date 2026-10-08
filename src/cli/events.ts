import type { AppEvent, Task } from "../types.js";
import type { JsonStore } from "../store.js";
import {
  SYMBOLS,
  TERMINAL_TASK_STATUSES,
  blue,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  yellow,
} from "./format.js";

/** Events rendered as a full line; `agent.output` is streamed raw instead. */
export const renderEvent = (event: AppEvent): string | undefined => {
  if (event.type === "agent.output") return undefined;
  const label = dim(event.timestamp.slice(11, 19));
  const message = event.message.replace(/\s+/g, " ").trim();
  switch (event.type) {
    case "task.created":
    case "plan.created":
      return `${label} ${blue(SYMBOLS.bullet)} ${message}`;
    case "task.started":
      return `${label} ${cyan(SYMBOLS.active)} ${message}`;
    case "workspace.ready":
      return `${label} ${gray(SYMBOLS.bullet)} ${message}`;
    case "verification.passed":
      return `${label} ${green(SYMBOLS.success)} ${message}`;
    case "verification.failed":
      return `${label} ${red(SYMBOLS.failure)} ${message}`;
    case "task.review":
      return `${label} ${yellow(SYMBOLS.pending)} ${message}`;
    case "task.completed":
      return `${label} ${green(SYMBOLS.success)} ${message}`;
    case "task.failed":
    case "change.failed":
    case "change.conflict":
      return `${label} ${red(SYMBOLS.failure)} ${message}`;
    case "task.cancelled":
      return `${label} ${gray(SYMBOLS.failure)} ${message}`;
    case "change.merged":
      return `${label} ${green(SYMBOLS.success)} ${message}`;
    case "change.approved":
      return `${label} ${cyan(SYMBOLS.active)} ${message}`;
    case "project.synced":
      return `${label} ${green(SYMBOLS.bullet)} ${message}`;
    case "task.deferred":
      return `${label} ${yellow("~")} ${message}`;
    case "project.sync_warning":
      return `${label} ${magenta("!")} ${message}`;
    case "project.created":
      return `${label} ${blue(SYMBOLS.bullet)} ${message}`;
    default:
      return `${label} ${dim(SYMBOLS.bullet)} ${message}`;
  }
};

export interface WaitOptions {
  onEvent?: (event: AppEvent) => void;
  signal?: AbortSignal;
  /**
   * Decides when a task stops being interesting. Defaults to the terminal
   * statuses; a caller following a dependency chain overrides it so an upstream
   * task awaiting review ends the wait instead of hanging forever.
   */
  settled?: (task: Task) => boolean;
}

const isTerminal = (task: Task | undefined): boolean => Boolean(task && TERMINAL_TASK_STATUSES.has(task.status));

export const waitForTask = async (store: JsonStore, taskId: string, options: WaitOptions = {}): Promise<Task> => {
  const pending = new Set([taskId]);
  const settled = await waitForTasks(store, pending, options);
  const task = settled.get(taskId);
  if (!task) throw new Error(`Task ${taskId} disappeared while running`);
  return task;
};

export const waitForTasks = async (
  store: JsonStore,
  taskIds: Iterable<string>,
  options: WaitOptions = {},
): Promise<Map<string, Task>> => {
  const watched = new Set(taskIds);
  const isSettled = options.settled ?? ((task: Task) => TERMINAL_TASK_STATUSES.has(task.status));
  const done = new Map<string, Task>();
  const collect = (): void => {
    for (const id of watched) {
      const task = store.getTask(id);
      if (task && isSettled(task)) done.set(id, task);
    }
  };
  collect();
  if (done.size === watched.size) return done;

  return new Promise<Map<string, Task>>((resolve) => {
    let unsubscribe: () => void = () => {};
    let settle = (): void => {};
    const timer = setInterval(collect, 750);
    const finish = (): void => {
      unsubscribe();
      clearInterval(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(done);
    };
    const check = (): void => {
      collect();
      if (done.size >= watched.size) settle();
    };
    const onAbort = (): void => {
      clearInterval(timer);
      unsubscribe();
      resolve(done);
    };
    unsubscribe = store.subscribe((event) => {
      if (options.onEvent && (!event.taskId || watched.has(event.taskId) || event.type.startsWith("project."))) {
        options.onEvent(event);
      }
      check();
    });
    settle = finish;
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** A single-line activity indicator that yields the line to streamed agent output. */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label: string;
  private drawing = false;
  private active = false;

  public constructor(
    private readonly stream: NodeJS.WriteStream,
    label: string,
  ) {
    this.label = label;
  }

  public get spinning(): boolean {
    return this.active;
  }

  public start(delayMs = 1_200): void {
    if (!this.stream.isTTY || this.active) return;
    this.active = true;
    this.timer = setTimeout(() => {
      if (!this.active) return;
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SYMBOLS.spinner.length;
        this.draw();
      }, 90);
    }, delayMs);
  }

  public update(label: string): void {
    this.label = label;
    if (this.active) this.draw();
  }

  public pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = false;
    this.erase();
  }

  public resume(delayMs = 400): void {
    if (this.active) return;
    this.start(delayMs);
  }

  public stop(): void {
    this.pause();
  }

  private draw(): void {
    this.erase();
    this.stream.write(dim(`${SYMBOLS.spinner[this.frame]} ${this.label}`));
    this.drawing = true;
  }

  private erase(): void {
    if (!this.drawing) return;
    this.stream.write("\r\u001b[2K");
    this.drawing = false;
  }
}

/** Buffers partial lines so streamed agent output does not flicker mid-line. */
export class LineWriter {
  private buffer = "";

  public constructor(private readonly write: (text: string) => void) {}

  public push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.write(line);
  }

  public flush(): void {
    if (!this.buffer) return;
    const remainder = this.buffer;
    this.buffer = "";
    this.write(remainder);
  }
}