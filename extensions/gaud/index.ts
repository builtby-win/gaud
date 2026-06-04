import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_AGENTS = ["claude", "opencode", "antigravity"] as const;
const POPULAR_AGENT_ORDER = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"antigravity",
	"cursor",
	"aider",
	"goose",
	"amp",
	"qwen",
	"crush",
	"factory",
	"kiro",
	"openhands",
] as const;

const AGENT_COMMAND_CANDIDATES: Record<string, string[]> = {
	claude: ["claude"],
	codex: ["codex"],
	gemini: ["gemini"],
	opencode: ["opencode"],
	antigravity: ["agy", "antigravity"],
	agy: ["agy", "antigravity"],
	cursor: ["cursor-agent", "cursor"],
	aider: ["aider"],
	goose: ["goose"],
	amp: ["amp"],
	qwen: ["qwen"],
	crush: ["crush"],
	factory: ["factory"],
	kiro: ["kiro"],
	openhands: ["openhands"],
};
const POLL_INTERVAL_MS = 5000;
const UI_TICK_MS = 1000;
const PEEK_LINES = 80;
const STUCK_AFTER_MS = 2 * 60 * 1000;

type RunStatus = "starting" | "running" | "waiting-user" | "done" | "failed" | "stopped" | "detached";
type WorkerStatus = "starting" | "working" | "done" | "waiting-user" | "waiting-permission" | "stuck" | "dead" | "failed" | "unknown";

type GaudRole = "gaud-design" | "gaud-eng" | "gaud-implementer" | "gaud-code-review";

type PromptRole = "planning" | "design" | "eng" | "implementer" | "codeReview";

type PromptSource =
	| { type: "builtin" }
	| { type: "local"; path: string }
	| { type: "remote"; url: string };

type GaudConfig = {
	orchestrator: { type: "pi"; agent: "pi" };
	roles: {
		"gaud-design"?: string;
		"gaud-eng"?: string;
		"gaud-implementer"?: string[];
		"gaud-code-review"?: string;
	};
	promptSources?: Partial<Record<PromptRole, PromptSource>>;
};

type WorkerPlan = {
	id: string;
	agent: string;
	role: GaudRole;
	objective: string;
	files: string[];
	doneCriteria: string[];
};

type WorkerState = {
	id: string;
	agent: string;
	role: string;
	workstream: string;
	status: WorkerStatus;
	paneId?: string;
	paneIndex?: string;
	pid?: string;
	command: string;
	promptPath: string;
	logPath: string;
	lastEventAt?: number;
	lastOutputAt?: number;
	lastPeek?: string;
	summary?: string;
};

export type GaudRunState = {
	id: string;
	status: RunStatus;
	task: string;
	createdAt: number;
	updatedAt: number;
	repoRoot: string;
	runDir: string;
	eventsPath: string;
	statePath: string;
	tmuxSocket: string;
	tmuxSession: string;
	piOrchestratorId?: string;
	workers: Record<string, WorkerState>;
	lastEventOffset: number;
	reason?: string;
};

type UiContext = Pick<ExtensionContext, "ui">;

type ExecResult = { stdout: string; stderr: string; code: number };

let activeRun: GaudRunState | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let uiTickTimer: NodeJS.Timeout | undefined;
let extensionPi: ExtensionAPI | undefined;
let lastCtx: ExtensionContext | undefined;
let extensionActive = false;
let lastPollStartedAt = 0;
let lastPollCompletedAt = 0;
let nextPollAt = 0;
let pollInFlight = false;
let consecutivePollErrors = 0;
let lastPollError: string | undefined;
let dashboardOpen = false;
let dashboardHandle: { focus?: () => void; setHidden?: (hidden: boolean) => void; hide?: () => void } | undefined;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function execFile(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options?.cwd,
			env: options?.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = options?.timeoutMs
			? setTimeout(() => {
				child.kill("SIGTERM");
			}, options.timeoutMs)
			: undefined;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			resolve({ stdout, stderr: `${stderr}${error.message}`, code: 1 });
		});
	});
}

async function commandExists(command: string): Promise<boolean> {
	const result = await execFile("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { timeoutMs: 5000 });
	return result.code === 0;
}

async function resolveAgentCommand(agent: string): Promise<string | undefined> {
	const candidates = AGENT_COMMAND_CANDIDATES[agent] ?? [agent];
	for (const candidate of candidates) {
		if (await commandExists(candidate)) return candidate;
	}
	return undefined;
}

async function checkAgentCommands(agents: string[]): Promise<{ ok: Array<{ agent: string; command: string }>; missing: string[] }> {
	const ok: Array<{ agent: string; command: string }> = [];
	const missing: string[] = [];
	for (const agent of agents) {
		const command = await resolveAgentCommand(agent);
		if (command) ok.push({ agent, command });
		else missing.push(agent);
	}
	return { ok, missing };
}

function localConfigPath(cwd: string): string {
	return path.join(cwd, ".gaud", "gaud.config.json");
}

function globalConfigPath(): string {
	return path.join(os.homedir(), ".config", "gaud.config.json");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function loadGaudConfig(cwd: string): Promise<GaudConfig | undefined> {
	const global = await readJsonFile<GaudConfig>(globalConfigPath());
	const local = await readJsonFile<GaudConfig>(localConfigPath(cwd));
	if (!global && !local) return undefined;
	return {
		orchestrator: { type: "pi", agent: "pi" },
		roles: { ...(global?.roles ?? {}), ...(local?.roles ?? {}) },
		promptSources: { ...(global?.promptSources ?? {}), ...(local?.promptSources ?? {}) },
	};
}

async function saveLocalGaudConfig(cwd: string, config: GaudConfig) {
	const filePath = localConfigPath(cwd);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function detectInstalledAgents(): Promise<string[]> {
	const installed: string[] = [];
	for (const name of POPULAR_AGENT_ORDER) {
		if (await resolveAgentCommand(name)) installed.push(name);
	}
	return installed;
}

async function doctorLines(agents: string[] = [...DEFAULT_AGENTS]): Promise<string[]> {
	const lines = ["Gaud doctor", ""];
	lines.push(`${(await commandExists("tmux")) ? "✓" : "✗"} tmux`);
	lines.push(`${(await commandExists("tmux-cli")) ? "✓" : "○"} tmux-cli optional`);
	lines.push("");
	lines.push("Agent CLIs:");
	for (const agent of agents) {
		const command = await resolveAgentCommand(agent);
		lines.push(`${command ? "✓" : "✗"} ${agent}${command ? ` (${command})` : " missing"}`);
	}
	lines.push("");
	lines.push("Tip: run /gaud --agents claude,opencode,antigravity <task> after required CLIs are installed.");
	return lines;
}

function makeRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
	return `gaud-${stamp}`;
}

function parseArgs(args: string): { task: string; agents: string[]; fake: boolean } {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let agents: string[] | undefined;
	let fake = false;
	const taskTokens: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--fake") {
			fake = true;
			continue;
		}
		if (token === "--agents" || token === "--agent") {
			agents = (tokens[++i] ?? "").split(",").map((agent) => agent.trim()).filter(Boolean);
			continue;
		}
		if (token.startsWith("--agents=")) {
			agents = token.slice("--agents=".length).split(",").map((agent) => agent.trim()).filter(Boolean);
			continue;
		}
		taskTokens.push(token);
	}
	return { task: taskTokens.join(" ").trim(), agents: agents?.length ? agents : [...DEFAULT_AGENTS], fake };
}

