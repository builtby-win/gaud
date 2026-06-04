# Gaud Pi Extension — Implementation Plan

## Goal

Create a new distributable `gaud` repo that packages a Pi extension for running Gaud mode natively inside Pi.

The extension should let users install it with Pi package installation, start Gaud from Pi, spawn implementer tmux work in the background, run its own built-in polling loop, and show Gaud state inside Pi with custom UI.

Target install flows:

```bash
pi install git:github.com/builtby-win/gaud@v0.1.0
# or, later:
pi install npm:@builtby-win/gaud
```

## Product Summary

Pi becomes the Gaud conductor UI/control plane.

- Tmux is the V0 execution substrate for workers.
- Gaud uses its own `gaud-pi` tmux client/wrapper rather than relying on ad-hoc shell snippets.
- The tmux client may wrap/use `tmux-cli` for pane discovery, pane querying, message sending, and polling.
- Polling is the primary reliability mechanism: tmux pane status, pane logs, structured event JSONL, and persisted state are all polled/reconciled.
- Workers receive fresh per-run environment variables that identify the run, worker, callback paths, and Pi orchestrator session.
- Environment variables are metadata and routing hints, not the transport back to Pi.
- Worker callbacks return through `.gaud/runs/<run-id>/events.jsonl` via a callback helper.
- The Pi extension tails/polls those events and routes important callbacks into Pi programmatically, not by typing into the Pi terminal.
- Users can inspect the underlying tmux sessions whenever they want.

## Non-Goals For V0

- No cloud backend.
- No GitHub issues or PR automation.
- No replacing Gaud's existing skill immediately.
- No complex multi-project scheduler.
- No fully custom Pi editor replacement.

## Key Architecture Decision

Gaud-on-Pi uses an approved local markdown execution plan before launching any real tmux workers.

Execution order:

```txt
PLAN.md or user idea
  -> Gaud planning gate
  -> gaud-design review
  -> gaud-eng review
  -> current milestone tickets/workstreams
  -> user approval
  -> tmux worker launch
  -> gaud-code-review / integrator review
```

Fake smoke-test workers may bypass this with `--fake`; real agent workers must not.

Gaud-on-Pi uses tmux workers with a Pi-native polling/control bridge.

The old/default tmux callback path is brittle for Pi and should be treated as legacy only:

```txt
worker pane -> gaud-poll -> tmux send-keys -> conductor pane
```

The Pi-native path is:

```txt
worker pane
  -> per-run callback helper / pane log / tmux status
  -> .gaud/runs/<run-id>/events.jsonl
  -> Pi extension poller/tailer
  -> pi.sendUserMessage()/pi.sendMessage()
```

This avoids terminal injection into Pi and gives the Pi extension direct lifecycle control.

The Pi extension owns polling directly. `tmux-cli` can be used as a status/query source, but `gaud-poll` is not required for Pi-native Gaud. V0 should treat built-in polling as the universal contract and should not require agent-specific native hooks.

Production target: structured event routing only, no `tmux send-keys` into the Pi terminal.

## Repository Layout

```txt
gaud/
  README.md
  PLAN.md
  package.json
  tsconfig.json
  extensions/
    gaud/
      index.ts
      config.ts
      gaudDir.ts
      gaudRunner.ts
      pollerBridge.ts
      state.ts
      tmux.ts
      gaudPiTmuxClient.ts
      tmuxCliBridge.ts
      callbackHelper.ts
      hookInstaller.ts
      usage.ts
      ui/
        compactWidget.ts
        dashboardOverlay.ts
        messageRenderer.ts
  scripts/
    smoke-test.ts
  test/
    state.test.ts
    tmux.test.ts
    pollerBridge.test.ts
```

## Pi Package Manifest

`package.json` should expose the extension through Pi's package manifest:

```json
{
  "name": "@builtby-win/gaud",
  "version": "0.1.0",
  "description": "Pi extension for running Gaud tmux milestone orchestration natively inside Pi",
  "keywords": ["pi-package", "pi", "gaud", "tmux", "coding-agent"],
  "type": "module",
  "pi": {
    "extensions": ["./extensions"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "typescript": "latest",
    "tsx": "latest"
  }
}
```

## Extension Commands

Register these Pi commands:

### `/gaud <task>`

Start a new Gaud run from a user task.

Flow:

