import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import {
  commitWorkspace,
  createBareMirror,
  getBareHead,
  getChangedFiles,
  getCommitSubject,
  getDiff,
  getRepositoryInfo,
  getWorkspace,
  mergeChange as mergeGitChange,
  publishWorkspaceBranch,
  removeWorkspace,
  syncBareMirror,
  verifyWorkspace,
  type SyncResult,
} from "./git.js";
import { newId, now } from "./ids.js";
import { ensureProviderAvailable, getAdapter, knownProviderIds, listProviders } from "./providers.js";
import type { JsonStore } from "./store.js";
import type {
  AppEvent,
  Change,
  CreateProjectInput,
  CreateTaskInput,
  PlanInput,
  Project,
  ProjectSnapshot,
  ProviderId,
  Run,
  Task,
} from "./types.js";

const truncate = (value: string, length = 12_000): string => value.length > length ? `${value.slice(0, length)}\n…` : value;

const pathAllowed = (file: string, patterns: string[]): boolean => {
  const normalized = patternOf(file);
  return patterns.some((pattern) => covers(pattern, normalized));
};

/** The literal prefix of a pattern, so a glob can still be reasoned about. */
const patternOf = (value: string): string => value.replace(/^\.\//, "").replace(/\/$/, "");

/**
 * Glob matching for allowed paths.
 *
 * A wildcard-free pattern is treated as a directory, so `src` covers everything
 * beneath it. Otherwise `*` stays inside one path segment, `**` crosses
 * separators, and `?` is a single character. A bare `*` or `**` still means the
 * whole repository.
 */
export const covers = (rawPattern: string, file: string): boolean => {
  const pattern = patternOf(rawPattern);
  if (pattern === "*" || pattern === "**") return true;
  if (!/[*?[]/.test(pattern)) return file === pattern || file.startsWith(`${pattern}/`);
  const source = pattern
    .split("")
    .map((character, index) => {
      if (character === "*") return pattern[index + 1] === "*" ? ".*" : "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  try {
    return new RegExp(`^${source}$`).test(file);
  } catch {
    return false;
  }
};

/** The directory a pattern is anchored at, ignoring any wildcard tail. */
const scopeRoot = (pattern: string): string => {
  const normalized = patternOf(pattern);
  const wildcard = normalized.search(/[*?[{]/);
  const root = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  const cut = root.lastIndexOf("/");
  return cut === -1 ? "" : root.slice(0, cut);
};

/**
 * Whether two tasks could plausibly touch the same file.
 *
 * An empty allow list means the whole repository, which collides with everything.
 * Wildcards are compared by the directory they are anchored at, which is
 * deliberately pessimistic: a false positive costs a short wait, a false negative
 * costs a merge conflict discovered after a full agent run.
 */
export const scopesOverlap = (left: string[], right: string[]): boolean => {
  if (!left.length || !right.length) return true;
  if ([...left, ...right].some((pattern) => pattern === "*" || pattern === "**")) return true;
  for (const a of left) {
    for (const b of right) {
      if (covers(a, b) || covers(b, a)) return true;
      const rootA = scopeRoot(a);
      const rootB = scopeRoot(b);
      if (!rootA || !rootB) return true;
      if (rootA === rootB) return true;
      if (rootA.startsWith(`${rootB}/`) || rootB.startsWith(`${rootA}/`)) return true;
    }
  }
  return false;
};

export class Orchestrator {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly startingTasks = new Set<string>();
  private readonly cancelledTasks = new Set<string>();
  /** Tasks dispatched by this instance. Shutdown only ever settles these, so a
   * second process working the same state file is left alone. */
  private readonly ownedTasks = new Set<string>();
  /** Task ids currently occupying a concurrency slot. */
  private readonly runningTasks = new Set<string>();
  private readonly pendingStarts = new Set<Promise<void>>();
  private readonly syncOperations = new Map<string, Promise<SyncResult>>();
  /** Why a ready task was not started, surfaced instead of silently waiting. */
  private readonly deferred = new Map<string, string>();

  public constructor(private readonly store: JsonStore) {}

  public listProjects(): Project[] {
    return this.store.listProjects().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public async createProject(input: CreateProjectInput): Promise<Project> {
    const name = input.name.trim();
    const repositoryPath = input.repositoryPath.trim();
    if (!name) throw new Error("Project name is required");
    if (!repositoryPath) throw new Error("Repository path is required");
    const source = await getRepositoryInfo(repositoryPath);
    const id = newId("prj");
    const managedRepositoryPath = join(config.dataDir, "repos", `${id}.git`);
    const mirror = await createBareMirror(source.root, managedRepositoryPath, input.defaultBranch || source.branch);
    const timestamp = now();
    const project: Project = {
      id,
      name,
      repositoryPath: source.root,
      managedRepositoryPath,
      defaultBranch: mirror.branch,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createProject(project);
    await this.event({ projectId: project.id, type: "project.created", message: `Project ${project.name} connected` });
    return project;
  }

  public getProject(projectId: string): Project {
    return this.requireProject(projectId);
  }

  public async syncProject(projectId: string): Promise<SyncResult> {
    const project = this.requireProject(projectId);
    const existing = this.syncOperations.get(projectId);
    if (existing) return existing;
    const operation = (async (): Promise<SyncResult> => {
      const result = await syncBareMirror(project.managedRepositoryPath, project.defaultBranch);
      if (result.status === "updated") {
        await this.event({ projectId, type: "project.synced", message: `Source branch advanced to ${result.remoteSha.slice(0, 8)}` });
      } else if (result.status === "diverged") {
        await this.event({ projectId, type: "project.sync_warning", message: "Source and managed branches have diverged; managed changes were preserved" });
      }
      return result;
    })();
    this.syncOperations.set(projectId, operation);
    try {
      return await operation;
    } finally {
      this.syncOperations.delete(projectId);
    }
  }

  public async createTask(projectId: string, input: CreateTaskInput, options: { dispatch?: boolean } = {}): Promise<Task> {
    const project = this.requireProject(projectId);
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title) throw new Error("Task title is required");
    if (!description) throw new Error("Task description is required");
    const provider = input.provider ?? "mock";
    if (!getAdapter(provider)) throw new Error(`Unsupported provider: ${provider}`);
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      const task = this.store.getTask(dependency);
      if (!task || task.projectId !== projectId) throw new Error(`Unknown task dependency: ${dependency}`);
    }
    const id = newId("task");
    if (dependencies.some((dependency) => this.dependencyContains(dependency, id))) throw new Error("Task dependencies cannot contain a cycle");
    if (dependencies.includes(input.parentId ?? "")) throw new Error("A task cannot depend on its parent");
    const timestamp = now();
    const task: Task = {
      id,
      projectId,
      parentId: input.parentId,
      title,
      description,
      status: "queued",
      assignee: input.assignee?.trim() || undefined,
      provider: provider as ProviderId,
      model: input.model?.trim() || undefined,
      dependencies,
      allowedPaths: [...new Set(input.allowedPaths ?? [])],
      acceptanceTests: [...new Set(input.acceptanceTests ?? [])],
      verifyCommand: input.verifyCommand?.trim() || undefined,
      branch: `agentswarm/task/${id}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createTask(task);
    await this.event({ projectId, taskId: id, type: "task.created", message: `Task queued: ${title}` });
    // Callers that only record the task pass `dispatch: false` and start it later.
    if (options.dispatch !== false) this.dispatchInBackground(projectId);
    return task;
  }

  public async createPlan(projectId: string, input: PlanInput): Promise<Task[]> {
    const goal = input.goal.trim();
    if (!goal) throw new Error("Plan goal is required");
    const project = this.requireProject(projectId);
    const planId = newId("plan");
    const supplied = input.tasks?.filter((task) => task.title?.trim() && task.description?.trim());
    const templates = supplied?.length
      ? supplied
      : [
          {
            title: "Inspect and design",
            description: `Inspect the repository and produce an implementation outline for: ${goal}`,
          },
          {
            title: "Implement the change",
            description: `Implement the requested goal in the repository: ${goal}`,
          },
          {
            title: "Verify and integrate",
            description: `Review the implementation, run the project's verification commands, and report any remaining issues for: ${goal}`,
          },
        ];
    const created: Task[] = [];
    for (const [index, template] of templates.entries()) {
      // Indices from a coordinator plan resolve against tasks already created,
      // so a plan can express a DAG without knowing the generated ids. An
      // explicitly empty list means "runs in parallel" and must not fall through
      // to the default chain, which is only for templates that said nothing.
      const explicitIndexes = template.dependsOn !== undefined;
      const indexed = (template.dependsOn ?? [])
        .filter((value) => Number.isInteger(value) && value >= 0 && value < created.length)
        .map((value) => created[value].id);
      const dependencies = explicitIndexes
        ? indexed
        : template.dependencies?.length
          ? template.dependencies
          : index === 0 ? [] : index === 1 ? [created[0]?.id ?? ""] : [created[1]?.id ?? ""];
      const task = await this.createTask(projectId, {
        ...template,
        title: template.title.trim(),
        description: template.description.trim(),
        parentId: planId,
        provider: template.provider ?? input.provider,
        model: input.model,
        assignee: template.assignee ?? input.assignee,
        allowedPaths: template.allowedPaths ?? input.allowedPaths,
        verifyCommand: template.verifyCommand ?? input.verifyCommand,
        dependencies: dependencies.filter(Boolean),
      });
      created.push(task);
    }
    await this.event({ projectId, type: "plan.created", message: `Plan created for ${project.name}: ${goal}` });
    this.dispatchInBackground(projectId);
    return created;
  }

  public async assignTask(taskId: string, assignee?: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    const name = assignee?.trim() || undefined;
    const updated = await this.store.updateTask(taskId, { assignee: name });
    await this.event({
      projectId: task.projectId,
      taskId,
      type: "task.assigned",
      message: name ? `Task assigned to ${name}: ${task.title}` : `Task unassigned: ${task.title}`,
    });
    return updated ?? task;
  }

  public async dispatchTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (["running", "completed", "cancelled"].includes(task.status)) return task;
    this.assertDependencies(task);
    this.startTracked(task);
    return this.store.getTask(taskId) ?? task;
  }

  public async dispatchReadyTasks(projectId: string): Promise<void> {
    this.requireProject(projectId);
    for (const task of this.store.listTasks(projectId)) {
      if (task.status !== "queued" && task.status !== "blocked") continue;
      if (!this.dependenciesComplete(task)) continue;
      if (this.startingTasks.has(task.id)) continue;

      // Order matters: the scope check is cheaper than a slot, and a task that
      // would collide should wait for a peer rather than for the cap.
      const blocker = this.collisionReason(task);
      if (blocker) {
        if (this.deferred.get(task.id) !== blocker) {
          this.deferred.set(task.id, blocker);
          await this.event({ projectId, taskId: task.id, type: "task.deferred", message: blocker });
        }
        continue;
      }
      if (this.runningTasks.size >= config.maxConcurrentRuns) {
        const reason = `Waiting for a free slot: ${this.runningTasks.size} of ${config.maxConcurrentRuns} agents are running`;
        if (this.deferred.get(task.id) !== reason) {
          this.deferred.set(task.id, reason);
          await this.event({ projectId, taskId: task.id, type: "task.deferred", message: reason });
        }
        continue;
      }
      this.deferred.delete(task.id);
      this.startTracked(task);
    }
  }

  /**
   * The already-running task this one would fight with, if any.
   *
   * Only tasks that both *declare* a scope are compared. A task without
   * `allowedPaths` may touch anything, so treating it as a collision would
   * serialise every ordinary task against every other; git already refuses the
   * unsafe merge afterwards. Declaring `--paths` on both sides is what opts a pair
   * into avoiding a conflict that could be predicted for free.
   */
  private collisionReason(task: Task): string | undefined {
    if (!task.allowedPaths.length) return undefined;
    for (const taskId of this.runningTasks) {
      const other = this.store.getTask(taskId);
      if (!other?.allowedPaths.length) continue;
      if (scopesOverlap(task.allowedPaths, other.allowedPaths)) {
        return `Waiting for ${other.title}: it is already editing ${task.allowedPaths.join(", ")}`;
      }
    }
    return undefined;
  }

  /** Overlapping scopes among currently running tasks, for reporting. */
  public collisions(projectId: string): Array<{ left: Task; right: Task }> {
    const running = [...this.runningTasks]
      .map((taskId) => this.store.getTask(taskId))
      .filter((task): task is Task => task !== undefined)
      .filter((task) => task.projectId === projectId && task.allowedPaths.length > 0);
    const pairs: Array<{ left: Task; right: Task }> = [];
    for (const [index, left] of running.entries()) {
      for (const right of running.slice(index + 1)) {
        if (scopesOverlap(left.allowedPaths, right.allowedPaths)) pairs.push({ left, right });
      }
    }
    return pairs;
  }

  public deferredReasons(projectId: string): Array<{ taskId: string; reason: string }> {
    return [...this.deferred]
      .filter(([taskId]) => this.store.getTask(taskId)?.projectId === projectId)
      .map(([taskId, reason]) => ({ taskId, reason }));
  }

  /** Agents currently occupying a slot. */
  public runningCount(): number {
    return this.runningTasks.size;
  }

  public async cancelTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (["completed", "cancelled"].includes(task.status)) return task;
    // Recorded separately from the status because startTask flips the task back
    // to `running` after its sync, which would otherwise resurrect a cancelled one.
    this.cancelledTasks.add(taskId);
    this.activeRuns.get(task.runId ?? "")?.abort();
    const updated = await this.store.updateTask(taskId, { status: "cancelled", completedAt: now(), error: "Cancelled by user" });
    if (task.runId) await this.store.updateRun(task.runId, { status: "cancelled", finishedAt: now(), error: "Cancelled by user" });
    await this.event({ projectId: task.projectId, taskId, runId: task.runId, type: "task.cancelled", message: "Task cancelled" });
    return updated ?? task;
  }

  public async approveChange(changeId: string): Promise<Change> {
    const change = this.store.getChange(changeId);
    if (!change) throw new Error("Change not found");
    if (change.status !== "pending") throw new Error(`Change is ${change.status}, not pending`);
    const updated = await this.store.updateChange(changeId, { status: "approved" });
    await this.event({ projectId: change.projectId, taskId: change.taskId, changeId, type: "change.approved", message: "Change approved for merge" });
    return updated ?? change;
  }

  public async mergeChange(changeId: string): Promise<Change> {
    const change = this.store.getChange(changeId);
    if (!change) throw new Error("Change not found");
    if (change.status !== "approved") throw new Error("Change must be approved before merging");
    const project = this.requireProject(change.projectId);
    const currentBase = await getBareHead(project.managedRepositoryPath, project.defaultBranch);
    const mergeId = newId("merge");
    try {
      const result = await mergeGitChange(
        project.managedRepositoryPath,
        project.defaultBranch,
        currentBase,
        change.branch,
        mergeId,
      );
      if (result.status === "conflict") {
        const updated = await this.store.updateChange(changeId, { status: "conflict", error: result.error });
        await this.event({ projectId: project.id, taskId: change.taskId, changeId, type: "change.conflict", message: result.error || "Merge conflict" });
        return updated ?? change;
      }
      if (!result.mergeSha) throw new Error("Merge completed without a commit");
      const updated = await this.store.updateChange(changeId, { status: "merged", mergedSha: result.mergeSha, error: undefined });
      await this.store.updateTask(change.taskId, { status: "completed", completedAt: now(), result: `Merged as ${result.mergeSha}` });
      if (this.store.getTask(change.taskId)?.workspacePath) await removeWorkspace(this.store.getTask(change.taskId)!.workspacePath!);
      await this.event({ projectId: project.id, taskId: change.taskId, changeId, type: "change.merged", message: `Change merged as ${result.mergeSha}` });
      this.dispatchInBackground(project.id);
      return updated ?? change;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Merge failed";
      const updated = await this.store.updateChange(changeId, { status: "failed", error: message });
      await this.event({ projectId: project.id, taskId: change.taskId, changeId, type: "change.failed", message });
      return updated ?? change;
    }
  }

  public getSnapshot(projectId: string): ProjectSnapshot {
    const project = this.requireProject(projectId);
    return {
      project,
      tasks: this.store.listTasks(projectId),
      runs: this.store.listRuns(projectId),
      changes: this.store.listChanges(projectId),
      events: this.store.listEvents(projectId),
    };
  }

  public getProviders() {
    return listProviders();
  }

  public async drain(): Promise<void> {
    while (this.pendingStarts.size) {
      await Promise.all([...this.pendingStarts]);
    }
  }

  /**
   * `cancelPending` settles the queued and running work this instance started, so
   * a caller that cannot keep supervising them — a short-lived CLI invocation —
   * exits at once instead of draining background work it was told not to wait for.
   */
  public async shutdown(options: { cancelPending?: boolean } = {}): Promise<void> {
    if (options.cancelPending) {
      for (const taskId of [...this.ownedTasks]) {
        const task = this.store.getTask(taskId);
        if (task && task.status === "running") {
          await this.cancelTask(taskId).catch(() => undefined);
        }
      }
    }
    for (const controller of this.activeRuns.values()) controller.abort();
    await this.drain();
  }

  private dispatchInBackground(projectId: string): void {
    void this.dispatchReadyTasks(projectId).catch(() => undefined);
  }

  private trackStart(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined);
    this.pendingStarts.add(tracked);
    void tracked.finally(() => this.pendingStarts.delete(tracked));
  }

  private startTracked(task: Task): void {
    if (this.startingTasks.has(task.id)) return;
    this.ownedTasks.add(task.id);
    this.runningTasks.add(task.id);
    this.trackStart(this.startTask(task));
  }

  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }

  private dependenciesComplete(task: Task): boolean {
    return task.dependencies.every((dependency) => this.store.getTask(dependency)?.status === "completed");
  }

  private dependencyContains(taskId: string, targetId: string, visited = new Set<string>()): boolean {
    if (taskId === targetId) return true;
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    const task = this.store.getTask(taskId);
    return task ? task.dependencies.some((dependency) => this.dependencyContains(dependency, targetId, visited)) : false;
  }

  private assertDependencies(task: Task): void {
    if (!this.dependenciesComplete(task)) throw new Error("Task dependencies are not complete");
  }

  private isCancelled(taskId: string): boolean {
    return this.cancelledTasks.has(taskId) || this.store.getTask(taskId)?.status === "cancelled";
  }

  /** Settles a cancelled task that a racing start may have flipped back to running. */
  private async settleCancelled(taskId: string): Promise<boolean> {
    if (!this.isCancelled(taskId)) return false;
    if (this.store.getTask(taskId)?.status !== "cancelled") {
      await this.store.updateTask(taskId, { status: "cancelled", completedAt: now(), error: "Cancelled by user" });
    }
    return true;
  }

  private async startTask(task: Task): Promise<void> {
    let project: Project | undefined;
    let runId: string | undefined;
    let startedTask: Task | undefined;
    try {
      // The guard sits inside the try so a duplicate start still releases the
      // concurrency slot its caller already reserved.
      if (this.startingTasks.has(task.id)) return;
      this.startingTasks.add(task.id);
      project = this.requireProject(task.projectId);
      if (await this.settleCancelled(task.id)) return;
      try {
        await this.syncProject(project.id);
      } catch (error) {
        await this.event({ projectId: project.id, taskId: task.id, type: "project.sync_warning", message: error instanceof Error ? error.message : "Source sync unavailable" });
      }
      const controller = new AbortController();
      const baseSha = await getBareHead(project.managedRepositoryPath, project.defaultBranch);
      const workspacePath = join(config.dataDir, "workspaces", project.id, task.id);
      const branch = task.branch || `agentswarm/task/${task.id}`;
      const timestamp = now();
      runId = newId("run");
      const updated = await this.store.updateTask(task.id, {
        status: "running",
        runId,
        baseSha,
        workspacePath,
        branch,
        startedAt: timestamp,
        error: undefined,
      });
      if (!updated || (await this.settleCancelled(task.id))) return;
      startedTask = updated;
      const run: Run = {
        id: runId,
        taskId: task.id,
        projectId: project.id,
        provider: task.provider,
        status: "starting",
        startedAt: timestamp,
      };
      await this.store.createRun(run);
      this.activeRuns.set(runId, controller);
      await this.event({ projectId: project.id, taskId: task.id, runId, type: "task.started", message: `${task.provider} started in an isolated workspace` });

      await mkdir(join(config.dataDir, "workspaces", project.id), { recursive: true });
      await getWorkspace(project.managedRepositoryPath, workspacePath, baseSha, branch);
      if (await this.settleCancelled(task.id)) {
        controller.abort();
        return;
      }
      await this.event({ projectId: project.id, taskId: task.id, runId, type: "workspace.ready", message: `Workspace ready on ${branch}` });
      await ensureProviderAvailable(task.provider);
      await this.store.updateRun(runId, { status: "running" });
      const adapter = getAdapter(task.provider);
      const result = await adapter.run({
        task: startedTask,
        workspacePath,
        signal: controller.signal,
        onOutput: (output) => {
          const message = truncate(output.trim());
          if (message) void this.event({ projectId: task.projectId, taskId: task.id, runId, type: "agent.output", message });
        },
      });

      if (await this.settleCancelled(task.id)) return;
      if (task.verifyCommand) {
        const verification = await verifyWorkspace(workspacePath, task.verifyCommand);
        await this.event({
          projectId: project.id,
          taskId: task.id,
          runId,
          type: verification.exitCode === 0 ? "verification.passed" : "verification.failed",
          message: truncate(verification.output || `Verification exited with ${verification.exitCode}`),
        });
        if (verification.exitCode !== 0) throw new Error(`Verification command failed: ${task.verifyCommand}`);
      }

      const commitSha = await commitWorkspace(workspacePath, `AgentSwarm: ${task.title}`);
      if (commitSha !== baseSha && task.allowedPaths.length) {
        const changedFiles = await getChangedFiles(workspacePath, baseSha, commitSha);
        const violations = changedFiles.filter((file) => !pathAllowed(file, task.allowedPaths));
        if (violations.length) throw new Error(`Changed files outside allowed paths: ${violations.join(", ")}`);
      }
      if (commitSha !== baseSha) await publishWorkspaceBranch(workspacePath, branch);
      if (commitSha === baseSha) {
        await this.store.updateTask(task.id, { status: "completed", completedAt: now(), result: truncate(result.output, 4000) });
        await this.store.updateRun(runId, { status: "completed", exitCode: result.exitCode, finishedAt: now() });
        await this.event({ projectId: project.id, taskId: task.id, runId, type: "task.completed", message: "Agent completed without file changes" });
      } else {
        const diff = await getDiff(workspacePath, baseSha, commitSha);
        const summary = await getCommitSubject(workspacePath, commitSha);
        const change: Change = {
          id: newId("chg"),
          projectId: project.id,
          taskId: task.id,
          runId,
          branch,
          baseSha,
          commitSha,
          status: "pending",
          summary,
          diff,
          createdAt: now(),
          updatedAt: now(),
        };
        await this.store.createChange(change);
        await this.store.updateTask(task.id, { status: "review", result: truncate(result.output, 4000) });
        await this.store.updateRun(runId, { status: "completed", exitCode: result.exitCode, finishedAt: now() });
        await this.event({ projectId: project.id, taskId: task.id, runId, changeId: change.id, type: "task.review", message: `Change ready for review: ${summary}` });
      }
    } catch (error) {
      if (startedTask) {
        await this.failTask(startedTask, error, runId);
      } else {
        await this.store.updateTask(task.id, { status: "failed", completedAt: now(), error: error instanceof Error ? error.message : "Task failed" });
        await this.event({ projectId: task.projectId, taskId: task.id, type: "task.failed", message: error instanceof Error ? error.message : "Task failed" });
      }
    } finally {
      if (runId) this.activeRuns.delete(runId);
      this.startingTasks.delete(task.id);
      this.cancelledTasks.delete(task.id);
      this.ownedTasks.delete(task.id);
      // Free the slot before re-dispatching so a queued task can take it.
      this.runningTasks.delete(task.id);
      this.deferred.delete(task.id);
      if (project) this.dispatchInBackground(project.id);
    }
  }

  private async failTask(task: Task, error: unknown, runId = task.runId): Promise<void> {
    if (this.isCancelled(task.id)) return;
    const message = truncate(error instanceof Error ? error.message : "Agent run failed", 4000);
    await this.store.updateTask(task.id, { status: "failed", completedAt: now(), error: message });
    if (runId) await this.store.updateRun(runId, { status: "failed", finishedAt: now(), error: message });
    await this.event({ projectId: task.projectId, taskId: task.id, runId, type: "task.failed", message });
  }

  private async event(event: Omit<AppEvent, "id" | "timestamp">): Promise<void> {
    await this.store.appendEvent(event);
  }
}
