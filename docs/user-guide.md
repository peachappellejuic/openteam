# AgentSwarm user guide

A local control plane that runs coding agents against your git repository without
letting them touch your working tree. Every task gets an isolated checkout on its own
branch, and nothing reaches your branch until you review the diff and merge it.

There are two front ends over the same engine: a **command line client**, which is the
usual way to work, and a **web control plane** for sharing a board with someone else.
Both drive the identical task, review, and merge machinery.

Start with [tutorial.md](tutorial.md) for a hands-on walkthrough. This document is the
reference behind it.

---

## 1. The mental model

Four ideas explain the whole system.

**Managed mirror.** When you connect a repository, AgentSwarm clones it to a bare
mirror at `data/repos/<project-id>.git`. That mirror is the only thing agents ever see.
Your own checkout is never modified by an agent.

**Isolated workspace.** Each task gets its own clone at
`data/workspaces/<project-id>/<task-id>`, created on a fresh branch named
`agentswarm/task/<task-id>` from the mirror's current default branch. Two tasks never
share a directory, so they can run at the same time without stepping on each other.

**Review queue.** When a task finishes, AgentSwarm commits the workspace and records
the diff as a *change*. The task moves to `review` and waits. Nothing merges itself.

**Task graph.** Tasks can declare dependencies. A task only starts once everything it
depends on has reached `completed`, which is how you express "design, then implement,
then verify".

---

## 2. Install and run

No `engines` constraint is declared, but this needs a modern Node: 20.12+ is the
practical floor, because `.env` auto-loading uses `process.loadEnvFile` (added in
20.12). On anything older the CLI still runs, but you must export the variables
yourself. Developed and tested against Node 22.

```bash
npm install
npm run build             # compiles to dist/, including the openteam binary
npm link                  # puts `openteam` on your PATH
```

Then, from inside any git repository:

```bash
openteam "add retry with exponential backoff to the fetch client"
```

That is the whole loop: instruction, live output, diff, then merge when you are happy.

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm run cli -- <args>` | Run the CLI from source without building |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the built CLI (what the `openteam` bin does) |
| `npm run serve` | Run the web control plane |
| `npm test` | Run the test suite |
| `npm run lint` | Alias for `typecheck` |

### Configuration

All settings come from the environment; `.env` is loaded automatically at startup.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4317` | Only used by the web control plane |
| `HOST` | `127.0.0.1` | Non-loopback requires a shared token |
| `AGENTSWARM_DATA_DIR` | `./data` | Where state, mirrors, and workspaces live |
| `AGENTSWARM_SHARED_TOKEN` | *(empty)* | Required to reach the web API when `HOST` is not loopback |
| `CODEX_COMMAND` | `codex` | Override a provider binary |
| `CLAUDE_COMMAND` | `claude` | |
| `OPENCODE_COMMAND` | `opencode` | |
| `HERMES_COMMAND` | `hermes` | |
| `AGENTSWARM_AGENT_COMMAND` | *(empty)* | Command for the `custom` provider |
| `AGENTSWARM_MAX_CONCURRENCY` | `4` | Simultaneous agents per process |
| `NO_COLOR` | *(unset)* | Disables colour, as does `--no-color` |

Provider credentials and endpoints are also read from the environment; see §6.2 for the
full list, or run `openteam keys`.

---

## 3. First run, end to end

### 3.1 Connecting a repository

A project is a connected git repository. `openteam init` creates one:

```bash
openteam init                          # the repository in your working directory
openteam init ~/code/my-project        # a specific path, ~ expanded
openteam init ~/code/api --name api    # name it something other than the directory
openteam init ~/code/api --branch trunk
```

The repository is mirrored to `data/repos/<project-id>.git`, named after the directory
unless `--name` says otherwise, with the branch read from the repo's `HEAD` unless
`--branch` says otherwise. The mirror is the only thing agents ever see; your own
checkout is not touched.

Connecting a repository makes it the **default**, so the next bare `openteam` from
anywhere acts on it. Running `init` again on a path that is already connected reports
the existing project instead of creating a second one, and does not rename or re-branch
it.

`init` is a question about one specific path, so it never falls back to another
project. Given a directory that is not a git repository it fails and says so:

```bash
$ openteam init ~/scratch
error /home/alan/scratch is not a git repository. Run `git init` there first.
```

### 3.2 Which repository it acts on

`openteam` is meant to be typed from wherever you happen to be. It resolves the
repository in this order:

1. **`--project <ref>`** if you passed one. Accepts an id, a name, or a path, and
   `~` is expanded: `--project ~/code/other-repo`.
2. **The repository in your working directory**, if there is one. Running it inside a
   checkout always does what you expect.
3. **The default repository**, otherwise — whichever one you used last, or one you
   pinned with `openteam use`.

You rarely need `init` at all: running any command inside a repository
connects it on first use.

```bash
cd ~/code/my-project
openteam tasks        # connects my-project and prints an empty task list
```

So this works from anywhere, with no `cd`:

```bash
openteam "add retry logic"
```

