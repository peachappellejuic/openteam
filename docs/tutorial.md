# Using openteam

A hands-on walkthrough. Every command and every line of output below was produced by
running it against a small throwaway repository, so what you see here is what you
should see.

The example repository is a two-file project:

```
ratelimit/
  package.json
  src/client.js      export async function get(url) { ... }
```

---

## 0. The one idea to hold on to

An agent never edits your working tree. Each task runs in a throwaway checkout of a
managed mirror of your repository, on its own branch. When it finishes, the result is
recorded as a **change** you read, approve, and merge. Until you merge, your repository
is exactly as you left it.

That is the whole design. Everything else follows from it.

---

## 1. Install and check

```bash
cd ~/code/openteam
npm install
npm run build      # compiles to dist/, including the openteam binary
npm link           # puts `openteam` on your PATH
```

Check the environment before you spend anything:

```bash
cd ~/code/ratelimit
openteam doctor
```

```
    CHECK           DETAIL
──  ──────────────  ────────────────────────────────────────────────────────
ok  node            v22.23.2
ok  data dir        /tmp/openteam/data
ok  git repository  /tmp/openteam/ratelimit
!   api openai      no key; set OPENAI_API_KEY
...
ok  api ollama      api:ollama
ok  agent mock      mock
ok  agent codex     codex
ok  agent claude    claude
ok  agent opencode  opencode
ok  agent hermes    hermes
!   agent custom    custom is not on PATH
ok  api keys        0 set, 7 missing (/tmp/openteam/data/keys.json)
```

The `!` lines are not errors. `doctor` reports what exists; it passes whether or not
you have keys. You need exactly one usable agent: a key for a direct API provider, or
one of the agent CLIs.

**Start with `--provider mock`.** It writes a small file and exercises the entire
pipeline — workspace, commit, diff, review, merge — without a model:

```bash
openteam "touch a file" --provider mock
```

---

## 2. Your first real task

```bash
openteam "add a retry helper to src" --provider claude
```

What you see, step by step:

```
ratelimit on main
queued task_f3552557f24d
18:49:08 ● custom started in an isolated workspace
18:49:08 • Workspace ready on agentswarm/task/task_f3552557f24d
Reading src/client.js…
wrote src/retry.js
18:49:08 ○ Change ready for review: AgentSwarm: add a retry helper to src
```

Then the result, with the diff:

```
add a retry helper to src  task_f3552557f24d
review  AgentSwarm: add a retry helper to src
branch agentswarm/task/task_f3552557f24d  09446e4254 → 2e2e1b5df6
files 1 file  +5 -0
```

Read the diff before anything else. It is paged through `less`, and prints straight
out when your output is not a terminal.

If the agent finished without touching a file you get `done  the agent reported no
file changes` instead — common when a model decides the work is already done.

### The options you will use most

| Option | What it does |
| --- | --- |
| `--provider <id>` | Which agent runs the work. See §10. |
| `--model <name>` | Passed straight through to that agent. |
| `--paths '<globs>'` | Files it is allowed to change. Everything else fails the task. |
| `--verify '<cmd>'` | A shell command that must exit 0, run after the agent. |
| `--assignee <name>` | Who owns the task. |
| `--no-follow` | Record the task and exit without starting it. |
| `--json` | Machine-readable output on stdout. |

---

## 3. What the states mean

```
STATUS     TASK                        AGENT   OWNER  UPDATED   ID
────────  ───────────────────────  ──────  ─────  ────────  ─────────────────
○ review   add a retry helper to src  custom   -      2m ago   task_f3552557f24d
✖ failed  tidy the docs              custom   -      1m ago   task_3b30308e736a
● running add caching                 groq     -      now      task_9f1c2d3e4a5b
○ queued   update the docs            claude   -      now      task_6b7a8c9d0e1f
```

| State | Meaning |
| --- | --- |
| `queued` | Recorded, waiting for a free slot or an unmet dependency. |
| `running` | An agent is working in its own workspace. |
| `review` | Finished and produced a diff. Waiting for you. |
| `done` | Finished and changed nothing. |
| `failed` | Failed. The reason is on the task, nothing was committed. |
| `cancelled` | You or a shutdown stopped it. |

Inspect one any time:

```bash
openteam show task_f3552557f24d     # instructions, result, and its changes
openteam tasks                      # active work
openteam tasks --all                # including finished
openteam tasks --status failed      # just failures
```

Tasks can be named by id, by id prefix, or by a fragment of the title:

```bash
openteam show "retry"               # if that matches exactly one task
```

