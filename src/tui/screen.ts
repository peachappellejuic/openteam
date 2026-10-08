import { emitKeypressEvents } from "node:readline";

export interface Size {
  columns: number;
  rows: number;
}

export interface Key {
  /** Printable text, empty for control keys. */
  sequence: string;
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface Cell {
  /** Character, plus escape sequences already rendered. */
  text: string;
  width: number;
}

const MIN_COLUMNS = 24;
const MIN_ROWS = 8;

const ANSI = {
  enterAlt: "\u001b[?1049h",
  leaveAlt: "\u001b[?1049l",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clear: "\u001b[2J",
  home: "\u001b[H",
  reset: "\u001b[0m",
  reverse: "\u001b[7m",
} as const;

/**
 * Owns the terminal for the duration of the interface.
 *
 * The alternate screen is entered so the user's scrollback survives, raw mode is
 * used so single keys arrive without Enter, and every exit path — including a
 * thrown error or a signal — restores the terminal. A terminal left in raw mode
 * with a hidden cursor is unusable, so restoration is not optional.
 */
export class Screen {
  private entered = false;
  private disposed = false;

  public constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  public get size(): Size {
    return {
      columns: Math.max(MIN_COLUMNS, this.output.columns || MIN_COLUMNS),
      rows: Math.max(MIN_ROWS, this.output.rows || MIN_ROWS),
    };
  }

  public get interactive(): boolean {
    return Boolean(this.input.isTTY) && Boolean(this.output.isTTY);
  }

  public enter(): void {
    if (this.disposed) throw new Error("Screen has already been disposed");
    if (this.entered) return;
    this.entered = true;

    if (this.input.isTTY) this.input.setRawMode?.(true);
    this.input.resume();
    this.output.write(`${ANSI.enterAlt}${ANSI.hideCursor}${ANSI.clear}${ANSI.home}`);
    this.installCleanup();
  }

  public exit(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.output.write(`${ANSI.reset}${ANSI.showCursor}${ANSI.leaveAlt}`);
    if (this.input.isTTY) this.input.setRawMode?.(false);
    this.input.pause();
    this.removeCleanup();
  }

  /** Repaints the whole screen from scratch. */
  public render(lines: string[]): void {
    if (!this.entered) return;
    const { rows } = this.size;
    const padded = [...lines.slice(0, rows)];
    while (padded.length < rows) padded.push("");
    this.output.write(`${ANSI.home}${ANSI.clear}`);
    // One write keeps a frame atomic; partial frames flicker.
    this.output.write(padded.map((line) => `${line}${ANSI.reset}`).join("\r\n"));
  }

  public onKey(handler: (key: Key) => void): () => void {
    emitKeypressEvents(this.input);
    const listener = (value: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): void => {
      handler({
        sequence: typeof value === "string" ? value : "",
        name: key?.name ?? "",
        ctrl: Boolean(key?.ctrl),
        meta: Boolean(key?.meta),
        shift: Boolean(key?.shift),
      });
    };
    this.input.on("keypress", listener);
    return () => this.input.off("keypress", listener);
  }

  public onResize(handler: () => void): () => void {
    this.output.on("resize", handler);
    return () => this.output.off("resize", handler);
  }

  private installCleanup(): void {
    const restore = (): void => this.exit();
    process.once("exit", restore);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, restore);
    }
    this.removeCleanup = () => {
      process.off("exit", restore);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.off(signal, restore);
      }
    };
  }

  private removeCleanup: () => void = () => undefined;
}

export { ANSI as SCREEN_ANSI };

/** Ranges rendered two columns wide, so CJK and emoji do not break alignment. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
];

/** One printable character at `index`, with its display width and code units. */
const widthOf = (text: string, index: number): { text: string; width: number; length: number } => {
  const code = text.codePointAt(index) ?? 0;
  const character = String.fromCodePoint(code);
  const wide = WIDE_RANGES.some(([low, high]) => code >= low && code <= high);
  return { text: character, width: wide ? 2 : 1, length: character.length };
};

/**
 * Trims a rendered string to `width` columns without splitting a wide character
 * or leaving a half-written escape sequence behind.
 */
/**
 * True when a key should insert its character into the prompt.
 *
 * Deliberately based only on the character itself: any rule that also treats a
 * letter as a shortcut means that letter cannot be typed, which silently
 * corrupts instructions. Navigation uses arrows; `/` reaches the commands.
 */
export const isTextKey = (key: Key): boolean =>
  !key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ";

export const clip = (text: string, width: number): string => {
  if (width <= 0) return "";
  let used = 0;
  let out = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const cell = widthOf(text, index);
    if (used + cell.width > width) break;
    out += cell.text;
    used += cell.width;
    index += cell.length;
  }
  return out;
};

/** Pads to `width`, ignoring escapes when measuring. */
export const fit = (text: string, width: number): string => {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
};

export const displayWidth = (text: string): number => {
  let width = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    const cell = widthOf(text, index);
    width += cell.width;
    index += cell.length;
  }
  return width;
};

/**
 * Splits text to fit `width`, preferring a word boundary but falling back to a
 * hard split for unbroken strings like file paths or ids. Explicit newlines are
 * always honoured as breaks, and never survive into a returned line.
 */
export const wrap = (text: string, width: number, maxLines = 1): string[] => {
  if (width <= 0) return [""];
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;

    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        if (current) {
          current += " ";
          currentWidth += 1;
        }
        continue;
      }
      const wordWidth = displayWidth(word);
      if (currentWidth + wordWidth <= width) {
        current += word;
        currentWidth += wordWidth;
        continue;
      }
      if (wordWidth > width) {
        if (current.trim()) out.push(current.trimEnd());
        current = "";
        currentWidth = 0;
        let remaining = word;
        while (displayWidth(remaining) > width) {
          const taken = clip(remaining, width);
          out.push(taken);
          remaining = remaining.slice(taken.length);
        }
        current = remaining;
        currentWidth = displayWidth(current);
        continue;
      }
      if (current.trim()) out.push(current.trimEnd());
      current = word;
      currentWidth = wordWidth;
    }
    out.push(current.trimEnd());
  }

  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    const last = maxLines - 1;
    kept[last] = `${clip(`${kept[last] ?? ""}…`, width)}`;
    return kept;
  }
  return out;
};

/** Column position of the cursor for a prompt, accounting for wrapping. */
export const promptCursor = (text: string, promptWidth: number, totalWidth: number): { row: number; column: number } => {
  const usable = Math.max(1, totalWidth - promptWidth);
  const rows = Math.max(1, Math.ceil(displayWidth(text) / usable));
  const column = displayWidth(text) % usable;
  return { row: rows, column: column === 0 && displayWidth(text) > 0 ? usable : column };
};

export const REVERSE = ANSI.reverse;