The first time you work in a new repository it becomes the default, and the next bare
`openteam` from `~` or `/tmp` acts on it. Whenever the repository it picks is *not*
the one in your working directory, it says so rather than acting silently:

```
my-project /home/alan/code/my-project — not a repository here; --project to choose another
```

### 3.3 Pinning a default

`openteam use` lists the connected repositories and marks the default:

```bash
openteam use                     # list, with * on the current default
openteam use my-project          # pin it
openteam use --clear             # go back to following the working directory
```

The pin lives in `data/current.json` and survives between sessions, so it also decides
which repository an interactive session opens on when started from a plain directory.
`/use` inside a session switches and remembers it the same way.

### 3.4 Queue a task

Any text that is not a command name is treated as an instruction:

```bash
openteam "add retry with exponential backoff to the fetch client"
openteam "fix the failing lint error" --provider codex --model gpt-5 --verify "npm test"
```

The instruction becomes both the task title (first sentence, trimmed to 72
characters) and the prompt handed to the agent. Options shape the task:

| Option | Meaning |
| --- | --- |
| `--provider <id>` | Which agent CLI runs the work (see §5) |
| `--model <model>` | Optional; forwarded to the agent CLI |
| `--assignee <name>` | Who owns the task. See §8 |
| `--paths <globs>` | Comma separated allow list of files to change |
| `--verify <command>` | A shell command that must exit 0 |
| `--depends <ids>` | Comma separated task ids that must finish first |
| `--title <text>` | Override the derived title |
| `--no-follow` | Record the task and exit without starting it |
| `--prompt <text>` | Pass the instruction explicitly, for text full of dashes |

`--prompt` exists because recognised flags are stripped from the instruction: to ask
about `--json` in the source, write `openteam --prompt "why is --json stripped from
my prompt"`. A first word that is a near miss on a command name is reported as a
typo rather than quietly handed to an agent.

The task is created as `queued` and dispatched immediately unless `--no-follow` was
passed.

### 3.5 Watch it run

Agent output streams to the terminal as it arrives, interleaved with lifecycle
events:

```
01:15:12 ● claude started in an isolated workspace
01:15:12 • Workspace ready on agentswarm/task/task_a8acd962591c
Reading src/client.ts…
01:15:31 ○ Change ready for review: AgentSwarm: add retry with backoff
```

The agent runs with its working directory set to the isolated workspace, and receives
`AGENTSWARM_TASK_ID`, `AGENTSWARM_PROJECT_ID`, and `AGENTSWARM_PROVIDER` in its
environment. **Ctrl-C stops the client, not the work**: the agent is signalled, the
task settles as `cancelled`, and nothing is left stranded in `running`. Press
Ctrl-C again to exit without waiting.

`openteam watch` reattaches to whatever is already running, and `openteam run <id>`
re-dispatches a specific task.

### 3.6 Review and merge

If the agent changed files, the task lands in `review` and the diff is printed
through `less`, or straight out when output is not a terminal.

```bash
openteam diff              # newest change awaiting review
openteam approve <change>  # mark it ready to merge
openteam merge <change>    # merge into the managed mirror
```

The merge is a real `--no-ff` merge performed in a staging clone under `data/merge/`.
If it conflicts, the change is marked `conflict` with git's message and nothing is
applied.

If the agent changed nothing, the task goes straight to `completed`.

In the web UI the same three steps are **Diff**, **Approve**, and **Merge** buttons.

### 3.7 Get your work back out

**This is the part people miss.** Merging updates the managed mirror, *not* your
original repository. To publish the result:

```bash
openteam push             # pushes the mirror branch to refs/heads/agentswarm/<repo>
openteam push main my-br  # or name both sides explicitly
```

That is shorthand for:

```bash
git -C data/repos/<project-id>.git push origin refs/heads/main:refs/heads/agentswarm/alice
```

Push to a branch and open a pull request rather than pushing straight to `main`, so
your collaborator reviews it like any other change.

Then update your own checkout however you normally would. `openteam sync` reports
whether the mirror has diverged from origin; see the synchronisation trap in §7.

---

## 4. How a task executes

The order below is enforced in `src/orchestrator.ts` and matters when debugging.

1. **Sync.** Fetch the source branch into the mirror. A failure here is a warning, not
   an error; the task continues against the mirror's current state.
2. **Record the base.** Capture `baseSha` from the mirror's default branch. Every
   later comparison uses this SHA.
3. **Prepare the workspace.** Clone the mirror, force-create
   `agentswarm/task/<task-id>` at `baseSha`, and emit `workspace.ready`.
4. **Run the agent.** 30-minute timeout, abortable. Output is streamed to the feed in
   12,000-character chunks and capped at 128 KB.
5. **Verify.** If `verifyCommand` is set, it runs via `/bin/sh -lc` with a 10-minute
   timeout. **A non-zero exit fails the task** before anything is committed.
6. **Commit.** `git add -A` plus a commit as `AgentSwarm: <title>`. A task that changed
   nothing yields `commitSha === baseSha`.
7. **Enforce scope.** If the task has `allowedPaths`, the changed file list is checked
   and the task **fails** if anything outside the list was modified. This runs *after*
   the commit, so a violation is reported rather than silently reverted.