If it is ambiguous it says so rather than guessing:

```
error "retry" matches 2: task_f3552557f24d, task_68ae87824ce0
```

---

## 4. Guardrails that fail the task

Two checks run after the agent and can fail a task. Both leave your repository alone.

**`--verify`** runs in the workspace. Non-zero exit fails the task, and nothing is
committed:

```bash
openteam "add a retry helper" --verify "npm test"
```

```
add a retry helper  task_68ae87824ce0
failed  Verification command failed: exit 1
```

**`--paths`** is checked against the files that actually changed:

```bash
openteam "tidy the docs" --paths 'src/**'
```

```
editing more than asked
18:49:32 ✖ Changed files outside allowed paths: README.md
failed  Changed files outside allowed paths: README.md
```

Your `README.md` is untouched. Use `--paths` whenever an agent could plausibly go
wandering; it is the cheapest guard there is.

### Glob syntax

| Pattern | Covers |
| --- | --- |
| `src` | `src` and everything under it |
| `src/*` | immediate children only |
| `src/**` | everything under `src`, at any depth |
| `*` or `**` | the whole repository |

---

## 5. Review and merge

Nothing merges itself. Two commands:

```bash
openteam changes                       # what is waiting
openteam diff                          # read the newest one
openteam diff chg_27391c43f385         # or a specific change
openteam approve chg_27391c43f385
openteam merge chg_27391c43f385
```

```
○ pending  AgentSwarm: add a retry helper to src  task/task_f3552557f24d  2m ago  chg_27391c43f385

approved chg_27391c43f385  AgentSwarm: add a retry helper to src
merged chg_27391c43f385 as ebbb57e4f1
still only in the mirror — publish it with: openteam push main
```

Merging is a real `--no-ff` merge with git conflict detection. If it conflicts you get
the conflict and nothing is applied:

```
conflict chg_9ce2924f9e8  Auto-merging shared.txt
CONFLICT (add/add): Merge conflict in shared.txt
```

---

## 6. Getting the work back out

**This is the step people miss.** A merge updates the managed mirror, not your
repository. Your checkout is still where it was:

```bash
$ git status --short      # clean
$ git branch
  agentswarm/ratelimit
* main
```

Publish it:

```bash
openteam push
```

```
pushed main agentswarm/ratelimit
open a pull request from that branch; your own checkout was never touched
```

That pushes the mirror branch to `agentswarm/<repo-name>` in your repository. Open a
pull request from it like any other branch. Name both ends explicitly if you prefer:

```bash
openteam push main my-feature-branch
```

---

## 7. The interactive board

Run `openteam` with no arguments:

```
openteam ratelimit main                     2 to review · 1 queued · max 4
/tmp/opencode/ratelimit
───────────────────────────────────────────────────────────────────────────────────────
tasks 3                                   │
○ queued    write the docs                │ next
○ review    add a cache                   │
○ review    write the docs                │ Queued work runs in parallel up to a
                                          │ limit.
                                          │ Two tasks declaring the same --paths
                                          │ are run
                                          │ one at a time so a conflict is never
                                          │ discovered
                                          │ after a full agent run.
                                          │
                                          │ a approve the selected change
                                          │ m merge it into the managed mirror
───────────────────────────────────────────────────────────────────────────────────────
 type an instruction  •  ↑↓ move  → detail  tab switch  enter run  ctrl-c quit
›
```

| Key | Action |
| --- | --- |
| `↑` `↓` | Move the selection |
| `enter` | Run the selected task, or open the selected change |
| `esc` | Back to the list |
| `tab` | Switch between tasks and changes |
| `ctrl-u` `ctrl-w` | Clear the line / delete the last word |
| `ctrl-c` | Leave |

There are **no bare letter shortcuts** — every printable character is typed into
your instruction. A `k` that moved the cursor, or an `a` that approved a change, would
quietly corrupt anything you wanted to say starting with those letters.

Type an instruction and press `enter` to queue work. Quoted phrases survive:
`fix the "foo bar" parser` arrives intact.

### The command palette

Type `/` and the prompt opens a list of what you can do:

```
› /d
commands  3
› /diff [change-id]    show a diff
  /cancel <task-id>    abort a running task
  /keys                provider keys and their free tiers
1 command  •  ↑↓ choose  •  enter or tab to complete  •  esc to dismiss
```

It narrows as you type, prefix matches first:

| Typed | Offers |
| --- | --- |
| `/` | everything |
| `/ap` | `/approve` |
| `/k` | `/keys`, then `/tasks` |

