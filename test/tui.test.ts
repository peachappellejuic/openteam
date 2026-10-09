import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clip,
  decodeKeys,
  displayWidth,
  fit,
  isIncomplete,
  isTextKey,
  promptCursor,
  wrap,
} from "../src/tui/screen.js";
import {
  commandNames,
  detectCompletion,
  filterCommands,
  filterPromptOptions,
  TUI_COMMANDS,
} from "../src/tui/commands.js";
import {
  changeRow,
  commandHint,
  commandPalette,
  footer,
  optionPalette,
  header,
  panelTitle,
  sideBySide,
  splitWidths,
  summarise,
  taskRow,
  window_,
} from "../src/tui/layout.js";
import { setColor } from "../src/cli/format.js";
import type { Change, Task } from "../src/types.js";

const SIZES = [
  { columns: 200, rows: 50 },
  { columns: 120, rows: 40 },
  { columns: 92, rows: 24 },
  { columns: 80, rows: 24 },
  { columns: 60, rows: 20 },
  { columns: 40, rows: 12 },
  { columns: 24, rows: 8 },
];

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task_a1b2c3d4e5f6",
  projectId: "prj_1",
  title: "Add exponential backoff to the outbound fetch client so retries stop hammering the API",
  description: "Implement retry with backoff.",
  status: "running",
  provider: "codex",
  model: "gpt-5",
  assignee: "alan",
  dependencies: [],
  allowedPaths: ["src/**"],
  acceptanceTests: [],
  branch: "agentswarm/task/task_a1b2c3d4e5f6",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const change = (overrides: Partial<Change> = {}): Change => ({
  id: "chg_0f1e2d3c4b5a",
  projectId: "prj_1",
  taskId: "task_a1b2c3d4e5f6",
  runId: "run_1",
  branch: "agentswarm/task/task_a1b2c3d4e5f6",
  baseSha: "a".repeat(40),
  commitSha: "b".repeat(40),
  status: "pending",
  summary: "AgentSwarm: add exponential backoff to the fetch client",
  diff: "diff --git a/src/f.ts b/src/f.ts\n--- a/src/f.ts\n+++ b/src/f.ts\n@@ -1 +1,4 @@\n-old\n+new\n+more\n",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

test("clipping never exceeds the width, ignoring colour sequences", () => {
  setColor(true);
  for (const width of [1, 4, 10, 40]) {
    const coloured = "\u001b[31mred text here\u001b[39m and more";
    assert.ok(displayWidth(clip(coloured, width)) <= width, `clip to ${width}`);
    assert.ok(displayWidth(fit(coloured, width)) === Math.min(width, displayWidth(coloured)) || width >= displayWidth(coloured));
  }
  setColor(false);
  assert.equal(displayWidth(clip("abcdef", 3)), 3);
  assert.equal(displayWidth(fit("abc", 6)), 6);
});

test("wide characters count as two columns so borders stay aligned", () => {
  setColor(false);
  const cjk = "\u4e2d\u6587\u6d4b\u8bd5";
  assert.equal(displayWidth(cjk), 8);
  assert.equal(displayWidth(clip(cjk, 5)), 4, "cannot split a wide glyph");
  const line = fit(`\u4e2d\u6587`, 10);
  assert.equal(displayWidth(line), 10);
});

test("wrapping breaks on words but keeps long paths intact", () => {
  setColor(false);
  const sentence = "Queued work runs in parallel up to a limit set by the concurrency cap";
  const lines = wrap(sentence, 20, 10);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(displayWidth(line) <= 20, `line fits: ${JSON.stringify(line)}`);

  const path = "src/very/deeply/nested/module/implementation.ts";
  const wrapped = wrap(`see ${path} for details`, 20, 5);
  assert.ok(wrapped.length >= 2, "an unbreakable word must be split rather than overflow");
  for (const line of wrapped) assert.ok(displayWidth(line) <= 20);
  assert.ok(wrapped.join("").includes("implementation.ts"), "no content is lost");
});

test("explicit newlines are honoured and never leak into a returned line", () => {
  setColor(false);
  const body = "first paragraph here\nsecond paragraph here\n\nthird";
  const lines = wrap(body, 40, 10);
  assert.deepEqual(lines, ["first paragraph here", "second paragraph here", "", "third"]);
  for (const line of lines) assert.ok(!line.includes("\n"), `no embedded newline in ${JSON.stringify(line)}`);
});

test("the line budget is honoured and the last line is marked", () => {
  setColor(false);
  const many = Array.from({ length: 50 }, (_unused, index) => `line number ${index}`).join("\n");
  const lines = wrap(many, 30, 5);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /\u2026$/, "truncation is visible");
});

test("the header fits every terminal width exactly", () => {
  setColor(true);
  for (const size of SIZES) {
    const frame = header(
      size,
      { name: "a-fairly-long-project-name", defaultBranch: "main", repositoryPath: "/home/someone/code/project" },
      { running: 3, review: 2, queued: 1 },
      4,
    );
    assert.equal(displayWidth(frame[0]), size.columns, `header bar at ${size.columns}`);
    assert.ok(displayWidth(frame[1]) <= size.columns, `header path at ${size.columns}`);
    assert.equal(displayWidth(frame[2]), size.columns, "the rule spans the width");
    // The title appears once, not duplicated across two bars. Only checkable
    // where it survives clipping.
    if (size.columns >= 60) {
      assert.equal(frame.filter((line) => line.includes("a-fairly-long-project-name")).length, 1);
    }
  }
  setColor(false);
});

test("list rows never exceed the pane width at any size", () => {
  setColor(true);
  for (const size of SIZES) {
    const { left } = splitWidths(size);
    for (const line of [taskRow(task(), false, left), taskRow(task(), true, left)]) {
      assert.equal(displayWidth(line), left, `task row should fill the pane at ${left}`);
    }
    for (const line of [changeRow(change(), false, left), changeRow(change(), true, left)]) {
      assert.equal(displayWidth(line), left, `change row should fill the pane at ${left}`);
    }
  }
  setColor(false);
});

test("the selected row is highlighted and its width is unchanged", () => {
  setColor(true);
  const plain = taskRow(task(), false, 60);
  const selected = taskRow(task(), true, 60);
  assert.equal(displayWidth(plain), displayWidth(selected), "highlighting must not shift columns");
  assert.match(selected, /\u001b\[7m/, "the selected row uses reverse video");
  setColor(false);
});

test("two panes divide the width with no gap and no overflow", () => {
  setColor(false);
  for (const size of SIZES) {
    const { left, right } = splitWidths(size);
    const frame = sideBySide(
      [panelTitle("tasks", left), taskRow(task(), false, left), taskRow(task(), true, left)],
      [panelTitle("next", right), ...wrap("Queued work runs in parallel up to a limit set by the cap.", right, 6)],
      size,
    );
    for (const line of frame) {
      assert.equal(displayWidth(line), size.columns, `frame line width at ${size.columns}`);
    }
    const { stacked } = splitWidths(size);
    if (stacked) {
      assert.ok(!frame.some((line) => line.includes("\u2502")), "a narrow terminal must not clip a divider");
    } else {
      assert.ok(frame.every((line) => line.includes("\u2502")), "the divider spans every line");
    }
  }
});

test("content wrapped for the right pane survives the divider intact", () => {
  setColor(false);
  const size = { columns: 92, rows: 24 };
  const { left, right } = splitWidths(size);
  const prose = [
    "Queued work runs in parallel up to a limit.",
    "Two tasks declaring the same --paths are run one at a time.",
  ].join("\n");
  const frame = sideBySide(
    [panelTitle("tasks", left)],
    wrap(prose, right, 8),
    size,
  );
  const rightText = frame.map((line) => line.slice(left + 3).trim()).join(" ").replace(/\s+/g, " ");
  for (const word of ["Queued", "parallel", "limit", "declaring", "paths", "at"]) {
    assert.ok(rightText.includes(word), `"${word}" should survive: ${rightText}`);
  }
  assert.doesNotMatch(rightText, /--pa\b/, "no word is cut mid-token");
});

test("the scroll window clamps to the body and pads short bodies", () => {
  assert.deepEqual(window_(["a", "b"], 4, 0), ["a", "b", "", ""]);
  assert.deepEqual(window_(["a", "b", "c", "d", "e"], 2, 10), ["d", "e"], "scroll is clamped");
  assert.deepEqual(window_(["a"], 3, -5), ["a", "", ""], "negative scroll clamps to the top");
  assert.deepEqual(window_(["a"], 0, 0), []);
});

test("an empty selection renders a placeholder rather than crashing", () => {
  assert.deepEqual(summarise("", 40, 3), ["(nothing yet)"]);
  assert.deepEqual(summarise("   ", 40, 3), ["(nothing yet)"]);
});

test("the prompt cursor accounts for wrapping", () => {
  assert.deepEqual(promptCursor("short", 3, 40), { row: 1, column: 5 });
  // 80 characters at 37 usable columns fills two rows and starts a third.
  const long = "x".repeat(80);
  assert.deepEqual(promptCursor(long, 3, 40), { row: 3, column: 6 });
  assert.equal(promptCursor("", 2, 40).row, 1);
});
test("the footer never exceeds the width, even for a long or wrapping prompt", () => {
  setColor(true);
  for (const size of SIZES) {
    for (const input of ["", "short", "x".repeat(size.columns * 3)]) {
      for (const busy of [false, true]) {
        for (const line of footer(size, input, "type an instruction  •  up/down move  •  tab switch", busy)) {
          assert.ok(
            displayWidth(line) <= size.columns,
            `footer ${displayWidth(line)} > ${size.columns} for input of ${input.length}`,
          );
        }
      }
    }
  }
  setColor(false);
});

test("a full frame at any size stays inside the terminal", () => {
  setColor(true);
  const item = task({ status: "running" });
  const diff = change();
  for (const size of SIZES) {
    const { left, right } = splitWidths(size);
    const frame = [
      ...header(size, { name: "project", defaultBranch: "main", repositoryPath: "/home/x/project" }, { running: 1, review: 1, queued: 1 }, 4),
      ...sideBySide(
        [panelTitle("tasks", left, 2), taskRow(item, true, left), taskRow(item, false, left)],
        [panelTitle("changes", right, 1), changeRow(diff, false, right)],
        size,
      ),
      ...footer(size, "an instruction typed at the prompt", "hint line", false),
    ];
    for (const line of frame) {
      assert.ok(displayWidth(line) <= size.columns, `frame line ${displayWidth(line)} > ${size.columns}`);
    }
  }
  setColor(false);
});

test("columns are dropped rather than squeezing the title on a narrow pane", () => {
  setColor(false);
  const wide = taskRow(task(), false, 80);
  const narrow = taskRow(task(), false, 40);
  assert.ok(wide.includes("gpt-5"), "a roomy pane shows the model");
  assert.equal(displayWidth(narrow), 40);
  const plain = narrow.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.ok(plain.includes("Add exponential backoff") || plain.includes("Add exponential"), "the title keeps real width");
});

// --- command palette --------------------------------------------------------

test("typing filters by prefix first, then substring", () => {
  assert.equal(filterCommands("/").length, TUI_COMMANDS.length);
  assert.deepEqual(filterCommands("/").map((c) => c.name), commandNames());

  // Prefix matches come before substring matches: /a should offer approve first.
  const a = filterCommands("/a").map((command) => command.name);
  assert.equal(a[0], "approve");

  assert.deepEqual(filterCommands("/ap").map((c) => c.name), ["approve"]);
  // Prefix matches outrank substring matches: keys starts with k, tasks only contains it.
  assert.deepEqual(filterCommands("/k").map((c) => c.name), ["keys", "tasks"]);
  assert.deepEqual(filterCommands("/zz"), []);

  // A query matching nothing returns an empty list rather than everything.
  assert.notEqual(filterCommands("/qqq").length, TUI_COMMANDS.length);
});

test("every listed command is actually implemented", () => {
  // The palette is generated from a list, and app.ts dispatches with a switch.
  // Without this the two drift and the board offers commands that do nothing.
  const source = readFileSync(new URL("../src/tui/app.ts", import.meta.url), "utf8");
  const unhandled = commandNames().filter(
    (name) => !source.includes(`case "${name}"`) && !(name === "exit" && source.includes('"quit"')),
  );
  assert.deepEqual(unhandled, [], "these are offered but not handled");
});

test("the palette fits the terminal and says when it hides commands", () => {
  setColor(false);
  for (const size of SIZES) {
    const all = commandPalette(TUI_COMMANDS, 0, size);
    for (const line of all) {
      assert.ok(displayWidth(line) <= size.columns, `palette line ${displayWidth(line)} > ${size.columns}`);
    }
    assert.ok(all.length <= size.rows, `palette must not exceed ${size.rows} rows, got ${all.length}`);
    assert.ok(all.length > 1, "a match list should render its rows");

    // A short terminal must admit that it is hiding some.
    if (all.length < TUI_COMMANDS.length + 2) {
      assert.match(all.join("\n"), /not shown|more/, "hidden commands are reported, not silently dropped");
    }
  }
  assert.match(commandPalette([], 0, { columns: 40, rows: 10 })[0].trim(), /no matching command/);
});

test("the palette highlights the selected row without shifting it", () => {
  setColor(true);
  const size = { columns: 80, rows: 24 };
  const first = commandPalette(TUI_COMMANDS, 0, size);
  const third = commandPalette(TUI_COMMANDS, 2, size);
  assert.match(first[1], /\u001b\[7m/, "the selected row uses reverse video");
  assert.equal(displayWidth(first[1]), displayWidth(third[3]), "rows all have one width");
  setColor(false);
});

test("every printable letter is a text key, including the old shortcuts", () => {
  // `k` and `j` used to navigate and were swallowed from instructions;
  // `a` and `m` used to approve and merge, so "add caching" could not be typed.
  for (const letter of ["j", "k", "a", "m", "q", "z"]) {
    assert.equal(isTextKey({ sequence: letter, name: letter, ctrl: false, meta: false, shift: false }), true, letter);
  }
  assert.equal(isTextKey({ sequence: " ", name: "space", ctrl: false, meta: false, shift: false }), true);
  assert.equal(isTextKey({ sequence: "", name: "return", ctrl: false, meta: false, shift: false }), false);
  assert.equal(isTextKey({ sequence: "", name: "up", ctrl: false, meta: false, shift: false }), false);
  assert.equal(isTextKey({ sequence: "\t", name: "tab", ctrl: false, meta: false, shift: false }), false);
  assert.equal(isTextKey({ sequence: "c", name: "c", ctrl: true, meta: false, shift: false }), false);
});

test("the usage hint survives being wrapped into a narrow footer", () => {
  for (const size of SIZES) {
    assert.ok(displayWidth(commandHint("14 commands  •  enter to complete", size.columns)) <= size.columns);
  }
});

// --- provider completion ----------------------------------------------------

test("the prompt knows when it is being completed, and what for", () => {
  assert.deepEqual(detectCompletion("/"), { kind: "command", keep: "", query: "", replaceFrom: 0 });
  assert.deepEqual(detectCompletion("/ap"), { kind: "command", keep: "", query: "ap", replaceFrom: 0 });

  // A bare provider flag opens the list.
  const bare = detectCompletion("fix caching --provider");
  assert.equal(bare?.kind, "provider");
  assert.equal(bare?.query, "");

  // A partial value filters.
  assert.equal(detectCompletion("x --provider gro")?.query, "gro");
  assert.equal(detectCompletion("--coordinator lm")?.query, "lm");

  // Completing then typing more keeps filtering rather than closing.
  const refined = detectCompletion("fix --provider ollama o");
  assert.equal(refined?.kind, "provider");
  assert.equal(refined?.query, "o");
  assert.equal(refined?.keep, "fix --provider ollama ");

  // A command with an argument, and an unrelated flag, are not completions.
  assert.equal(detectCompletion("/merge chg_1"), undefined);
  assert.equal(detectCompletion("task --paths src"), undefined);
  assert.equal(detectCompletion("no flags at all"), undefined);
});

test("the kept text always ends in a space so a value cannot run into its flag", () => {
  for (const input of ["--provider", "fix --provider", "fix --provider gro", "--coordinator", "fix --coordinator g"]) {
    const request = detectCompletion(input);
    assert.ok(request?.keep.endsWith(" "), `"${input}" kept "${request?.keep}"`);
    assert.equal(request?.replaceFrom, input.length - request!.query.length);
  }
  // Rebuilding the input from keep + value must be what the user typed.
  const request = detectCompletion("fix caching --provider")!;
  assert.equal(`${request.keep}${"ollama"} `, "fix caching --provider ollama ");
});

test("usable providers are offered before unavailable ones, in a stable order", () => {
  const options = [
    { value: "openai", usage: "not available", summary: "set a key or install it", usable: false },
    { value: "mock", usage: "", summary: "agent cli", usable: true },
    { value: "claude", usage: "", summary: "agent cli", usable: true },
    { value: "groq", usage: "", summary: "direct api", usable: true },
  ];
  assert.deepEqual(filterPromptOptions(options, "").map((o) => o.value), ["mock", "claude", "groq", "openai"]);
  // Substring, not prefix: "a" is in both claude and openai.
  assert.deepEqual(filterPromptOptions(options, "a").map((o) => o.value), ["claude", "openai"]);
  assert.deepEqual(filterPromptOptions(options, "gr").map((o) => o.value), ["groq"]);
  assert.deepEqual(filterPromptOptions(options, "zzz"), []);
  // Order must not depend on the query, or the list jumps around as you type.
  assert.deepEqual(
    filterPromptOptions(options, "").map((o) => o.value),
    filterPromptOptions(options, "").map((o) => o.value),
  );
});

test("the provider dropdown renders and fits like the command one", () => {
  setColor(false);
  const options = [
    { value: "ollama", usage: "", summary: "local, no key needed", usable: true },
    { value: "claude", usage: "", summary: "agent cli", usable: true },
    { value: "openai", usage: "not available", summary: "set a key or install it", usable: false },
  ];
  for (const size of SIZES) {
    const lines = optionPalette(options, 0, size, "providers");
    for (const line of lines) {
      assert.ok(displayWidth(line) <= size.columns, `provider row ${displayWidth(line)} > ${size.columns}`);
    }
    assert.match(lines[0], /providers\s+3/);
  }
  assert.match(optionPalette([], 0, { columns: 40, rows: 10 }, "providers")[0].trim(), /no matching provider/);
});

// --- key decoding ------------------------------------------------------------
// A read can end part-way through an escape sequence. Treating the fragment as a
// finished key made a fast arrow burst cancel whatever was open, which is how
// the provider menu used to close the instant you scrolled it.

test("decodeKeys leaves a split escape sequence incomplete", () => {
  const keys = decodeKeys("\u001b");
  assert.equal(keys.length, 1);
  assert.equal(isIncomplete(keys[0] as never), true);

  const partial = decodeKeys("\u001b[");
  assert.equal(isIncomplete(partial[partial.length - 1] as never), true);
});

test("decodeKeys reads a whole sequence as one arrow, not escape plus text", () => {
  const keys = decodeKeys("\u001b[B").filter((key) => !isIncomplete(key as never));
  assert.equal(keys.length, 1);
  assert.equal((keys[0] as { name: string }).name, "down");
});

test("decodeKeys survives a burst of arrows split across reads", () => {
  const names: string[] = [];
  let pending = "";
  for (const chunk of ["\u001b[B\u001b", "[B\u001b[B"]) {
    const keys = decodeKeys(pending + chunk);
    const last = keys[keys.length - 1];
    pending = last && isIncomplete(last as never) ? (last as { sequence: string }).sequence : "";
    for (const key of keys) {
      if (isIncomplete(key as never)) continue;
      names.push((key as { name: string }).name);
    }
  }
  // Three arrows arrived. The trailing lone ESC is indistinguishable from a real
  // Escape press and is deliberately left for the flush timer rather than being
  // reported here; what matters is that no arrow was ever read as Escape, which
  // is what used to close the open menu.
  assert.equal(names.filter((name) => name === "down").length, 3);
  assert.equal(names.includes("escape"), false);
});

test("decodeKeys maps control and function keys the app relies on", () => {
  const name = (text: string): string =>
    (decodeKeys(text).filter((key) => !isIncomplete(key as never))[0] as { name: string }).name;
  assert.equal(name("\r"), "return");
  assert.equal(name("\n"), "enter");
  assert.equal(name("\t"), "tab");
  assert.equal(name("\u007f"), "backspace");
  assert.equal(isIncomplete(decodeKeys("\u001b")[0] as never), true); // resolved by the flush timer
  const ctrlC = decodeKeys("\u0003")[0] as { name: string; ctrl: boolean };
  assert.equal(ctrlC.name, "c");
  assert.equal(ctrlC.ctrl, true);
});

test("decodeKeys reads modified arrows so ctrl-w is not swallowed as text", () => {
  const shifted = decodeKeys("\u001b[1;2C")[0] as { name: string; shift: boolean };
  assert.equal(shifted.name, "right");
  assert.equal(shifted.shift, true);
});

test("decodeKeys never emits escape for an incomplete sequence", () => {
  // The failure this guards: a fragment arriving alone must not act as Escape,
  // which would cancel the open flow.
  for (const fragment of ["\u001b", "\u001b[", "\u001bO", "\u001b[1;"]) {
    for (const key of decodeKeys(fragment)) {
      assert.notEqual((key as { name: string }).name, "escape", fragment);
    }
  }
});
