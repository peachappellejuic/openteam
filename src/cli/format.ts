const CODES = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  white: [37, 39],
} as const;

export type StyleName = keyof typeof CODES;

let colorEnabled = false;

export const setColor = (enabled: boolean): void => {
  colorEnabled = enabled;
};

export const colorEnabledForStream = (stream: NodeJS.WriteStream): boolean =>
  Boolean(stream.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

export const paint = (name: StyleName, text: string): string =>
  colorEnabled ? `\u001b[${CODES[name][0]}m${text}\u001b[${CODES[name][1]}m` : text;

export const bold = (text: string): string => paint("bold", text);
export const underline = (text: string): string => paint("underline", text);
export const dim = (text: string): string => paint("dim", text);
export const red = (text: string): string => paint("red", text);
export const green = (text: string): string => paint("green", text);
export const yellow = (text: string): string => paint("yellow", text);
export const blue = (text: string): string => paint("blue", text);
export const cyan = (text: string): string => paint("cyan", text);
export const gray = (text: string): string => paint("gray", text);
export const magenta = (text: string): string => paint("magenta", text);

export const SYMBOLS = {
  success: "\u2714",
  failure: "\u2716",
  pending: "\u25cb",
  active: "\u25cf",
  waiting: "\u25cb",
  bullet: "\u2022",
  arrow: "\u2192",
  spinner: ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"],
} as const;

export const TASK_STATUS_STYLE: Record<string, { label: string; color: StyleName; symbol: string }> = {
  queued: { label: "queued", color: "gray", symbol: SYMBOLS.pending },
  running: { label: "running", color: "cyan", symbol: SYMBOLS.active },
  review: { label: "review", color: "yellow", symbol: SYMBOLS.pending },
  completed: { label: "done", color: "green", symbol: SYMBOLS.success },
  failed: { label: "failed", color: "red", symbol: SYMBOLS.failure },
  cancelled: { label: "cancelled", color: "gray", symbol: SYMBOLS.failure },
  blocked: { label: "blocked", color: "magenta", symbol: SYMBOLS.waiting },
};

export const CHANGE_STATUS_STYLE: Record<string, { label: string; color: StyleName; symbol: string }> = {
  pending: { label: "pending", color: "yellow", symbol: SYMBOLS.pending },
  approved: { label: "approved", color: "cyan", symbol: SYMBOLS.active },
  merged: { label: "merged", color: "green", symbol: SYMBOLS.success },
  conflict: { label: "conflict", color: "red", symbol: SYMBOLS.failure },
  failed: { label: "failed", color: "red", symbol: SYMBOLS.failure },
  no_changes: { label: "no changes", color: "gray", symbol: SYMBOLS.bullet },
};

export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "review"]);

export const badge = (status: string): string => {
  const style = TASK_STATUS_STYLE[status] ?? { label: status, color: "white" as StyleName, symbol: SYMBOLS.bullet };
  return paint(style.color, `${style.symbol} ${style.label}`);
};

export const changeBadge = (status: string): string => {
  const style = CHANGE_STATUS_STYLE[status] ?? { label: status, color: "white" as StyleName, symbol: SYMBOLS.bullet };
  return paint(style.color, `${style.symbol} ${style.label}`);
};

export const heading = (text: string): string => bold(underline(text));

export const indent = (text: string, width = 2): string =>
  text
    .split("\n")
    .map((line) => (line ? `${" ".repeat(width)}${line}` : line))
    .join("\n");

export const truncate = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}\u2026`;

export const oneLine = (text: string, length = 72): string => truncate(text.replace(/\s+/g, " ").trim(), length);

export const visibleWidth = (text: string): number =>
  [...text].reduce((total, character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) return total;
    return total + (code >= 0x1100 && isWide(code) ? 2 : 1);
  }, 0);

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1f9ff) ||
  (code >= 0x20000 && code <= 0x3fffd);

export const pad = (text: string, width: number): string => {
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(padding)}`;
};

export const padStart = (text: string, width: number): string => {
  const padding = Math.max(0, width - visibleWidth(text));
  return `${" ".repeat(padding)}${text}`;
};

export interface Column {
  header: string;
  align?: "left" | "right";
}

export const table = (columns: Column[], rows: string[][]): string => {
  if (!rows.length) return "";
  const widths = columns.map((column, index) =>
    Math.max(visibleWidth(column.header), ...rows.map((row) => visibleWidth(row[index] ?? ""))));
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) =>
        columns[index]?.align === "right" ? padStart(cell, widths[index]) : pad(cell, widths[index]))
      .join("  ")
      .trimEnd();
  const header = renderRow(columns.map((column) => paint("bold", column.header)));
  const rule = renderRow(columns.map((_, index) => dim("\u2500".repeat(widths[index]))));
  return [header, rule, ...rows.map(renderRow)].join("\n");
};

const columnAlign = (column: Column): "left" | "right" => column.align ?? "left";

export const relativeTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "unknown";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const duration = (from: string, to?: string): string => {
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const shortSha = (sha: string): string => (sha.length > 10 ? sha.slice(0, 10) : sha);