`↑` `↓` choose, `enter` or `tab` fill the command in, `esc` clears it. On a terminal
too short to show the whole list it says how many are hidden rather than dropping them
silently.

It uses the terminal's alternate screen, so your scrollback survives. If your terminal
does not handle that well, `openteam repl` gives you the same commands as a plain
line-based prompt.

---

## 8. More than one task at a time

Queue several and they run in parallel — up to four agents at once:

```bash
openteam "add caching to the client" --no-follow
openteam "write the docs for caching" --no-follow
openteam "add a benchmark" --no-follow
openteam watch
```

`--no-follow` records the task without starting it, which is how you build a queue.
`watch` starts everything ready and follows it.

Raise or lower the limit:

```bash
AGENTSWARM_MAX_CONCURRENCY=8 openteam watch
```

Every agent clones the repository and spends tokens, so the cap exists. When work has
to wait you are told:

```
4 of 6 tasks waited for a free slot or a conflicting peer
```

**Two tasks that both declare the same `--paths` are run one at a time.** A conflict
between them is predictable, so it is cheaper to avoid than to discover after a full
agent run:

```bash
openteam "add caching"        --paths 'src/api/**'    # runs
openteam "rewrite the client" --paths 'src/api/**'    # waits for the first
```

Disjoint scopes run together. Tasks with no `--paths` are not treated as colliding —
they may touch anything, so serialising them would make ordinary use single-file.

---

## 9. Plans

`openteam plan` queues a chain of tasks rather than one:

```bash
openteam plan "migrate the build to esbuild" --paths 'build/**'
```

That builds a three-step scaffold — inspect, implement, verify — where each depends on
the last. It follows the chain as far as it can and stops at the first step that needs
you:

```
3 tasks queued in ratelimit
review  AgentSwarm: Inspect and design
2 tasks waiting on an earlier change: merge it, then run `openteam watch` to continue the chain.
```

**A plan advances one review at a time, by design.** A task only counts as complete
once its change is merged, so each step is a reviewable increment. `openteam merge`
picks the chain back up and continues into the next step automatically.

### Letting a model do the decomposing

The scaffold is fixed. `--decompose` asks a model to inspect the repository and write
the plan instead:

```bash
openteam plan "add caching to the api client and document it" \
  --decompose --provider groq --model llama-3.3-70b-versatile
```

```
   TASK                           SCOPE         AFTER
*  Add caching to the client      src/api/**    -
   Update the docs                docs/**       -
   Wire the cache into the index  src/index.ts  1
4 tasks queued in ratelimit
Two disjoint tracks.
```

The first two are disjoint so they run together; the third waits for the first.

The coordinator may only read the repository — `list_files` and `read_file`. Writes and
shell commands are refused by name. It cannot decide what merges; the plan it returns
is data, and scheduling, scope enforcement, and merging stay deterministic. A malformed
plan is repaired rather than trusted: a task with no description is dropped, and a
dependency on a *later* task is discarded because it could never be satisfied.

`--coordinator <id>` plans with one model while `--provider` executes with another — a
cheap model to plan, an expensive one to do the work.

---

## 10. Providers and keys

### Which agent to use

```bash
openteam providers        # what is installed, what has a key
```

Two kinds:

**Agent CLIs** do the work themselves: `codex`, `claude`, `opencode`, `hermes`, and
`custom` for any command you point `AGENTSWARM_AGENT_COMMAND` at.

**Direct API providers** skip the CLI — openteam speaks HTTP and runs the loop itself.
Use these when no agent CLI is installed for a service, or when you want a local model.

| Provider | Key | Default model |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-3-5-haiku-latest` |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-2.0-flash` |
| `openrouter` | `OPENROUTER_API_KEY` | a `:free` model |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` |
| `ollama` | *none* | `qwen2.5-coder` |

`openteam keys` shows what is set alongside the reality of each free tier, because
"free" varies — Groq, Gemini, Mistral and OpenRouter's `:free` models are usable at no
cost, OpenAI and Anthropic offer trial credits only, and `ollama` is both free and
private.

### Storing keys

```bash
openteam keys                    # what is set, from where
openteam keys set groq           # prompts without echoing; nothing lands in history
openteam keys test groq          # one real request to check it works
openteam keys unset groq
openteam keys path
```

```
    PROVIDER    KIND  SOURCE        KEY                     FREE TIER
