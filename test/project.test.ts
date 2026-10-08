import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";
import { expandPath, ProjectPointer, pointerPath } from "../src/cli/current.js";
import { parseArgs, flagBool } from "../src/cli/args.js";
import { connectRepository, ProjectNotFoundError, resolveExplicitProject, selectProject } from "../src/cli/project.js";
import { Orchestrator } from "../src/orchestrator.js";
import { JsonStore } from "../src/store.js";
import { createTestRepository, removeTestPath } from "./helpers.js";

interface Harness {
  orchestrator: Orchestrator;
  pointer: ProjectPointer;
  store: JsonStore;
  release: () => Promise<void>;
}

const harness = async (prefix: string): Promise<Harness> => {
  const source = await createTestRepository(prefix);
  const stateDirectory = await mkdtemp(join(tmpdir(), `${prefix}state-`));
  const dataDirectory = await mkdtemp(join(tmpdir(), `${prefix}data-`));
  const store = new JsonStore(join(stateDirectory, "state.json"));
  const orchestrator = new Orchestrator(store);
  const pointer = new ProjectPointer(pointerPath(dataDirectory));
  return {
    orchestrator,
    pointer,
    store,
    release: async () => {
      await orchestrator.shutdown();
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(dataDirectory, { recursive: true, force: true });
      await removeTestPath(source);
    },
  };
};

const select = (context: Harness, overrides: Partial<Parameters<typeof selectProject>[1]>) =>
  selectProject(context.orchestrator, {
    cwd: tmpdir(),
    create: false,
    log: () => {},
    ...overrides,
  });

test("a tilde is expanded so paths can be typed the way they are written", () => {
  assert.equal(expandPath("~"), homedir());
  assert.equal(expandPath("~/code"), join(homedir(), "code"));
  assert.equal(expandPath("  ~/code  "), join(homedir(), "code"));
  assert.equal(expandPath("/abs/path"), "/abs/path");
  assert.equal(expandPath("relative"), "relative");
});

test("--clear is a boolean flag so `use --clear` is not an unknown option", () => {
  assert.equal(flagBool(parseArgs(["use", "--clear"]), "clear"), true);
});

test("a project can be named by id, name, or path", async () => {
  const context = await harness("agentswarm-pick-");
  const repo = await createTestRepository("agentswarm-pick-repo-");
  try {
    const project = await context.orchestrator.createProject({ name: "alpha", repositoryPath: repo });

    assert.equal(resolveExplicitProject(context.orchestrator, project.id).id, project.id);
    assert.equal(resolveExplicitProject(context.orchestrator, project.id.slice(0, 10)).id, project.id);
    assert.equal(resolveExplicitProject(context.orchestrator, "alpha").id, project.id);
    assert.equal(resolveExplicitProject(context.orchestrator, repo).id, project.id);
    assert.equal(resolveExplicitProject(context.orchestrator, `${repo}/`).id, project.id);
    assert.throws(() => resolveExplicitProject(context.orchestrator, "nope"), ProjectNotFoundError);
  } finally {
    await removeTestPath(repo);
    await context.release();
  }
});

test("a repository in the working directory wins over the pinned default", async () => {
  const context = await harness("agentswarm-cwd-");
  const other = await createTestRepository("agentswarm-cwd-other-");
  try {
    const alpha = await context.orchestrator.createProject({ name: "alpha", repositoryPath: other });
    context.pointer.pin(alpha.id);

    const inside = await select(context, { cwd: other, create: true });
    assert.equal(inside.project.id, alpha.id);
    assert.equal(inside.source, "cwd");
    assert.equal(inside.note, undefined, "acting on the current checkout needs no explanation");
  } finally {
    await removeTestPath(other);
    await context.release();
  }
});

test("outside a repository the pinned default is used and the fallback is stated", async () => {
  const context = await harness("agentswarm-pinned-");
  const elsewhere = await mkdtemp(join(tmpdir(), "agentswarm-plain-"));
  const repo = await createTestRepository("agentswarm-pinned-repo-");
  try {
    const alpha = await context.orchestrator.createProject({ name: "alpha", repositoryPath: repo });
    context.pointer.pin(alpha.id);

    const outcome = await select(context, { cwd: elsewhere, pinned: alpha.id });
    assert.equal(outcome.project.id, alpha.id);
    assert.equal(outcome.source, "pinned");
    assert.match(outcome.note ?? "", /alpha/);
    assert.match(outcome.note ?? "", /not a repository here/);
    assert.match(outcome.note ?? "", /--project/, "the user must be told how to override");
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await removeTestPath(repo);
    await context.release();
  }
});