8. **Record the change.** Publish the branch into the mirror and store the diff, capped
   at 512 KB with a truncation notice.

`allowedPaths` matching is simple and predictable: a pattern matches the exact path, or
anything beneath it; `*` and `**` match everything; and a trailing `/*` restricts to
that directory's immediate children.

---

## 5. Agents

Choose an agent per task with `--provider`. Availability is probed with
`<command> --version`, which must exit 0 within two seconds; `openteam providers` or
`openteam doctor` reports the result, and an unavailable agent fails the task rather
than being selected. In the web UI, an unavailable agent cannot be chosen from the
dropdown.

There are two kinds of agent.

**Installed CLIs** are handed the work and do it themselves. **Direct API**
providers skip the CLI: openteam speaks HTTP to the model and runs the loop itself,
which is the only option when no agent CLI is installed for a service.

| Agent | Invocation |
| --- | --- |
| `mock` | Built in. Writes `.agentswarm/mock/<task-id>.json`. No model needed. |
| `codex` | `codex exec --json --sandbox workspace-write [--model M] <prompt>` |
| `claude` | `claude -p --permission-mode acceptEdits --no-session-persistence [--model M] <prompt>` |
| `opencode` | `opencode run [--model M] <prompt>` |
| `hermes` | `hermes -z <prompt> --accept-hooks [--model M]` |
| `custom` | Whatever `AGENTSWARM_AGENT_COMMAND` points at |

Start with `mock` to confirm the pipeline works before spending tokens on a real agent:

```bash
openteam "write a file in the repository" --provider mock
```

The `mock` agent writes `.agentswarm/mock/<task-id>.json`, which is enough to exercise
the whole pipeline — workspace, commit, diff, review, merge — without a model.

### 5.1 Direct API providers

These skip the agent CLI entirely. openteam builds the requests, exposes a small tool
set, and runs the loop until the model calls `finish`.

| Provider | Key | Base URL override | Default model |
| --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `claude-3-5-haiku-latest` |
| `gemini` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `GEMINI_BASE_URL` | `gemini-2.0-flash` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | a `:free` model |
| `groq` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `llama-3.3-70b-versatile` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `deepseek-chat` |
| `mistral` | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `mistral-small-latest` |
| `ollama` | *none* | `OLLAMA_BASE_URL` | `qwen2.5-coder` |

`openteam keys` prints what is set alongside the reality of each free tier, because
"free" varies: Groq, Gemini, Mistral and OpenRouter's `:free` models are genuinely
usable at no cost, OpenAI and Anthropic offer trial credits only, and DeepSeek is
simply cheap. `ollama` is the only option that is both free and private, and it needs
no key at all — just `ollama pull qwen2.5-coder` and a running server.

**Pointing at something else.** Every provider accepts a base URL override, so any
OpenAI-compatible server works: LM Studio, llama.cpp, vLLM, OpenAI-compatible
gateways. For example, against a local llama.cpp server:

```bash
openteam "add a docstring" --provider groq \
  --model qwen2.5-coder \
  --no-color   # with GROQ_BASE_URL=http://127.0.0.1:8080 and no key
```

A provider set to `ollama` with `requiresKey: false` sends no `Authorization` header,
which is what those servers expect.

### 5.2 Tools and limits

The direct providers can call `list_files`, `read_file`, `write_file`, `edit_file`,
`run_command`, and `finish`.

Every path is resolved inside the task's workspace and anything escaping it —
`../secrets`, an absolute path elsewhere, a symlinked parent — is refused before any
filesystem call, so a model cannot read or write outside the throwaway checkout.
`run_command` is *not* filtered: an agent that can edit files can already run code, so
the meaningful boundary is the isolated checkout rather than the command string.

A run stops when the model calls `finish`, answers without asking for a tool, or a
budget is hit: 24 turns and 20 minutes by default, plus a 120-second cap per
command. Partial work is still committed and sent to review rather than discarded,
with the reason recorded on the task.

### 5.3 Concurrency

Independent tasks run in parallel, up to a limit:

```bash
AGENTSWARM_MAX_CONCURRENCY=8 openteam watch
```

The default is **4**. Every agent clones the repository and spends tokens, so an
unlimited fan-out is expensive; the cap defers the surplus rather than dropping it,
and a freed slot immediately picks up the next ready task. Work held back this way is
reported rather than left silent:

```
4 of 6 tasks waited for a free slot or a conflicting peer
```

Two tasks that **both** declare the same `--paths` are additionally run one at a
time, because a conflict between them is predictable and cheaper to avoid than to
discover at merge time:

```bash
openteam "add caching"   --paths 'src/api/**'
openteam "rewrite client" --paths 'src/api/**'   # waits for the first
```

Tasks that declare no `--paths` are **not** treated as colliding. Such a task may touch
anything, so serialising them against each other would make ordinary use single-file
slow; git still refuses the unsafe merge afterwards. Declaring a scope on both sides
is what opts a pair into avoidance.

### 5.4 An LLM coordinator