──  ──────────  ────  ────────────  ──────────────────────  ──────────────────────────────────────
ok  groq        api   file          gsk_…7890               free tier, generous rate limits
!   openai      api   missing       OPENAI_API_KEY          no free tier, only trial credits
ok  ollama      api   not required  http://127.0.0.1:11434  free and offline
```

Keys are read from the environment first, then from `data/keys.json` at mode `0600`.
Stored keys are also handed to agent CLIs, so `codex` finds `OPENAI_API_KEY` without a
shell profile. They are deliberately *not* given to `--verify` commands.

### Adding your own endpoint

Any OpenAI-, Anthropic-, or Gemini-shaped server works, including local ones:

```bash
openteam provider add my-vllm --wire openai \
  --base-url http://127.0.0.1:8000 \
  --env-name VLLM_API_KEY --model qwen2.5-coder

openteam "fix the flaky test" --provider my-vllm
openteam provider list
openteam provider remove my-vllm
```

Available immediately, with no restart. To point a built-in somewhere else, add the same
id and only the fields you name:

```bash
openteam provider add openai --base-url http://127.0.0.1:8000
# OpenAI now uses the local server, still reads OPENAI_API_KEY, still defaults to gpt-4o-mini
openteam provider remove openai      # back to the built-in configuration
```

> A provider whose base URL is not on this machine is flagged when you add it. The
> agent sends prompts, tool calls, and any file it reads to whatever host you name, so
> a remote endpoint is a real decision.

---

## 11. Working from anywhere

Inside a repository, openteam acts on that one. Outside one it acts on the default —
whichever repository you used last — and says so:

```bash
$ cd /tmp
$ openteam tasks
ratelimit /home/you/code/ratelimit — not a repository here; --project to choose another
```

Pin a different one:

```bash
openteam use                       # list, * marks the default
openteam use ratelimit
openteam use --clear               # follow the working directory again
```

Or override for one command:

```bash
openteam "task" --project ~/code/other-repo
openteam "task" --project ratelimit
```

Connect a repository explicitly whenever you like:

```bash
openteam init ~/code/my-project
openteam init ~/code/api --name api --branch trunk
```

Running a command inside a repository connects it on first use, so `init` is rarely
necessary. `init` never falls back to another project: point it at a directory that is
not a checkout and it says so rather than reporting a false success.

---

## 12. Recipes

```bash
# Explore without changing anything
openteam "explain how the cache invalidation works" --no-follow
openteam tasks

# Work on one area, safely
openteam "add caching" --paths 'src/cache/**' --verify "npm test -- cache"

# Keep an agent honest
openteam "migrate to the new API" --paths 'src/**' --verify "npm run typecheck && npm test"

# Queue a batch, then watch it
for f in a b c; do openteam "fix $f" --no-follow; done
AGENTSWARM_MAX_CONCURRENCY=6 openteam watch

# Resume an interrupted run
openteam run task_f3552557f24d

# Publish and open a PR
openteam push

# Take it back if an agent went wrong
openteam cancel task_9f1c2d3e4a5b
openteam show task_9f1c2d3e4a5b        # read what it said

# Scripting
openteam tasks --json | jq '.tasks[] | select(.status=="review")'
openteam changes --json | jq -r 'first(.changes[]?.id) // "nothing to review"'
```

---

## 13. When something looks wrong

| Symptom | What is happening |
| --- | --- |
| `Unknown provider "my-vllm"` | Add it first: `openteam provider add ...` |
| `No usable API key for Groq` | `openteam keys set groq`, then `openteam keys test groq` |
| `claude is not available on PATH` | Not installed. Use `--provider mock`, or a direct API provider. |
| Task `failed` with `Verification command failed` | Your `--verify` exited non-zero. Nothing was committed. |
| Task `failed` with `outside allowed paths` | The agent edited something you excluded. Widen `--paths` or reword. |
| Task `done` but nothing happened | The agent exited without touching a file. `openteam show <id>` has what it said. |
| Stuck in `queued` | A dependency is not merged yet, or the cap is full. `openteam watch`. |
| `2 tasks waiting on an earlier change` | Expected in a plan. Merge to continue. |
| A merge conflicted | Nothing was applied. Resolve by hand, or reword the task and re-run. |
| `diverged` from `openteam sync` | Your mirror and origin have both moved. Merge `origin/main` into the mirror by hand. |
| `command not found` | `npm run build && npm link`. |
| The board looks broken | `openteam repl`. If the shell is unresponsive, `stty sane`. |

More detail, including the data layout and the HTTP API used by `openteam serve`, is in
[user-guide.md](user-guide.md).