# AgentSwarm user guide

A local control plane that runs coding agents against your git repository without
letting them touch your working tree. Every task gets an isolated checkout on its own
branch, and nothing reaches your branch until you review the diff and click Merge.

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
20.12). On anything older the server still starts, but you must export the variables
yourself. Developed and tested against Node 22.

```bash
npm install
cp .env.example .env      # optional; sensible defaults apply without it
npm run dev               # http://127.0.0.1:4317
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode, restarts on file changes |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the test suite |
| `npm run lint` | Alias for `typecheck` |

### Configuration

All settings come from the environment; `.env` is loaded automatically at startup.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4317` | |
| `HOST` | `127.0.0.1` | Non-loopback requires a shared token |
| `AGENTSWARM_DATA_DIR` | `./data` | Where state, mirrors, and workspaces live |
| `AGENTSWARM_SHARED_TOKEN` | *(empty)* | Required to reach the API when `HOST` is not loopback |
| `CODEX_COMMAND` | `codex` | Override a provider binary |
| `CLAUDE_COMMAND` | `claude` | |
| `OPENCODE_COMMAND` | `opencode` | |
| `HERMES_COMMAND` | `hermes` | |
| `AGENTSWARM_AGENT_COMMAND` | *(empty)* | Command for the `custom` provider |

---

## 3. First run, end to end

### 3.1 Connect a repository

Click **+ Connect repository** in the sidebar and give a name, the absolute path to a
local git repo, and optionally a default branch. The branch is resolved from the
repo's `HEAD` if you leave it blank.

AgentSwarm records `repositoryPath` (your original) and `managedRepositoryPath` (the
mirror) and emits a `project.created` event. Your checkout is not touched.

### 3.2 Queue a task

In **Delegate work**, fill in:

| Field | Meaning |
| --- | --- |
| **Task title** | One line, becomes the commit subject |
| **Instructions** | The prompt handed to the agent |
| **Agent** | Which CLI runs the work (see §5) |
| **Model** | Optional; forwarded to the agent CLI |
| **Assignee** | Optional; who owns the task. See §7 |
| **Dependencies** | Task IDs that must complete first |
| **Allowed paths** | Files the agent is permitted to change |
| **Acceptance checks** | Recorded in the prompt for the agent to self-check |
| **Verification command** | A shell command that must exit 0 |

The task is created as `queued` and dispatched immediately if it has no unmet
dependencies.

### 3.3 Watch it run

While a task runs you will see these events in the activity feed:

```
task.started         workspace.ready      agent.output (streamed)
verification.passed  / verification.failed
task.review          task.completed       task.failed
```

The agent runs with its working directory set to the isolated workspace, and receives
`AGENTSWARM_TASK_ID`, `AGENTSWARM_PROJECT_ID`, and `AGENTSWARM_PROVIDER` in its
environment.

### 3.4 Review and merge

If the agent changed files, the task lands in `review` and a change appears in the
integration queue. Open **Diff** to read it, then **Approve**, then **Merge**.

The merge is a real `--no-ff` merge performed in a staging clone under `data/merge/`.
If it conflicts, the change is marked `conflict` with git's message and nothing is
applied.

If the agent changed nothing, the task goes straight to `completed`.

### 3.5 Get your work back out

**This is the part people miss.** Merging updates the managed mirror, *not* your
original repository. To publish the result:

```bash
git -C data/repos/<project-id>.git push origin refs/heads/main:refs/heads/agentswarm/alice
```

Push to a branch and open a pull request rather than pushing straight to `main`, so
your collaborator reviews it like any other change.

Then update your own checkout however you normally would.

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

Choose an agent per task. Availability is probed with `<command> --version` and shown
in the dropdown; an unavailable agent cannot be selected.

