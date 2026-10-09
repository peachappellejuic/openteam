/**
 * Agent CLIs openteam shells out to.
 *
 * The full provider list is dynamic: built-in API providers plus whatever the
 * user has added with `openteam provider add`, so the id cannot be a literal
 * union at the type level.
 */
export const CLI_PROVIDER_IDS = ["mock", "codex", "claude", "opencode", "hermes", "antigravity", "custom"] as const;

export const CLI_PROVIDER_SET: ReadonlySet<string> = new Set(CLI_PROVIDER_IDS);

export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number];
export type ProviderId = string;
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
  /** A second opinion on the diff before it reaches the review queue. */
  reviewer?: ProviderId;
  reviewModel?: string;
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
  /** The reviewer's verdict, when one was asked for. */
  review?: {
    verdict: "approve" | "request-changes" | "abstain";
    reasons: string[];
    provider: string;
    model?: string;
    /** False when the reviewer could not be run at all. */
    completed: boolean;
    /** True when this verdict is what approved the change, with no human involved. */
    autoApproved?: boolean;
    error?: string;
  };
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
  /** A second opinion on the diff; must differ from `provider`. */
  reviewer?: ProviderId;
  reviewModel?: string;
  parentId?: string;
}

/** One step of a plan. `dependsOn` holds indices into the same array. */
export type PlanTaskInput = Pick<
  CreateTaskInput,
  | "title"
  | "description"
  | "assignee"
  | "provider"
  | "allowedPaths"
  | "acceptanceTests"
  | "verifyCommand"
  | "reviewer"
  | "reviewModel"
> & {
  dependencies?: string[];
  /** Zero-based indices of earlier tasks that must finish first. */
  dependsOn?: number[];
};

export interface PlanInput {
  goal: string;
  tasks?: PlanTaskInput[];
  /** Used for generated steps that do not name their own provider. */
  provider?: ProviderId;
  model?: string;
  reviewer?: ProviderId;
  reviewModel?: string;
  allowedPaths?: string[];
  verifyCommand?: string;
  assignee?: string;
}

export interface ProjectSnapshot {
  project: Project;
  tasks: Task[];
  runs: Run[];
  changes: Change[];
  events: AppEvent[];
}
