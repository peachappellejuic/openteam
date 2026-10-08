import { basename, resolve } from "node:path";
import { getRepositoryInfo } from "../git.js";
import type { Orchestrator } from "../orchestrator.js";
import type { Project } from "../types.js";
import { absolutePath } from "./current.js";
import { dim, oneLine } from "./format.js";

export type ProjectSource = "flag" | "path" | "cwd" | "pinned" | "recent";

export interface ResolveOptions {
  /** Project id, name, or filesystem path given with --project. */
  explicit?: string;
  /** Directory to resolve a repository from. Defaults to process.cwd(). */
  cwd: string;
  /** Register a repository found in cwd that is not connected yet. */
  create: boolean;
  /** Project to fall back on when cwd holds no repository. */
  pinned?: string;
  /** Progress notes, written to stderr so stdout stays pipeable. */
  log: (message: string) => void;
}

export interface ResolveOutcome {
  project: Project;
  source: ProjectSource;
  /**
   * Why the project differs from the working directory. Surfaced so acting on
   * one repository from inside another is never silent.
   */
  note?: string;
}

export class ProjectNotFoundError extends Error {}

const matchByName = (projects: Project[], needle: string): Project[] => {
  const lowered = needle.toLowerCase();
  return projects.filter((project) => project.name.toLowerCase() === lowered);
};

const sameDirectory = (candidate: string, path: string): boolean => {
  const left = candidate.replace(/\/+$/, "");
  const right = path.replace(/\/+$/, "");
  return left === right || right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
};

/** Resolves --project, which accepts an id, a name, or a path. */
export const resolveExplicitProject = (orchestrator: Orchestrator, reference: string, cwd?: string): Project => {
  const projects = orchestrator.listProjects();
  const exact = projects.find((project) => project.id === reference || project.id.startsWith(reference));
  if (exact) return exact;

  const asPath = absolutePath(reference, cwd);
  const byPath = projects.find((project) => sameDirectory(project.repositoryPath, asPath));
  if (byPath) return byPath;

  const named = matchByName(projects, reference);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new ProjectNotFoundError(
      `Several projects are named "${reference}": ${named.map((project) => `${project.name} (${project.id})`).join(", ")}`,
    );
  }
  throw new ProjectNotFoundError(
    `No project matches "${reference}". Run \`openteam projects\` to see them, or \`openteam use <name>\` to pick one.`,
  );
};

const repositoryAt = async (cwd: string): Promise<string | undefined> => {
  try {
    return (await getRepositoryInfo(cwd)).root;
  } catch {
    return undefined;
  }
};

/**
 * Picks the project a command should act on.
 *
 * The working directory wins whenever it holds a repository, so working inside a
 * checkout does what you expect. Failing that the pinned project is used, then the
 * most recently connected one, which is what lets the CLI run from anywhere.
 */
export const selectProject = async (
  orchestrator: Orchestrator,
  options: ResolveOptions,
): Promise<ResolveOutcome> => {
  if (options.explicit) {
    return { project: resolveExplicitProject(orchestrator, options.explicit, options.cwd), source: "flag" };
  }

  const cwd = resolve(options.cwd);
  const repositoryRoot = await repositoryAt(cwd);
  const projects = orchestrator.listProjects();

  if (repositoryRoot) {
    const registered = projects.find((project) => project.repositoryPath === repositoryRoot);
    if (registered) {
      return { project: registered, source: "cwd" };
    }
    if (!options.create) {
      throw new ProjectNotFoundError(
        `${repositoryRoot} is not connected. Run \`openteam init\`, or pass --project <name>.`,
      );
    }
    options.log(dim(`connecting ${repositoryRoot}`));
    return { project: await orchestrator.createProject({ name: basename(repositoryRoot), repositoryPath: repositoryRoot }), source: "cwd" };
  }

  if (options.pinned) {
    const pinned = projects.find((project) => project.id === options.pinned);
    if (pinned) {
      return {
        project: pinned,
        source: "pinned",
        note: dim(`${pinned.name} ${dim(pinned.repositoryPath)} — not a repository here; --project to choose another`),
      };
    }
  }

  const recent = projects[0];
  if (recent) {
    return {
      project: recent,
      source: "recent",
      note: dim(`${recent.name} ${dim(recent.repositoryPath)} — not a repository here; --project to choose another`),
    };
  }

  throw new ProjectNotFoundError(
    `${cwd} is not inside a git repository and no project is connected yet. Try \`openteam init <path>\`.`,
  );
};

/**
 * Connects one specific directory.
 *
 * `init` is a request about a named path, so it must never fall back to the
 * default project: reporting a different repository as connected because the
 * given path happened not to be a checkout would be worse than failing.
 */
export const connectRepository = async (
  orchestrator: Orchestrator,
  path: string,
  options: { name?: string; defaultBranch?: string; log: (message: string) => void },
): Promise<Project> => {
  const target = absolutePath(path);
  const repositoryRoot = await repositoryAt(target);
  if (!repositoryRoot) {
    throw new ProjectNotFoundError(`${target} is not a git repository. Run \`git init\` there first.`);
  }

  const existing = orchestrator.listProjects().find((project) => project.repositoryPath === repositoryRoot);
  if (existing) {
    options.log(dim(`already connected as ${existing.name}`));
    return existing;
  }

  options.log(dim(`connecting ${repositoryRoot}`));
  const name = options.name?.trim();
  return orchestrator.createProject({
    name: name || basename(repositoryRoot),
    repositoryPath: repositoryRoot,
    defaultBranch: options.defaultBranch?.trim() || undefined,
  });
};

/** Convenience wrapper for callers that only need the project. */
export const resolveProject = async (orchestrator: Orchestrator, options: ResolveOptions): Promise<Project> =>
  (await selectProject(orchestrator, options)).project;

export const describeProject = (project: Project): string =>
  `${project.name} ${dim(oneLine(project.repositoryPath))}`;