1. Resolve Gaud skill/binary directory.
2. Run update check.
3. Initialize built-in Gaud Pi poller.
4. Load global/repo config.
5. Run usage preflight.
6. Ask user for agent choices only when ambiguous.
7. Read `PLAN.md` or collect an interactive plan from the user.
8. Optionally launch short-lived parallel explore agents for ambiguous domains (product/design/engineering/repo survey). These are discovery-only workers: they report findings back to the Pi orchestrator and do not own implementation tickets.
9. The Pi orchestrator folds explore findings into the plan, then runs the planning gate: gaud-design critique, gaud-eng architecture review, and current-milestone ticket assignment.
10. Write an approved local markdown execution plan to `.gaud/plans/<plan-id>.md`.
11. Reflect the role/workstream assignment back to the user and ask for launch approval.
12. Create `.gaud/runs/<run-id>/`.
13. Start private tmux session for implementers using the Gaud Pi tmux client.
14. Set fresh per-run and per-worker tmux environment variables.
15. Start pane logging and built-in polling/tailing of structured events.
16. Show compact pinned widget; do not auto-open an obtrusive dashboard overlay.
17. Inject Gaud conductor context into Pi.

### `/gaud-status`

Show current run summary in a notification or message.

### `/gaud-dashboard`

Open or refocus the detailed dashboard overlay with worker state, event timeline, tmux attach commands, and controls. The compact run state stays pinned as a normal Pi widget; the detailed dashboard is on-demand via `/gaud-dashboard` or `Ctrl+Shift+G` so it does not cover the transcript by default.

### `/gaud-attach`

Print the tmux attach command, e.g.:

```bash
tmux -L gaud-<run-id> attach -t <run-id>
```

Optionally launch it in a new terminal later, but V0 can just show the command.

### /gaud-cancel <worker-id>

Send Ctrl+C to a specific worker's tmux pane to interrupt execution.

### /gaud-restart <worker-id>

Restart a specific worker pane by killing the pane, recreating it with the same command and env prefix, and re-binding output piping.

### `/gaud-stop`

Stop the built-in poller and optionally kill the private tmux session.

Default behavior:

- ask before killing tmux workers
- allow “detach only”

### `/gaud-resume`

Reconnect to the latest active `.gaud/runs/<run-id>/state.json` and restart tailing events.

## Custom Tools

Register tools callable by the Pi agent:

### `gaud_start_run`

Starts a run from structured parameters. Used when the model decides Gaud is appropriate.

### `gaud_get_status`

Returns structured state for current run.

### `gaud_stop_run`

Stops or detaches a run.

### `gaud_send_worker_message`

Sends a message to a specific tmux worker pane.

This is useful for orchestrator follow-ups without exposing raw tmux commands to the model.

## Lifecycle Hooks

### `session_start`

- Restore active run from Pi custom entries and/or `.gaud/runs`.
- Reconnect the built-in polling bridge if a run is still active.
- Re-render widget.

### `session_shutdown`

- Persist state.
- Stop only extension-owned child watchers.
- Do not kill tmux workers by default.
- Mark run as `detached` unless `/gaud-stop` requested cleanup.

### `before_agent_start`

If Gaud is active, inject hidden orchestration context:

```txt
[GAUD ACTIVE]
Run: <id>
Milestone: <milestone>
Workers: ...
Callback events will arrive as GAUDMODE messages.
Use /gaud-dashboard for status.
Do not launch raw tmux workers manually; use gaud tools/commands.
```

### `input`

Optional convenience routing:

- `gaud ...` -> `/gaud ...`
- `god ...` -> `/gaud ...`
- `gaud status` -> `/gaud-status`

### `tool_call`

Optional guardrail:

- warn/block raw `tmux kill-session` for active Gaud sessions unless called through Gaud extension tools.

## UI Plan

### Footer Status

Use `ctx.ui.setStatus("gaud", ...)`:

```txt
gaud: M1 2/3 working
```

### Compact Widget

Use `ctx.ui.setWidget("gaud", lines, { placement: "aboveEditor" })`.

Example:

```txt
GAUD dark-mode-refactor · M1 · running · 3 workers
frontend  working       last 2m ago
backend   done          tests passing
ux        waiting-user  needs design decision
```

### Dashboard Overlay

Use `ctx.ui.custom(..., { overlay: true })`.

Keyboard controls:

```txt
j/k move selection
Enter/v view selected worker tmux attach command
p/space toggle selected worker pane output preview
x send Ctrl+C to selected worker pane (with confirmation)
s restart selected worker (with confirmation)
r refresh state
a show session attach command
q/esc close dashboard
```

Dashboard sections:

1. run metadata
2. milestone status
3. worker table
4. poller health
5. recent event timeline
6. available commands

### Custom Message Renderer

Register renderer for `customType: "gaud-event"`.

Use it for status events that should appear in Pi but not necessarily trigger model work.

## State Model