export function agentCommand(agent: string, commandName: string, promptPath: string, fake: boolean): string {
	if (fake) {
		return `bash -lc ${shellQuote(`echo "[gaud] fake ${agent} worker started"; sleep 2; echo "[gaud] fake ${agent} worker done"; "$GAUD_CALLBACK_BIN" done --summary "fake ${agent} completed"; exec bash`)}`;
	}

	const promptRef = shellQuote(promptPath);
	const callbackInstruction = `When you finish or become blocked, report status by running one of these commands:\n$GAUD_CALLBACK_BIN done --summary "what changed"\n$GAUD_CALLBACK_BIN waiting-user --question "what you need"\n$GAUD_CALLBACK_BIN failed --summary "what failed"`;
	const promptCommand = `cat ${promptRef}; printf '\n\n%s\n' ${shellQuote(callbackInstruction)}`;
	const promptSubstitution = `"$(${promptCommand})"`;
	const cmd = shellQuote(commandName);
	const callbackMarker = `"$GAUD_RUN_DIR/workers/$GAUD_WORKER_ID/callback.done"`;
	const autoCallback = `(status=$?; if [ ! -e ${callbackMarker} ]; then if [ "$status" -eq 0 ]; then "$GAUD_CALLBACK_BIN" done --summary "${agent} completed without explicit callback"; else "$GAUD_CALLBACK_BIN" failed --summary "${agent} exited with status $status"; fi; fi; exec bash)`;
	const wrap = (invocation: string) => `bash -lc ${shellQuote(`${invocation}; ${autoCallback}`)}`;

	if (agent === "claude") return wrap(`${cmd} --dangerously-skip-permissions --print ${promptSubstitution}`);
	if (agent === "codex") return wrap(`${cmd} exec --dangerously-bypass-approvals-and-sandbox ${promptSubstitution}`);
	if (agent === "gemini") return wrap(`${cmd} --yolo --prompt ${promptSubstitution}`);
	if (agent === "opencode") return wrap(`${cmd} run --dangerously-skip-permissions ${promptSubstitution}`);
	if (agent === "antigravity" || agent === "agy") return wrap(`${cmd} --dangerously-skip-permissions --print ${promptSubstitution}`);
	return wrap(`${cmd} ${promptSubstitution}`);
}

function formatAge(ts?: number): string {
	if (!ts) return "never";
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s ago`;
}

function formatEta(ts?: number): string {
	if (!ts) return "soon";
	const seconds = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
	return seconds <= 0 ? "now" : `${seconds}s`;
}

function pollHealthText(): string {
	const parts = [
		pollInFlight ? "polling now" : `next poll in ${formatEta(nextPollAt)}`,
		`last poll ${formatAge(lastPollCompletedAt)}`,
	];
	if (consecutivePollErrors > 0) parts.push(`${consecutivePollErrors} poll error${consecutivePollErrors === 1 ? "" : "s"}`);
	if (lastPollError) parts.push(`last error: ${lastPollError}`);
	return parts.join(" · ");
}

function workerLastActivity(worker: WorkerState): number | undefined {
	return Math.max(worker.lastEventAt ?? 0, worker.lastOutputAt ?? 0) || undefined;
}

export function workerEnvPrefix(worker: Pick<WorkerState, "id" | "agent" | "role" | "workstream">): string {
	return [
		`B2V_DISABLED=true`,
		`GAUD_WORKER_ID=${shellQuote(worker.id)}`,
		`GAUD_WORKER_ROLE=${shellQuote(worker.role || "implementer")}`,
		`GAUD_WORKSTREAM=${shellQuote(worker.workstream || worker.id)}`,
		`GAUD_AGENT=${shellQuote(worker.agent)}`,
		`GAUD_MILESTONE=M1`,
	].join(" ");
}

function workerStatusSymbol(status: WorkerStatus): string {
	switch (status) {
		case "done": return "✓";
		case "failed": return "✗";
		case "dead": return "✗";
		case "stuck": return "!";
		case "waiting-user": return "?";
		case "waiting-permission": return "?";
		case "working": return "●";
		case "starting": return "◌";
		default: return "·";
	}
}

function workerStatusColor(status: WorkerStatus): ThemeColor {
	switch (status) {
		case "done": return "success";
		case "failed":
		case "dead": return "error";
		case "waiting-user":
		case "waiting-permission":
		case "stuck": return "warning";
		case "working": return "accent";
		case "starting":
		case "unknown": return "muted";
		default: return "dim";
	}
}

function statusText(): string {
	if (!activeRun) return "No active Gaud run.";
	const workers = Object.values(activeRun.workers);
	const done = workers.filter((worker) => worker.status === "done").length;
	const stuck = workers.filter((worker) => worker.status === "stuck").length;
	const waiting = workers.filter((worker) => ["waiting-user", "waiting-permission"].includes(worker.status)).length;
	const parts = [`${done}/${workers.length} done`];
	if (stuck) parts.push(`${stuck} stuck`);
	if (waiting) parts.push(`${waiting} waiting`);
	return `Gaud ${activeRun.id}: ${activeRun.status} — ${parts.join(" · ")} — ${pollHealthText()} — ${activeRun.task}`;
}

function tmuxAttachCommand(run: GaudRunState): string {
	return `tmux -L ${run.tmuxSocket} attach -t ${run.tmuxSession}`;
}

function tmuxWorkerViewCommand(run: GaudRunState, worker: WorkerState): string {
	return worker.paneId
		? `tmux -L ${run.tmuxSocket} select-pane -t ${worker.paneId} \\; attach -t ${run.tmuxSession}`
		: tmuxAttachCommand(run);
}

function renderWidget(): string[] {
	if (!activeRun) return [];
	const spinner = pollInFlight ? "⟳" : "○";
	const lines = [`${spinner} GAUD ${activeRun.id} · ${activeRun.status} · ${pollHealthText()}`];
	lines.push(`task: ${activeRun.task}`);
	const stuckOrWaiting: string[] = [];
	for (const worker of Object.values(activeRun.workers)) {
		const activity = formatAge(workerLastActivity(worker));
		const symbol = workerStatusSymbol(worker.status);
		const summary = worker.summary ? ` · ${worker.summary.slice(0, 60)}` : "";
		lines.push(`${symbol} ${worker.id.padEnd(16)} ${worker.agent.padEnd(10)} ${worker.status.padEnd(18)} ${activity}${summary}`);
		if (worker.status === "stuck" || worker.status === "waiting-user" || worker.status === "waiting-permission") {
			stuckOrWaiting.push(worker.id);
		}
	}
	if (stuckOrWaiting.length > 0) {
		lines.push(`⚠ needs attention: ${stuckOrWaiting.join(", ")} — /gaud-peek ${stuckOrWaiting[0]} or Ctrl+Shift+G`);
	}
	lines.push(`/gaud-peek [worker] · /gaud-attach · ${tmuxAttachCommand(activeRun)}`);
	return lines;
}

function refreshUi(ctx?: UiContext) {
	if (!ctx || !extensionActive) return;
	try {
		const status = activeRun ? `gaud: ${activeRun.status} · ${pollInFlight ? "polling" : `next ${formatEta(nextPollAt)}`}` : "gaud: idle";
		ctx.ui.setStatus("gaud", status);
		ctx.ui.setWidget("gaud", renderWidget());
	} catch {
		// Extension contexts become stale during shutdown/reload. Polling is best-effort.
	}
}

async function writeJson(filePath: string, value: unknown) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readRunState(statePath: string): Promise<GaudRunState | undefined> {
	try {
		return JSON.parse(await readFile(statePath, "utf8")) as GaudRunState;
	} catch {
		return undefined;
	}
}

function workerPrompt(task: string, agent: string, workerId: string, plan?: WorkerPlan): string {
	const role = plan?.role ?? "gaud-implementer";
	const assignment = plan
		? `Assigned role: ${plan.role}\nAssigned objective:\n${plan.objective}\n\nPrimary files/areas:\n${plan.files.map((file) => `- ${file}`).join("\n")}\n\nDone criteria:\n${plan.doneCriteria.map((item) => `- ${item}`).join("\n")}`
		: `Focus on the slice implied by your worker id/agent. Keep changes small and coherent.`;
	return `You are a Gaud background specialist worker.\n\nTask:\n${task}\n\nWorker id: ${workerId}\nAgent: ${agent}\nRole: ${role}\n\n${assignment}\n\nCoordination rules:\n- Avoid broad unrelated refactors.\n- Prefer small, reviewable changes in your assigned files.\n- If you need to edit outside your assigned files, explain why in your callback summary.\n- Run the relevant checks before reporting done when practical.\n\nStatus protocol:\n- When done, run: $GAUD_CALLBACK_BIN done --summary "${role}: brief summary"\n- If blocked on the user, run: $GAUD_CALLBACK_BIN waiting-user --question "specific question"\n- If blocked on permission, run: $GAUD_CALLBACK_BIN waiting-permission --summary "specific permission needed"\n- If failed, run: $GAUD_CALLBACK_BIN failed --summary "brief failure"\n`;
}

async function createCallbackHelper(runDir: string) {
	const binDir = path.join(runDir, "bin");
	await mkdir(binDir, { recursive: true });
	const helperPath = path.join(binDir, "gaud-callback");
	const script = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const type = args.shift() || 'event';
const data = { ts: Date.now(), type, runId: process.env.GAUD_RUN_ID, workerId: process.env.GAUD_WORKER_ID, agent: process.env.GAUD_AGENT };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) data[arg.slice(2)] = args[++i] || '';
}
const file = process.env.GAUD_EVENTS_PATH;
if (!file) { console.error('GAUD_EVENTS_PATH is not set'); process.exit(1); }
fs.appendFileSync(file, JSON.stringify(data) + '\\n');
const markerDir = (process.env.GAUD_RUN_DIR || '') + '/workers/' + (process.env.GAUD_WORKER_ID || '');
if (process.env.GAUD_RUN_DIR && process.env.GAUD_WORKER_ID) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(markerDir + '/callback.done', JSON.stringify(data) + '\\n');
}
console.log('[gaud-callback]', type, data.summary || data.question || '');
`;
	await writeFile(helperPath, script, { mode: 0o755 });
	return helperPath;
}

