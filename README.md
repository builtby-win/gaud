# Gaud Pi Extension

Run Gaud mode natively inside [Pi](https://pi.ai) — parallel tmux workers, live dashboard, and callback routing all in one Pi extension.

## Install

```bash
pi install git:github.com/builtby-win/gaud
```

Or pin to a specific release:

```bash
pi install git:github.com/builtby-win/gaud@v0.1.9
```

That's it. No global config required. After install, open Pi in any repo and run `/gaud <task>`.

### Prerequisites

- [Pi coding agent](https://pi.ai) installed
- `tmux` on PATH (`brew install tmux` / `apt install tmux`)
- At least one supported agent CLI on PATH: `claude`, `opencode`, `codex`, `gemini`, `agy`/`antigravity`

Check what's available with `/gaud-doctor` after install.

## Usage

```
/gaud <task or PLAN.md>     — ask the foreground agent to plan + launch explicit workers
/gaud-status                — show current run summary
/gaud-dashboard             — open interactive dashboard overlay (Ctrl+Shift+G)
/gaud-attach                — print tmux attach command
/gaud-peek [worker-id]      — peek latest pane output
/gaud-cancel <worker-id>    — send Ctrl+C to a specific worker pane
/gaud-restart <worker-id>   — restart a specific worker pane
/gaud-stop [--kill]         — stop poller; --kill also kills tmux session
/gaud-resume                — reconnect to latest run from session state
/gaud-doctor                — check dependencies and agent CLIs
/gaud-setup                 — configure default agents and prompt sources
```

`/gaud` hands the request to the foreground agent. The agent reads or creates the local markdown plan, identifies the current-milestone workstreams that can actually run in parallel, then calls `gaud_start_run` with explicit workers. The extension no longer invents template TPM/UX/review workers or sizes from keyword heuristics; configured agents are just a pool.

`--fake` launches bash smoke-test workers instead of real agent CLIs (useful for testing the extension itself).

Dashboard keys: `j`/`k` move between workers, `Enter`/`v` shows the tmux command for the selected worker, `p` toggles pane output, `x` sends Ctrl+C (with confirmation), `s` restarts the worker pane (with confirmation), `r` polls now, `a` shows the session attach command, `q` closes.

## How it works

1. You describe a task; the foreground agent plans the current milestone and decides explicit worker assignments.
2. Worker count comes from the plan's parallelizable current-milestone tickets/workstreams. Sequential work is combined; roles with no concrete current work are omitted.
3. The extension launches those explicit workers in a private tmux session and prefixes every worker/agent command with `B2V_DISABLED=true` plus provider-specific YOLO/permission-skip flags where supported.
4. The extension polls tmux pane state, pane logs, permission prompts, stuck/dead agents, and a structured `events.jsonl` callback file.
5. Worker callbacks (`done`, `waiting-user`, `waiting-permission`, `failed`) are injected back into Pi as `GAUDMODE ...` messages — no manual tmux watching needed.
6. The dashboard opens automatically when implementation starts. It shows the plan path, milestone checklist, current-milestone workers/tasks, permission prompts, stuck/dead workers, relaunch/cancel actions, and latest pane output.

Run dirs are written to `.gaud/runs/<run-id>/` in the current repo.

## Development

```bash
pnpm install
pnpm check
pnpm smoke
```

Load locally in Pi with:

```bash
pi -e .
```

Then try:

```
/gaud-status
/gaud-doctor
/gaud --fake build a demo app
/gaud-plan PLAN.md
/gaud-dashboard
```

## Security & Permissions

Pi extensions run with full system permissions. This extension:
- Launches background `tmux` sessions.
- Spawns configured agent CLIs (e.g., `claude`, `opencode`, `agy`/`antigravity`).
- Writes to and manages files under `.gaud/runs/*`.
- Runs a built-in polling loop over tmux state, pane logs, and callback events.
- Can inject worker callback events back into Pi sessions.

Please audit the repository and configurations before executing real agent workers. Use `/gaud-doctor` to audit what CLIs are on PATH.
