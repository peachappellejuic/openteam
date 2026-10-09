import { badge, changeBadge, bold, cyan, dim, green, relativeTime, shortSha, yellow } from "../cli/format.js";
import type { Change, Task } from "../types.js";
import type { PromptOption, TuiCommand } from "./commands.js";
import { clip, displayWidth, fit, wrap, type Size } from "./screen.js";

export type Pane = "tasks" | "changes";

export interface ViewState {
  pane: Pane;
  selected: number;
  detail: boolean;
  /** Scroll offset within the detail pane. */
  scroll: number;
}

export interface Frame {
  lines: string[];
}

const PANEL_BORDER = "\u2502";

/** Top bar: project, branch, and what the pipeline is doing right now. */
export const header = (
  size: Size,
  project: { name: string; defaultBranch: string; repositoryPath: string } | undefined,
  counts: { running: number; review: number; queued: number },
  concurrency: number,
): string[] => {
  const left = project
    ? `${bold("openteam")} ${project.name} ${dim(project.defaultBranch)}`
    : `${bold("openteam")} ${dim("no project")}`;

  const parts: string[] = [];
  if (counts.running) parts.push(cyan(`${counts.running} running`));
  if (counts.review) parts.push(yellow(`${counts.review} to review`));
  if (counts.queued) parts.push(dim(`${counts.queued} queued`));
  if (!parts.length) parts.push(dim("idle"));
  const right = `${parts.join(dim(" \u00b7 "))}${dim(` \u00b7 max ${concurrency}`)}`;

  const gap = size.columns - displayWidth(left) - displayWidth(right);
  const rule = dim("\u2500".repeat(size.columns));
  // When the two halves cannot both fit, the right side gives way.
  const combined = gap > 0 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`;

  // One bar: title on the left, live counts on the right. The project path sits
  // beneath it because the session may not be running in that directory.
  return [fit(combined, size.columns), dim(clip(project?.repositoryPath ?? "", size.columns)), rule];
};

/**
 * One row of the task or change list, as a single string.
 *
 * The width budget in the column layouts reserves a single space between
 * cells, so the separator has to be emitted here or the row comes up short.
 */
export const row = (selected: boolean, columns: Array<{ text: string; width: number }>): string => {
  const cells = columns.map((column, index) => {
    const padded = fit(column.text, column.width);
    // Highlight the whole row, not just the status cell.
    return selected && index === 0 ? `\u001b[7m${padded}\u001b[27m` : padded;
  });
  return fit(cells.join(" "), cells.reduce((total, cell) => total + displayWidth(cell), 0) + cells.length - 1);
};

/**
 * Column budget for the task list.
 *
 * The title is what matters, so the optional columns are dropped as the pane
 * narrows rather than squeezing the title down to nothing.
 */
const TASK_COLUMNS = (width: number): Array<{ key: string; width: number }> => {
  const statusWidth = 11;
  const gap = 1;
  const columns: Array<{ key: string; width: number }> = [{ key: "status", width: statusWidth }];
  let remaining = width - statusWidth - gap;

  for (const optional of [
    { key: "agent", width: 12 },
    { key: "time", width: 11 },
    { key: "id", width: 20 },
  ]) {
    // Only add a column if the title keeps a usable share afterwards.
    if (remaining - optional.width - gap < 24) break;
    columns.push({ key: optional.key, width: optional.width });
    remaining -= optional.width + gap;
  }
  columns.push({ key: "title", width: Math.max(8, remaining) });
  return columns.sort((a, b) => ORDER[a.key] - ORDER[b.key]);
};

const ORDER: Record<string, number> = { status: 0, title: 1, agent: 2, time: 3, id: 4 };

export const taskRow = (task: Task, selected: boolean, width: number): string => {
  const columns = TASK_COLUMNS(width);
  const values: Record<string, string> = {
    status: badge(task.status),
    title: task.title,
    agent: task.model ? `${task.provider}/${task.model}` : task.provider,
    time: relativeTime(task.updatedAt),
    id: task.id,
  };
  return row(selected, columns.map((column) => ({ text: values[column.key] ?? "", width: column.width })));
};

const CHANGE_COLUMNS = (width: number): Array<{ key: string; width: number }> => {
  const statusWidth = 11;
  const gap = 1;
  const columns: Array<{ key: string; width: number }> = [{ key: "status", width: statusWidth }];
  let remaining = width - statusWidth - gap;

  for (const optional of [
    { key: "branch", width: 22 },
    { key: "time", width: 11 },
    { key: "id", width: 20 },
  ]) {
    if (remaining - optional.width - gap < 24) break;
    columns.push({ key: optional.key, width: optional.width });
    remaining -= optional.width + gap;
  }
  columns.push({ key: "summary", width: Math.max(8, remaining) });
  return columns.sort((a, b) => CHANGE_ORDER[a.key] - CHANGE_ORDER[b.key]);
};

const CHANGE_ORDER: Record<string, number> = { status: 0, summary: 1, branch: 2, time: 3, id: 4 };

export const changeRow = (change: Change, selected: boolean, width: number): string => {
  const columns = CHANGE_COLUMNS(width);
  const values: Record<string, string> = {
    status: changeBadge(change.status),
    summary: change.summary,
    branch: change.branch.replace(/^agentswarm\/task\//, ""),
    time: relativeTime(change.updatedAt),
    id: change.id,
  };
  return row(selected, columns.map((column) => ({ text: values[column.key] ?? "", width: column.width })));
};

export const emptyState = (message: string, width: number): string[] => [`${dim(message)}`].map((line) => fit(line, width));

/**
 * The dropdown the prompt raises while it is being completed: a command list for
 * `/`, a provider list for `--provider`.
 *
 * Height is bounded so a long list cannot take over a short terminal, the window
 * follows the selection instead of scrolling the page, and anything hidden is
 * reported rather than silently dropped.
 */
export const optionPalette = (
  options: PromptOption[],
  selected: number,
  size: Size,
  title: string,
  maxRows = 10,
): string[] => {
  if (!options.length) return [fit(dim(`no matching ${title}`), size.columns)];

  const wanted = Math.min(options.length, Math.max(1, Math.min(maxRows, size.rows - 6)));
  const start = Math.max(0, Math.min(selected - wanted + 1, options.length - wanted));
  const shown = options.slice(start, start + wanted);
  const hidden = options.length - wanted;

  const lines: string[] = [
    fit(dim(`${title}  ${options.length}${hidden ? `  (${hidden} not shown)` : ""}`), size.columns),
  ];

  const nameWidth = Math.max(10, ...options.map((option) => displayWidth(optionLabel(option))));
  for (const [offset, option] of shown.entries()) {
    const index = start + offset;
    const isSelected = index === selected;
    const marker = isSelected ? cyan("\u203a") : " ";
    const label = fit(optionLabel(option), Math.min(nameWidth, size.columns - 8));
    const left = `${marker} ${option.usable ? label : dim(label)} `;
    const room = Math.max(4, size.columns - displayWidth(left) - 1);
    const row = fit(`${left}${fit(option.summary, room)}`, size.columns);
    lines.push(isSelected ? `\u001b[7m${row}\u001b[27m` : row);
  }

  if (hidden > 0) {
    lines.push(fit(dim(`  ${hidden} more; keep typing to narrow`), size.columns));
  }
  return lines;
};

const optionLabel = (option: PromptOption): string =>
  option.usage ? `${option.value} ${option.usage}` : option.value;

/** The command palette, which is the option list fed with commands. */
export const commandPalette = (
  commands: TuiCommand[],
  selected: number,
  size: Size,
  maxRows = 10,
): string[] =>
  optionPalette(
    commands.map((command) => ({
      value: `/${command.name}`,
      usage: command.usage,
      summary: command.summary,
      usable: true,
    })),
    selected,
    size,
    "commands",
    maxRows,
  );

/** A single dim line explaining the arguments of the command being typed. */
export const commandHint = (text: string, width: number): string =>
  fit(dim(clip(text, width)), width);

/** Wraps a body of text into a scrollable window. */
export const window_ = (body: string[], height: number, scroll: number): string[] => {
  if (height <= 0) return [];
  const maxScroll = Math.max(0, body.length - height);
  const start = Math.min(Math.max(0, scroll), maxScroll);
  const visible = body.slice(start, start + height);
  const padded = [...visible];
  while (padded.length < height) padded.push("");
  return padded;
};

/**
 * Widths for the two panes. Callers wrap the right pane to `right` so text is
 * not wrapped at one width and then clipped at a narrower one.
 *
 * Below the combined minimum there is no room for a divider, so the panes stack
 * instead: guaranteeing the sum would push the divider off the right edge.
 */
export const splitWidths = (size: Size, leftRatio = 0.55): { left: number; right: number; stacked: boolean } => {
  const columns = size.columns;
  const minimumLeft = 24;
  const minimumRight = 20;
  if (columns < minimumLeft + minimumRight + 3) {
    return { left: columns, right: columns, stacked: true };
  }
  const left = Math.max(minimumLeft, Math.floor(columns * leftRatio) - 1);
  return { left, right: columns - left - 3, stacked: false };
};

/** Draws a vertical divider between two panes. */
export const sideBySide = (left: string[], right: string[], size: Size, leftRatio = 0.55): string[] => {
  const { left: leftWidth, right: rightWidth, stacked } = splitWidths(size, leftRatio);
  const out: string[] = [];

  if (stacked) {
    // Too narrow for two panes: the list wins, and the hint pane is dropped
    // rather than clipped into a column of fragments.
    for (const line of left) out.push(fit(line, size.columns));
    return out;
  }

  const rows = Math.max(left.length, right.length);
  for (let index = 0; index < rows; index += 1) {
    const leftCell = fit(left[index] ?? "", leftWidth);
    const rightCell = fit(right[index] ?? "", rightWidth);
    // slice/padEnd count characters, not columns, so they corrupt any line
    // containing colour codes.
    out.push(fit(`${leftCell} ${dim(PANEL_BORDER)} ${rightCell}`, size.columns));
  }
  return out;
};

export const panelTitle = (text: string, width: number, count?: number): string =>
  fit(bold(text) + (count === undefined ? "" : dim(` ${count}`)), width);

/** The prompt at the bottom, with the hint line above it. */
export const footer = (size: Size, input: string, hint: string, busy: boolean): string[] => {
  const rule = dim("\u2500".repeat(size.columns));
  const marker = busy ? cyan("\u25cf") : cyan("\u203a");
  const prompt = `${marker} `;
  const rows = wrap(input || "", Math.max(10, size.columns - 2), 2);
  const lines = rows.map((rowText, index) =>
    index === 0 ? `${prompt}${rowText}` : `${" ".repeat(2)}${rowText}`,
  );
  return [rule, fit(hint, size.columns), ...lines.map((line) => clip(line, size.columns))];
};

/** Collapses long output into a fixed number of lines for the detail pane. */
export const summarise = (text: string, width: number, lines: number): string[] => {
  if (!text.trim()) return [dim("(nothing yet)")];
  return wrap(text.trim(), width, lines);
};

export { clip, displayWidth, fit, shortSha, wrap };