async function tmux(run: GaudRunState, args: string[]): Promise<ExecResult> {
	return execFile("tmux", ["-L", run.tmuxSocket, ...args], { cwd: run.repoRoot, timeoutMs: 10_000 });
}

async function launchRun(pi: ExtensionAPI, ctx: ExtensionContext, task: string, agents: string[], fake: boolean, reason?: string, workerPlans?: WorkerPlan[]) {
	if (!fake && !workerPlans?.length) {
		ctx.ui.notify("Real Gaud runs require an approved execution plan before launching workers. Run /gaud-plan PLAN.md first. Use --fake only for smoke tests.", "error");
		return;
	}

	if (!(await commandExists("tmux"))) {
		ctx.ui.notify("Gaud requires tmux on PATH. Install tmux, then rerun /gaud doctor.", "error");
		return;
	}

	const requestedAgents = workerPlans?.length ? workerPlans.map((plan) => plan.agent) : agents;
	const agentCheck = fake ? { ok: requestedAgents.map((agent) => ({ agent, command: agent })), missing: [] } : await checkAgentCommands(requestedAgents);
	const resolvedAgents = agentCheck.ok;
	const missingAgents = agentCheck.missing;
	if (missingAgents.length > 0) {
		ctx.ui.notify(`Missing agent CLI(s): ${missingAgents.join(", ")}\n\n${(await doctorLines(agents)).join("\n")}`, "error");
		return;
	}

	const id = makeRunId();
	const repoRoot = ctx.cwd;
	const runDir = path.join(repoRoot, ".gaud", "runs", id);
	const eventsPath = path.join(runDir, "events.jsonl");
	const statePath = path.join(runDir, "state.json");
	const tmuxSocket = id;
	const tmuxSession = id;
	await mkdir(runDir, { recursive: true });
	await mkdir(path.join(runDir, "prompts"), { recursive: true });
	await writeFile(eventsPath, "", "utf8");
	const callbackBin = await createCallbackHelper(runDir);

	const run: GaudRunState = {
		id,
		status: "starting",
		task,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		repoRoot,
		runDir,
		eventsPath,
		statePath,
		tmuxSocket,
		tmuxSession,
		piOrchestratorId: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getLeafId() ?? undefined,
		workers: {},
		lastEventOffset: 0,
		reason,
	};
	activeRun = run;

	await writeJson(path.join(runDir, "launch.json"), { id, task, agents: resolvedAgents, fake, createdAt: Date.now() });
	const firstPaneResult = await tmux(run, ["new-session", "-d", "-s", tmuxSession, "-P", "-F", "#{pane_id}", "bash"]);
	const firstPaneId = firstPaneResult.stdout.trim() || "%0";
	for (const [name, value] of Object.entries({
		GAUD_RUN_ID: id,
		GAUD_RUN_DIR: runDir,
		GAUD_EVENTS_PATH: eventsPath,
		GAUD_ORCHESTRATOR_ID: run.piOrchestratorId ?? "",
		PI_ORCHESTRATOR_ID: run.piOrchestratorId ?? "",
		GAUD_CALLBACK_MODE: "jsonl",
		GAUD_CALLBACK_BIN: callbackBin,
		B2V_DISABLED: "true",
	})) {
		await tmux(run, ["set-environment", "-t", tmuxSession, name, value]);
	}

	for (let index = 0; index < resolvedAgents.length; index++) {
		const { agent, command: commandName } = resolvedAgents[index];
		const plan = workerPlans?.[index];
		const workerId = plan?.id ?? `${agent}-${index + 1}`;
		const workerDir = path.join(runDir, "workers", workerId);
		await mkdir(workerDir, { recursive: true });
		const promptPath = path.join(runDir, "prompts", `${workerId}.txt`);
		const logPath = path.join(workerDir, "pane.log");
		await writeFile(promptPath, workerPrompt(task, agent, workerId, plan), "utf8");
		await writeFile(logPath, "", "utf8");
		const command = agentCommand(agent, commandName, promptPath, fake);
		const envPrefix = workerEnvPrefix({ id: workerId, agent, role: "implementer", workstream: workerId });
		const paneResult = await tmux(run, ["split-window", "-d", "-t", tmuxSession, "-P", "-F", "#{pane_id}", `${envPrefix} exec ${command}`]);
		const paneId = paneResult.stdout.trim();
		await tmux(run, ["select-layout", "-t", tmuxSession, "tiled"]);
		if (paneId) await tmux(run, ["pipe-pane", "-o", "-t", paneId, `cat >> ${shellQuote(logPath)}`]);
		run.workers[workerId] = {
			id: workerId,
			agent,
			role: "implementer",
			workstream: workerId,
			status: "starting",
			paneId,
			command,
			promptPath,
			logPath,
			lastEventAt: Date.now(),
		};
	}

	await tmux(run, ["kill-pane", "-t", firstPaneId]);
	run.status = "running";
	run.updatedAt = Date.now();
	await persistRun(pi);
	refreshUi(ctx);
	startPolling(pi, ctx);
	ctx.ui.notify(`Started Gaud run ${id} with agents: ${resolvedAgents.map((agent) => agent.agent).join(", ")}. Pinned status is visible above the editor; use /gaud-dashboard or Ctrl+Shift+G for the detailed dashboard.`, "info");
}

async function persistRun(pi?: ExtensionAPI) {
	if (!activeRun) return;
	activeRun.updatedAt = Date.now();
	await writeJson(activeRun.statePath, activeRun);
	pi?.appendEntry("gaud-state", { id: activeRun.id, statePath: activeRun.statePath, status: activeRun.status, updatedAt: activeRun.updatedAt });
}

async function pollTmux(run: GaudRunState) {
	const result = await tmux(run, ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"]);
	if (result.code !== 0) {
		run.status = "detached";
		lastPollError = result.stderr.trim() || "tmux list-panes failed";
		return;
	}
	const byPane = new Map(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
		const [paneId, paneIndex, pid, dead, currentCommand] = line.split("\t");
		return [paneId, { paneIndex, pid, dead, currentCommand }] as const;
	}));
	for (const worker of Object.values(run.workers)) {
		const pane = worker.paneId ? byPane.get(worker.paneId) : undefined;
		if (!pane) {
			worker.status = worker.status === "done" ? "done" : "dead";
			continue;
		}
		worker.paneIndex = pane.paneIndex;
		worker.pid = pane.pid;
		if (pane.dead === "1" && worker.status !== "done") worker.status = "dead";
		else if (worker.status === "starting") worker.status = "working";
	}
}