```ts
type GaudRunState = {
  id: string;
  repoRoot: string;
  createdAt: number;
  updatedAt: number;
  status: "starting" | "running" | "waiting-user" | "done" | "failed" | "stopped" | "detached";
  task: string;
  planPath: string;
  eventsPath: string;
  logPath: string;
  tmuxSocket: string;
  tmuxSession: string;
  pollerPid?: number;
  milestone?: string;
  workers: Record<string, WorkerState>;
};

type WorkerState = {
  role: string;
  workstream: string;
  milestone: string;
  cli: string;
  model?: string;
  paneId?: string;
  command?: string;
  status: "starting" | "working" | "done" | "waiting-user" | "waiting-permission" | "stuck" | "dead" | "unknown";
  lastEventAt?: number;
  summary?: string;
};
```

Persist to:

```txt
.gaud/runs/<run-id>/state.json
```

Also append important state checkpoints to Pi session:

```ts
pi.appendEntry("gaud-state", { runId, status, statePath })
```

## Run Directory Layout

```txt
.gaud/runs/<run-id>/
  plan.md
  state.json
  events.jsonl
  poller.log
  launch.json
  bin/
    gaud-callback
  prompts/
    frontend.txt
    backend.txt
  workers/
    frontend/
      pane.log
      status.json
      exit.json
    backend/
      pane.log
      status.json
      exit.json
```

## Gaud Directory Resolution

Search for Gaud skill/binaries in this order:

```txt
$PWD/skills/gaud-mode
$PWD/.agents/skills/gaud-mode
$HOME/.agents/skills/gaud-mode
$HOME/.claude/skills/gaud-mode
$HOME/.config/opencode/skills/gaud-mode
```

Legacy/helper binaries that may exist in an older Gaud skill checkout:

```txt
bin/gaud-mode-update-check
bin/gaud-mode-upgrade
bin/gaud-tmux-layout
bin/gaud-agent-usage
```

`gaud-poll` and `gaud-poll-install` are not required for Pi-native Gaud. Polling lives inside the Pi extension through the Gaud Pi tmux client and optional `tmux-cli` bridge.

V0 can depend on the existing skill checkout for update/layout/usage helpers if present. Later, this repo can vendor or package only the helpers it still needs directly.

## Launch Flow Details

### 1. Preflight

Check:

- `tmux` on PATH
- configured CLIs on PATH
- needed Gaud helper binaries exist, if this install mode depends on them
- built-in Gaud Pi poller can query tmux successfully
- usage data available if possible

### 2. Usage-Aware Agent Selection

Run:

```bash
"$GAUD_DIR/bin/gaud-agent-usage" --repo "$PWD" --json
```

Rules:

- if preferred agents are healthy, proceed
- if preferred agent is depleted/unavailable, ask user
- if data is stale/missing, report uncertainty but do not block

### 3. Planning Gate And Assignment

Before any real agent launch, Gaud must create or read a local markdown execution plan.

Sources:

- `PLAN.md` by default
- user-provided plan path
- interactive user answers when no plan exists

The planning gate must produce:

- PRD or problem statement
- Program DONE Criteria
- one current milestone only
- Milestone DONE Criteria
- role map
- ticket/workstream assignments for the current milestone only
- verification commands
- callback expectations

Specialist roles before/during execution:

- `gaud-design`: product/UX/design critique and acceptance criteria refinement
- `gaud-eng`: architecture, data flow, failure modes, test plan, ticket boundaries
- `gaud-implementer`: scoped code/doc implementation for one ticket/workstream
- `gaud-code-review`: integration/code review after implementation

The user must see and approve the generated role/workstream assignment before real workers launch. Fake smoke-test workers may bypass this with `--fake`.

### 4. Tmux Creation

Use the Gaud Pi tmux client to manage a private tmux server. Internally, the client can call raw `tmux` and/or `tmux-cli`; extension code should depend on the Gaud client abstraction rather than scattered shell commands:

```bash
tmux -L gaud-<run-id> new-session -d -s <run-id>
```

Create worker panes/windows with pane titles:

```txt
<role>:<workstream>:<milestone>
```

Before launching workers, set session-level environment variables:

```bash
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_RUN_ID "$RUN_ID"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_RUN_DIR "$RUN_DIR"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_EVENTS_PATH "$RUN_DIR/events.jsonl"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_ORCHESTRATOR_ID "$PI_SESSION_ID"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" PI_ORCHESTRATOR_ID "$PI_SESSION_ID"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_CALLBACK_MODE "jsonl"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" GAUD_CALLBACK_BIN "$RUN_DIR/bin/gaud-callback"
tmux -L gaud-$RUN_ID set-environment -t "$SESSION" B2V_DISABLED "true"
```

