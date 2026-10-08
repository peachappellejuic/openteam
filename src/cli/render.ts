import { spawn } from "node:child_process";
import { providerRegistry } from "../providers-registry.js";
import { redact, type SecretStore } from "../secrets.js";
import type { Change, Task } from "../types.js";
import {
  badge,
  bold,
  changeBadge,
  cyan,
  dim,
  green,
  gray,
  heading,
  indent,
  pad,
  red,
  relativeTime,
  shortSha,
  truncate,
  yellow,
} from "./format.js";

const MAX_TITLE = 60;

export const TASK_COLUMNS = [
  { header: "STATUS" },
  { header: "TASK" },
  { header: "AGENT" },
  { header: "OWNER" },
  { header: "UPDATED" },
  { header: "ID" },
];

export const CHANGE_COLUMNS = [
  { header: "STATUS" },
  { header: "SUMMARY" },
  { header: "BRANCH" },
  { header: "UPDATED" },
  { header: "ID" },
];

export const renderTaskRows = (tasks: Task[]): string[][] =>
  tasks.map((task) => [
    badge(task.status),
    task.status === "failed" ? red(truncate(task.title, MAX_TITLE)) : truncate(task.title, MAX_TITLE),
    gray(task.model ? `${task.provider}/${task.model}` : task.provider),
    dim(task.assignee ?? "-"),
    dim(relativeTime(task.updatedAt)),
    dim(task.id),
  ]);

export const renderChangeRows = (changes: Change[]): string[][] =>
  changes.map((change) => [
    changeBadge(change.status),
    truncate(change.summary, MAX_TITLE),
    dim(change.branch.replace(/^agentswarm\/task\//, "task/")),
    dim(relativeTime(change.updatedAt)),
    dim(change.id),
  ]);

export const colorizeDiff = (diff: string): string =>
  diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file")) return bold(line);
      if (line.startsWith("+++") || line.startsWith("---")) return bold(line);
      if (line.startsWith("@@")) return cyan(line);
      if (line.startsWith("+")) return green(line);
      if (line.startsWith("-")) return red(line);
      return line;
    })
    .join("\n");

export const changeHeader = (change: Change, projectName: string): string =>
  [
    `${bold("change")}  ${change.id}   ${changeBadge(change.status)}`,
    `${bold("task")}    ${change.taskId}`,
    `${bold("project")} ${projectName}`,
    `${bold("branch")}  ${change.branch}   ${dim(`${shortSha(change.baseSha)} → ${shortSha(change.commitSha)}`)}`,
    change.error ? `${bold("error")}   ${red(change.error)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

const field = (label: string, value: string): string => `${dim(pad(label, 8))}${value}`;

export const taskDetail = (task: Task): string =>
  [
    heading(truncate(task.title, 100)),
    field("id", task.id),
    field("status", badge(task.status)),
    field("agent", `${task.provider}${task.model ? ` (${task.model})` : ""}`),
    field("owner", task.assignee ?? "-"),
    field("branch", task.branch ?? "-"),
    field("created", relativeTime(task.createdAt)),
    task.dependencies.length ? field("needs", task.dependencies.join(", ")) : "",
    task.allowedPaths.length ? field("paths", task.allowedPaths.join(", ")) : "",
    task.verifyCommand ? field("verify", task.verifyCommand) : "",
    task.acceptanceTests.length ? field("checks", task.acceptanceTests.join("; ")) : "",
    "",
    task.description,
    task.error ? `\n${red(task.error)}` : "",
    task.result ? `\n${dim("agent said")}\n${truncate(task.result, 4_000)}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

export const PROVIDER_COLUMNS = [{ header: "" }, { header: "AGENT" }, { header: "COMMAND" }];

export const renderProviderRows = (providers: Array<{ id: string; command: string; available: boolean }>): string[][] =>
  providers.map((provider) => [
    provider.available ? green("ok") : red("missing"),
    bold(provider.id),
    dim(provider.command || "(not configured)"),
  ]);

export const KEY_COLUMNS = [
  { header: "" },
  { header: "PROVIDER" },
  { header: "KIND" },
  { header: "SOURCE" },
  { header: "KEY" },
  { header: "FREE TIER" },
];

export interface KeyRow {
  id: string;
  kind: "api" | "cli";
  /** True when the provider needs no credential at all. */
  optional: boolean;
  source: "env" | "file" | "not required" | "missing";
  /** Redacted value; empty when there is none. */
  hint: string;
  /** What the user should do: the variable to export, or the endpoint to point at. */
  setting: string;
  freeTier: string;
}

export const renderKeyRows = (rows: KeyRow[]): string[][] =>
  rows.map((row) => [
    row.source === "missing" ? (row.optional ? dim("–") : yellow("!")) : green("ok"),
    bold(row.id),
    dim(row.kind),
    row.source === "file" ? cyan(row.source) : dim(row.source),
    dim(row.hint || row.setting),
    dim(row.freeTier),
  ]);

/** One row per direct-API provider describing where its credential comes from. */
export const keyRows = (store: SecretStore, env: NodeJS.ProcessEnv = process.env): KeyRow[] =>
  providerRegistry().entries().map((entry) => {
    if (!entry.requiresKey) {
      return {
        id: entry.id,
        kind: "api",
        optional: true,
        source: "not required" as const,
        hint: "",
        setting: entry.baseUrl,
        freeTier: entry.freeTier,
      };
    }
    const found = store.getAny(entry.envNames, env);
    return {
      id: entry.id,
      kind: "api",
      optional: false,
      source: found ? (env[found.name]?.trim() ? ("env" as const) : ("file" as const)) : ("missing" as const),
      hint: found ? redact(found.value) : "",
      setting: entry.envNames[0],
      freeTier: entry.freeTier,
    };
  });

export const page = async (text: string): Promise<void> => {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  if (!process.stdout.isTTY || process.env.OPENTEAM_PAGER === "0") {
    process.stdout.write(body);
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn("less", ["-R", "-F", "-X"], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, LESS: process.env.LESS ?? "FRX" },
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", () => {
      process.stdout.write(body);
      finish();
    });
    child.once("close", finish);
    child.stdin?.end(body);
  });
};

export const hint = (text: string): string => dim(yellow(text));

export const warn = (text: string): string => red(text);