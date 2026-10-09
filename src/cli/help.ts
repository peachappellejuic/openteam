export const VERSION = "0.2.0";

const USAGE = `
  openteam — run coding agents against your repo without touching your working tree

  Usage
    openteam [options] "<instruction>"     run one task and follow it to review
    openteam                               open the interactive board

  Works from anywhere. Inside a repository openteam acts on that one; outside
  one it acts on the default, which is whichever repository you used last.

  Commands
    init [path]              connect a git repository (automatic on first run)
    use [name|path|clear]    choose the default repository, or list them
    projects                 list connected repositories
    providers                list agents and report availability
    plan "<goal>"            queue a goal-driven task chain and follow it
                             --decompose asks a model to plan it (needs --provider)
    run <task-id>            follow a task live
    watch                    follow every running task
    tasks                    list tasks
    show <task-id>           show one task
    cancel <task-id>         abort a running task
    dispatch <task-id>       start a queued task now
    assign <task-id> [who]   set or clear the owner
    changes                  list changes awaiting review
    diff [change-id]         show a diff in the terminal
    approve <change-id>      approve a change for merge
    merge <change-id>        merge an approved change into the mirror
    sync                     fetch the source branch into the mirror
    push [branch]            push the mirror branch back to origin
    provider [list|add|remove]     manage providers, including your own endpoints
    keys [list|set|unset|test|path]   manage provider API keys
    doctor                   check the environment
    repl                     line-based session, without the full-screen board
    serve                    start the web control plane
    help, version

  Agents
    Installed CLIs       codex, claude, opencode, hermes, antigravity,
                         custom, mock
    Direct API           openai, anthropic, gemini, openrouter, groq,
                         deepseek, mistral, ollama (local, no key needed)

    Keys are read from the environment first, then from data/keys.json (mode 0600),
    and are handed to agent CLIs as well as used by the direct API providers.

  Providers
    openteam provider list                built-ins plus anything you added
    openteam provider remove my-vllm      drop an added provider

    openteam provider add my-vllm --wire openai
      --base-url http://127.0.0.1:8000 --env-name VLLM_API_KEY
      --model qwen2.5-coder

    openteam provider add openai --base-url http://127.0.0.1:8000   override a built-in

    wire is openai, anthropic, or gemini. Adding a built-in id only changes the
    fields you name, so its model and key variable survive. Definitions live in
    data/providers.json and are used with no restart.

  Keys
    openteam keys                     show what is set, and what is missing
    openteam keys set groq            prompt for the key without echoing it
    openteam keys unset groq          remove a stored key
    openteam keys test [provider...]  make a live request to check each provider
    openteam keys path                where the credentials file lives

  Options
    -p, --project <ref>      project id, name, or path (default: cwd, else the default)
        --provider <id>      agent to run: mock, codex, claude, opencode, hermes,
                         antigravity, custom. Also a comma separated list, or
                         "all" for every installed agent at once
    -m, --model <model>      model passed through to the agent
        --reviewer <id>      a different model reviews the diff; on approve it
                         is merged into the mirror. Publishing stays yours.
        --review-model <m>   model for the reviewer (defaults to its own)
    -a, --assignee <name>    record who owns the task
        --paths <globs>      comma separated allow list of files to change
        --verify <command>   shell command that must exit 0
        --depends <ids>      comma separated task ids that must finish first
        --decompose           plan with a model instead of the default scaffold
        --coordinator <id>    which model plans with --decompose
        --tasks <n>           most tasks a coordinator may produce
        --prompt "<text>"    supply the instruction explicitly
        --status <status>    filter task and change lists
        --all                include finished work in lists
    -n, --limit <n>          limit list output
        --no-follow          queue the task and exit instead of streaming
        --no-pager           never page long output
        --json               machine readable output
        --no-color           disable colour
        --data-dir <path>    override AGENTSWARM_DATA_DIR

  Interactive board
    up/down move   enter open   tab switch pane   esc back   ctrl-c leave
    type an instruction and press enter; type / for the command list

  Examples
    openteam "add retry with exponential backoff to the fetch client"
    openteam "fix the failing lint error" --provider codex --model gpt-5 --verify "npm test"
    openteam plan "migrate the build to esbuild" --paths 'build/**'
    openteam tasks --status review
    openteam diff && openteam approve chg_1a2b3c4d5e6f && openteam merge chg_1a2b3c4d5e6f
    openteam push main
    openteam repl                 # if you prefer a plain prompt

  Concurrency
    At most 4 agents run at once (AGENTSWARM_MAX_CONCURRENCY). Two tasks that both
    declare the same --paths are run one at a time to avoid a predictable conflict.

  Merges land in the managed mirror only. Run \`openteam push\` to publish them.
`;

export const helpText = (): string => USAGE.trimStart();