async function pollPanePeeks(run: GaudRunState) {
	for (const worker of Object.values(run.workers)) {
		if (!worker.paneId) continue;
		const result = await tmux(run, ["capture-pane", "-p", "-t", worker.paneId, "-S", `-${PEEK_LINES}`]);
		if (result.code === 0) {
			const peek = result.stdout.trimEnd();
			if (peek && peek !== worker.lastPeek) {
				worker.lastOutputAt = Date.now();
				if (worker.status === "stuck") worker.status = "working";
			}
			worker.lastPeek = peek;
		}
	}
}

function markStuckWorkers(run: GaudRunState) {
	const now = Date.now();
	for (const worker of Object.values(run.workers)) {
		if (!["starting", "working", "unknown"].includes(worker.status)) continue;
		const lastActivity = workerLastActivity(worker) ?? run.createdAt;
		if (now - lastActivity > STUCK_AFTER_MS) worker.status = "stuck";
	}
}

async function pollEvents(pi: ExtensionAPI, ctx: ExtensionContext, run: GaudRunState) {
	if (!extensionActive) return;
	if (!existsSync(run.eventsPath)) return;
	const content = await readFile(run.eventsPath, "utf8");
	const next = content.length;
	const chunk = content.slice(run.lastEventOffset);
	run.lastEventOffset = next;
	for (const line of chunk.split("\n")) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try { event = JSON.parse(line); } catch { continue; }
		const workerId = String(event.workerId ?? "");
		const type = String(event.type ?? "event");
		const worker = run.workers[workerId];
		if (worker) {
			worker.lastEventAt = Date.now();
			worker.summary = String(event.summary ?? event.question ?? worker.summary ?? "");
			if (["done", "waiting-user", "waiting-permission", "failed"].includes(type)) worker.status = type as WorkerStatus;
		}
		if (type === "done" && Object.values(run.workers).every((w) => w.status === "done")) {
			run.status = "done";
			stopPolling();
			dashboardHandle?.hide?.();
		}
		try {
			if (["done", "waiting-user", "waiting-permission", "failed"].includes(type)) {
				const text = `GAUDMODE ${type} ${workerId}: ${String(event.summary ?? event.question ?? "")}`;
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} else {
				pi.sendMessage({ customType: "gaud-event", content: `Gaud event ${type} from ${workerId}`, display: true, details: event });
			}
		} catch {
			// Ignore stale extension contexts during shutdown/reload.
		}
	}
}

async function pollOnce(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!extensionActive) return;
	if (pollInFlight) return;
	if (!activeRun || ["stopped", "done", "failed"].includes(activeRun.status)) {
		refreshUi(ctx);
		return;
	}
	pollInFlight = true;
	lastPollStartedAt = Date.now();
	nextPollAt = lastPollStartedAt + POLL_INTERVAL_MS;
	refreshUi(ctx);
	try {
		await pollTmux(activeRun);
		await pollPanePeeks(activeRun);
		await pollEvents(pi, ctx, activeRun);
		const preStuck = new Set(Object.values(activeRun.workers).filter((w) => w.status === "stuck").map((w) => w.id));
		markStuckWorkers(activeRun);
		for (const worker of Object.values(activeRun.workers)) {
			if (worker.status === "stuck" && !preStuck.has(worker.id)) {
				const cmd = tmuxWorkerViewCommand(activeRun, worker);
				try { ctx.ui.notify(`Worker ${worker.id} is stuck (no activity for ${STUCK_AFTER_MS / 60000}m).\n\nJump to pane:\n${cmd}`, "error"); } catch { /* stale ctx */ }
			}
		}
		await persistRun(pi);
		lastPollCompletedAt = Date.now();
		consecutivePollErrors = 0;
		if (activeRun.status !== "detached") lastPollError = undefined;
		refreshUi(ctx);
	} catch (error) {
		consecutivePollErrors += 1;
		lastPollError = error instanceof Error ? error.message : String(error);
		try {
			if (extensionActive) ctx.ui.notify(`Gaud poll error: ${lastPollError}\n\nNext poll in ${formatEta(nextPollAt)}. Use /gaud-peek or /gaud-attach to inspect workers.`, "error");
		} catch {
			// Ignore stale extension contexts during shutdown/reload.
		}
	} finally {
		pollInFlight = false;
		lastPollCompletedAt ||= Date.now();
		nextPollAt = Date.now() + POLL_INTERVAL_MS;
		refreshUi(ctx);
	}
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext) {
	stopPolling();
	extensionActive = true;
	extensionPi = pi;
	lastCtx = ctx;
	nextPollAt = Date.now();
	pollTimer = setInterval(() => {
		if (extensionPi && lastCtx) void pollOnce(extensionPi, lastCtx);
	}, POLL_INTERVAL_MS);
	uiTickTimer = setInterval(() => refreshUi(lastCtx), UI_TICK_MS);
	void pollOnce(pi, ctx);
}

function stopPolling() {
	if (pollTimer) clearInterval(pollTimer);
	if (uiTickTimer) clearInterval(uiTickTimer);
	pollTimer = undefined;
	uiTickTimer = undefined;
	pollInFlight = false;
}

async function killActiveTmuxRun(): Promise<void> {
	if (!activeRun) return;
	await tmux(activeRun, ["kill-session", "-t", activeRun.tmuxSession]);
}

async function stopRun(pi: ExtensionAPI, ctx: ExtensionContext, killTmux: boolean) {
	if (!activeRun) {
		ctx.ui.notify("No active Gaud run to stop.", "info");
		return;
	}
	stopPolling();
	if (killTmux) await killActiveTmuxRun();
	activeRun.status = "stopped";
	await persistRun(pi);
	refreshUi(ctx);
	ctx.ui.notify(statusText(), "info");
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workstream";
}

export function buildWorkerPlans(planText: string, focus: string, roleAgents: GaudConfig["roles"]): WorkerPlan[] {
	const templates: Array<Omit<WorkerPlan, "agent">> = [
		{
			id: "gaud-design",
			role: "gaud-design",
			objective: "Review the requested milestone before implementation. Improve product/UX shape, identify user-facing risks, and refine acceptance criteria. Do not make broad code changes unless the plan explicitly calls for docs/copy edits.",
			files: ["PLAN.md", "README.md", "extensions/gaud/index.ts"],
			doneCriteria: ["Design/UX risks are called out or marked not applicable.", "Acceptance criteria are concrete enough for implementers.", "Any proposed scope change is explicit."],
		},
		{
			id: "gaud-eng",
			role: "gaud-eng",
			objective: "Lock the engineering plan for the milestone. Identify architecture boundaries, state/data flow, tmux/polling failure modes, and test strategy before implementation proceeds.",
			files: ["PLAN.md", "extensions/gaud/index.ts", "test/*", "scripts/*"],
			doneCriteria: ["Architecture risks and edge cases are documented or addressed.", "Implementation tickets are small and non-overlapping.", "Verification commands are named."],
		},
		{
			id: "gaud-implementer",
			role: "gaud-implementer",
			objective: "Implement the assigned milestone slice only after reading the execution plan. Keep changes scoped and verify locally.",
			files: ["extensions/gaud/index.ts", "README.md", "PLAN.md"],
			doneCriteria: ["Scoped code/docs changes are complete.", "pnpm check passes if code changed.", "Callback summary lists changed files and verification."],
		},
		{
			id: "gaud-code-review",
			role: "gaud-code-review",
			objective: "Review the resulting milestone changes for correctness, safety, callback protocol issues, and missed tests. Prefer reporting findings over rewriting unrelated code.",
			files: ["extensions/gaud/index.ts", "README.md", "PLAN.md", "scripts/*", "test/*"],
			doneCriteria: ["Review findings are concrete and severity-ranked.", "Critical issues are fixed or reported as blockers.", "No unrelated refactors."],
		},
	];
	const assignments: Array<{ role: GaudRole; agent: string }> = [];
	if (roleAgents["gaud-design"]) assignments.push({ role: "gaud-design", agent: roleAgents["gaud-design"] });
	if (roleAgents["gaud-eng"]) assignments.push({ role: "gaud-eng", agent: roleAgents["gaud-eng"] });
	for (const agent of roleAgents["gaud-implementer"] ?? []) assignments.push({ role: "gaud-implementer", agent });
	if (roleAgents["gaud-code-review"]) assignments.push({ role: "gaud-code-review", agent: roleAgents["gaud-code-review"] });

	return assignments.map(({ role, agent }, index) => {
		const template = templates.find((item) => item.role === role) ?? templates[index % templates.length];
		return {
			...template,
			id: `${slugify(template.id)}-${index + 1}`,
			agent,
			objective: `${template.objective}\n\nFocus requested by user: ${focus}`,
		};
	});
}

