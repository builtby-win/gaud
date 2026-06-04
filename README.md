# Gaud Pi Extension

Run Gaud mode natively inside [Pi](https://pi.ai) — parallel tmux workers, live dashboard, and callback routing all in one Pi extension.

## Install

```bash
pi install git:github.com/builtby-win/gaud
```

Or pin to a specific release:

```bash
pi install git:github.com/builtby-win/gaud@v0.1.0
```

That's it. No global config required. After install, open Pi in any repo and run `/gaud <task>`.

### Prerequisites

- [Pi coding agent](https://pi.ai) installed
- `tmux` on PATH (`brew install tmux` / `apt install tmux`)
- At least one supported agent CLI on PATH: `claude`, `opencode`, `codex`, `gemini`, `agy`/`antigravity`

Check what's available with `/gaud-doctor` after install.

## Usage

```
/gaud <task or PLAN.md>     — plan + launch workers (main entry point)
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

`/gaud` defaults to the planning wizard: reads `PLAN.md` if present, otherwise walks you through creating one interactively. After reviewing the generated execution plan you approve the worker assignment before any agents launch.

`--fake` launches bash smoke-test workers instead of real agent CLIs (useful for testing the extension itself).

Dashboard keys: `j`/`k` move between workers, `Enter`/`v` shows the tmux command for the selected worker, `p` toggles pane output, `x` sends Ctrl+C (with confirmation), `s` restarts the worker pane (with confirmation), `r` polls now, `a` shows the session attach command, `q` closes.

## How it works

1. You describe a task; Gaud creates an execution plan with role-based worker assignments.
2. You review and approve the plan, then workers launch in a private tmux session.
3. The extension polls tmux pane state, pane logs, and a structured `events.jsonl` callback file.
4. Worker callbacks (`done`, `waiting-user`, `failed`) are injected back into Pi as user messages — no manual tmux watching needed.
5. A compact status widget stays pinned above the editor; the full dashboard is on-demand.

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
