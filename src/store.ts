import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId, now } from "./ids.js";
import type { AppEvent, Change, Project, Run, StoreData, Task } from "./types.js";
import { config } from "./config.js";

const emptyData = (): StoreData => ({
  projects: [],
  tasks: [],
  runs: [],
  changes: [],
  events: [],
});

const copy = <T>(value: T): T => structuredClone(value);

export class JsonStore {
  private data: StoreData;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: AppEvent) => void>();

  public constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData>;
      return {
        projects: parsed.projects ?? [],
        tasks: parsed.tasks ?? [],
        runs: parsed.runs ?? [],
        changes: parsed.changes ?? [],
        events: parsed.events ?? [],
      };
    } catch {
      return emptyData();
    }
  }

  private persist(): Promise<void> {
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await Promise.resolve(writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), "utf8"));
        renameSync(temporaryPath, this.filePath);
      });
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  public async flush(): Promise<void> {
    await this.persist();
  }

  public subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public publish(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }

  public listProjects(): Project[] {
    return copy(this.data.projects);
  }

  public getProject(id: string): Project | undefined {
    const project = this.data.projects.find((candidate) => candidate.id === id);
    return project ? copy(project) : undefined;
  }

  public async createProject(project: Project): Promise<Project> {
    this.data.projects.push(project);
    await this.persist();
    return copy(project);
  }

  public async updateProject(id: string, patch: Partial<Project>): Promise<Project | undefined> {
    const project = this.data.projects.find((candidate) => candidate.id === id);
    if (!project) return undefined;
    Object.assign(project, patch, { updatedAt: now() });
    await this.persist();
    return copy(project);
  }

  public listTasks(projectId: string): Task[] {
    return copy(this.data.tasks.filter((task) => task.projectId === projectId));
  }

  public getTask(id: string): Task | undefined {
    const task = this.data.tasks.find((candidate) => candidate.id === id);
    return task ? copy(task) : undefined;
  }

  public async createTask(task: Task): Promise<Task> {
    this.data.tasks.push(task);
    await this.persist();
    return copy(task);
  }

  public async updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
    const task = this.data.tasks.find((candidate) => candidate.id === id);
    if (!task) return undefined;
    Object.assign(task, patch, { updatedAt: now() });
    await this.persist();
    return copy(task);
  }

  public listRuns(projectId: string): Run[] {
    return copy(this.data.runs.filter((run) => run.projectId === projectId));
  }

  public getRun(id: string): Run | undefined {
    const run = this.data.runs.find((candidate) => candidate.id === id);
    return run ? copy(run) : undefined;
  }

  public async createRun(run: Run): Promise<Run> {
    this.data.runs.push(run);
    await this.persist();
    return copy(run);
  }

  public async updateRun(id: string, patch: Partial<Run>): Promise<Run | undefined> {
    const run = this.data.runs.find((candidate) => candidate.id === id);
    if (!run) return undefined;
    Object.assign(run, patch);
    await this.persist();
    return copy(run);
  }

  public listChanges(projectId: string): Change[] {
    return copy(this.data.changes.filter((change) => change.projectId === projectId));
  }

  public getChange(id: string): Change | undefined {
    const change = this.data.changes.find((candidate) => candidate.id === id);
    return change ? copy(change) : undefined;
  }

  public async createChange(change: Change): Promise<Change> {
    this.data.changes.push(change);
    await this.persist();
    return copy(change);
  }

  public async updateChange(id: string, patch: Partial<Change>): Promise<Change | undefined> {
    const change = this.data.changes.find((candidate) => candidate.id === id);
    if (!change) return undefined;
    Object.assign(change, patch, { updatedAt: now() });
    await this.persist();
    return copy(change);
  }

  public listEvents(projectId?: string, afterId?: string): AppEvent[] {
    let events = projectId ? this.data.events.filter((event) => event.projectId === projectId) : this.data.events;
    if (afterId) {
      const index = events.findIndex((event) => event.id === afterId);
      if (index >= 0) events = events.slice(index + 1);
    }
    return copy(events.slice(-300));
  }

  public async appendEvent(event: Omit<AppEvent, "id" | "timestamp">): Promise<AppEvent> {
    const completeEvent: AppEvent = {
      ...event,
      id: newId("evt"),
      timestamp: now(),
    };
    this.data.events.push(completeEvent);
    if (this.data.events.length > config.maxEvents) {
      this.data.events.splice(0, this.data.events.length - config.maxEvents);
    }
    this.publish(completeEvent);
    await this.persist();
    return copy(completeEvent);
  }

  public async appendEvents(events: Array<Omit<AppEvent, "id" | "timestamp">>): Promise<AppEvent[]> {
    const completeEvents = events.map((event) => ({ ...event, id: newId("evt"), timestamp: now() }));
    this.data.events.push(...completeEvents);
    if (this.data.events.length > config.maxEvents) {
      this.data.events.splice(0, this.data.events.length - config.maxEvents);
    }
    for (const event of completeEvents) this.publish(event);
    await this.persist();
    return copy(completeEvents);
  }
}

export const createStore = (): JsonStore => new JsonStore(`${config.dataDir}/state.json`);