function renderPlanMarkdown(task: string, sourcePath: string, workerPlans: WorkerPlan[], basePlan?: string): string {
	const workerSection = `## Worker Assignments\n\n${workerPlans.map((plan) => `### ${plan.id} (${plan.role} via ${plan.agent})\n\n${plan.objective}\n\nFiles/areas:\n${plan.files.map((file) => `- ${file}`).join("\n")}\n\nDone criteria:\n${plan.doneCriteria.map((item) => `- ${item}`).join("\n")}`).join("\n\n")}`;
	if (basePlan?.trim()) {
		return `${basePlan.trim()}\n\n---\n\n# Gaud Launch Assignment\n\nSource: ${sourcePath}\n\nTask/focus:\n${task}\n\n${workerSection}\n`;
	}
	return `# Gaud Execution Plan\n\nSource: ${sourcePath}\n\nTask/focus:\n${task}\n\n## Current Milestone\n\nImplement the next coherent slice with parallel workers while keeping changes reviewable.\n\n${workerSection}\n`;
}

async function askRequired(ctx: ExtensionContext, title: string, placeholder: string): Promise<string | undefined> {
	while (true) {
		const answer = await ctx.ui.input(title, placeholder);
		if (answer?.trim()) return answer.trim();
		const retry = await ctx.ui.confirm("Required answer", `${title} is required to make a launchable Gaud plan. Try again?`);
		if (!retry) return undefined;
	}
}

async function createPlanByInterview(ctx: ExtensionContext): Promise<{ markdown: string; focus: string } | undefined> {
	const idea = await askRequired(ctx, "What are we trying to build or change?", "Describe the product/codebase outcome in one paragraph");
	if (!idea) return undefined;
	const targetUser = await askRequired(ctx, "Who is this for?", "User/dev persona or system owner");
	if (!targetUser) return undefined;
	const desiredOutcome = await askRequired(ctx, "What should be true when this is done?", "Observable outcome, not implementation activity");
	if (!desiredOutcome) return undefined;
	const nonGoals = await ctx.ui.input("What should Gaud NOT do?", "Non-goals / out-of-scope changes");
	const constraints = await ctx.ui.input("Constraints or risks?", "Files to avoid, compatibility, safety, deadlines, unknowns");
	const programDone = await ctx.ui.editor("Program DONE criteria", "- [ ] Outcome is clear enough to judge complete/incomplete\n- [ ] User-visible or system-visible behavior is explicit\n- [ ] Required verification is named\n- [ ] Open questions are resolved or tracked as blockers");
	if (!programDone) return undefined;
	const milestoneName = await askRequired(ctx, "Current milestone name", "Smallest coherent milestone to implement first");
	if (!milestoneName) return undefined;
	const milestoneGoal = await askRequired(ctx, "Current milestone goal", "What this one milestone accomplishes");
	if (!milestoneGoal) return undefined;
	const milestoneDone = await ctx.ui.editor("Milestone DONE criteria", "- [ ] ...\n- [ ] pnpm check passes\n- [ ] User can verify via ...");
	if (!milestoneDone) return undefined;
	const tickets = await ctx.ui.editor("Current milestone tickets only", "## Ticket 1: <name>\n- Owner: gaud-implementer\n- Deliverable:\n- Verification:\n- Check-back trigger:\n\n## Ticket 2: <name>\n- Owner: gaud-implementer\n- Deliverable:\n- Verification:\n- Check-back trigger:");
	if (!tickets) return undefined;
	const dogfood = await ctx.ui.input("Dogfooding scenario", "How should a human verify this milestone? Use 'none' if internal-only.");
	const markdown = `# Gaud Execution Plan\n\n## PRD\n\n- Problem: ${idea}\n- Target user: ${targetUser}\n- Desired outcome: ${desiredOutcome}\n- Non-goals: ${nonGoals || "TBD"}\n- Constraints: ${constraints || "TBD"}\n- Risks: ${constraints || "TBD"}\n\n## Program DONE Criteria\n\n${programDone}\n\n## Role Map\n\n- Orchestrator: Pi agent\n- gaud-design: selected at launch\n- gaud-eng: selected at launch\n- gaud-implementer: selected at launch\n- gaud-code-review: selected at launch\n\n## Milestone 1: ${milestoneName}\n\n- Status: ready\n- Goal: ${milestoneGoal}\n- Depends on: none known\n- User-testable: ${dogfood && dogfood.toLowerCase() !== "none" ? "yes" : "no"}\n\n### Milestone DONE Criteria\n\n${milestoneDone}\n\n### Tickets\n\n${tickets}\n\n## Dogfooding Gate\n\n- Scenario to exercise: ${dogfood || "none"}\n- Must-pass outcomes: match milestone DONE criteria\n\n## PM Decisions\n\n- Date: ${new Date().toISOString().slice(0, 10)}\n- Decision: Initial Gaud plan created interactively.\n- Why: Real workers require an approved plan before launch.\n- Next action: Review assignment and launch workers.\n`;
	return { markdown, focus: `${milestoneName}: ${milestoneGoal}` };
}

async function pickAgent(ctx: ExtensionContext, title: string, installed: string[], preferred?: string): Promise<string | undefined> {
	if (installed.length === 0) return undefined;
	const choices = preferred && installed.includes(preferred)
		? [preferred, ...installed.filter((agent) => agent !== preferred)]
		: installed;
	return ctx.ui.select(title, choices);
}

async function pickImplementers(ctx: ExtensionContext, installed: string[], preferred: string[] = []): Promise<string[]> {
	const selected: string[] = [];
	const preferredInstalled = preferred.filter((agent) => installed.includes(agent));
	if (preferredInstalled.length > 0) {
		const useDefaults = await ctx.ui.confirm("Gaud implementers", `Use saved implementers?\n\n${preferredInstalled.join(", ")}`);
		if (useDefaults) return preferredInstalled;
	}

	while (true) {
		const remaining = installed.filter((agent) => !selected.includes(agent));
		if (remaining.length === 0) break;
		const choice = await ctx.ui.select(
			"Add implementer agent",
			selected.length > 0 ? ["Done", ...remaining] : remaining,
		);
		if (!choice || choice === "Done") break;
		selected.push(choice);
		if (selected.length >= 3) {
			const addMore = await ctx.ui.confirm("More implementers?", `Selected: ${selected.join(", ")}\nAdd another implementer?`);
			if (!addMore) break;
		}
	}
	return selected;
}