`openteam plan` normally builds a fixed three-step scaffold. `--decompose` instead
asks a model to inspect the repository and produce the plan:

```bash
openteam plan "add caching to the api client and document it" \
  --decompose --provider groq --model llama-3.3-70b-versatile
```

The coordinator may only `list_files` and `read_file`. Any write, edit, or shell
command is refused by name, so it cannot change the repository while planning. It
returns tasks with explicit `--paths` scopes and dependencies, which become real tasks:

```
   TASK                           SCOPE         AFTER
*  Add caching to the client      src/api/**    -
   Update the docs                docs/**       -
   Wire the cache into the index  src/index.ts  1
```

The first two are disjoint, so they run together; the third waits. `--coordinator <id>`
plans with one provider while `--provider` runs the resulting tasks with another — a
cheap model to plan, an expensive one to execute.

**What is and is not delegated.** Decomposition only. The plan the model returns is
data; scheduling, the concurrency cap, scope enforcement, verification, and merging
stay in the deterministic orchestrator, because a model choosing which branch to merge
would be a security problem rather than a feature. The model also cannot invent
dependencies that create cycles, and malformed tasks are repaired rather than trusted:

- a task with no title or description is dropped
- a dependency on a *later* task is discarded, since it could never be satisfied
- non-numeric or out-of-range indices are ignored
- an explicitly empty dependency list is preserved, so parallel work stays parallel

The plan is capped at `--tasks <n>` (default 8) and 12 inspection turns, because an
unbounded planner is just an expensive way to write a to-do list.

### 5.5 Hermes specifics

Hermes needs two things that the other agents do not.

**Argument order.** `hermes -z` takes the prompt as its value, so the prompt must come
*immediately* after `-z`. Putting `--model` in between makes argparse fail with
`argument -z/--oneshot: expected one argument`. The adapter handles this, which is why
the ordering logic in `buildProviderArgs` is covered by tests.

**Exit code 0 does not mean success.** Hermes reports provider, credential, and quota
failures on stdout and still exits 0. Without special handling a failed run looks like
a clean success and the task is marked `completed` with an error message as its
"result". The adapter therefore inspects the first output line for Hermes' own
diagnostic prefixes (`API call failed after N retries:` and `... agent failed:`) and
fails the task if one matches. Only the first line is checked, so an agent that
legitimately writes prose about a failing test is not misreported.

`--accept-hooks` is passed so a headless run cannot block waiting for approval of hooks
declared in your `~/.hermes/config.yaml`.

### 5.6 Choosing a model

Set `--model` on the task, or leave it blank to use the agent's own default. The value
is passed through verbatim, so use whatever identifier your agent expects
(`tencent/hy3:free` for Hermes, `gpt-5` for Codex, and so on). Direct API providers
fall back to the default in the table in §5.1.

---

## 6. API keys

### 6.1 Where keys come from

Two sources, in this order:

1. **The environment.** `OPENAI_API_KEY` and friends, from your shell or `.env`.
2. **`data/keys.json`**, written by `openteam keys set`.

The environment always wins, so an export overrides anything saved earlier and CI can
inject a value without touching disk. `openteam keys list` shows which source each
provider is using.

Keys held in the file are also handed to agent CLIs. When openteam spawns `codex`,
`claude`, `opencode`, or `hermes`, the stored keys are added to the child's
environment, so a CLI that expects e.g. `GROQ_API_KEY` finds it without a shell
profile. They are deliberately *not* added to verification commands, which run with a
clean environment.

> This means an agent process can read every stored key. These are the same
> credentials the agent CLIs already read from your own profile, and the agent is
> running in a throwaway checkout of your code either way. Do not store keys for
> services that matter more than the repository.

### 6.2 Adding your own providers

The built-in list is not the whole story. Any OpenAI-, Anthropic-, or
Gemini-shaped endpoint can be added, including local servers and gateways:

```bash
openteam provider add my-vllm \
  --wire openai \
  --base-url http://127.0.0.1:8000 \
  --env-name VLLM_API_KEY \
  --model qwen2.5-coder

openteam provider add lmstudio --wire openai --base-url http://127.0.0.1:1234/v1 --no-key
openteam provider list
openteam provider remove my-vllm
```

The added provider is immediately usable everywhere a built-in one is —
`--provider my-vllm`, `openteam keys set my-vllm`, `openteam keys test my-vllm`,
and it appears in the board and in `doctor`. Definitions live in
`data/providers.json` and are re-read when the file changes, so nothing needs a
restart.

| Option | Meaning |
| --- | --- |
| `--wire` | `openai`, `anthropic`, or `gemini`. Selects the request format. |
| `--base-url` | Required. `http` or `https`. |
| `--env-name` | Which variable holds the key, e.g. `VLLM_API_KEY`. |
| `--model` | Default model when a task does not name one. |
| `--no-key` | The server needs no credential. |
| `--free-tier`, `--label` | Notes shown by `openteam keys`. |

**Overriding a built-in.** Adding an id that already exists changes only the fields
you name, so its default model and key variable survive:

