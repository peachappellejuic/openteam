
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
    // Read directly from the stream instead of via emitKeypressEvents: that
    // decoder emits a bare "escape" for any chunk that ends mid-sequence, so a
    // fast burst of arrows (one read splitting "\u001b[B\u001b[B") is misread
    // as Escape and cancels whatever is on screen.
    let pending = "";
    const listener = (chunk: Buffer | string): void => {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const rest = pending;
      const keys = decodeKeys(rest);
      const complete: Key[] = [];
      for (const key of keys) {
        if (isIncomplete(key)) {
          // Keep the partial sequence for the next read.
          pending = key.sequence;
          continue;
        }
        complete.push(key);
      }
      for (const key of complete) handler(key);
    };
    this.input.on("data", listener);
    return () => this.input.off("data", listener);
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

const CSI_FINAL = /[\u0040-\u007e]/;

/** The keys `decodeKeys` produces, plus a marker for a partial sequence. */
export type DecodedKey = Key | { name: "incomplete"; sequence: string };

/** Narrows the "partial sequence" marker out of a decode. */
export const isIncomplete = (key: DecodedKey): key is { name: "incomplete"; sequence: string } =>
  key.name === "incomplete";

/**
 * Decodes terminal input into keys.
 *
 * Returns a trailing key named "incomplete" when the buffer ends part-way
 * through an escape sequence, so the caller can wait for the rest instead of
 * acting on a half-read arrow. A lone ESC that is never completed resolves to
 * "escape" on the following read, or immediately if a timer-driven flush is
 * wanted; here it is emitted as escape only once more input arrives.
 */
export const decodeKeys = (buffer: string): DecodedKey[] => {
  const keys: DecodedKey[] = [];
  let index = 0;

  while (index < buffer.length) {
    const char = buffer[index];

    if (char === "\u001b") {
      const next = buffer[index + 1];
      if (next === undefined) {
        keys.push({ name: "incomplete", sequence: buffer.slice(index) });
        return keys;
      }
      if (next === "[" || next === "O") {
        // CSI/SS3: parameters, then a final byte in 0x40-0x7e.
        const params = buffer.slice(index + 2).match(/^[0-9;]*:?[0-9;]*/)?.[0] ?? "";
        const finalIndex = index + 2 + params.length;
        const final = buffer[finalIndex];
        if (final === undefined) {
          keys.push({ name: "incomplete", sequence: buffer.slice(index) });
          return keys;
        }
        if (!CSI_FINAL.test(final)) {
          // Not a sequence after all: treat the ESC as its own key.
          keys.push({ sequence: "\u001b", name: "escape", ctrl: false, meta: false, shift: false });
          index += 1;
          continue;
        }
        keys.push(decodeCsi(buffer.slice(index, finalIndex + 1), params, final));
        index = finalIndex + 1;
        continue;
      }
      // ESC followed by a printable character is alt-modified.
      const code = next.codePointAt(0)!;
      const text = String.fromCodePoint(code);
      keys.push({
        sequence: buffer.slice(index, index + 1 + text.length),
        name: text,
        ctrl: false,
        meta: true,
        shift: false,
      });
      index += 1 + text.length;
      continue;
    }

    if (char === "\r") {
      keys.push({ sequence: char, name: "return", ctrl: false, meta: false, shift: false });
      index += 1;
      continue;
    }
    if (char === "\n") {
      keys.push({ sequence: char, name: "enter", ctrl: false, meta: false, shift: false });
      index += 1;
      continue;
    }
    if (char === "\t") {
      keys.push({ sequence: char, name: "tab", ctrl: false, meta: false, shift: false });
      index += 1;
      continue;
    }
    if (char === "\u007f" || char === "\b") {
      keys.push({ sequence: char, name: "backspace", ctrl: false, meta: false, shift: false });
      index += 1;
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code < 0x20) {
      // Remaining control characters are ctrl-<letter>.
      keys.push({
        sequence: char,
        name: String.fromCharCode(code + 0x60),
        ctrl: true,
        meta: false,
        shift: false,
      });
      index += 1;
      continue;
    }
    const text = String.fromCodePoint(code);
    keys.push({ sequence: text, name: text, ctrl: false, meta: false, shift: false });
    index += text.length;
  }

  return keys;
};

const CSI_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};

/**
 * Decodes one CSI/SS3 sequence.
 *
 * The modifier parameter follows `;`: 2 is shift, 3 alt/meta, 5 ctrl, and 6 is
 * ctrl+shift. Anything unrecognised is left alone rather than guessed at.
 */
const decodeCsi = (sequence: string, params: string, final: string): Key => {
  const parts = params.replace(/:/g, ";").split(";").filter((part) => part !== "");
  const modifier = Number(parts[1] ?? "1");
  const ctrl = modifier >= 5 && modifier % 2 === 1;
  const shift = modifier >= 2 && modifier % 2 === 0;
  const meta = modifier === 3 || modifier === 7 || modifier === 8;

  if (final === "~") {
    const name = CSI_TILDE[parts[0] ?? ""] ?? "unknown";
    return { sequence, name, ctrl, meta, shift };
  }
  return { sequence, name: CSI_NAMES[final] ?? "unknown", ctrl, meta, shift };
};

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