function expandHome(filePath: string): string {
	return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function builtinPrompt(role: PromptRole): string {
	const prompts: Record<PromptRole, string> = {
		planning: "Use a gstack-style planning interview: challenge vague goals, force explicit DONE criteria, current milestone only, small tickets, and user approval before launch.",
		design: "gaud-design: review UX/product shape, user journey, copy, visual hierarchy, and acceptance criteria before implementation.",
		eng: "gaud-eng: review architecture, state/data flow, tmux/polling failure modes, edge cases, and verification before implementation.",
		implementer: "gaud-implementer: implement one scoped current-milestone ticket only, verify locally, and report callbacks.",
		codeReview: "gaud-code-review: review milestone changes for correctness, safety, tests, callback protocol issues, and integration risks.",
	};
	return prompts[role];
}

async function resolvePromptSource(source: PromptSource | undefined, role: PromptRole): Promise<string> {
	if (!source || source.type === "builtin") return builtinPrompt(role);
	if (source.type === "local") {
		try { return await readFile(expandHome(source.path), "utf8"); } catch { return builtinPrompt(role); }
	}
	try {
		const response = await fetch(source.url);
		if (!response.ok) return builtinPrompt(role);
		return await response.text();
	} catch {
		return builtinPrompt(role);
	}
}

async function detectLocalGstack(): Promise<string | undefined> {
	const candidates = [
		path.join(os.homedir(), ".claude", "skills", "gstack"),
		path.join(os.homedir(), ".agents", "skills"),
		path.join(os.homedir(), "gstack"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

async function promptForPromptSources(ctx: ExtensionContext, existing?: GaudConfig): Promise<GaudConfig["promptSources"] | undefined> {
	const mode = await ctx.ui.select("Gaud planning methodology", [
		"Built-in Gaud defaults",
		"Use local gstack/skills files",
		"Use remote gstack URLs",
		"Keep existing config",
	]);
	if (!mode) return undefined;
	if (mode === "Keep existing config") return existing?.promptSources ?? { planning: { type: "builtin" } };
	if (mode === "Built-in Gaud defaults") {
		return { planning: { type: "builtin" }, design: { type: "builtin" }, eng: { type: "builtin" }, implementer: { type: "builtin" }, codeReview: { type: "builtin" } };
	}
	if (mode === "Use remote gstack URLs") {
		const base = "https://raw.githubusercontent.com/garrytan/gstack/main";
		return {
			planning: { type: "remote", url: `${base}/skills/office-hours/SKILL.md` },
			design: { type: "remote", url: `${base}/skills/plan-design-review/SKILL.md` },
			eng: { type: "remote", url: `${base}/skills/plan-eng-review/SKILL.md` },
			implementer: { type: "builtin" },
			codeReview: { type: "remote", url: `${base}/skills/review/SKILL.md` },
		};
	}
	const detected = await detectLocalGstack();
	const root = await ctx.ui.input("Local prompt root", detected ?? "~/.agents/skills");
	if (!root) return undefined;
	return {
		planning: { type: "local", path: path.join(root, "office-hours", "SKILL.md") },
		design: { type: "local", path: path.join(root, "plan-design-review", "SKILL.md") },
		eng: { type: "local", path: path.join(root, "plan-eng-review", "SKILL.md") },
		implementer: { type: "builtin" },
		codeReview: { type: "local", path: path.join(root, "review", "SKILL.md") },
	};
}

async function runSetupWizard(ctx: ExtensionContext) {
	const existing = await loadGaudConfig(ctx.cwd);
	const promptSources = await promptForPromptSources(ctx, existing);
	if (!promptSources) return;
	const roleConfig = await chooseRoleAgents(ctx, []);
	if (!roleConfig) return;
	const config: GaudConfig = { ...roleConfig, promptSources };
	await saveLocalGaudConfig(ctx.cwd, config);
	ctx.ui.notify(`Gaud config saved to ${localConfigPath(ctx.cwd)}`, "info");
}

async function chooseRoleAgents(ctx: ExtensionContext, parsedAgents: string[]): Promise<GaudConfig | undefined> {
	const installed = await detectInstalledAgents();
	if (installed.length === 0) {
		ctx.ui.notify("No supported agent CLIs found. Install claude, opencode, codex, gemini, or antigravity/agy, then run /gaud-doctor.", "error");
		return undefined;
	}
	const saved = await loadGaudConfig(ctx.cwd);
	const seededImplementers = parsedAgents.length > 0 ? parsedAgents.filter((agent) => installed.includes(agent)) : saved?.roles["gaud-implementer"];
	const design = await pickAgent(ctx, "gaud-design agent", installed, saved?.roles["gaud-design"]);
	if (!design) return undefined;
	const eng = await pickAgent(ctx, "gaud-eng agent", installed, saved?.roles["gaud-eng"]);
	if (!eng) return undefined;
	const implementers = await pickImplementers(ctx, installed, seededImplementers);
	if (implementers.length === 0) return undefined;
	const review = await pickAgent(ctx, "gaud-code-review agent", installed, saved?.roles["gaud-code-review"]);
	if (!review) return undefined;

	const config: GaudConfig = {
		orchestrator: { type: "pi", agent: "pi" },
		roles: {
			"gaud-design": design,
			"gaud-eng": eng,
			"gaud-implementer": implementers,
			"gaud-code-review": review,
		},
	};

	const save = await ctx.ui.confirm("Save Gaud defaults?", `Save these role defaults to ${localConfigPath(ctx.cwd)}?\n\nOrchestrator: pi\nDesign: ${design}\nEng: ${eng}\nImplementers: ${implementers.join(", ")}\nCode review: ${review}`);
	if (save) await saveLocalGaudConfig(ctx.cwd, config);
	return config;
}

async function runPlanningWizard(pi: ExtensionAPI, ctx: ExtensionContext, args: string) {
	const parsed = parseArgs(args);
	const taskArg = parsed.task && parsed.task !== "doctor" && parsed.task !== "status" ? parsed.task : "";
	const taskArgPath = taskArg ? (path.isAbsolute(taskArg) ? taskArg : path.join(ctx.cwd, taskArg)) : "";
	const taskArgLooksLikePath = Boolean(taskArg && (existsSync(taskArgPath) || /\.(md|markdown|txt)$/i.test(taskArg) || taskArg.includes("/")));
	const seededFocus = taskArgLooksLikePath ? undefined : taskArg || undefined;
	const sourcePath = taskArgLooksLikePath ? taskArg : "PLAN.md";
	const absoluteSourcePath = path.isAbsolute(sourcePath) ? sourcePath : path.join(ctx.cwd, sourcePath);
	let planText = "";
	let focus: string | undefined = seededFocus;
	let sourceLabel = sourcePath;

	if (existsSync(absoluteSourcePath)) {
		const useExisting = seededFocus
			? await ctx.ui.confirm("Gaud plan source", `Use existing ${sourcePath} as the planning source for this focus?\n\n${seededFocus}`)
			: await ctx.ui.confirm("Gaud plan source", `Use existing ${sourcePath} as the planning source? Choose No to create a new plan interactively.`);
		if (useExisting) {
			planText = await readFile(absoluteSourcePath, "utf8");
			if (!focus) focus = await ctx.ui.input("Gaud plan focus", "What milestone/slice should workers implement next?");
			if (!focus) return;
		}
	}

	if (!planText) {
		const interview = await createPlanByInterview(ctx);
		if (!interview) return;
		planText = interview.markdown;
		focus = interview.focus;
		sourceLabel = "interactive interview";
	}

	if (!focus) return;
	const approvedFocus = focus;
	let existingConfig = await loadGaudConfig(ctx.cwd);
	if (!existingConfig?.promptSources) {
		const configure = await ctx.ui.confirm("Set up Gaud methodology?", "Choose planning/review prompt sources before generating the launch plan? You can use built-in defaults, local gstack/skills files, or remote gstack URLs.");
		if (configure) {
			await runSetupWizard(ctx);
			existingConfig = await loadGaudConfig(ctx.cwd);
		}
	}
	const roleConfig = await chooseRoleAgents(ctx, parsed.agents);
	if (!roleConfig) return;
	const promptSources = existingConfig?.promptSources ?? { planning: { type: "builtin" }, design: { type: "builtin" }, eng: { type: "builtin" }, implementer: { type: "builtin" }, codeReview: { type: "builtin" } };
	const methodology = await Promise.all([
		resolvePromptSource(promptSources.planning, "planning"),
		resolvePromptSource(promptSources.design, "design"),
		resolvePromptSource(promptSources.eng, "eng"),
		resolvePromptSource(promptSources.implementer, "implementer"),
		resolvePromptSource(promptSources.codeReview, "codeReview"),
	]);
	planText = `${planText}\n\n## Gaud Methodology Context\n\n${methodology.map((text, index) => `### ${["planning", "design", "eng", "implementer", "codeReview"][index]}\n\n${text.slice(0, 6000)}`).join("\n\n")}`;
	const workerPlans = buildWorkerPlans(planText, approvedFocus, roleConfig.roles);
	if (workerPlans.length === 0) {
		ctx.ui.notify("No worker assignments were generated.", "error");
		return;
	}
	const planDir = path.join(ctx.cwd, ".gaud", "plans");
	await mkdir(planDir, { recursive: true });
	const outPath = path.join(planDir, `${makeRunId()}-plan.md`);
	const generatedMarkdown = renderPlanMarkdown(approvedFocus, sourceLabel, workerPlans, planText);
	const reviewedMarkdown = await ctx.ui.editor("Review/edit Gaud execution plan before launch", generatedMarkdown);
	if (!reviewedMarkdown) return;
	await writeFile(outPath, reviewedMarkdown, "utf8");
	const launch = await ctx.ui.confirm("Launch Gaud workers?", `Plan written to ${outPath}\n\nLaunch these assigned workers now?\n\n${workerPlans.map((plan) => `- ${plan.id}: ${plan.role} via ${plan.agent}`).join("\n")}`);
	if (launch) await launchRun(pi, ctx, `${approvedFocus}\n\nExecution plan: ${outPath}`, workerPlans.map((plan) => plan.agent), parsed.fake, "User approved reviewed Gaud plan.", workerPlans);
	else ctx.ui.notify(`Gaud plan written: ${outPath}`, "info");
}

async function showPeek(ctx: ExtensionContext, workerId?: string) {
	if (!activeRun) {
		ctx.ui.notify("No active Gaud run to peek.", "info");
		return;
	}
	await pollPanePeeks(activeRun);
	const workers = workerId ? [activeRun.workers[workerId]].filter(Boolean) : Object.values(activeRun.workers);
	if (workers.length === 0) {
		ctx.ui.notify(`No worker found: ${workerId}`, "error");
		return;
	}
	const header = `${statusText()}\n\nFull tmux: ${tmuxAttachCommand(activeRun)}\n`;
	const body = workers.map((worker) => {
		const activity = formatAge(workerLastActivity(worker));
		return `--- ${worker.id} (${worker.agent}) ${worker.status} ${worker.paneId ?? ""} · active ${activity} ---\nview: ${tmuxWorkerViewCommand(activeRun!, worker)}\n\n${worker.lastPeek || "(no pane output captured)"}`;
	}).join("\n\n");
	ctx.ui.notify(`${header}\n${body}`.slice(-7000), "info");
}

class GaudDashboardComponent implements Component {
	private selected = 0;
	private showPane = true;
	private tick: ReturnType<typeof setInterval> | undefined;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private pi: ExtensionAPI,
		private ctx: ExtensionContext,
	) {
		this.tick = setInterval(() => this.tui.requestRender(), UI_TICK_MS);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.tick) clearInterval(this.tick);
		this.tick = undefined;
	}

	private workers(): WorkerState[] {
		return activeRun ? Object.values(activeRun.workers) : [];
	}

	private selectedWorker(): WorkerState | undefined {
		const workers = this.workers();
		if (this.selected >= workers.length) this.selected = Math.max(0, workers.length - 1);
		return workers[this.selected];
	}

	private close() {
		this.dispose();
		this.done();
	}

	private notifyAttach(worker?: WorkerState) {
		if (!activeRun) return;
		this.ctx.ui.notify(worker ? tmuxWorkerViewCommand(activeRun, worker) : tmuxAttachCommand(activeRun), "info");
	}

	handleInput(data: string): void {
		const workers = this.workers();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) return this.close();
		if (matchesKey(data, "down") || matchesKey(data, "j")) this.selected = Math.min(workers.length - 1, this.selected + 1);
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "g")) this.selected = 0;
		else if (data === "G") this.selected = Math.max(0, workers.length - 1);
		else if (matchesKey(data, "p") || matchesKey(data, "space")) this.showPane = !this.showPane;
		else if (matchesKey(data, "r")) void pollOnce(this.pi, this.ctx).then(() => this.tui.requestRender());
		else if (matchesKey(data, "a")) this.notifyAttach();
		else if (matchesKey(data, "return") || matchesKey(data, "v")) this.notifyAttach(this.selectedWorker());
		else if (matchesKey(data, "y")) {
			const worker = this.selectedWorker();
			if (activeRun) this.ctx.ui.notify(worker ? tmuxWorkerViewCommand(activeRun, worker) : tmuxAttachCommand(activeRun), "info");
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const pad = (value: string) => truncateToWidth(value, innerW, "…", true);
		const border = (value: string) => th.fg("border", value);
		const line = (value = "") => border("│") + pad(value) + border("│");
		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(line(th.fg("accent", "Gaud Dashboard") + `  ${activeRun ? activeRun.id : "no active run"}`));
		lines.push(line(activeRun ? `${statusText()}` : "No active Gaud run."));
		lines.push(line("keys: j/k · Enter/v tmux cmd · p pane · r refresh · a attach · q close"));
		lines.push(line());
		if (activeRun) {
			const workers = this.workers();
			const needsAttention = workers.filter((w) => w.status === "stuck" || w.status === "waiting-user" || w.status === "waiting-permission");
			if (needsAttention.length > 0) {
				lines.push(line(th.fg("error", `⚠ needs attention: ${needsAttention.map((w) => `${w.id} (${w.status})`).join(", ")}`)));
				lines.push(line());
			}
			for (let index = 0; index < workers.length; index++) {
				const worker = workers[index]!;
				const marker = index === this.selected ? th.fg("accent", "▸") : " ";
				const symbol = workerStatusSymbol(worker.status);
				const status = th.fg(workerStatusColor(worker.status), `${symbol} ${worker.status}`.padEnd(20));
				const activity = formatAge(workerLastActivity(worker));
				const summary = worker.summary ? ` ${worker.summary}` : "";
				lines.push(line(`${marker}${status} ${worker.id.padEnd(16)} ${worker.agent.padEnd(10)} ${activity}${summary}`));
			}
			const worker = this.selectedWorker();
			if (worker) {
				lines.push(line());
				lines.push(line(th.fg("accent", `Selected: ${worker.id}`) + `  ${th.fg(workerStatusColor(worker.status), `${workerStatusSymbol(worker.status)} ${worker.status}`)}`));
				lines.push(line(`tmux: ${tmuxWorkerViewCommand(activeRun, worker)}`));
				if (this.showPane) {
					lines.push(line("latest pane output:"));
					const paneLines = (worker.lastPeek || "(no pane output captured yet)").split("\n").slice(-12);
					for (const paneLine of paneLines) lines.push(line(`  ${paneLine}`));
				}
			}
		}
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

function showGaudDashboard(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (dashboardOpen) {
		dashboardHandle?.setHidden?.(false);
		dashboardHandle?.focus?.();
		return;
	}
	dashboardOpen = true;
	void ctx.ui.custom<void>((tui, theme, _keybindings, done) => new GaudDashboardComponent(tui, theme, done, pi, ctx), {
		overlay: true,
		overlayOptions: { anchor: "right-center", width: "60%", minWidth: 56, maxHeight: "75%", margin: 1 },
		onHandle: (handle) => {
			dashboardHandle = handle;
		},
	}).finally(() => {
		dashboardOpen = false;
		dashboardHandle = undefined;
	});
}

function explicitGaudRequest(text: string): string | undefined {
	const trimmed = text.trim();
	const match = /^(?:gaud|god|gaud mode|god mode|parallelize|parallelise)\b[:\s-]*(.*)$/i.exec(trimmed);
	return match?.[1]?.trim();
}

function looksParallelizable(text: string): boolean {
	const trimmed = text.trim();
	const lower = trimmed.toLowerCase();
	if (!trimmed || trimmed.startsWith("/")) return false;
	if (/^(what|why|how|can you explain|tell me|show me)\b/.test(lower) && !/\b(build|implement|create|make|fix|refactor)\b/.test(lower)) return false;

	const action = /\b(implement|build|make|refactor|migrate|rewrite|fix|ship|create|add|update|integrate|scaffold)\b/.test(lower);
	const productNoun = /\b(app|site|website|dashboard|feature|workflow|integration|api|cli|sdk|tool|system|ui|ux|backend|frontend|database)\b/.test(lower);
	const breadth = /\b(and|plus|multiple|several|all|frontend|backend|api|database|docs|tests|ui|ux|auth|payments|deploy|polish|end-to-end|full stack|full-stack)\b/.test(lower);
	const bigTask = /\b(build|make|create|scaffold)\b.*\b(app|site|website|dashboard|tool|system|workflow|integration)\b/.test(lower);
	const multiPart = trimmed.split(/\b(?:and|plus|then|also)\b|[,;]/i).filter((part) => part.trim().length > 8).length >= 2;
	return action && (bigTask || (productNoun && breadth) || multiPart || trimmed.length > 120);
}

export default function gaudExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		extensionActive = true;
		lastCtx = ctx;
		refreshUi(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopPolling();
		if (activeRun && activeRun.status === "running") {
			let shouldKill = event.reason === "quit";
			if (event.reason === "quit" && ctx.hasUI) {
				shouldKill = await ctx.ui.confirm(
					"Gaud workers are still running",
					`Kill tmux session ${activeRun.tmuxSession} before Pi exits? Choose No to leave it detached.`,
				);
			}

			if (shouldKill) {
				await killActiveTmuxRun();
				activeRun.status = "stopped";
			} else {
				activeRun.status = "detached";
			}
			await persistRun(pi);
		}
		extensionActive = false;
		refreshUi(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const explicitTask = explicitGaudRequest(event.text);
		if (explicitTask !== undefined) {
			if (explicitTask === "status") {
				refreshUi(ctx);
				ctx.ui.notify(statusText(), "info");
				return { action: "handled" as const };
			}
			const parsed = parseArgs(explicitTask);
			if (parsed.fake) await launchRun(pi, ctx, parsed.task, parsed.agents, true, "User explicitly requested fake Gaud smoke run.");
			else await runPlanningWizard(pi, ctx, explicitTask || "PLAN.md");
			return { action: "handled" as const };
		}

		if (!activeRun && looksParallelizable(event.text)) {
			const yes = await ctx.ui.confirm("Maybe use Gaud?", "This looks like a Gaud-sized build/change with separable workstreams. Create a Gaud execution plan first?");
			if (yes) {
				await runPlanningWizard(pi, ctx, event.text);
				return { action: "handled" as const };
			}
		}

		return { action: "continue" as const };
	});

	pi.registerShortcut("ctrl+shift+g", {
		description: "Focus/open Gaud dashboard",
		handler: async (ctx) => {
			if (activeRun) await pollOnce(pi, ctx);
			refreshUi(ctx);
			showGaudDashboard(pi, ctx);
		},
	});

	pi.registerTool({
		name: "gaud_start_run",
		label: "Start Gaud Run",
		description: "Start a Gaud tmux background worker run for tasks that benefit from multiple agents.",
		promptSnippet: "Start Gaud mode to parallelize large implementation tasks in tmux workers.",
		promptGuidelines: [
			"Use gaud_start_run when the user's task has separable workstreams, multiple modules, or would benefit from parallel implementation.",
			"Do not use gaud_start_run for small one-file edits, simple questions, or tasks where serial execution is clearly faster.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The user's task to parallelize." }),
			reason: Type.String({ description: "Why this task benefits from Gaud parallelization." }),
			agents: Type.Optional(Type.Array(Type.String(), { description: "Agent CLI names to launch, e.g. claude, opencode, antigravity." })),
			fake: Type.Optional(Type.Boolean({ description: "Launch fake bash workers for smoke testing." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await launchRun(pi, ctx, params.task, params.agents?.length ? params.agents : [...DEFAULT_AGENTS], Boolean(params.fake), params.reason);
			return { content: [{ type: "text", text: statusText() }], details: { run: activeRun } };
		},
	});

	pi.registerCommand("gaud-setup", {
		description: "Configure Gaud default agents and prompt sources",
		handler: async (_args, ctx) => {
			await runSetupWizard(ctx);
		},
	});

	pi.registerCommand("gaud-plan", {
		description: "Read PLAN.md or another plan file, ask planning questions, create workstreams, and optionally launch Gaud",
		handler: async (args, ctx) => {
			await runPlanningWizard(pi, ctx, args);
		},
	});

	pi.registerCommand("gaud-doctor", {
		description: "Check Gaud dependencies and configured agent CLIs",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			ctx.ui.notify((await doctorLines(parsed.agents)).join("\n"), "info");
		},
	});

	pi.registerCommand("gaud-status", {
		description: "Show current Gaud run status",
		handler: async (_args, ctx) => {
			if (activeRun) await pollOnce(pi, ctx);
			refreshUi(ctx);
			ctx.ui.notify(statusText(), "info");
		},
	});

	pi.registerCommand("gaud", {
		description: "Create a Gaud execution plan by default. Usage: /gaud [doctor|status|setup|plan] [--fake] [--agents claude,opencode,antigravity] [task or PLAN.md]",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.task === "doctor") {
				ctx.ui.notify((await doctorLines(parsed.agents)).join("\n"), "info");
				return;
			}
			if (parsed.task === "setup") {
				await runSetupWizard(ctx);
				return;
			}
			if (parsed.task === "status") {
				refreshUi(ctx);
				ctx.ui.notify(statusText(), "info");
				return;
			}
			if (parsed.fake) {
				await launchRun(pi, ctx, parsed.task, parsed.agents, true, "User ran /gaud fake smoke run.");
				return;
			}
			await runPlanningWizard(pi, ctx, parsed.task === "plan" ? "PLAN.md" : (args.trim() || "PLAN.md"));
		},
	});

	pi.registerCommand("gaud-dashboard", {
		description: "Open interactive Gaud dashboard overlay",
		handler: async (args, ctx) => {
			if (activeRun) await pollOnce(pi, ctx);
			refreshUi(ctx);
			if (args.includes("--text") || !ctx.hasUI) ctx.ui.notify(`${statusText()}\n\n${renderWidget().join("\n")}`, "info");
			else showGaudDashboard(pi, ctx);
		},
	});

	pi.registerCommand("gaud-view", {
		description: "Show live tmux view commands and latest pane peeks",
		handler: async (args, ctx) => {
			await showPeek(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("gaud-peek", {
		description: "Peek tmux pane output for all workers or one worker id",
		handler: async (args, ctx) => {
			await showPeek(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("gaud-attach", {
		description: "Show tmux attach command for current Gaud run",
		handler: async (_args, ctx) => {
			if (!activeRun) {
				ctx.ui.notify("No active Gaud run to attach.", "info");
				return;
			}
			const workerCommands = Object.values(activeRun.workers).map((worker) => `${worker.id}: ${tmuxWorkerViewCommand(activeRun!, worker)}`);
			ctx.ui.notify([tmuxAttachCommand(activeRun), "", "Worker panes:", ...workerCommands].join("\n"), "info");
		},
	});

	pi.registerCommand("gaud-stop", {
		description: "Stop current Gaud run. Use /gaud-stop --kill to kill tmux workers.",
		handler: async (args, ctx) => {
			await stopRun(pi, ctx, args.includes("--kill"));
		},
	});

	pi.registerCommand("gaud-resume", {
		description: "Resume latest Gaud run from Pi session state",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const latest = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "gaud-state") as { data?: { statePath?: string } } | undefined;
			activeRun = latest?.data?.statePath ? await readRunState(latest.data.statePath) : undefined;
			if (activeRun) startPolling(pi, ctx);
			refreshUi(ctx);
			ctx.ui.notify(activeRun ? `Resumed ${statusText()}` : "No persisted Gaud run found.", "info");
		},
	});
}