```bash
openteam provider add openai --wire openai --base-url http://127.0.0.1:8000
# OpenAI now points at the local server, still reads OPENAI_API_KEY, still uses gpt-4o-mini
openteam provider remove openai    # back to the built-in configuration
```

Ids are constrained to lowercase letters, digits, dot, dash and underscore, and the
six agent CLI ids cannot be redefined, because `--provider codex` means the codex
binary. A corrupt entry is skipped rather than hiding the rest of the file.

> **Where your code goes.** A provider whose base URL is not on this machine is
> flagged when you add it. The agent sends prompts, tool calls, and any file it
> reads to whatever host you name, so a remote endpoint is a real decision rather
> than a detail. Loopback URLs are marked as local.

### 6.3 Managing keys

```bash
openteam keys                     # what is set, what is missing, and each free tier
openteam keys set groq            # prompts without echoing, so nothing lands in history
openteam keys unset groq          # remove a stored key
openteam keys path                # where the file is
openteam keys test                # one live request per configured provider
openteam keys test groq ollama    # just these
```

Inside a session, `/keys` prints the same table. There is deliberately no `/keys set`:
a credential typed into a prompt inside an agent session would be echoed into the
transcript.

`keys set` writes `data/keys.json` with mode `0600`, via a temporary file and an
atomic rename. Nothing else in the CLI ever prints a key: listings show a prefix and
the last four characters (`sk-…mnop`), and an error from a provider reports that the
key was rejected rather than repeating it. A corrupt or unreadable file is treated as
absent rather than fatal, and the next `set` rewrites it.

### 6.4 Checking them

`openteam keys test` makes one minimal request per provider and reports latency or the
reason it failed:

```
    PROVIDER  RESULT
──  ─────────  ──────────────
ok  groq      184ms
!   openai    chat rejected: check the API key for this provider
!   ollama    http://127.0.0.1:11434/v1 models unreachable
```

`openteam doctor` reports key status without touching the network, which makes it safe
to run anywhere.

---

## 7. Working with a friend

There are two workable arrangements.

### Sharing one instance

Set `AGENTSWARM_SHARED_TOKEN` and bind to a reachable address:

```bash
AGENTSWARM_SHARED_TOKEN=$(openssl rand -hex 16) HOST=0.0.0.0 openteam serve
```

Start the server with a non-loopback `HOST` and no token and it **refuses to start**,
because the API can approve and merge code.

Each person pastes the token into the **Shared token** field in the topbar. It is kept
in `localStorage` and sent as `Authorization: Bearer`; the SSE activity stream uses
`?token=` because `EventSource` cannot set headers.

`GET /api/health` and all static assets stay unauthenticated so the page can load and
prompt for a token. Everything else returns `401`. Token comparison is constant-time.

> Put this behind TLS (a reverse proxy or a private network such as Tailscale). As
> written the token crosses plain HTTP.

Both of you see one shared task list, and because a single process owns `state.json`
there are no lost updates. Assignee badges and the filter in §8 are what keep the list
readable.

### Two separate instances

Each person runs their own instance against the same remote repository, each with their
own `AGENTSWARM_DATA_DIR`. They never interfere, and git is the only coordination point:
hand work over by pushing a branch as in §3.5.

### The synchronisation trap

`syncBareMirror` only fast-forwards when the mirror's branch is an **ancestor** of the
remote. The moment you merge a change into the mirror it is no longer an ancestor, so
`Sync source` stops pulling your collaborator's work and reports `ahead` or `diverged`
instead.

When you see that, resynchronise by hand:

```bash
MIRROR=data/repos/<project-id>.git
git -C $MIRROR fetch origin
git -C $MIRROR merge origin/main
```

To avoid it, keep merges small and push promptly. Using disjoint `allowedPaths` for
each person's tasks avoids most conflicts outright.

### A note on concurrent merges

Merging uses git's compare-and-swap (`update-ref <branch> <new> <expected-old-sha>`), so
two merges can never silently clobber each other. If something else moved the branch in
between, git refuses and the change is marked `failed` rather than retried. Re-dispatch
it.

---

## 8. Assignees and the filter

From the CLI, an owner is set with `--assignee` when queuing a task, or afterwards
with `openteam assign <task> <name>`; passing no name clears it. Inside a session,
`/assignee <name>` sets a default for subsequent tasks.

In the web UI, set **You are** in the sidebar; it is stored in `localStorage` and used
by **Show my tasks**.

- **Assignee** on a new task records the owner.
- **+ claim** on an unowned card assigns it to you.
- Clicking an assignee badge filters the board to that person; click again to clear.
- **Filter by assignee** matches any part of a name and is also remembered.
- A note under the filter reports how many tasks are hidden.
- The integration queue shows who authored each change.

The `Assignee` field autocompletes from names already in use.

---

## 9. Data layout

Everything lives under `AGENTSWARM_DATA_DIR` (default `./data`), which is gitignored.

```
data/
  state.json                        all application state, see below
  keys.json                         stored API keys, mode 0600, see §6
  current.json                      the default repository, see §3.3
  repos/<project-id>.git            bare mirror per project
  workspaces/<project-id>/<task-id> per-task checkout
  merge/<merge-id>                  staging area, removed after each merge
```