Each pane also receives per-worker environment variables:

```bash
GAUD_WORKER_ID=frontend
GAUD_WORKER_ROLE=implementer
GAUD_WORKSTREAM=frontend
GAUD_AGENT=codex
GAUD_MILESTONE=M1
B2V_DISABLED=true
```

Use `tmux pipe-pane -o` to capture each worker pane to:

```txt
.gaud/runs/<run-id>/workers/<worker-id>/pane.log
```

### 5. Built-In Poller Startup

Pi-native Gaud starts an extension-owned polling loop instead of relying on an external `gaud-poll` binary.

The built-in poller:

1. queries tmux panes through the Gaud Pi tmux client and optional `tmux-cli`
2. checks worker process/pane liveness
3. tails/polls `events.jsonl`
4. tails/polls pane logs when useful
5. detects stale/no-output workers
6. writes `state.json`
7. refreshes Pi UI widgets/status
8. routes important callbacks into Pi

Polling interval should be configurable, defaulting to about 5-10 seconds. The poller must de-dupe file offsets/events so `/reload` and resume do not replay old callbacks.

## Polling And Event Routing

The Pi extension reconciles state from multiple polling sources:

1. tmux pane/process status via `tmux-cli` or `tmux list-panes -a -F ...`
2. pane content/query snapshots via `tmux-cli` when useful
3. worker pane logs written by `tmux pipe-pane -o`
4. structured callback events in `.gaud/runs/<run-id>/events.jsonl`
5. persisted `.gaud/runs/<run-id>/state.json`

Workers should report structured lifecycle events by running the per-run callback helper:

```bash
$GAUD_CALLBACK_BIN done --summary "implemented frontend"
$GAUD_CALLBACK_BIN waiting-user --question "Need product decision"
$GAUD_CALLBACK_BIN waiting-permission --summary "Needs approval to run migration"
$GAUD_CALLBACK_BIN failed --summary "tests failing"
```

The helper appends JSONL to `GAUD_EVENTS_PATH`, for example:

```json
{"ts":123,"runId":"...","workerId":"frontend","type":"done","summary":"implemented frontend"}
```

For every JSONL event:

1. parse event
2. de-dupe by event id/hash/offset
3. update `GaudRunState`
4. write state file
5. refresh widget/status
6. render display event when useful
7. if callback should reach model, inject a user message

Callback events that should trigger Pi agent work:

```txt
GAUDMODE done ...
GAUDMODE waiting-user ...
GAUDMODE waiting-permission ...
GAUDMODE failed ...
```

Use:

```ts
pi.sendUserMessage(callbackText, { deliverAs: ctx.isIdle() ? undefined : "followUp" })
```

Use `pi.sendMessage()` for non-triggering events.

## Optional Agent Hooks

V0 does not require native hooks from Claude, Codex, Gemini, OpenCode, Agy, or other configured agents. Polling plus the callback helper is the baseline.

Later versions can offer optional hook installation during Pi package setup or via a command such as:

```txt
/gaud install-hooks
```

Hook installation targets may include:

```txt
~/.claude
~/.codex
~/.config/gemini
~/.config/opencode
~/.config/agy
```

Hook installers should:

1. ask for explicit user confirmation before modifying agent config directories
2. show exactly which files will be created or changed
3. prefer additive per-user config snippets over overwriting existing files
4. write lifecycle events to `GAUD_EVENTS_PATH` when available
5. fall back silently to polling when hooks are unavailable or disabled
6. provide an uninstall/disable path

Native hooks are an optimization for cleaner status events, not a dependency for Gaud correctness.

## Milestones

### Milestone 0 — Repo Skeleton

Deliverables:

- initialize `../gaud`
- `package.json` with Pi manifest
- TypeScript config
- README install instructions
- empty extension loads successfully with `/gaud-status`

Verification:

```bash
pi -e ../gaud
```

Then run:

```txt
/gaud-status
```

Expected: “No active Gaud run.”

### Milestone 1 — State + UI Shell

Deliverables:

- `GaudRunState`
- state read/write helpers
- compact widget renderer
- dashboard overlay stub
- custom message renderer

Verification:

- `/gaud-dashboard` opens overlay
- fake state renders correctly
- `/reload` preserves/reloads state

### Milestone 2 — Preflight + Config

Deliverables:

- resolve Gaud dir
- check binaries
- detect `tmux` and optional `tmux-cli`
- run update check
- load global/repo config JSONL
- run usage preflight

Verification:

- `/gaud doctor` or `/gaud-status --doctor` reports readiness
- missing binary produces clear error
- stale/missing usage does not block