test("without a pin the most recently connected project is used", async () => {
  const context = await harness("agentswarm-recent-");
  const elsewhere = await mkdtemp(join(tmpdir(), "agentswarm-plain2-"));
  try {
    const firstRepo = await createTestRepository("agentswarm-recent-one-");
    const secondRepo = await createTestRepository("agentswarm-recent-two-");
    await context.orchestrator.createProject({ name: "first", repositoryPath: firstRepo });
    const second = await context.orchestrator.createProject({ name: "second", repositoryPath: secondRepo });

    const outcome = await select(context, { cwd: elsewhere });
    assert.equal(outcome.project.id, second.id, "listProjects is ordered newest first");
    assert.equal(outcome.source, "recent");
    await removeTestPath(firstRepo);
    await removeTestPath(secondRepo);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await context.release();
  }
});

test("an unknown pin falls back rather than failing", async () => {
  const context = await harness("agentswarm-stalepin-");
  const elsewhere = await mkdtemp(join(tmpdir(), "agentswarm-plain3-"));
  try {
    const solo = await createTestRepository("agentswarm-stale-repo-");
    const only = await context.orchestrator.createProject({ name: "only", repositoryPath: solo });
    const outcome = await select(context, { cwd: elsewhere, pinned: "prj_deleted" });
    assert.equal(outcome.project.id, only.id);
    assert.equal(outcome.source, "recent");
    await removeTestPath(solo);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await context.release();
  }
});

test("with nothing connected the error explains what to do", async () => {
  const context = await harness("agentswarm-nothing-");
  const elsewhere = await mkdtemp(join(tmpdir(), "agentswarm-plain4-"));
  try {
    await assert.rejects(select(context, { cwd: elsewhere }), (error: unknown) => {
      assert.ok(error instanceof ProjectNotFoundError);
      assert.match(error.message, /not inside a git repository/);
      assert.match(error.message, /openteam init <path>/);
      return true;
    });
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
    await context.release();
  }
});

test("an explicit --project is honoured over the working directory", async () => {
  const context = await harness("agentswarm-explicit-");
  const cwdRepo = await createTestRepository("agentswarm-explicit-cwd-");
  const other = await createTestRepository("agentswarm-explicit-other-");
  try {
    const pinned = await context.orchestrator.createProject({ name: "pinned", repositoryPath: other });
    const here = await context.orchestrator.createProject({ name: "here", repositoryPath: cwdRepo });

    const outcome = await select(context, { cwd: cwdRepo, explicit: pinned.id, pinned: pinned.id });
    assert.equal(outcome.project.id, pinned.id);
    assert.equal(outcome.source, "flag");
    assert.ok(here.id);
  } finally {
    await removeTestPath(cwdRepo);
    await removeTestPath(other);
    await context.release();
  }
});

test("the pointer survives a corrupt file and round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentswarm-pointer-"));
  const path = pointerPath(directory);
  try {
    assert.equal(new ProjectPointer(path).pinned, undefined);

    new ProjectPointer(path).pin("prj_abc");
    assert.equal(new ProjectPointer(path).pinned, "prj_abc");

    new ProjectPointer(path).clear();
    assert.equal(new ProjectPointer(path).pinned, undefined);

    await writeFile(path, "{broken", "utf8");
    assert.equal(new ProjectPointer(path).pinned, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("connectRepository names a project after the directory and honours overrides", async () => {
  const context = await harness("agentswarm-connect-");
  const repo = await createTestRepository("agentswarm-connect-repo-");
  try {
    const notes: string[] = [];
    const plain = await connectRepository(context.orchestrator, repo, { log: (m) => notes.push(m) });
    assert.equal(plain.name, basename(repo), "the project takes the repository directory name");
    assert.equal(plain.repositoryPath, repo);
    assert.match(notes.join(""), /connecting/);

    const again = await connectRepository(context.orchestrator, repo, {
      name: "backend",
      defaultBranch: "trunk",
      log: (m) => notes.push(m),
    });
    assert.equal(again.id, plain.id, "an existing project is reused, not duplicated");
    assert.equal(again.name, plain.name, "a second connect does not rename or re-branch it");
    assert.match(notes.join(""), /already connected/);
  } finally {
    await removeTestPath(repo);
    await context.release();
  }
});

test("connectRepository refuses a path that is not a repository", async () => {
  const context = await harness("agentswarm-connect-bad-");
  const plain = await mkdtemp(join(tmpdir(), "agentswarm-connect-plain-"));
  const repo = await createTestRepository("agentswarm-connect-good-");
  try {
    await connectRepository(context.orchestrator, repo, { log: () => {} });

    // The crucial case: init must never answer with some other repository just
    // because the requested path turned out not to be a checkout.
    await assert.rejects(connectRepository(context.orchestrator, plain, { log: () => {} }), (error: unknown) => {
      assert.ok(error instanceof ProjectNotFoundError);
      assert.match(error.message, /is not a git repository/);
      assert.match(error.message, /git init/);
      return true;
    });
    assert.equal(context.store.listProjects().length, 1);
  } finally {
    await rm(plain, { recursive: true, force: true });
    await removeTestPath(repo);
    await context.release();
  }
});