`state.json` is a single JSON document with five arrays: `projects`, `tasks`, `runs`,
`changes`, and `events`. It is rewritten in full on every change, via a temporary file
and an atomic rename, and events are capped at 5,000.

Identifiers are `<prefix>_<12 hex>`: `prj_`, `task_`, `run_`, `chg_`, `evt_`, `plan_`.

### Statuses

| Kind | Values |
| --- | --- |
| Task | `queued` `running` `review` `completed` `failed` `cancelled` `blocked` |
| Run | `starting` `running` `completed` `failed` `cancelled` |
| Change | `pending` `approved` `merged` `conflict` `failed` `no_changes` |

A change must be `approved` before it can be merged. Merging marks its task
`completed` and deletes the task's workspace.

---

## 10. HTTP API

The CLI talks to the orchestrator in process and never opens a socket. This API
belongs to `openteam serve`, for the web UI and for scripting against a shared
instance.

Every `/api/*` route except `/api/health` requires the shared token when one is
configured. Bodies are JSON; request bodies are capped at 2 MB.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness; never authenticated |
| `GET` | `/api/providers` | Agents and their availability |
| `GET` `POST` | `/api/projects` | List or create projects |
| `GET` | `/api/projects/:id/snapshot` | Project, tasks, runs, changes, events |
| `GET` | `/api/projects/:id/events` | SSE stream |
| `POST` | `/api/projects/:id/sync` | Fetch the source branch |
| `GET` `POST` | `/api/projects/:id/tasks` | List or create tasks |
| `POST` | `/api/projects/:id/plan` | Create a goal-driven task chain |
| `POST` | `/api/projects/:id/dispatch` | Dispatch every ready task |
| `GET` | `/api/tasks/:id` | Task with its runs and changes |
| `POST` | `/api/tasks/:id/dispatch` | Run one task |
| `POST` | `/api/tasks/:id/cancel` | Abort a run |
| `POST` | `/api/tasks/:id/assign` | Set or clear the assignee |
| `GET` | `/api/changes/:id` | A single change |
| `POST` | `/api/changes/:id/approve` | Approve for merge |
| `POST` | `/api/changes/:id/merge` | Merge into the mirror |

### Delegating a plan

`POST /api/projects/:id/plan` with a `goal` creates a default three-step chain —
inspect and design, implement the change, verify and integrate — each depending on the
previous. Supply `tasks` to override the steps entirely. It is a scaffold, not a planner;
the goal string is interpolated into each description.

---

## 11. The command line client

### 10.1 Commands

Every command is also listed by `openteam help`.

| Command | Purpose |
| --- | --- |
| `openteam "<instruction>"` | Queue one task, follow it, show the diff |
| `openteam` | Interactive session |
| `openteam init [path]` | Connect a repository; `--name` and `--branch` override the defaults |
| `openteam use [name\|path\|clear]` | Choose the default repository, or list them |
| `openteam projects` | List connected repositories |
| `openteam providers` | Agents and whether they are on `PATH` |
| `openteam plan "<goal>"` | Queue a chain and follow it; `--decompose` plans it with a model |
| `openteam tasks` | Active tasks (`--all`, `--status`, `--limit`) |
| `openteam show <task>` | One task in full |
| `openteam run <task>` | Start or reattach to a task |
| `openteam watch` | Follow everything currently running |
| `openteam cancel <task>` | Abort a running task |
| `openteam dispatch <task>` | Start a queued task now |
| `openteam assign <task> [who]` | Set or clear the owner |
| `openteam changes` | Changes awaiting review |
| `openteam diff [change]` | Show a diff, paged |
| `openteam approve <change>` | Approve for merge |
| `openteam merge <change>` | Merge into the mirror |
| `openteam sync` | Fetch the source branch |
| `openteam push [branch] [dest]` | Publish the mirror branch to origin |
| `openteam provider [subcommand]` | Add, list, or remove providers, see §6.2 |
| `openteam keys [subcommand]` | Manage provider API keys, see §6.3 |
| `openteam doctor` | Check node, git, data dir, agents, and keys |
| `openteam repl` | Line-based session, no screen control |
| `openteam serve` | Start the web control plane on this data directory |

Global options: `--project <id\|name\|path>`, `--data-dir`, `--json`, `--no-color`, `--no-pager`.
Task options: `--provider`, `--model`, `--assignee`, `--paths`, `--verify`,
`--depends`, `--title`, `--no-follow`.

Tasks and changes can be named by id prefix or by a case-insensitive substring of
their title or summary, so `openteam show "retry"` works.

`--json` switches every command to machine-readable output on stdout. Progress and
diagnostics always go to stderr, so `openteam tasks --json | jq` is safe.

### 10.2 The interactive board

Running `openteam` with no arguments opens a full-screen board. It connects the
repository in your working directory on startup, shows the project and its path in the
header, and updates live as agents run. It uses the terminal's alternate screen, so
your scrollback is untouched when you leave.

