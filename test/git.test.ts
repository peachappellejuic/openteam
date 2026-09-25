import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  commitWorkspace,
  createBareMirror,
  getBareHead,
  getDiff,
  getRepositoryInfo,
  getWorkspace,
  mergeChange,
  publishWorkspaceBranch,
} from "../src/git.js";
import { createTestRepository } from "./helpers.js";

test("Git mirror, isolated workspace, and merge queue work together", async () => {
  const source = await createTestRepository("agentswarm-git-");
  const root = join(source, "..", `mirror-${Date.now()}.git`);
  const workspace = join(source, "..", `workspace-${Date.now()}`);
  try {
    const info = await getRepositoryInfo(source);
    assert.equal(info.branch, "main");
    const mirror = await createBareMirror(source, root, "main");
    const base = await getBareHead(mirror.root, "main");
    await getWorkspace(mirror.root, workspace, base, "agentswarm/task/test");
    await readFile(join(workspace, "README.md"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(workspace, "feature.txt"), "feature\n", "utf8");
    const commit = await commitWorkspace(workspace, "Add feature");
    await publishWorkspaceBranch(workspace, "agentswarm/task/test");
    assert.notEqual(commit, base);
    assert.match(await getDiff(workspace, base, commit), /feature\.txt/);
    const result = await mergeChange(mirror.root, "main", base, "agentswarm/task/test", "test-merge");
    assert.equal(result.status, "merged");
    assert.notEqual(await getBareHead(mirror.root, "main"), base);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
