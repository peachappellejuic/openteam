export const PROVIDER_IDS = ["mock", "codex", "claude", "opencode", "custom"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type TaskStatus =
  | "queued"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";
export type RunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
export type ChangeStatus = "pending" | "approved" | "merged" | "conflict" | "failed" | "no_changes";

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  managedRepositoryPath: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  parentId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  provider: ProviderId;
  model?: string;
  branch?: string;
  workspacePath?: string;
  runId?: string;
  baseSha?: string;
  dependencies: string[];
  allowedPaths: string[];
  acceptanceTests: string[];
  verifyCommand?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: string;
}

export interface Run {
  id: string;
  taskId: string;
  projectId: string;
  provider: ProviderId;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface Change {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  branch: string;
  baseSha: string;
  commitSha: string;
  status: ChangeStatus;
  summary: string;
  diff: string;
  createdAt: string;
  updatedAt: string;
  mergedSha?: string;
  error?: string;
}

export interface AppEvent {
  id: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  changeId?: string;
  type: string;
  message: string;
  timestamp: string;
}

export interface StoreData {
  projects: Project[];
  tasks: Task[];
  runs: Run[];
  changes: Change[];
  events: AppEvent[];
}

export interface CreateProjectInput {
  name: string;
  repositoryPath: string;
  defaultBranch?: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  assignee?: string;
  provider?: ProviderId;
  model?: string;
  dependencies?: string[];
  allowedPaths?: string[];
  acceptanceTests?: string[];
  verifyCommand?: string;
  parentId?: string;
}

export interface PlanInput {
  goal: string;
  tasks?: Array<Pick<CreateTaskInput, "title" | "description" | "assignee" | "provider" | "dependencies" | "allowedPaths" | "acceptanceTests" | "verifyCommand">>;
}

export interface ProjectSnapshot {
  project: Project;
  tasks: Task[];
  runs: Run[];
  changes: Change[];
  events: AppEvent[];
}
