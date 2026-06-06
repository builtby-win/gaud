import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

type GaudRole = "TPM" | "Investigator" | "UX/UI" | "Implementer" | "Integrator";

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
	objective?: string;
	lastEventAt?: number;
	lastOutputAt?: number;
	lastPeek?: string;
	summary?: string;
	restartCount?: number;
	permissionNotifiedAt?: number;
	stuckNotifiedAt?: number;
	trustAutoRespondedAt?: number;
};

type PlanMilestone = {
	id: string;
	name: string;
	status: "planned" | "in-progress" | "done";
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
	planPath?: string;
	milestones?: PlanMilestone[];
	currentMilestone?: string;
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
let dashboardOffset = { x: 0, y: 0 };
let planningInFlight = false;

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

type MarkdownPlanCandidate = {
	path: string;
	relativePath: string;
	mtimeMs: number;
	score: number;
};

export type PlanningSource = {
	taskArg: string;
	taskArgPath: string;
	taskArgExists: boolean;
	taskArgLooksLikePath: boolean;
	seededFocus?: string;
	sourcePath: string;
	absoluteSourcePath: string;
	missingExplicitPath: boolean;
};

function isMarkdownPlanName(name: string): boolean {
	if (!/\.(md|markdown)$/i.test(name)) return false;
	const lower = name.toLowerCase();
	if (["readme.md", "changelog.md", "contributing.md", "license.md"].includes(lower)) return false;
	return lower === "plan.md" || lower.includes("plan") || lower.includes("prd") || lower.includes("spec") || lower.includes("gaud") || lower.includes("firmware");
}

function planCandidateScore(relativePath: string): number {
	const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
	if (normalized === "plan.md") return 100;
	if (normalized.startsWith(".gaud/plans/") && normalized.endsWith(".md")) return 90;
	if (!normalized.includes("/") && normalized.includes("plan")) return 80;
	if (!normalized.includes("/") && (normalized.includes("prd") || normalized.includes("spec") || normalized.includes("firmware"))) return 70;
	if (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/")) return 0;
	return 10;
}

async function listMarkdownPlanCandidates(cwd: string): Promise<MarkdownPlanCandidate[]> {
	const candidates: MarkdownPlanCandidate[] = [];
	const addIfPlan = async (absolutePath: string, relativePath: string, mtimeMs: number) => {
		if (!isMarkdownPlanName(path.basename(relativePath))) return;
		const score = planCandidateScore(relativePath);
		if (score <= 0) return;
		candidates.push({ path: absolutePath, relativePath, mtimeMs, score });
	};

	try {
		for (const entry of await readdir(cwd, { withFileTypes: true })) {
			if (entry.isFile()) {
				const absolutePath = path.join(cwd, entry.name);
				const fileStat = await stat(absolutePath);
				await addIfPlan(absolutePath, entry.name, fileStat.mtimeMs);
			}
		}
	} catch {
		return candidates;
	}

	const gaudPlansDir = path.join(cwd, ".gaud", "plans");
	try {
		for (const entry of await readdir(gaudPlansDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const relativePath = path.join(".gaud", "plans", entry.name);
			const absolutePath = path.join(gaudPlansDir, entry.name);
			const fileStat = await stat(absolutePath);
			await addIfPlan(absolutePath, relativePath, fileStat.mtimeMs);
		}
	} catch {
		return candidates.sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
	}

	return candidates.sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath));
}

export async function discoverDefaultPlanPath(cwd: string): Promise<string | undefined> {
	return (await listMarkdownPlanCandidates(cwd))[0]?.relativePath;
}

export async function resolvePlanningSource(cwd: string, parsedTask: string): Promise<PlanningSource> {
	const taskArg = parsedTask && parsedTask !== "doctor" && parsedTask !== "status" ? parsedTask : "";
	const taskArgPath = taskArg ? (path.isAbsolute(taskArg) ? taskArg : path.join(cwd, taskArg)) : "";
	const taskArgExists = Boolean(taskArgPath && existsSync(taskArgPath));
	const taskArgLooksLikePath = Boolean(taskArg && (taskArgExists || /\.(md|markdown|txt)$/i.test(taskArg) || taskArg.includes("/")));
	const discoveredSourcePath = !taskArg ? await discoverDefaultPlanPath(cwd) : undefined;
	const seededFocus = taskArgLooksLikePath ? undefined : taskArg || undefined;
	const sourcePath = taskArgLooksLikePath ? taskArg : discoveredSourcePath ?? "PLAN.md";
	const absoluteSourcePath = path.isAbsolute(sourcePath) ? sourcePath : path.join(cwd, sourcePath);
	return {
		taskArg,
		taskArgPath,
		taskArgExists,
		taskArgLooksLikePath,
		seededFocus,
		sourcePath,
		absoluteSourcePath,
		missingExplicitPath: taskArgLooksLikePath && !taskArgExists,
	};
}

function inferPlanFocus(planText: string, sourcePath: string): string {
	const title = /^#\s+(.+)$/m.exec(planText)?.[1]?.trim();
	const milestone = /^##\s+Milestone\s+\d+\s*:?\s*(.+)$/mi.exec(planText)?.[1]?.trim();
	const base = milestone || title || path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ");
	return base.startsWith("M1") ? base : `M1 — ${base}`;
}

export function agentCommand(agent: string, commandName: string, promptPath: string, fake: boolean): string {
	if (fake) {
		return `bash -lc ${shellQuote(`echo "[gaud] fake ${agent} worker started"; sleep 2; echo "[gaud] fake ${agent} worker done"; "$GAUD_CALLBACK_BIN" done --summary "fake ${agent} completed"; exec bash`)}`;
	}

	const promptRef = shellQuote(promptPath);
	const callbackInstruction = `When you finish or become blocked, report status by running one of these commands:\n$GAUD_CALLBACK_BIN done --summary "what changed"\n$GAUD_CALLBACK_BIN waiting-user --question "what you need"\n$GAUD_CALLBACK_BIN waiting-permission --summary "what you need permission for"\n$GAUD_CALLBACK_BIN failed --summary "what failed"`;
	const promptCommand = `cat ${promptRef}; printf '\n\n%s\n' ${shellQuote(callbackInstruction)}`;
	const promptSubstitution = `"$(${promptCommand})"`;
	const cmd = shellQuote(commandName);
	const callbackMarker = `"$GAUD_RUN_DIR/workers/$GAUD_WORKER_ID/callback.done"`;
	const autoCallback = `(status=$?; if [ ! -e ${callbackMarker} ]; then if [ "$status" -eq 0 ]; then "$GAUD_CALLBACK_BIN" done --summary "${agent} completed without explicit callback"; else "$GAUD_CALLBACK_BIN" failed --summary "${agent} exited with status $status"; fi; fi; exec bash)`;
	const wrap = (invocation: string) => `bash -lc ${shellQuote(`${invocation}; ${autoCallback}`)}`;

	if (agent === "claude") return wrap(`${cmd} --dangerously-skip-permissions --print ${promptSubstitution}`);
	if (agent === "codex") return wrap(`${cmd} --yolo ${promptSubstitution}`);
	if (agent === "gemini") return wrap(`${cmd} --yolo -i ${promptSubstitution}`);
	if (agent === "opencode") return wrap(`${cmd} --prompt ${promptSubstitution}`);
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
		`GAUD_WORKER_ROLE=${shellQuote(worker.role || "Implementer")}`,
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
	lines.push(`Dashboard: Ctrl+Shift+G / Ctrl+D (q to close) · /gaud-peek [worker] · ${tmuxAttachCommand(activeRun)}`);
	return lines;
}

function refreshUi(ctx?: UiContext) {
	if (!ctx || !extensionActive) return;
	try {
		const status = activeRun
			? `gaud: ${activeRun.status} · ${pollInFlight ? "polling" : `next ${formatEta(nextPollAt)}`} · Ctrl+Shift+G dashboard`
			: "gaud: idle · Ctrl+Shift+G dashboard";
		ctx.ui.setStatus("gaud", status);
		ctx.ui.setWidget("gaud", dashboardOpen ? undefined : renderWidget());
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
	return `You are a Gaud background specialist worker.\n\nTask:\n${task}\n\nWorker id: ${workerId}\nAgent: ${agent}\nRole: ${role}\n\n${assignment}\n\nCoordination rules:\n- Avoid broad unrelated refactors.\n- Prefer small, reviewable changes in your assigned files.\n- If you need to edit outside your assigned files, explain why in your callback summary.\n- Run the relevant checks before reporting done when practical.\n- Default reasonable product/engineering details yourself; ask the user only when ambiguity would materially change the outcome.\n- If your CLI/tooling prompts for approval, credentials, network access, or destructive permission and you cannot safely proceed, immediately report waiting-permission with the exact prompt/permission needed.\n- Keep status summaries operator-friendly: changed files, current blocker, next action, and verification.\n\nStatus protocol:\n- When done, run: $GAUD_CALLBACK_BIN done --summary "${role}: brief summary"\n- If blocked on the user, run: $GAUD_CALLBACK_BIN waiting-user --question "specific question"\n- If blocked on permission, run: $GAUD_CALLBACK_BIN waiting-permission --summary "specific permission needed"\n- If failed, run: $GAUD_CALLBACK_BIN failed --summary "brief failure"\n`;
}

async function createCallbackHelper(runDir: string) {
	const binDir = path.join(runDir, "bin");
	await mkdir(binDir, { recursive: true });
	const helperPath = path.join(binDir, "gaud-callback");
	const script = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const type = args.shift() || 'event';
const data = { ts: Date.now(), type, runId: process.env.GAUD_RUN_ID, workerId: process.env.GAUD_WORKER_ID, agent: process.env.GAUD_AGENT, role: process.env.GAUD_WORKER_ROLE, milestone: process.env.GAUD_MILESTONE, workstream: process.env.GAUD_WORKSTREAM };
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

function extractPlanPath(task: string): string | undefined {
	const match = /Execution plan:\s*(.+)$/mi.exec(task);
	return match?.[1]?.trim();
}

function extractMilestones(planText: string): PlanMilestone[] {
	const matches = [...planText.matchAll(/^##\s+Milestone\s+(\d+)\s*:?\s*(.+)$/gmi)];
	const milestones = matches.map((match, index) => ({
		id: `M${match[1] ?? index + 1}`,
		name: (match[2] ?? `Milestone ${index + 1}`).trim(),
		status: index === 0 ? "in-progress" as const : "planned" as const,
	}));
	return milestones.length ? milestones : [{ id: "M1", name: "Current milestone", status: "in-progress" }];
}

async function loadPlanOverview(task: string): Promise<{ planPath?: string; milestones: PlanMilestone[]; currentMilestone: string }> {
	const planPath = extractPlanPath(task);
	if (planPath && existsSync(planPath)) {
		const milestones = extractMilestones(await readFile(planPath, "utf8"));
		return { planPath, milestones, currentMilestone: milestones[0]?.id ?? "M1" };
	}
	return { planPath, milestones: [{ id: "M1", name: "Current milestone", status: "in-progress" }], currentMilestone: "M1" };
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
	const planOverview = await loadPlanOverview(task);

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
		planPath: planOverview.planPath,
		milestones: planOverview.milestones,
		currentMilestone: planOverview.currentMilestone,
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
		const workerRole = plan?.role ?? "Implementer";
		const envPrefix = workerEnvPrefix({ id: workerId, agent, role: workerRole, workstream: workerId });
		const paneResult = await tmux(run, ["split-window", "-d", "-t", tmuxSession, "-P", "-F", "#{pane_id}", `${envPrefix} exec ${command}`]);
		const paneId = paneResult.stdout.trim();
		await tmux(run, ["select-layout", "-t", tmuxSession, "tiled"]);
		if (paneId) await tmux(run, ["pipe-pane", "-o", "-t", paneId, `cat >> ${shellQuote(logPath)}`]);
		run.workers[workerId] = {
			id: workerId,
			agent,
			role: workerRole,
			workstream: workerId,
			status: "starting",
			paneId,
			command,
			promptPath,
			logPath,
			objective: plan?.objective,
			lastEventAt: Date.now(),
		};
	}

	await tmux(run, ["kill-pane", "-t", firstPaneId]);
	run.status = "running";
	run.updatedAt = Date.now();
	await persistRun(pi);
	refreshUi(ctx);
	startPolling(pi, ctx);
	ctx.ui.notify(`Started Gaud run ${id} with agents: ${resolvedAgents.map((agent) => agent.agent).join(", ")}. Opening dashboard.`, "info");
	try {
		pi.sendUserMessage(
			`Gaud run ${id} started. Workers: ${resolvedAgents.map((a) => `${a.agent}`).join(", ")}. Tmux socket: ${tmuxSocket}.\n\nIMPORTANT: The Pi extension owns all polling and GAUDMODE callback forwarding for this run. Do NOT invoke gaud-poll, gaud-tmux-layout, or any other gaud-mode skill infrastructure commands — they conflict with the extension's built-in poller. Worker callbacks will arrive automatically as GAUDMODE follow-up messages. Wait for them before taking action.`,
			{ deliverAs: "followUp" },
		);
	} catch { /* stale ctx at launch */ }
	if (ctx.hasUI) showGaudDashboard(pi, ctx);
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

function stuckSummary(worker: WorkerState): string {
	const peek = worker.lastPeek ?? "";
	const tail = peek.split("\n").slice(-20).join("\n").trim();
	return tail.replace(/\s+/g, " ").slice(-700) || "(no output captured)";
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
			if (run.milestones?.[0]) run.milestones[0].status = "done";
			stopPolling();
		}
		try {
			if (["done", "waiting-user", "waiting-permission", "failed"].includes(type)) {
				const role = String(event.role ?? worker?.role ?? "Implementer");
				const milestone = String(event.milestone ?? "M1");
				const workstream = String(event.workstream ?? workerId);
				const summary = String(event.summary ?? event.question ?? "").replace(/\s+/g, " ").trim();
				const text = `GAUDMODE ${type} role=${role} milestone=${milestone} workstream=${workstream} summary=${summary}`;
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
			if (worker.status === "stuck" && (!preStuck.has(worker.id) || Date.now() - (worker.stuckNotifiedAt ?? 0) > 60_000)) {
				worker.stuckNotifiedAt = Date.now();
				const cmd = tmuxWorkerViewCommand(activeRun, worker);
				const lastOutput = (worker.lastPeek ?? "").split("\n").slice(-20).join("\n");
				const socket = activeRun.tmuxSocket;
				const paneId = worker.paneId ?? "";
				const captureCmd = paneId
					? `tmux -L ${socket} capture-pane -p -t ${paneId} -S -80`
					: `tmux -L ${socket} list-panes -a`;
				const sendKeysCmd = paneId
					? `tmux -L ${socket} send-keys -t ${paneId} "YOUR_INPUT" Enter`
					: "";
				try {
					pi.sendUserMessage(
						`GAUDMODE stuck role=${worker.role || "Implementer"} milestone=${activeRun.currentMilestone ?? "M1"} workstream=${worker.workstream || worker.id} workerId=${worker.id} agent=${worker.agent}\n\nWorker ${worker.id} (${worker.agent}) has had no activity for ${STUCK_AFTER_MS / 60000}m. Investigate the pane output below and decide: unblock via tmux send-keys, restart via /gaud-restart, or ask the user.\n\n${paneId ? `Capture latest output:\n  ${captureCmd}\nSend input to pane:\n  ${sendKeysCmd}\n` : ""}Restart: /gaud-restart ${worker.id}\n\nDo NOT run gaud-poll or gaud-mode skill commands — the Pi extension owns all polling.\n\nLast pane output:\n${lastOutput}`,
						{ deliverAs: "followUp" },
					);
				} catch { /* stale ctx */ }
				try { ctx.ui.notify(`Worker ${worker.id} (${worker.agent}) stuck — no activity for ${STUCK_AFTER_MS / 60000}m.\nJump to pane:\n${cmd}`, "warning"); } catch { /* stale ctx */ }
			}
			if (worker.status === "dead") {
				try {
					pi.sendUserMessage(
						`GAUDMODE dead role=${worker.role || "Implementer"} milestone=${activeRun.currentMilestone ?? "M1"} workstream=${worker.workstream || worker.id} workerId=${worker.id} agent=${worker.agent}\n\nWorker ${worker.id} (${worker.agent}) pane has died. Decide: restart via /gaud-restart ${worker.id} or continue without it.\n\nDo NOT run gaud-poll or gaud-mode skill commands — the Pi extension owns all polling.`,
						{ deliverAs: "followUp" },
					);
				} catch { /* stale ctx */ }
			}
			if (worker.status === "waiting-permission" && worker.summary && Date.now() - (worker.permissionNotifiedAt ?? 0) > 60_000) {
				worker.permissionNotifiedAt = Date.now();
				try { ctx.ui.notify(`Worker ${worker.id} needs permission:\n${worker.summary}\n\nInspect with /gaud-peek ${worker.id}; approve in tmux or restart/cancel from dashboard.`, "error"); } catch { /* stale ctx */ }
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

function findWorker(workerId: string): WorkerState | undefined {
	return activeRun?.workers[workerId];
}

async function confirmWorkerAction(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm(title, message);
}

async function cancelWorker(pi: ExtensionAPI, ctx: ExtensionContext, workerId: string, confirm = true): Promise<boolean> {
	if (!activeRun) {
		ctx.ui.notify("No active Gaud run.", "info");
		return false;
	}
	const worker = findWorker(workerId);
	if (!worker) {
		ctx.ui.notify(`No worker found: ${workerId}`, "error");
		return false;
	}
	if (!worker.paneId) {
		ctx.ui.notify(`Worker ${workerId} has no tmux pane to cancel.`, "error");
		return false;
	}
	if (confirm) {
		const ok = await confirmWorkerAction(ctx, "Cancel Gaud worker?", `Send Ctrl+C to ${worker.id} (${worker.agent})?\n\nPane: ${worker.paneId}`);
		if (!ok) return false;
	}
	const result = await tmux(activeRun, ["send-keys", "-t", worker.paneId, "C-c"]);
	if (result.code !== 0) {
		ctx.ui.notify(`Failed to cancel ${worker.id}: ${result.stderr.trim() || "tmux send-keys failed"}`, "error");
		return false;
	}
	worker.status = "working";
	worker.summary = "Ctrl+C sent by user";
	worker.lastEventAt = Date.now();
	await persistRun(pi);
	refreshUi(ctx);
	ctx.ui.notify(`Sent Ctrl+C to ${worker.id}. Use /gaud-peek ${worker.id} to inspect output.`, "info");
	return true;
}

async function restartWorker(pi: ExtensionAPI, ctx: ExtensionContext, workerId: string, confirm = true): Promise<boolean> {
	if (!activeRun) {
		ctx.ui.notify("No active Gaud run.", "info");
		return false;
	}
	const worker = findWorker(workerId);
	if (!worker) {
		ctx.ui.notify(`No worker found: ${workerId}`, "error");
		return false;
	}
	if (confirm) {
		const ok = await confirmWorkerAction(ctx, "Restart Gaud worker?", `Kill and recreate ${worker.id} (${worker.agent}) with the same prompt and command?\n\nOld pane: ${worker.paneId ?? "none"}`);
		if (!ok) return false;
	}

	const oldPaneId = worker.paneId;
	const markerPath = path.join(activeRun.runDir, "workers", worker.id, "callback.done");
	await rm(markerPath, { force: true });
	const paneResult = await tmux(activeRun, ["split-window", "-d", "-t", activeRun.tmuxSession, "-P", "-F", "#{pane_id}", `${workerEnvPrefix(worker)} exec ${worker.command}`]);
	if (paneResult.code !== 0) {
		ctx.ui.notify(`Failed to restart ${worker.id}: ${paneResult.stderr.trim() || "tmux split-window failed"}`, "error");
		return false;
	}
	const newPaneId = paneResult.stdout.trim();
	if (!newPaneId) {
		ctx.ui.notify(`Failed to restart ${worker.id}: tmux did not return a new pane id.`, "error");
		return false;
	}
	const pipeResult = await tmux(activeRun, ["pipe-pane", "-o", "-t", newPaneId, `cat >> ${shellQuote(worker.logPath)}`]);
	if (pipeResult.code !== 0) {
		ctx.ui.notify(`Restarted ${worker.id}, but failed to re-bind pane logging: ${pipeResult.stderr.trim() || "tmux pipe-pane failed"}`, "error");
	}
	await tmux(activeRun, ["select-layout", "-t", activeRun.tmuxSession, "tiled"]);
	if (oldPaneId && oldPaneId !== newPaneId) await tmux(activeRun, ["kill-pane", "-t", oldPaneId]);
	worker.paneId = newPaneId;
	worker.paneIndex = undefined;
	worker.pid = undefined;
	worker.status = "starting";
	worker.summary = confirm ? "Restarted by user" : "Relaunched automatically after pane failure";
	worker.restartCount = (worker.restartCount ?? 0) + 1;
	worker.lastEventAt = Date.now();
	worker.lastOutputAt = undefined;
	worker.lastPeek = undefined;
	worker.trustAutoRespondedAt = undefined;
	activeRun.status = "running";
	await persistRun(pi);
	refreshUi(ctx);
	ctx.ui.notify(`Restarted ${worker.id} in pane ${newPaneId}.`, "info");
	return true;
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workstream";
}

export function buildWorkerPlans(planText: string, focus: string, roleAgents: GaudConfig["roles"]): WorkerPlan[] {
	const templates: Array<Omit<WorkerPlan, "agent">> = [
		{
			id: "tpm",
			role: "TPM",
			objective: "Turn the approved outcome into one current milestone with small tickets, dependencies, verification, and check-back triggers. Do not implement.",
			files: ["PLAN.md", ".gaud/plans/*", "README.md"],
			doneCriteria: ["Program and milestone DONE criteria are explicit or a concrete blocker is reported.", "Tickets are small, non-overlapping, and scoped to the current milestone.", "Verification commands and check-back triggers are named."],
		},
		{
			id: "investigator",
			role: "Investigator",
			objective: "Gather repo facts, edge cases, risks, and implementation constraints for the current milestone. Do not implement unless explicitly assigned cleanup.",
			files: ["PLAN.md", "README.md", "extensions/gaud/index.ts", "test/*", "scripts/*"],
			doneCriteria: ["Relevant files and conventions are identified.", "Risks or blockers are concrete and milestone-scoped.", "One recommended default is provided for non-blocking ambiguity."],
		},
		{
			id: "ux-ui",
			role: "UX/UI",
			objective: "Review the current milestone for product shape, user journey, copy, layout, and acceptance criteria. Mark non-user-facing work as not applicable quickly.",
			files: ["PLAN.md", "README.md", "extensions/gaud/index.ts"],
			doneCriteria: ["UX/product risks are called out or marked not applicable.", "Acceptance criteria are concrete enough for implementers.", "Any proposed scope change is explicit."],
		},
		{
			id: "implementer",
			role: "Implementer",
			objective: "Implement one scoped current-milestone ticket only after reading the execution plan. Keep changes small and verify locally.",
			files: ["extensions/gaud/index.ts", "README.md", "PLAN.md", "test/*"],
			doneCriteria: ["Scoped code/docs changes are complete.", "Relevant checks pass if code changed.", "Callback summary lists changed files and verification."],
		},
		{
			id: "integrator",
			role: "Integrator",
			objective: "Integrate current milestone outputs, review correctness/safety/tests, resolve small glue issues, and report whether the milestone is ready for dogfooding or PM review.",
			files: ["extensions/gaud/index.ts", "README.md", "PLAN.md", "scripts/*", "test/*"],
			doneCriteria: ["Review findings are concrete and severity-ranked.", "Critical issues are fixed or reported as blockers.", "Milestone readiness and verification evidence are summarized."],
		},
	];
	const assignments: Array<{ role: GaudRole; agent: string }> = [];
	if (roleAgents["gaud-eng"]) assignments.push({ role: "TPM", agent: roleAgents["gaud-eng"] });
	if (roleAgents["gaud-eng"]) assignments.push({ role: "Investigator", agent: roleAgents["gaud-eng"] });
	if (roleAgents["gaud-design"]) assignments.push({ role: "UX/UI", agent: roleAgents["gaud-design"] });
	for (const agent of roleAgents["gaud-implementer"] ?? []) assignments.push({ role: "Implementer", agent });
	if (roleAgents["gaud-code-review"]) assignments.push({ role: "Integrator", agent: roleAgents["gaud-code-review"] });

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

export function createAutogeneratedPlan(idea: string, cwd: string): { markdown: string; focus: string } {
	const trimmedIdea = idea.trim();
	const repoName = path.basename(cwd);
	const milestoneName = "M1 — Plan, implement, verify";
	const focus = `${milestoneName}: ${trimmedIdea}`;
	const today = new Date().toISOString().slice(0, 10);
	const markdown = `# Gaud Execution Plan

## PRD

- Problem: ${trimmedIdea}
- Target user: inferred from the repo and request; clarify only if implementation choices depend on a specific persona.
- Desired outcome: the requested change works end-to-end and is easy for the user to verify.
- Non-goals: avoid unrelated refactors, remote artifacts, and scope expansion not needed for this milestone.
- Constraints: preserve existing project conventions in ${repoName}; keep changes small and reviewable.
- Risks: hidden product assumptions, missing tests, and ambiguous acceptance details should be surfaced as worker blockers only when they materially change the implementation.

## Program DONE Criteria

- [ ] Requested behavior is implemented or documented as intentionally out of scope.
- [ ] Current milestone DONE criteria pass.
- [ ] Relevant tests/checks are run, or skipped with a concrete reason.
- [ ] Any remaining ambiguity is recorded with a recommended default.

## Role Map

- Orchestrator: Pi agent
- gaud-design: selected at launch
- gaud-eng: selected at launch
- gaud-implementer: selected at launch
- gaud-code-review: selected at launch

## Milestone 1: ${milestoneName}

- Status: ready
- Goal: turn the user's request into the smallest coherent implementation slice, including local verification.
- Depends on: none known
- User-testable: yes

### Milestone DONE Criteria

- [ ] Repo conventions and relevant files are inspected before edits.
- [ ] Implementation changes are scoped to the request.
- [ ] Documentation/help text is updated if behavior or usage changes.
- [ ] \`pnpm check\` or the nearest project-specific check passes if code changed.
- [ ] Final callback summarizes changed files, verification, and any follow-up questions.

### Tickets

## Ticket 1: Discovery and plan tightening
- Owner: gaud-eng
- Deliverable: identify impacted files, edge cases, verification command, and any ambiguity that truly blocks execution.
- Verification: concise architecture/ticket note in callback.
- Check-back trigger: only ask the user if multiple reasonable defaults would lead to incompatible implementations.

## Ticket 2: Product/design acceptance pass
- Owner: gaud-design
- Deliverable: refine acceptance criteria, copy/user-facing behavior, and milestone risks without broadening scope by default.
- Verification: concise acceptance/risk note in callback.
- Check-back trigger: only ask the user for a product decision if the default would be surprising or destructive.

## Ticket 3: Implementation
- Owner: gaud-implementer
- Deliverable: implement the smallest useful slice for the request.
- Verification: run the relevant checks and report results.
- Check-back trigger: ask only for missing credentials/permissions or genuinely blocking product ambiguity.

## Ticket 4: Review
- Owner: gaud-code-review
- Deliverable: review changes for correctness, safety, tests, and missed acceptance criteria.
- Verification: severity-ranked findings or explicit pass.
- Check-back trigger: only block on critical issues that cannot be safely default-fixed.

## Dogfooding Gate

- Scenario to exercise: run the command/flow affected by the request, or use the nearest automated check for internal-only changes.
- Must-pass outcomes: match milestone DONE criteria.

## PM Decisions

- Date: ${today}
- Decision: Initial Gaud plan was auto-generated from the user's request.
- Why: Gaud should default obvious planning details itself and ask the user only for material clarification.
- Next action: Review/edit the generated plan if desired, then launch workers.
`;
	return { markdown, focus };
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

function firstInstalled(installed: string[], preferred: string[]): string | undefined {
	return preferred.find((agent) => installed.includes(agent)) ?? installed[0];
}

async function defaultRoleAgentsForRun(ctx: ExtensionContext, parsedAgents: string[]): Promise<GaudConfig | undefined> {
	const installed = await detectInstalledAgents();
	if (installed.length === 0) {
		ctx.ui.notify("No supported agent CLIs found. Install claude, opencode, codex, gemini, or antigravity/agy, then run /gaud-doctor.", "error");
		return undefined;
	}
	const saved = await loadGaudConfig(ctx.cwd);
	const savedRoles = saved?.roles ?? {};
	const parsedInstalled = parsedAgents.filter((agent) => installed.includes(agent));
	const savedImplementers = savedRoles["gaud-implementer"]?.filter((agent) => installed.includes(agent));
	const fallbackImplementer = firstInstalled(installed, [...DEFAULT_AGENTS]);
	const implementers = parsedInstalled.length > 0
		? parsedInstalled
		: savedImplementers?.length
			? savedImplementers
			: fallbackImplementer
				? [fallbackImplementer]
				: [];
	const design = savedRoles["gaud-design"] && installed.includes(savedRoles["gaud-design"])
		? savedRoles["gaud-design"]
		: firstInstalled(installed, ["claude", "opencode", "codex", "gemini", "antigravity"]);
	const eng = savedRoles["gaud-eng"] && installed.includes(savedRoles["gaud-eng"])
		? savedRoles["gaud-eng"]
		: firstInstalled(installed, ["codex", "claude", "opencode", "gemini", "antigravity"]);
	const review = savedRoles["gaud-code-review"] && installed.includes(savedRoles["gaud-code-review"])
		? savedRoles["gaud-code-review"]
		: firstInstalled(installed, ["codex", "claude", "opencode", "gemini", "antigravity"]);
	if (!design || !eng || !review || implementers.length === 0) return undefined;
	const config: GaudConfig = {
		orchestrator: { type: "pi", agent: "pi" },
		roles: {
			"gaud-design": design,
			"gaud-eng": eng,
			"gaud-implementer": implementers,
			"gaud-code-review": review,
		},
		promptSources: saved?.promptSources,
	};
	const needsPersistedRoles = !savedRoles["gaud-design"] || !savedRoles["gaud-eng"] || !savedRoles["gaud-implementer"]?.length || !savedRoles["gaud-code-review"];
	if (needsPersistedRoles) await saveLocalGaudConfig(ctx.cwd, config);
	ctx.ui.notify(`Gaud selected agents: design=${design}, eng=${eng}, implementer=${implementers.join(",")}, review=${review}. ${needsPersistedRoles ? "Saved defaults." : "Run /gaud setup to change defaults."}`, "info");
	return config;
}

async function runPlanningWizard(pi: ExtensionAPI, ctx: ExtensionContext, args: string) {
	if (planningInFlight) return;
	planningInFlight = true;
	try {
		const parsed = parseArgs(args);
		const { taskArgPath, seededFocus, sourcePath, absoluteSourcePath, missingExplicitPath } = await resolvePlanningSource(ctx.cwd, parsed.task);
	let planText = "";
	let focus: string | undefined = seededFocus;
	let sourceLabel = sourcePath;

	if (missingExplicitPath) {
		focus = parsed.task;
		sourceLabel = "user request";
	}

	if (existsSync(absoluteSourcePath)) {
		if (seededFocus) {
			planText = await readFile(absoluteSourcePath, "utf8");
			ctx.ui.notify(`Using existing ${sourcePath} as context and auto-generating the current milestone from your request.`, "info");
		} else {
			planText = await readFile(absoluteSourcePath, "utf8");
			focus = inferPlanFocus(planText, sourcePath);
			ctx.ui.notify(`Using existing ${sourcePath} as the Gaud planning source.`, "info");
		}
	}
	if (!planText) {
		const generated = createAutogeneratedPlan(focus || "Implement the next coherent improvement in this repo", ctx.cwd);
		planText = generated.markdown;
		focus = generated.focus;
		sourceLabel = seededFocus ? "user request" : "one-line request";
	}

	if (!focus) return;
	const approvedFocus = focus;
	let existingConfig = await loadGaudConfig(ctx.cwd);
	if (!existingConfig?.promptSources) {
		existingConfig = { orchestrator: { type: "pi", agent: "pi" }, roles: {}, promptSources: { planning: { type: "builtin" }, design: { type: "builtin" }, eng: { type: "builtin" }, implementer: { type: "builtin" }, codeReview: { type: "builtin" } } };
	}
	const roleConfig = await defaultRoleAgentsForRun(ctx, parsed.agents);
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
	} finally {
		planningInFlight = false;
	}
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

	private moveDashboard(dx: number, dy: number) {
		dashboardOffset = { x: dashboardOffset.x + dx, y: dashboardOffset.y + dy };
	}

	private resetDashboardPosition() {
		dashboardOffset = { x: 0, y: 0 };
	}

	private notifyAttach(worker?: WorkerState) {
		if (!activeRun) return;
		this.ctx.ui.notify(worker ? tmuxWorkerViewCommand(activeRun, worker) : tmuxAttachCommand(activeRun), "info");
	}

		handleInput(data: string): void {
		const workers = this.workers();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) return this.close();
		if (matchesKey(data, "shift+left") || matchesKey(data, "alt+left") || data === "H") this.moveDashboard(-4, 0);
		else if (matchesKey(data, "shift+right") || matchesKey(data, "alt+right") || data === "L") this.moveDashboard(4, 0);
		else if (matchesKey(data, "shift+up") || matchesKey(data, "alt+up") || data === "K") this.moveDashboard(0, -2);
		else if (matchesKey(data, "shift+down") || matchesKey(data, "alt+down") || data === "J") this.moveDashboard(0, 2);
		else if (data === "0") this.resetDashboardPosition();
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selected = Math.min(workers.length - 1, this.selected + 1);
		else if (matchesKey(data, "up") || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "g")) this.selected = 0;
		else if (data === "G") this.selected = Math.max(0, workers.length - 1);
		else if (matchesKey(data, "p") || matchesKey(data, "space")) this.showPane = !this.showPane;
		else if (matchesKey(data, "r")) void pollOnce(this.pi, this.ctx).then(() => this.tui.requestRender());
		else if (matchesKey(data, "x")) {
			const worker = this.selectedWorker();
			if (worker) void cancelWorker(this.pi, this.ctx, worker.id).then(() => this.tui.requestRender());
		}
		else if (matchesKey(data, "s")) {
			const worker = this.selectedWorker();
			if (worker) void restartWorker(this.pi, this.ctx, worker.id).then(() => this.tui.requestRender());
		}
		else if (matchesKey(data, "a")) this.notifyAttach();
		else if (matchesKey(data, "return") || matchesKey(data, "v")) {
			const worker = this.selectedWorker();
			const cmd = activeRun ? (worker ? tmuxWorkerViewCommand(activeRun, worker) : tmuxAttachCommand(activeRun)) : undefined;
			const ctx = this.ctx;
			this.close();
			if (cmd) ctx.ui.notify(cmd, "info");
		}
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
		lines.push(line("keys: ↑↓/j/k select · H/J/K/L move · 0 reset · Enter/v tmux · p output · s relaunch · x cancel · q/Esc close → back to input"));
		lines.push(line());
		if (activeRun) {
			const workers = this.workers();
			const counts = workers.reduce<Record<string, number>>((acc, worker) => {
				acc[worker.status] = (acc[worker.status] ?? 0) + 1;
				return acc;
			}, {});
			lines.push(line(`run: ${activeRun.status} · ${Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" ")} · poll: ${pollHealthText()}`));
			if (activeRun.planPath) lines.push(line(`plan: ${activeRun.planPath}`));
			if (activeRun.milestones?.length) {
				const milestoneText = activeRun.milestones.map((milestone) => {
					const icon = milestone.status === "done" ? "✓" : milestone.status === "in-progress" ? "●" : "○";
					const text = `${icon} ${milestone.id} ${milestone.name}`;
					return milestone.status === "in-progress" ? th.fg("accent", text) : milestone.status === "done" ? th.fg("success", text) : th.fg("muted", text);
				}).join("  ");
				lines.push(line(`milestones: ${milestoneText}`));
			}
			const currentAgents = workers.filter((worker) => worker.status !== "done").map((worker) => `${worker.role}:${worker.id}`).join(", ");
			lines.push(line(`current milestone agents: ${currentAgents || "none active"}`));
			const needsAttention = workers.filter((w) => w.status === "stuck" || w.status === "waiting-user" || w.status === "waiting-permission" || w.status === "dead");
			if (needsAttention.length > 0) {
				lines.push(line(th.fg("error", `⚠ action needed: ${needsAttention.map((w) => `${w.id}/${w.role}:${w.status}`).join(", ")}`)));
			}
			lines.push(line());
			lines.push(line(th.fg("muted", "   status                role          worker              agent       last activity  summary")));
			for (let index = 0; index < workers.length; index++) {
				const worker = workers[index]!;
				const marker = index === this.selected ? th.fg("accent", "▸") : " ";
				const symbol = workerStatusSymbol(worker.status);
				const status = th.fg(workerStatusColor(worker.status), `${symbol} ${worker.status}`.padEnd(21));
				const activity = formatAge(workerLastActivity(worker)).padEnd(13);
				const summary = worker.summary ? ` ${worker.summary}` : "";
				lines.push(line(`${marker}${status} ${(worker.role || "").padEnd(13)} ${worker.id.padEnd(19)} ${worker.agent.padEnd(10)} ${activity}${summary}`));
			}
			const worker = this.selectedWorker();
			if (worker) {
				lines.push(line());
				lines.push(line(th.fg("accent", `Selected: ${worker.id}`) + `  role=${worker.role} agent=${worker.agent} restarts=${worker.restartCount ?? 0}`));
				if (worker.objective) lines.push(line(`task: ${worker.objective.replace(/\s+/g, " ").slice(0, innerW - 8)}`));
				lines.push(line(th.fg(workerStatusColor(worker.status), `${workerStatusSymbol(worker.status)} ${worker.status}`) + (worker.summary ? ` — ${worker.summary}` : "")));
				if (worker.status === "waiting-permission") lines.push(line(th.fg("warning", "permission: approve in tmux if safe, or press s to relaunch / x to cancel")));
				if (worker.status === "stuck" || worker.status === "dead") lines.push(line(th.fg("warning", "health: press s to relaunch this worker with the same prompt")));
				lines.push(line(`tmux: ${tmuxWorkerViewCommand(activeRun, worker)}`));
				if (this.showPane) {
					lines.push(line("latest pane output:"));
					const paneLines = (worker.lastPeek || "(no pane output captured yet)").split("\n").slice(-14);
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
		refreshUi(ctx);
		return;
	}
	dashboardOpen = true;
	ctx.ui.setWidget("gaud", undefined);
	refreshUi(ctx);
	const overlayOptions = (): OverlayOptions => ({
		anchor: "right-center",
		width: "60%",
		minWidth: 56,
		maxHeight: "75%",
		margin: 1,
		offsetX: dashboardOffset.x,
		offsetY: dashboardOffset.y,
	});
	void ctx.ui.custom<void>((tui, theme, _keybindings, done) => new GaudDashboardComponent(tui, theme, done, pi, ctx), {
		overlay: true,
		overlayOptions,
		onHandle: (handle) => {
			dashboardHandle = handle;
		},
	}).finally(() => {
		dashboardOpen = false;
		dashboardHandle = undefined;
		refreshUi(ctx);
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeRun || activeRun.status !== "running") return;
		const workers = Object.values(activeRun.workers);
		const stuck = workers.filter((w) => ["stuck", "waiting-user", "waiting-permission", "dead"].includes(w.status));
		const done = workers.filter((w) => w.status === "done").length;
		const workerSummary = workers.map((w) => `  ${workerStatusSymbol(w.status)} ${w.id} (${w.agent}/${w.role}): ${w.status}${w.summary ? ` — ${w.summary.slice(0, 80)}` : ""}`).join("\n");
		const stuckBlock = stuck.length > 0 ? `\n⚠ NEEDS ATTENTION: ${stuck.map((w) => w.id).join(", ")}. Investigate in tmux or use /gaud-peek ${stuck[0]!.id}.` : "";
		const dashboardHint = activeRun && ctx.hasUI ? `\nDashboard: Ctrl+Shift+G or Ctrl+D. Close with q or Escape.` : "";
		return {
			systemPrompt: event.systemPrompt + `\n\n[GAUD ACTIVE — ${activeRun.id}]\nStatus: ${activeRun.status} · ${done}/${workers.length} workers done · poll: ${pollHealthText()}\nTask: ${activeRun.task}\nMilestone: ${activeRun.currentMilestone ?? "M1"}\nWorkers:\n${workerSummary}${stuckBlock}${dashboardHint}\n\nCallbacks arrive as GAUDMODE messages. Use tmux commands from follow-up messages to investigate stuck workers. Do NOT run gaud-poll or gaud-mode skill commands — the extension owns all polling.`,
		};
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
			else await runPlanningWizard(pi, ctx, explicitTask);
			return { action: "handled" as const };
		}

		if (!activeRun && looksParallelizable(event.text)) {
			const useGaud = await ctx.ui.confirm(
				"Gaud — parallel agent orchestration",
				"This looks like a multi-part task. Gaud can plan it across parallel agents (design, engineering, implementation, review).\n\nLaunch Gaud planning wizard?",
			);
			if (useGaud) {
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

	pi.registerShortcut("ctrl+d", {
		description: "Focus/open Gaud dashboard (alternative)",
		handler: async (ctx) => {
			if (activeRun) await pollOnce(pi, ctx);
			refreshUi(ctx);
			showGaudDashboard(pi, ctx);
		},
	});

	pi.registerTool({
		name: "gaud_start_run",
		label: "Start Gaud Run",
		description: "Launch parallel agent workers for a task. You decide how many workers, their roles, and what each should do — no hard-coded templates.",
		promptSnippet: "Default bias: use Gaud for any task with 2+ independent workstreams, multi-file changes, or milestone-level scope. You decide the worker count and roles dynamically based on the task.",
		promptGuidelines: [
			"You are the orchestrator. Decide: how many workers does this task need? What role should each play? What files should each focus on? What constitutes done for each?",
			"Small task (single file, simple fix) → call gaud_start_run with 1-2 workers, or handle it yourself without Gaud.",
			"Medium task (multiple files, one concern) → 2-3 workers: e.g. investigator + implementer, or implementer + reviewer.",
			"Large task (multiple modules, design + implementation + review) → 3-5 workers: e.g. planner + implementer(s) + reviewer.",
			"Extra large (full feature, architecture changes) → 4-7 workers with specialized roles you define.",
			"Each worker spec needs: agent (CLI name like claude/codex/gemini/opencode), role (brief label), objective (what to do), files (primary files/areas), doneCriteria (how to know it's done).",
			"Call gaud_start_run with an empty task to discover existing plan files. Call it with a task description and worker specs to launch directly.",
			"IMPORTANT: Do NOT invoke the gaud-mode skill. The Pi extension is the complete gaud implementation. The gaud-mode skill conflicts with the extension.",
			"After a run starts you will receive GAUDMODE follow-up messages automatically. Workers report their status — stuck workers include tmux commands to investigate.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The user's task to parallelize, an explicit plan path, or empty to discover existing plans." }),
			reason: Type.String({ description: "Why this task benefits from Gaud parallelization." }),
			workers: Type.Optional(Type.Array(Type.Object({
				agent: Type.String({ description: "Agent CLI to use: claude, codex, gemini, opencode, antigravity, etc." }),
				role: Type.String({ description: "Worker role label: e.g. Implementer, Reviewer, Investigator, Designer, Architect, Tester." }),
				objective: Type.String({ description: "What this worker should accomplish. Be specific." }),
				files: Type.Array(Type.String(), { description: "Primary files or file patterns this worker should focus on." }),
				doneCriteria: Type.Array(Type.String(), { description: "How to know this worker is done. Concrete, verifiable." }),
			}), { description: "Worker assignments you determine. Omit to use the planning wizard." })),
			agents: Type.Optional(Type.Array(Type.String(), { description: "Agent CLI names (shorthand for simple cases)." })),
			fake: Type.Optional(Type.Boolean({ description: "Launch fake bash workers for smoke testing." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.workers?.length) {
				const workerPlans: WorkerPlan[] = params.workers.map((w, i) => ({
					id: `${slugify(w.role)}-${i + 1}`,
					agent: w.agent,
					role: w.role as GaudRole,
					objective: w.objective,
					files: w.files,
					doneCriteria: w.doneCriteria,
				}));
				const allAgents = [...new Set(workerPlans.map((p) => p.agent))];
				const basePlan = `# Gaud Execution Plan\n\n## Task\n${params.task}\n\n## Worker Assignments\n\n${workerPlans.map((p) => `### ${p.id} — ${p.role} (${p.agent})\n\n**Objective:** ${p.objective}\n\n**Files:** ${p.files.join(", ")}\n\n**Done criteria:**\n${p.doneCriteria.map((c) => `- ${c}`).join("\n")}`).join("\n\n")}`;
				const planDir = path.join(ctx.cwd, ".gaud", "plans");
				await mkdir(planDir, { recursive: true });
				const planPath = path.join(planDir, `${makeRunId()}-plan.md`);
				await writeFile(planPath, basePlan, "utf8");
				await launchRun(pi, ctx, `${params.task}\n\nExecution plan: ${planPath}`, allAgents, params.fake ?? false, params.reason, workerPlans);
				return { content: [{ type: "text", text: statusText() }], details: { run: activeRun, reason: params.reason, workers: workerPlans.length } };
			}
			const agentArg = params.agents?.length ? ` --agents ${params.agents.join(",")}` : "";
			const fakeArg = params.fake ? " --fake" : "";
			await runPlanningWizard(pi, ctx, `${agentArg}${fakeArg} ${params.task}`.trim());
			return { content: [{ type: "text", text: activeRun ? statusText() : "Gaud plan flow completed without launching workers." }], details: { run: activeRun, reason: params.reason } };
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
			await runPlanningWizard(pi, ctx, parsed.task === "plan" ? "PLAN.md" : args.trim());
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

	pi.registerCommand("gaud-cancel", {
		description: "Send Ctrl+C to a specific Gaud worker pane. Usage: /gaud-cancel <worker-id>",
		handler: async (args, ctx) => {
			const workerId = args.trim();
			if (!workerId) {
				ctx.ui.notify("Usage: /gaud-cancel <worker-id>", "error");
				return;
			}
			await cancelWorker(pi, ctx, workerId);
		},
	});

	pi.registerCommand("gaud-restart", {
		description: "Restart a specific Gaud worker pane and re-bind logging/state. Usage: /gaud-restart <worker-id>",
		handler: async (args, ctx) => {
			const workerId = args.trim();
			if (!workerId) {
				ctx.ui.notify("Usage: /gaud-restart <worker-id>", "error");
				return;
			}
			await restartWorker(pi, ctx, workerId);
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