```
openteam repo main                                    2 running · 1 to review · max 4
────────────────────────────────────────────────────────────────────────────────
 tasks 2                                          │  next
 ● running  Add exponential backoff  codex/gpt-5   │  Queued work runs in parallel
 ○ queued   Update the docs          claude        │  up to a limit.
────────────────────────────────────────────────────────────────────────────────
 type an instruction  •  ↑↓ move  •  tab switch  •  enter run  •  ctrl-c quit
› add caching
```

| Key | Action |
| --- | --- |
| `↑` `↓` | Move the selection |
| `enter` | Run the selected task, or open the selected change |
| `esc` | Back to the list |
| `tab` | Switch between tasks and changes |
| `a` | Approve the selected change |
| `m` | Merge the selected change into the mirror |
| `ctrl-u` `ctrl-w` | Clear the line / delete the last word |
| `ctrl-c` | Leave; a second press quits even mid-run |

Typing an instruction and pressing `enter` queues a task, the same as the one-shot
form. Quoted phrases survive, so `fix the "foo bar" parser` arrives intact. Flags
typed on the line are honoured, including `--provider`, `--model`, and `--paths`; a
flag missing its value is reported in the board rather than raised as a crash:

```
--provider needs a value
```

A malformed line never takes the board down. Bad flags, an unknown command, or an id
that matches nothing are all shown as a message, and anything that escapes a handler
still restores the terminal before exiting. Slash commands work too, and are the way to reach anything that acts on state:
`/changes`, `/tasks`, `/cancel`, `/approve`, `/merge`, `/sync`, `/push`, `/init`,
`/providers`, `/keys`, `/repl`, `/quit`.

On a terminal too narrow for two panes the list takes the full width and the hint
pane is dropped rather than clipped. Narrow columns are dropped from the list
(`--paths`/`agent`/`time`/`id`) before the title is squeezed, so a task always reads
as a sentence.

### 10.3 The line-based session

`openteam repl` opens the simpler prompt, which needs no screen control and scrolls
like normal output. It connects the repository in your working directory on startup,
and the prompt shows which project and agent are active.

| Command | Purpose |
| --- | --- |
| *plain text* | Queue a task and follow it |
| `/help` | List commands |
| `/status` | Project, running tasks, review queue |
| `/init [path]`, `/projects`, `/use <name>` | Manage connections; `/use` also sets the default |
| `/changes`, `/diff [id]` | Inspect what is awaiting review |
| `/approve <id>`, `/merge <id>` | Integrate a change |
| `/show <id>`, `/cancel <id>` | Inspect or abort a task |
| `/plan <goal>` | Queue a chain |
| `/sync`, `/push [branch]` | Talk to git |
| `/providers` | Agents available on `PATH` |
| `/keys` | Provider keys and free tiers; set them outside the session |
| `/agent <id> [model]` | Set the session's agent |
| `/paths <globs>`, `/verify <cmd>`, `/assignee <name>` | Set session defaults |
| `/clear` | Forget the defaults |
| `/exit` | Leave |

### 10.4 Plan chains and review

`openteam plan` creates three chained tasks. Because a task only becomes `completed`
once its change is **merged**, the chain advances one step per review, which is the
point: a plan is a sequence of reviewable increments, not one unattended run.

The client follows the chain as far as it can go and stops at the first step needing
a decision, telling you how many tasks are still waiting. `openteam merge` picks the
chain back up and continues into the next step, so approving and merging repeatedly
walks the plan to the end.

### 10.5 Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | A task failed or was cancelled, a merge failed, or branches diverged |
| `2` | Bad arguments, unknown command, or no such task or project |

### 10.6 Sharing state with the web UI

The CLI and `openteam serve` read the same `state.json`, but each process owns only
the work it started. Running `openteam tasks` in one terminal never disturbs a task
running in another, and a CLI invocation that exits cancels only its own agents. To
share one board over the network, run `openteam serve` and use §7.

---