### Milestone 3 — Tmux Worker Launch

Deliverables:

- create Gaud Pi tmux client wrapper
- add optional `tmux-cli` bridge for pane discovery/query/send operations
- create private tmux server/session
- set session-level run environment variables
- launch one or more worker panes with per-worker environment variables
- enable pane logging via `tmux pipe-pane -o`
- record pane ids
- write `launch.json`
- `/gaud-attach` shows attach command

Verification:

- `/gaud test task` creates tmux session
- `tmux -L gaud-<id> list-panes -a` shows workers
- state file contains pane ids

### Milestone 4 — Polling Bridge

Deliverables:

- create per-run `bin/gaud-callback` helper
- poll tmux pane/process status
- tail/poll worker pane logs
- tail/poll structured `events.jsonl`
- update worker statuses
- display events in Pi

Verification:

- fake GAUDMODE callback in worker pane appears in Pi
- compact widget updates within polling interval
- built-in poller errors are detected and displayed

### Milestone 5 — Programmatic Callback Routing

Deliverables:

- convert built-in poller callback events to `pi.sendUserMessage()`
- non-callback events to `pi.sendMessage()`
- avoid duplicate routing
- handle active streaming via `followUp`

Verification:

- worker `GAUDMODE done ...` causes Pi orchestrator to receive a user message
- user does not need to attach tmux
- no duplicate callback appears

### Milestone 6 — Orchestrator Context

Deliverables:

- `before_agent_start` hidden context injection
- active run instructions
- milestone/worker summary
- guardrails against raw tmux launch by model

Verification:

- Pi understands current Gaud state after callback
- Pi can decide next milestone or ask user

### Milestone 7 — Stop/Resume/Recovery

Deliverables:

- `/gaud-stop`
- `/gaud-resume`
- session shutdown detach behavior
- reconnect after `/reload`
- detect dead tmux session or stopped polling loop

Verification:

- reload keeps dashboard state
- restart Pi and resume active run
- stop kills only when confirmed

### Milestone 8 — Distribution

Deliverables:

- README with install, use, security, and prerequisite instructions (specifically detailing `tmux` setup)
- Tagged release/tag for version pinning (e.g., `v0.1.0`)
- Valid package metadata for the Pi gallery/discovery manifest in `package.json`
- `/gaud doctor` command that verifies `tmux` and agent CLI dependencies are on `PATH`
- Document optional agent hook installation for `~/.claude`, `~/.codex`, Gemini, OpenCode, and other configured agents

Verification:

```bash
# Verify prerequisites installation (tmux must be on PATH)
which tmux

# Install from public git repository
pi install git:github.com/builtby-win/gaud

# List installed packages
pi list

# Alternatively install with explicit version pinning
pi install git:github.com/builtby-win/gaud@v0.1.0
```

## Testing Strategy

### Unit Tests

- config JSONL merge
- state serialization
- tmux command construction
- poller event parsing
- callback classification

### Manual Smoke Tests

1. install local package:

```bash
pi -e ../gaud
```

2. run doctor:

```txt
/gaud-status --doctor
```

3. start fake run:

```txt
/gaud --fake build a todo app
```

4. start real run:

```txt
/gaud implement a small README cleanup
```

5. inspect tmux:

```bash
tmux -L gaud-<run-id> attach -t <run-id>
```

6. force callback and confirm Pi receives it.

## Security Notes

Pi extensions run with full system permissions. README must clearly state:

- this extension launches tmux sessions
- this extension launches configured agent CLIs
- this extension writes `.gaud/runs/*`
- this extension runs a built-in polling loop over tmux state, pane logs, and callback events
- this extension can inject messages into Pi sessions
- users should inspect config before running

## Open Questions

1. Should the extension vendor Gaud helpers or require an installed Gaud skill checkout?
   - V0: prefer self-contained Pi extension code and only use existing skill helpers opportunistically.
   - Later: bundle/package any remaining update/layout/usage helpers directly. Do not depend on `gaud-poll`.

2. Should Pi be the orchestrator model, or should a separate orchestrator agent still run in tmux?
   - Recommended V0: Pi is orchestrator; tmux contains implementers only.
   - Compatibility mode: external orchestrator can be added later.

3. Should `/gaud` generate the execution plan itself or ask Pi to generate it first?
   - V0: create a plan file from the user's task with a simple template, then let Pi refine it before launch.
   - Later: fully automated planning flow.

## Definition Of Done For V0.1

A user can install the package, run `/gaud <task>` inside Pi, see a live Gaud widget/dashboard, have tmux workers spawned in the background, receive worker callbacks inside Pi without manually watching tmux, and stop/resume the run safely.