| Agent | Invocation |
| --- | --- |
| `mock` | Built in. Writes `.agentswarm/mock/<task-id>.json`. No model needed. |
| `codex` | `codex exec --json --sandbox workspace-write [--model M] <prompt>` |
| `claude` | `claude -p --permission-mode acceptEdits --no-session-persistence [--model M] <prompt>` |
| `opencode` | `opencode run [--model M] <prompt>` |
| `hermes` | `hermes -z <prompt> --accept-hooks [--model M]` |
| `custom` | Whatever `AGENTSWARM_AGENT_COMMAND` points at |

Start with `mock` to confirm the pipeline works before spending tokens on a real agent.

### 5.1 Hermes specifics

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

### 5.2 Choosing a model

Set **Model** on the task, or leave it blank to use the agent's own default. The value
is passed through verbatim, so use whatever identifier your agent expects
(`tencent/hy3:free` for Hermes, `gpt-5` for Codex, and so on).

---

## 6. Working with a friend

There are two workable arrangements.

### Sharing one instance

Set `AGENTSWARM_SHARED_TOKEN` and bind to a reachable address:

```bash
AGENTSWARM_SHARED_TOKEN=$(openssl rand -hex 16) HOST=0.0.0.0 npm run dev
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
there are no lost updates. Assignee badges and the filter in §7 are what keep the list
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

## 7. Assignees and the filter

Set **You are** in the sidebar; it is stored in `localStorage` and used by
**Show my tasks**.

- **Assignee** on a new task records the owner.
- **+ claim** on an unowned card assigns it to you.
- Clicking an assignee badge filters the board to that person; click again to clear.
- **Filter by assignee** matches any part of a name and is also remembered.
- A note under the filter reports how many tasks are hidden.
- The integration queue shows who authored each change.

The `Assignee` field autocompletes from names already in use.

---

## 8. Data layout

Everything lives under `AGENTSWARM_DATA_DIR` (default `./data`), which is gitignored.

```
data/
  state.json                        all application state, see below
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

## 9. HTTP API

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

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Refuses to start, mentions `AGENTSWARM_SHARED_TOKEN` | `HOST` is not loopback. Set a token, or use `127.0.0.1`. |
| Every API call returns 401 | Token missing or wrong. Check the **Shared token** field; the UI stores it in `localStorage`. |
| Task fails with `Verification command failed` | `verifyCommand` exited non-zero. Nothing was committed. |
| Task fails with `Changed files outside allowed paths` | The agent edited files you excluded. Widen the list or tighten the instructions. |
| Task `completed` but nothing happened | The agent exited 0 without touching a file, so no change was created. Read `result` on the task. |
| `Source and managed branches diverged` | See the synchronisation trap in §6. Merge `origin/main` into the mirror by hand. |
| Merge reported as `failed` with no message | The mirror branch moved during the merge. Re-dispatch the task. |
| `hermes exited with code 0` but the task shows `failed` | Expected. Hermes exits 0 on provider errors; the adapter detects them from the first output line. |
| Agent seems to hang | Runs are capped at 30 minutes. Hermes may also be waiting on an approval prompt; `--accept-hooks` is already passed. |
| Task stays `queued` | A dependency is not `completed`. Check the task's `dependencies`. |

### Logs

`console.error` output goes to wherever you launched the process. The activity feed in
the UI carries the per-task event history, and `GET /api/projects/:id/events` streams
the same events live.

---

## 11. Development

```bash
npm test          # 15 tests
npm run typecheck # tsc --noEmit, also what `npm run lint` runs
```

Layout:

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Routing, auth, request parsing, static files |
| `src/orchestrator.ts` | Task lifecycle, dispatch, merges |
| `src/store.ts` | JSON persistence, event log, subscriptions |
| `src/git.ts` | Mirror, workspace, commit, diff, merge primitives |
| `src/providers.ts` | Agent adapters and argv construction |
| `src/types.ts` | Domain types and status unions |
| `public/` | Untyped frontend, served as-is and not compiled |

Tests use Node's built-in runner and drive real git repositories in `tmpdir`, so
`git` must be on `PATH`.
