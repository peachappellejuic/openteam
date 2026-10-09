import type { ChatClient } from "./client.js";
import type { Task } from "../types.js";

/**
 * What a reviewer concluded.
 *
 * `abstain` exists so a reviewer can decline rather than guess. Silence is better
 * than a confident wrong verdict: the change simply stays in the human queue, and
 * a reviewer that admits uncertainty is one worth trusting when it says approve.
 */
export type Verdict = "approve" | "request-changes" | "abstain";

export interface Review {
  verdict: Verdict;
  /** Short reasons, shown on the board. One line each. */
  reasons: string[];
  provider: string;
  model?: string;
  /** False when the reviewer could not be run; the change stays with a human. */
  completed: boolean;
  error?: string;
}

export const VERDICTS: readonly Verdict[] = ["approve", "request-changes", "abstain"];

/** Diffs past this size are truncated: reviewers get worse, not better, with more. */
export const MAX_REVIEW_DIFF = 120_000;

/**
 * Reads a verdict out of whatever the model returned.
 *
 * Models wrap JSON in prose, in code fences, or emit it as the last object in a
 * longer answer, so the last plausible object is taken rather than requiring the
 * whole response to parse. Anything unrecognised abstains: guessing `approve`
 * from a truncated or chatty reply would defeat the point of the gate.
 */
export const parseVerdict = (output: string): { verdict: Verdict; reasons: string[] } => {
  const candidates: string[] = [];
  for (const block of output.split(/```(?:json)?/)) candidates.push(block.replace(/```/g, ""));

  let parsed: unknown;
  for (const candidate of candidates) {
    // The last balanced object in the text, so prose around it is tolerated.
    for (let end = candidate.lastIndexOf("}"); end > 0; end = candidate.lastIndexOf("}", end - 1)) {
      const start = candidate.lastIndexOf("{", end);
      if (start === -1) continue;
      try {
        const value = JSON.parse(candidate.slice(start, end + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value;
          break;
        }
      } catch {
        continue;
      }
    }
    if (parsed) break;
  }

  if (!parsed || typeof parsed !== "object") return { verdict: "abstain", reasons: [] };
  const record = parsed as Record<string, unknown>;
  const raw = String(record.verdict ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  const verdict = VERDICTS.includes(raw as Verdict) ? (raw as Verdict) : "abstain";

  const rawReasons = record.reasons ?? record.reason ?? record.notes;
  const reasons = (Array.isArray(rawReasons) ? rawReasons : [rawReasons])
    .map((reason) => (typeof reason === "string" ? reason.trim() : ""))
    .filter(Boolean)
    .map((reason) => reason.split("\n")[0]!.slice(0, 300));

  return { verdict, reasons: reasons.slice(0, 5) };
};

const REVIEW_SYSTEM = `You review one change to a repository, as a diff, before it is merged.

You are the last automated check before a human may publish this work. Judge only what the diff shows.

Approve only when all of these hold:
- it does what the task asked, and nothing beyond it
- it introduces no bug you can point at in the diff
- tests that should have changed were changed, or none were needed
- no secret, credential, or debug leftover is committed
- no unrelated refactoring or reformatting is bundled in

Request changes when you can name a concrete defect: wrong logic, an unhandled error, a silently swallowed rejection, a breaking API change, a missing test for new behaviour, or scope the task did not authorise.

Abstain when the diff is too large or too unfamiliar for you to judge, or when it depends on files you cannot see.

Be concrete and brief. Name the file and the line.

Reply with one JSON object and nothing else:
{"verdict":"approve"|"request-changes"|"abstain","reasons":["..."]}`;

export interface ReviewInput {
  task: Pick<Task, "title" | "description" | "allowedPaths" | "acceptanceTests">;
  diff: string;
}

/** The user-visible payload sent to the reviewer. */
export const buildReviewPrompt = ({ task, diff }: ReviewInput): string => {
  const scope = task.allowedPaths.length ? task.allowedPaths.join(", ") : "not restricted";
  const checks = task.acceptanceTests.length ? task.acceptanceTests.join("; ") : "none supplied";
  const body = diff.length > MAX_REVIEW_DIFF
    ? `${diff.slice(0, MAX_REVIEW_DIFF)}\n... diff truncated at ${MAX_REVIEW_DIFF} characters ...`
    : diff;
  return [
    "## Task",
    task.title,
    "",
    task.description || task.title,
    "",
    `## Declared scope (--paths)\n${scope}`,
    `## Required checks (--verify)\n${checks}`,
    "## Diff",
    "```diff",
    body,
    "```",
  ].join("\n");
};

/**
 * Asks a model to review a diff.
 *
 * No tools are offered: a reviewer that can edit the workspace is not a reviewer.
 * Any failure abstains rather than approving, so a broken reviewer cannot be
 * mistaken for a permissive one.
 */
export const reviewDiff = async (
  client: ChatClient,
  input: ReviewInput,
  meta: { provider: string; model?: string },
): Promise<Review> => {
  try {
    const response = await client.complete({
      model: client.model,
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: buildReviewPrompt(input) },
      ],
      tools: [],
      maxOutputTokens: 1200,
    });
    const parsed = parseVerdict(response.content);
    return { ...parsed, provider: meta.provider, model: meta.model, completed: true };
  } catch (error) {
    return {
      verdict: "abstain",
      reasons: [],
      provider: meta.provider,
      model: meta.model,
      completed: false,
      error: error instanceof Error ? error.message : "the reviewer could not be reached",
    };
  }
};