## 12. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `openteam: command not found` | Run `npm run build && npm link`, or use `npm run cli --`. |
| The board flashes or the terminal looks wrong | Terminals that do not support the alternate screen or raw mode. Use `openteam repl`. |
| A stack trace appears and the terminal looks broken | A bug, not your input; `stty sane` restores the shell. The terminal is restored automatically on exit and on signals, but a hard kill skips that. |
| Terminal left with no echo after a crash | `stty sane`. Restoration is attempted on exit and on signals, but a hard kill can skip it. |
| `openteam` prints nothing | The bin resolves through a symlink and the entry check failed. Build again, or run `node dist/cli.js`. |
| `Unknown command "tasl"` | A near miss on a command name. Use the suggested name, or pass the text as an instruction. |
| The agent ran the wrong thing | A recognised flag was stripped from your instruction. Use `--prompt "…"`. |
| `is not inside a git repository and no project is connected` | Nothing is connected yet. Run `openteam init <path>`. |
| Acting on the wrong repository | It is using the default, not your working directory; it says so. Override with `--project`, or change the default with `openteam use`. |
| `is not available on PATH` | The agent binary is missing, or it does not exit 0 for `--version`. |
| `claude is not available on PATH` | Expected. Check `openteam providers`; start with `--provider mock`. |
| `Unknown provider "my-vllm"` | Add it first: `openteam provider add my-vllm --wire openai --base-url ...` |
| `No usable API key for Groq` | Run `openteam keys set groq`, or export `GROQ_API_KEY`. `openteam keys test groq` checks it. |
| `keys rejected` | The stored or exported key is wrong or revoked. Replace it and re-test. |
| Task fails with `Verification command failed` | `verifyCommand` exited non-zero. Nothing was committed. |
| Task fails with `Changed files outside allowed paths` | The agent edited files you excluded. Widen `--paths` or tighten the instructions. |
| Task `completed` but nothing happened | The agent exited 0 without touching a file, so no change was created. Read the result with `openteam show <id>`. |
| `Source and managed branches diverged` | See the synchronisation trap in §7. `openteam sync` reports it; reconcile the mirror by hand. |
| Merge reported as `failed` with no message | The mirror branch moved during the merge. Re-dispatch the task. |
| `hermes exited with code 0` but the task shows `failed` | Expected. Hermes exits 0 on provider errors; the adapter detects them from the first output line. |
| Agent seems to hang | Runs are capped at 30 minutes. Hermes may also be waiting on an approval prompt; `--accept-hooks` is already passed. |
| Ctrl-C left a task `running` | It should not: the client signals the agent's whole process group and settles the task. If you killed the process with `SIGKILL`, cancel it with `openteam cancel <id>`. |
| Task stays `queued` | A dependency is not `completed`. Check `openteam show <id>`. |
| `N of M tasks waited for a free slot` | Working as intended; lower `AGENTSWARM_MAX_CONCURRENCY` to see it less. |
| A task waits for another with the same `--paths` | Scope collision avoidance; expected, and cheaper than a merge conflict. |
| `--decompose needs a direct API provider` | Pass `--provider groq`, `openai`, `ollama`, or another direct-API id. |
| `The coordinator returned no usable tasks` | The model produced nothing usable. Retry, or fall back to the default scaffold. |
| `Failed with "outside allowed paths"` on a glob | Unexpected: `src/**`, `src`, and `src/*` all work. |
| Refuses to serve, mentions `AGENTSWARM_SHARED_TOKEN` | `HOST` is not loopback. Set a token, or use `127.0.0.1`. |
| Every web API call returns 401 | Token missing or wrong. Check the **Shared token** field; the UI stores it in `localStorage`. |

### Logs

The CLI writes progress to stderr as it happens, so there is nothing to tail. The web
control plane's activity feed carries the per-task event history, and
`GET /api/projects/:id/events` streams the same events live.

---

## 13. Development

```bash
npm test          # 117 tests
npm run typecheck # tsc --noEmit, also what `npm run lint` runs
```

Layout:

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | CLI entry point: argument parsing, commands, one-shot mode |
| `src/cli/repl.ts` | Interactive session and slash commands |
| `src/cli/args.ts` | Flag parsing, prompt extraction, typo detection |
| `src/cli/core.ts` | Shared session helpers, task following, diff statistics |
| `src/cli/events.ts` | Event rendering, spinner, streamed output, wait loops |
| `src/cli/render.ts` | Tables, task and change details, diff colouring, pager |
| `src/cli/format.ts` | Colour, symbols, column alignment, relative times |
| `src/cli/project.ts` | Project resolution: flag, working directory, then default |
| `src/cli/current.ts` | The pinned default repository and `~` expansion |
| `src/tui/screen.ts` | Alternate screen, raw mode, width-aware clipping and wrapping |
| `src/tui/layout.ts` | Pane widths, header, list rows, footer |
| `src/tui/app.ts` | Board state, live updates, keybindings |
| `src/tui/commands.ts` | Command list shown by the palette |
| `src/orchestrator.ts` | Task lifecycle, dispatch, merges |
| `src/store.ts` | JSON persistence, event log, subscriptions |
| `src/git.ts` | Mirror, workspace, commit, diff, merge, push primitives |
| `src/providers.ts` | Agent adapters and argv construction |
| `src/spawn.ts` | Process-group termination for agents and verification |
| `src/secrets.ts` | Credential resolution, storage, and redaction |
| `src/api/registry.ts` | Direct-API provider metadata and definition validation |
| `src/providers-registry.ts` | Built-in plus user-defined providers |
| `src/api/client.ts` | OpenAI, Gemini, and Anthropic wire formats |
| `src/api/tools.ts` | Sandboxed tools for direct-API agents |
| `src/api/agent.ts` | Tool-calling loop and budgets |
| `src/api/planner.ts` | LLM coordinator: goal to a scoped task plan |
| `src/server.ts` | Web routing, auth, request parsing, static files |
| `src/types.ts` | Domain types and status unions |
| `public/` | Untyped frontend, served as-is and not compiled |

Tests use Node's built-in runner and drive real git repositories in `tmpdir`, so
`git` must be on `PATH`. The CLI tests drive the real entry point through
`execFile`, including a fake agent binary and a local HTTP server standing in for a
model API, so they exercise process spawn, streaming, tool calls, and exit codes
rather than mocks. No test reaches the network.
