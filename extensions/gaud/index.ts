import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, Editor, Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
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
	exitRecordedAt?: number;
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

type AskUserOption = { label: string; description?: string };

type GaudTraceEntry = {
	ts: number;
	phase: string;
	summary: string;
	details: string[];
};

export type GaudRoutingDecision = {
	shouldPrompt: boolean;
	score: number;
	threshold: number;
	signals: string[];
	blockers: string[];
	explanation: string;
};

const GAUD_ROUTING_THRESHOLD = 4;
const MAX_GAUD_TRACE_ENTRIES = 50;
const gaudTraceEntries: GaudTraceEntry[] = [];

function summarizeForTrace(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, 180) || "(empty)";
}

function recordGaudTrace(phase: string, summary: string, details: string[] = []) {
	const entry = { ts: Date.now(), phase, summary, details };
	gaudTraceEntries.push(entry);
	while (gaudTraceEntries.length > MAX_GAUD_TRACE_ENTRIES) gaudTraceEntries.shift();

	if (pollerLogPath) {
		try {
			appendFileSync(pollerLogPath, JSON.stringify(entry) + "\n");
		} catch (e) {
			// Fail silently for logging errors
		}
	}
}

function formatGaudTrace(limit = 20): string {
	const entries = gaudTraceEntries.slice(-Math.max(1, limit));
	if (entries.length === 0) return "No Gaud trace entries yet.";
	return entries.map((entry) => {
		const time = new Date(entry.ts).toLocaleTimeString();
		const details = entry.details.length ? `\n${entry.details.map((detail) => `  - ${detail}`).join("\n")}` : "";
		return `${time} [${entry.phase}] ${entry.summary}${details}`;
	}).join("\n\n");
}

function routingTraceDetails(text: string, decision: GaudRoutingDecision): string[] {
	return [
		`input: ${summarizeForTrace(text)}`,
		`score: ${decision.score}/${decision.threshold}`,
		`signals: ${decision.signals.length ? decision.signals.join(", ") : "none"}`,
		`blockers: ${decision.blockers.length ? decision.blockers.join(", ") : "none"}`,
		`decision: ${decision.explanation}`,
	];
}

export function renderAskUserDialogLines(params: {
	question: string;
	options: AskUserOption[];
	optionIndex: number;
	editMode: boolean;
	editorLines?: string[];
	width: number;
	theme: Pick<Theme, "fg">;
}): string[] {
	const width = Math.max(1, params.width);
	const lines: string[] = [];

	if (width < 4) {
		lines.push(params.theme.fg("accent", params.question));
		for (let i = 0; i < params.options.length; i++) {
			const opt = params.options[i];
			const marker = i === params.optionIndex ? "▸" : " ";
			lines.push(`${marker} ${opt.label}`);
			if (opt.description) lines.push(`  ${opt.description}`);
		}
		if (params.editMode && params.editorLines) lines.push(...params.editorLines);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	const innerW = width - 2;
	const border = (s: string) => params.theme.fg("border", s);
	const pad = (s: string) => truncateToWidth(s, innerW, "…", true);
	const boxed = (s = "") => border("│") + pad(s) + border("│");

	lines.push(border(`╭${"─".repeat(innerW)}╮`));
	lines.push(boxed(params.theme.fg("accent", ` ${params.question}`)));
	lines.push(boxed());

	for (let i = 0; i < params.options.length; i++) {
		const opt = params.options[i];
		const isLast = i === params.options.length - 1;
		const selected = i === params.optionIndex;
		const marker = selected ? params.theme.fg("accent", "▸") : " ";
		const label = isLast ? params.theme.fg("dim", opt.label) : selected ? params.theme.fg("accent", opt.label) : opt.label;
		const desc = isLast
			? params.theme.fg("dim", opt.description ?? "")
			: selected
				? params.theme.fg("accent", opt.description ?? "")
				: params.theme.fg("muted", opt.description ?? "");
		lines.push(boxed(`${marker} ${label}`));
		if (opt.description) lines.push(boxed(`   ${desc}`));
	}

	lines.push(boxed());
	if (params.editMode) {
		lines.push(boxed(params.theme.fg("muted", " Your answer:")));
		for (const line of params.editorLines ?? []) {
			lines.push(boxed(` ${line}`));
		}
		lines.push(boxed(params.theme.fg("dim", " Enter to submit · Esc to go back")));
	} else {
		lines.push(boxed(params.theme.fg("dim", " ↑↓/j k navigate · Enter to select · Esc to cancel")));
	}
	lines.push(border(`╰${"─".repeat(innerW)}╯`));

	return lines.map((line) => truncateToWidth(line, width, "", true));
}

type ExecResult = { stdout: string; stderr: string; code: number };

let activeRun: GaudRunState | undefined;
let pollerLogPath: string | undefined;
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

function parseArgs(args: string): { task: string; agents: string[]; agentsExplicit: boolean; fake: boolean } {
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
	return { task: taskTokens.join(" ").trim(), agents: agents?.length ? agents : [...DEFAULT_AGENTS], agentsExplicit: Boolean(agents?.length), fake };
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

export function buildGaudDelegationPrompt(task: string): string {
	const requested = task.trim() || "Use the current repo plan or ask for the intended Gaud task.";
	return `Gaud requested: ${requested}

You are the foreground Gaud orchestrator. Do not let the extension invent template workers.

Plan first, derive the worker assignment yourself, then ask the Pi extension to approve and launch only the parallel work the plan justifies:
1. Read the relevant local plan if a path was provided, otherwise inspect/create a local markdown execution plan with PRD, Program DONE Criteria, exactly one current milestone, Milestone DONE Criteria, and current-milestone tickets.
2. Decide which current-milestone tickets/workstreams are independently parallelizable now. Combine sequential/dependent work into one worker; omit roles that do not have concrete current work.
3. Choose as many workers as the plan requires and no arbitrary extras. Worker count comes from the plan, not from configured agents or fixed TPM/UX/review templates.
4. Use the available role catalog as guidance, not as a launch checklist: TPM/planning, Investigator/research, UX/UI/design, Implementer/build, Integrator/review/test. Dispatch one only when the current milestone has concrete work for that role.
5. Do not ask the user to manually add workers. You compute every worker assignment yourself and pass it to gaud_start_run.
6. Call gaud_start_run with explicit workers (agent, role, objective, files, doneCriteria). The Pi extension will show the computed assignment to the user and require approval before real workers start. Do not call gaud_start_run without workers for a real run.
7. Use ask_user only when a missing product/technical decision changes the worker plan; do not use it for routine launch confirmation.
8. If the plan is too vague to derive parallel workstreams, tighten the plan yourself before asking the user.`;
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
	const wrap = (invocation: string) => `bash -lc ${shellQuote(`B2V_DISABLED=true ${invocation}; ${autoCallback}`)}`;

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
	if (!activeRun || isTerminalRunStatus(activeRun.status)) return [];
	const spinner = pollInFlight ? "⟳" : "○";
	const lines = [`${spinner} GAUD ${activeRun.id} · ${activeRun.status} · ${pollHealthText()}`];
	lines.push(`task: ${activeRun.task}`);
	if (activeRun.milestones?.length) {
		const progress = activeRun.milestones.map((ms) => {
			const icon = ms.status === "done" ? "✓" : ms.status === "in-progress" ? "●" : "○";
			return `${icon} ${ms.id}`;
		}).join(" ");
		lines.push(`milestones: ${progress}`);
	}
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

export function gaudWidgetForUi(status: string | undefined, isDashboardOpen: boolean, widgetLines: string[]): string[] | undefined {
	if (isDashboardOpen || !status || isTerminalRunStatus(status)) return undefined;
	return widgetLines;
}

function clearTerminalActiveRun(): boolean {
	if (!activeRun || !isTerminalRunStatus(activeRun.status)) return false;
	activeRun = undefined;
	pollerLogPath = undefined;
	return true;
}

function refreshUi(ctx?: UiContext) {
	if (!ctx || !extensionActive) return;
	try {
		const isTerminal = activeRun && isTerminalRunStatus(activeRun.status);
		const milestoneSuffix = activeRun?.milestones?.length
			? ` · ${activeRun.milestones.filter((ms) => ms.status === "done").length}/${activeRun.milestones.length} ms`
			: "";
		const status = activeRun
			? (isTerminal ? undefined : `gaud: ${activeRun.status}${milestoneSuffix} · ${pollInFlight ? "polling" : `next ${formatEta(nextPollAt)}`} · Ctrl+Shift+G dashboard`)
			: "gaud: idle · Ctrl+Shift+G dashboard";
		ctx.ui.setStatus("gaud", status);
		ctx.ui.setWidget("gaud", gaudWidgetForUi(activeRun?.status, dashboardOpen, activeRun ? renderWidget() : []));
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

const ACTIVE_RUN_STATUSES: RunStatus[] = ["starting", "running", "waiting-user"];

function isActiveRunStatus(status: RunStatus | string | undefined): boolean {
	return ACTIVE_RUN_STATUSES.includes(status as RunStatus);
}

function isTerminalRunStatus(status: RunStatus | string | undefined): boolean {
	return ["stopped", "done", "failed", "detached"].includes(String(status));
}

function ensurePollerLogPath(run: GaudRunState): string {
	pollerLogPath = path.join(run.runDir, "poller.log");
	return pollerLogPath;
}

function workerStatusCountsForLog(run: GaudRunState): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const worker of Object.values(run.workers)) {
		counts[worker.status] = (counts[worker.status] ?? 0) + 1;
	}
	return counts;
}

function appendPollerLog(run: GaudRunState, event: string, details: Record<string, unknown> = {}) {
	try {
		appendFileSync(ensurePollerLogPath(run), `${JSON.stringify({
			ts: new Date().toISOString(),
			event,
			runId: run.id,
			status: run.status,
			...details,
		})}\n`);
	} catch {
		// Poller diagnostics must never break orchestration.
	}
}

function workerDirFor(run: GaudRunState, worker: WorkerState): string {
	return path.dirname(worker.logPath) || path.join(run.runDir, "workers", worker.id);
}

async function writeWorkerStatusFile(run: GaudRunState, worker: WorkerState) {
	try {
		await writeJson(path.join(workerDirFor(run, worker), "status.json"), {
			ts: new Date().toISOString(),
			runId: run.id,
			workerId: worker.id,
			agent: worker.agent,
			role: worker.role,
			status: worker.status,
			paneId: worker.paneId,
			paneIndex: worker.paneIndex,
			pid: worker.pid,
			lastEventAt: worker.lastEventAt,
			lastOutputAt: worker.lastOutputAt,
			summary: worker.summary,
			restartCount: worker.restartCount ?? 0,
		});
	} catch {
		// Worker status snapshots are diagnostic only.
	}
}

async function writeWorkerExitFile(run: GaudRunState, worker: WorkerState, details: Record<string, unknown>) {
	if (worker.exitRecordedAt) return;
	worker.exitRecordedAt = Date.now();
	try {
		await writeJson(path.join(workerDirFor(run, worker), "exit.json"), {
			ts: new Date(worker.exitRecordedAt).toISOString(),
			runId: run.id,
			workerId: worker.id,
			agent: worker.agent,
			role: worker.role,
			paneId: worker.paneId,
			status: worker.status,
			...details,
		});
	} catch {
		// Worker exit snapshots are diagnostic only.
	}
}

async function writeAllWorkerStatusFiles(run: GaudRunState) {
	await Promise.all(Object.values(run.workers).map((worker) => writeWorkerStatusFile(run, worker)));
}

async function reattachPaneLogs(run: GaudRunState) {
	for (const worker of Object.values(run.workers)) {
		if (!worker.paneId || ["done", "failed", "dead"].includes(worker.status)) continue;
		const result = await tmux(run, ["pipe-pane", "-o", "-t", worker.paneId, `cat >> ${shellQuote(worker.logPath)}`]);
		appendPollerLog(run, result.code === 0 ? "pane_log_reattached" : "pane_log_reattach_failed", {
			workerId: worker.id,
			paneId: worker.paneId,
			logPath: worker.logPath,
			error: result.code === 0 ? undefined : result.stderr.trim() || "tmux pipe-pane failed",
		});
	}
}

export async function findLatestActiveRun(cwd: string): Promise<GaudRunState | undefined> {
	const runsDir = path.join(cwd, ".gaud", "runs");
	try {
		const states: GaudRunState[] = [];
		for (const runId of await readdir(runsDir)) {
			const state = await readRunState(path.join(runsDir, runId, "state.json"));
			if (state && isActiveRunStatus(state.status)) states.push(state);
		}
		states.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		return states[0];
	} catch {
		// .gaud/runs doesn't exist yet
	}
	return undefined;
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
	recordGaudTrace("launch", "launch requested", [`task: ${summarizeForTrace(task)}`, `agents: ${agents.join(",")}`, `fake: ${fake}`, `workerPlans: ${workerPlans?.length ?? 0}`]);
	if (!fake && !workerPlans?.length) {
		recordGaudTrace("launch", "launch blocked", ["reason: real run requires worker plans"]);
		ctx.ui.notify("Real Gaud runs require an approved execution plan before launching workers. Run /gaud-plan PLAN.md first. Use --fake only for smoke tests.", "error");
		return;
	}

	if (!(await commandExists("tmux"))) {
		recordGaudTrace("launch", "launch blocked", ["reason: tmux missing"]);
		ctx.ui.notify("Gaud requires tmux on PATH. Install tmux, then rerun /gaud doctor.", "error");
		return;
	}

	const requestedAgents = workerPlans?.length ? workerPlans.map((plan) => plan.agent) : agents;
	const agentCheck = fake ? { ok: requestedAgents.map((agent) => ({ agent, command: agent })), missing: [] } : await checkAgentCommands(requestedAgents);
	const resolvedAgents = agentCheck.ok;
	const missingAgents = agentCheck.missing;
	recordGaudTrace("launch", "agent commands checked", [`resolved: ${resolvedAgents.map((agent) => `${agent.agent}=${agent.command}`).join(",") || "none"}`, `missing: ${missingAgents.join(",") || "none"}`]);
	if (missingAgents.length > 0) {
		recordGaudTrace("launch", "launch blocked", [`reason: missing agents ${missingAgents.join(",")}`]);
		ctx.ui.notify(`Missing agent CLI(s): ${missingAgents.join(", ")}\n\n${(await doctorLines(agents)).join("\n")}`, "error");
		return;
	}

	const id = makeRunId();
	const repoRoot = ctx.cwd;
	const runDir = path.join(repoRoot, ".gaud", "runs", id);
	pollerLogPath = path.join(runDir, "poller.log");
	const eventsPath = path.join(runDir, "events.jsonl");
	const statePath = path.join(runDir, "state.json");
	const tmuxSocket = id;
	const tmuxSession = id;
	await mkdir(runDir, { recursive: true });
	await mkdir(path.join(runDir, "prompts"), { recursive: true });
	await writeFile(eventsPath, "", "utf8");
	await writeFile(pollerLogPath, "", "utf8");
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
	recordGaudTrace("launch", "run state created", [`id: ${id}`, `runDir: ${runDir}`, `plan: ${planOverview.planPath ?? "(none)"}`, `milestone: ${planOverview.currentMilestone}`]);

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
		const paneResult = await tmux(run, ["split-window", "-d", "-t", tmuxSession, "-P", "-F", "#{pane_id}", "bash"]);
		const paneId = paneResult.stdout.trim();
		await tmux(run, ["select-layout", "-t", tmuxSession, "tiled"]);
		if (paneId) {
			const pipeResult = await tmux(run, ["pipe-pane", "-o", "-t", paneId, `cat >> ${shellQuote(logPath)}`]);
			if (pipeResult.code !== 0) recordGaudTrace("launch", "worker pane logging failed", [`worker: ${workerId}`, `error: ${pipeResult.stderr.trim() || "tmux pipe-pane failed"}`]);
			const sendResult = await tmux(run, ["send-keys", "-t", paneId, `${envPrefix} exec ${command}`, "Enter"]);
			if (sendResult.code !== 0) recordGaudTrace("launch", "worker command send failed", [`worker: ${workerId}`, `error: ${sendResult.stderr.trim() || "tmux send-keys failed"}`]);
		}
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
		recordGaudTrace("launch", "worker pane created", [`worker: ${workerId}`, `role: ${workerRole}`, `agent: ${agent}`, `pane: ${paneId || "(none)"}`, `prompt: ${promptPath}`]);
	}

	await tmux(run, ["kill-pane", "-t", firstPaneId]);
	run.status = "running";
	run.updatedAt = Date.now();
	await persistRun(pi);
	refreshUi(ctx);
	startPolling(pi, ctx);
	recordGaudTrace("launch", "run started", [`id: ${id}`, `workers: ${Object.keys(run.workers).join(",")}`, `tmux: ${tmuxAttachCommand(run)}`]);
	const launchWorkers = Object.values(run.workers).map((worker) => `${worker.role}/${worker.agent}`).join(", ");
	ctx.ui.notify(`Started Gaud run ${id} with ${Object.keys(run.workers).length} worker${Object.keys(run.workers).length === 1 ? "" : "s"}: ${launchWorkers}. Opening dashboard.`, "info");
	try {
		pi.sendUserMessage(
			`Gaud run ${id} started. Workers (${Object.keys(run.workers).length}): ${launchWorkers}. Tmux socket: ${tmuxSocket}.\n\nIMPORTANT: The Pi extension owns all polling and GAUDMODE callback forwarding for this run. Do NOT invoke gaud-poll, gaud-tmux-layout, or any other gaud-mode skill infrastructure commands — they conflict with the extension's built-in poller. Worker callbacks will arrive automatically as GAUDMODE follow-up messages. Wait for them before taking action.`,
			{ deliverAs: "followUp" },
		);
	} catch { /* stale ctx at launch */ }
	if (ctx.hasUI) showGaudDashboard(pi, ctx);
}

async function persistRun(pi?: ExtensionAPI) {
	if (!activeRun) return;
	activeRun.updatedAt = Date.now();
	await writeAllWorkerStatusFiles(activeRun);
	await writeJson(activeRun.statePath, activeRun);
	pi?.appendEntry("gaud-state", { id: activeRun.id, statePath: activeRun.statePath, status: activeRun.status, updatedAt: activeRun.updatedAt });
}

async function pollTmux(run: GaudRunState) {
	const result = await tmux(run, ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}"]);
	if (result.code !== 0) {
		run.status = "detached";
		lastPollError = result.stderr.trim() || "tmux list-panes failed";
		appendPollerLog(run, "tmux_error", { error: lastPollError });
		return;
	}
	const byPane = new Map(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
		const [paneId, paneIndex, pid, dead, currentCommand] = line.split("\t");
		return [paneId, { paneIndex, pid, dead, currentCommand }] as const;
	}));
	for (const worker of Object.values(run.workers)) {
		const prevStatus = worker.status;
		const pane = worker.paneId ? byPane.get(worker.paneId) : undefined;
		if (!pane) {
			worker.status = worker.status === "done" ? "done" : "dead";
			if (worker.status === "dead") await writeWorkerExitFile(run, worker, { reason: "pane_missing", previousStatus: prevStatus });
		} else {
			worker.paneIndex = pane.paneIndex;
			worker.pid = pane.pid;
			if (pane.dead === "1" && worker.status !== "done") {
				worker.status = "dead";
				await writeWorkerExitFile(run, worker, { reason: "pane_dead", previousStatus: prevStatus, paneIndex: pane.paneIndex, pid: pane.pid, currentCommand: pane.currentCommand });
			} else if (worker.status === "starting") worker.status = "working";
		}
		if (worker.status !== prevStatus) {
			appendPollerLog(run, "worker_status_change", { workerId: worker.id, agent: worker.agent, from: prevStatus, to: worker.status });
		}
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
			if (run.milestones?.length) {
				const current = run.milestones.find((ms) => ms.status === "in-progress");
				if (current) current.status = "done";
				const next = run.milestones.find((ms) => ms.status === "planned");
				if (next) {
					next.status = "in-progress";
					run.currentMilestone = next.id;
				} else if (run.milestones.every((ms) => ms.status === "done")) {
					run.status = "done";
				}
			} else {
				run.status = "done";
			}
		}
		try {
			if (["done", "waiting-user", "waiting-permission", "failed"].includes(type)) {
				const role = String(event.role ?? worker?.role ?? "Implementer");
				const milestone = String(event.milestone ?? "M1");
				const workstream = String(event.workstream ?? workerId);
				const summary = String(event.summary ?? event.question ?? "").replace(/\s+/g, " ").trim();
				let text = `GAUDMODE ${type} role=${role} milestone=${milestone} workstream=${workstream} summary=${summary}`;
				if (type === "failed" && worker?.lastPeek) {
					const tail = worker.lastPeek.split("\n").slice(-30).join("\n");
					text += `\n\nFailed worker output (last 30 lines):\n${tail}`;
					const failLog = path.join(run.runDir, "workers", workerId, "failure.log");
					await writeFile(failLog, `${new Date().toISOString()} FAILED\nSummary: ${summary}\n\nFull output:\n${worker.lastPeek}\n`, "utf8");
				}
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
	if (!activeRun || isTerminalRunStatus(activeRun.status)) {
		if (activeRun?.status === "detached") stopPolling();
		refreshUi(ctx);
		return;
	}
	pollInFlight = true;
	lastPollStartedAt = Date.now();
	nextPollAt = lastPollStartedAt + POLL_INTERVAL_MS;
	appendPollerLog(activeRun, "poll_start", { workers: workerStatusCountsForLog(activeRun), lastEventOffset: activeRun.lastEventOffset });
	refreshUi(ctx);
	try {
		await pollTmux(activeRun);
		if (activeRun.status === "detached") {
			appendPollerLog(activeRun, "poll_detached", { reason: lastPollError ?? "tmux unavailable" });
			await persistRun(pi);
			stopPolling();
			clearTerminalActiveRun();
			refreshUi(ctx);
			return;
		}
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
		appendPollerLog(activeRun, "poll_ok", { durationMs: lastPollCompletedAt - lastPollStartedAt, workers: workerStatusCountsForLog(activeRun), lastEventOffset: activeRun.lastEventOffset });
		if (isTerminalRunStatus(activeRun.status)) {
			recordGaudTrace("lifecycle", "clearing terminal active run", [`id: ${activeRun.id}`, `status: ${activeRun.status}`]);
			clearTerminalActiveRun();
		}
		consecutivePollErrors = 0;
		lastPollError = undefined;
		refreshUi(ctx);
	} catch (error) {
		consecutivePollErrors += 1;
		lastPollError = error instanceof Error ? error.message : String(error);
		if (activeRun) appendPollerLog(activeRun, "poll_error", { durationMs: Date.now() - lastPollStartedAt, error: lastPollError, consecutivePollErrors });
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
	if (activeRun) {
		ensurePollerLogPath(activeRun);
	}
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
	pollerLogPath = undefined;
	await persistRun(pi);
	const message = statusText();
	clearTerminalActiveRun();
	refreshUi(ctx);
	ctx.ui.notify(message, "info");
}

function findWorker(workerId: string): WorkerState | undefined {
	return activeRun?.workers[workerId];
}

async function confirmWorkerAction(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm(title, message);
}

export function formatWorkerApprovalSummary(workerPlans: WorkerPlan[], planPath: string): string {
	const lines = [`Plan: ${planPath}`, `Workers: ${workerPlans.length}`];
	for (const plan of workerPlans) {
		lines.push(`- ${plan.id}: ${plan.role} via ${plan.agent}`);
		lines.push(`  Objective: ${plan.objective.replace(/\s+/g, " ").slice(0, 180)}`);
		if (plan.files.length) lines.push(`  Files: ${plan.files.join(", ").slice(0, 180)}`);
		if (plan.doneCriteria.length) lines.push(`  Done: ${plan.doneCriteria[0]?.replace(/\s+/g, " ").slice(0, 180)}`);
	}
	return lines.join("\n");
}

async function confirmWorkerLaunch(ctx: ExtensionContext, workerPlans: WorkerPlan[], planPath: string): Promise<boolean> {
	const summary = formatWorkerApprovalSummary(workerPlans, planPath);
	if (!ctx.hasUI) {
		ctx.ui.notify(`Gaud workers not launched: user approval is required before real workers start.\n\n${summary}`, "error");
		return false;
	}
	return ctx.ui.confirm("Start Gaud workers?", `${summary}\n\nStart these workers now?`);
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
	const paneResult = await tmux(activeRun, ["split-window", "-d", "-t", activeRun.tmuxSession, "-P", "-F", "#{pane_id}", "bash"]);
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
	const sendResult = await tmux(activeRun, ["send-keys", "-t", newPaneId, `${workerEnvPrefix(worker)} exec ${worker.command}`, "Enter"]);
	if (sendResult.code !== 0) {
		ctx.ui.notify(`Restarted ${worker.id}, but failed to send command: ${sendResult.stderr.trim() || "tmux send-keys failed"}`, "error");
		return false;
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

type PlanTicket = {
	title: string;
	owner?: string;
	deliverable?: string;
	verification?: string;
	files: string[];
	dependsOn?: string;
	parallel?: string;
};

function fieldValue(block: string, field: string): string | undefined {
	const match = new RegExp(`^\\s*-\\s*${field}:\\s*(.+)$`, "im").exec(block);
	return match?.[1]?.trim();
}

function splitListField(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
}

function currentMilestoneText(planText: string): string {
	const match = /^##\s+Milestone\s+\d+[^\n]*$/im.exec(planText);
	if (!match) return planText;
	const rest = planText.slice((match.index ?? 0) + match[0].length);
	const next = /^##\s+(?:Milestone\s+\d+|Future Milestones|Dogfooding Gate|PM Decisions|Notes)\b/im.exec(rest);
	return rest.slice(0, next?.index ?? rest.length);
}

function extractCurrentMilestoneTickets(planText: string): PlanTicket[] {
	const milestone = currentMilestoneText(planText);
	const ticketHeading = /^#{3,5}\s+Ticket\s+\d*:?\s*(.+)$/gim;
	const matches = [...milestone.matchAll(ticketHeading)];
	return matches.map((match, index) => {
		const blockStart = (match.index ?? 0) + match[0].length;
		const blockEnd = matches[index + 1]?.index ?? milestone.length;
		const block = milestone.slice(blockStart, blockEnd);
		const title = match[1]?.trim() || `Ticket ${index + 1}`;
		return {
			title,
			owner: fieldValue(block, "Owner"),
			deliverable: fieldValue(block, "Deliverable"),
			verification: fieldValue(block, "Verification"),
			files: splitListField(fieldValue(block, "Files") ?? fieldValue(block, "Files/areas")),
			dependsOn: fieldValue(block, "Depends on") ?? fieldValue(block, "Depends"),
			parallel: fieldValue(block, "Parallel") ?? fieldValue(block, "Parallelizable"),
		};
	});
}

function ticketIsReadyForParallelLaunch(ticket: PlanTicket): boolean {
	const parallel = ticket.parallel?.toLowerCase();
	if (parallel && /^(no|false|blocked|after|later)/.test(parallel)) return false;
	const dependsOn = ticket.dependsOn?.trim().toLowerCase();
	if (!dependsOn || /^(none|n\/a|no|-)$/i.test(dependsOn)) return true;
	return false;
}

function roleForTicket(ticket: PlanTicket): GaudRole {
	const owner = (ticket.owner || "").toLowerCase();
	const title = ticket.title.toLowerCase();
	const combined = `${owner} ${title}`;
	if (/\b(ux|ui|design|designer|visual)\b/.test(combined)) return "UX/UI";
	if (/\b(investigator|research|explore|discovery|audit|analysis|eng)\b/.test(combined)) return "Investigator";
	if (/\b(integrator|review|reviewer|qa|verify|dogfood|test)\b/.test(combined)) return "Integrator";
	if (/\b(tpm|pm|planner|planning)\b/.test(combined)) return "TPM";
	return "Implementer";
}

function agentForRole(role: GaudRole, roleAgents: GaudConfig["roles"], implementerIndex: number): string | undefined {
	if (role === "UX/UI") return roleAgents["gaud-design"] ?? roleAgents["gaud-implementer"]?.[implementerIndex % (roleAgents["gaud-implementer"]?.length || 1)];
	if (role === "Integrator") return roleAgents["gaud-code-review"] ?? roleAgents["gaud-implementer"]?.[implementerIndex % (roleAgents["gaud-implementer"]?.length || 1)];
	if (role === "TPM" || role === "Investigator") return roleAgents["gaud-eng"] ?? roleAgents["gaud-implementer"]?.[implementerIndex % (roleAgents["gaud-implementer"]?.length || 1)];
	return roleAgents["gaud-implementer"]?.[implementerIndex % (roleAgents["gaud-implementer"].length)] ?? roleAgents["gaud-eng"] ?? roleAgents["gaud-code-review"] ?? roleAgents["gaud-design"];
}

function fallbackImplementerPlan(focus: string, roleAgents: GaudConfig["roles"]): WorkerPlan[] {
	const agent = roleAgents["gaud-implementer"]?.[0] ?? roleAgents["gaud-eng"] ?? roleAgents["gaud-code-review"] ?? roleAgents["gaud-design"];
	if (!agent) return [];
	return [{
		id: "implementer-1",
		agent,
		role: "Implementer",
		objective: `Implement the smallest current-plan slice. If the plan does not define parallel tickets yet, tighten the local plan first and report the concrete blocker instead of spawning template roles.\n\nFocus requested by user: ${focus}`,
		files: ["PLAN.md", "README.md", "extensions/gaud/index.ts", "test/*"],
		doneCriteria: ["Plan-derived scoped work is complete or a concrete missing-plan blocker is reported.", "Relevant checks pass if code changed.", "Callback summary lists changed files and verification."],
	}];
}

export function buildWorkerPlans(planText: string, focus: string, roleAgents: GaudConfig["roles"]): WorkerPlan[] {
	const tickets = extractCurrentMilestoneTickets(planText).filter(ticketIsReadyForParallelLaunch);
	if (tickets.length === 0) return fallbackImplementerPlan(focus, roleAgents);

	let implementerIndex = 0;
	const plans: WorkerPlan[] = [];
	for (const ticket of tickets) {
		const role = roleForTicket(ticket);
		const agent = agentForRole(role, roleAgents, implementerIndex);
		if (!agent) continue;
		if (role === "Implementer") implementerIndex++;
		const idBase = role === "UX/UI" ? "ux-ui" : slugify(role);
		plans.push({
			id: `${idBase}-${plans.length + 1}`,
			agent,
			role,
			objective: `${ticket.deliverable || `Complete plan ticket: ${ticket.title}`}\n\nPlan ticket: ${ticket.title}\nFocus requested by user: ${focus}`,
			files: ticket.files.length ? ticket.files : ["PLAN.md", "README.md", "extensions/gaud/index.ts", "test/*"],
			doneCriteria: [
				ticket.verification ? `Verification: ${ticket.verification}` : "Ticket verification is completed or a concrete blocker is reported.",
				"Work stays inside this ticket/current milestone.",
				"Callback summary lists changed files and verification.",
			],
		});
	}
	return plans.length ? plans : fallbackImplementerPlan(focus, roleAgents);
}

function renderPlanMarkdown(task: string, sourcePath: string, workerPlans: WorkerPlan[], basePlan?: string): string {
	const roleSummary = workerPlans.map((plan) => `${plan.role}/${plan.agent}`).join(", ") || "none";
	const workerSection = `## Worker Assignments\n\nWorker count: ${workerPlans.length} (${roleSummary})\n\nWorker count must come from the plan's current-milestone parallel workstreams; configured agents are a pool, not a requirement to launch every role.\n\n${workerPlans.map((plan) => `### ${plan.id} (${plan.role} via ${plan.agent})\n\n${plan.objective}\n\nFiles/areas:\n${plan.files.map((file) => `- ${file}`).join("\n")}\n\nDone criteria:\n${plan.doneCriteria.map((item) => `- ${item}`).join("\n")}`).join("\n\n")}`;
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

## Available Role Catalog

- Orchestrator: Pi foreground agent plans the milestone, derives concrete workstreams, and calls gaud_start_run with explicit workers.
- TPM / planning: use only when there is concrete coordination, sequencing, or plan-maintenance work beyond the foreground orchestrator.
- Investigator / research: use only when a concrete research/discovery workstream can run independently before implementation.
- UX/UI / design: use only when there is concrete user-facing design, copy, or interaction work.
- Implementer / build: use for concrete code/docs/config changes.
- Integrator / review-test: use only when there is concrete integration, QA, verification, or review work that can start independently.
- Configured agents are a pool. The planner dynamically dispatches only the roles needed for this milestone.

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

The foreground orchestrator must replace this note with concrete current-milestone tickets before dispatching workers. Do not launch generic planning, discovery, design, implementation, or review workers just because those roles exist in the catalog.

Suggested ticket shape when concrete work is known:

#### Ticket N: Concrete workstream title
- Owner: Implementer | Investigator | UX/UI | Integrator | TPM
- Deliverable: specific output this worker can complete independently.
- Files: concrete files/areas, if known.
- Verification: concrete check or callback evidence.
- Depends on: none, or the ticket it must wait for.
- Parallel: yes/no.

## Dogfooding Gate

- Scenario to exercise: run the command/flow affected by the request, or use the nearest automated check for internal-only changes.
- Must-pass outcomes: match milestone DONE criteria.

## PM Decisions

- Date: ${today}
- Decision: Initial Gaud plan was auto-generated from the user's request.
- Why: Gaud should default obvious planning details itself and ask the user only for material clarification.
- Next action: Foreground orchestrator derives concrete workstreams from the request/repo, then calls gaud_start_run with only the needed workers.
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

async function defaultRoleAgentsForRun(ctx: ExtensionContext, parsedAgents: string[], agentsExplicit = false): Promise<GaudConfig | undefined> {
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
	const implementers = agentsExplicit && parsedInstalled.length > 0
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
	ctx.ui.notify(`Gaud agent pool: design=${design}, eng=${eng}, implementer=${implementers.join(",")}, review=${review}. Actual worker count is derived from the plan. ${needsPersistedRoles ? "Saved defaults." : "Run /gaud setup to change defaults."}`, "info");
	return config;
}

function delegateGaudPlanningToAgent(pi: ExtensionAPI, ctx: UiContext, task: string) {
	const prompt = buildGaudDelegationPrompt(task);
	recordGaudTrace("planning", "delegated to foreground agent", [`task: ${summarizeForTrace(task)}`]);
	try {
		pi.sendUserMessage(prompt);
		ctx.ui.notify("Gaud planning handed to the foreground agent. It will read/create the plan and call gaud_start_run with explicit workers.", "info");
	} catch (error) {
		ctx.ui.notify(`Failed to hand Gaud planning to the agent: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runPlanningWizard(pi: ExtensionAPI, ctx: ExtensionContext, args: string) {
	if (planningInFlight) {
		recordGaudTrace("planning", "planning request ignored", ["reason: planning already in flight"]);
		return;
	}
	planningInFlight = true;
	try {
		const parsed = parseArgs(args);
		recordGaudTrace("planning", "wizard started", [`args: ${summarizeForTrace(args)}`, `agents: ${parsed.agents.join(",")}`, `agentsExplicit: ${parsed.agentsExplicit}`, `fake: ${parsed.fake}`]);
		const { taskArgPath, seededFocus, sourcePath, absoluteSourcePath, missingExplicitPath } = await resolvePlanningSource(ctx.cwd, parsed.task);
		recordGaudTrace("planning", "source resolved", [
			`taskArgPath: ${taskArgPath || "(none)"}`,
			`sourcePath: ${sourcePath}`,
			`seededFocus: ${seededFocus || "(none)"}`,
			`missingExplicitPath: ${missingExplicitPath}`,
		]);
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
		recordGaudTrace("planning", "autogenerated plan scaffold", [`focus: ${summarizeForTrace(focus)}`, `sourceLabel: ${sourceLabel}`]);
	}

	if (!focus) {
		recordGaudTrace("planning", "wizard stopped", ["reason: no focus resolved"]);
		return;
	}
	const approvedFocus = focus;
	let existingConfig = await loadGaudConfig(ctx.cwd);
	if (!existingConfig?.promptSources) {
		existingConfig = { orchestrator: { type: "pi", agent: "pi" }, roles: {}, promptSources: { planning: { type: "builtin" }, design: { type: "builtin" }, eng: { type: "builtin" }, implementer: { type: "builtin" }, codeReview: { type: "builtin" } } };
	}
	const roleConfig = await defaultRoleAgentsForRun(ctx, parsed.agents, parsed.agentsExplicit);
	if (!roleConfig) {
		recordGaudTrace("planning", "wizard stopped", ["reason: no role config"]);
		return;
	}
	recordGaudTrace("planning", "agents selected", [
		`design: ${roleConfig.roles["gaud-design"]}`,
		`eng: ${roleConfig.roles["gaud-eng"]}`,
		`implementers: ${roleConfig.roles["gaud-implementer"]?.join(",")}`,
		`review: ${roleConfig.roles["gaud-code-review"]}`,
	]);
	const promptSources = existingConfig?.promptSources ?? { planning: { type: "builtin" }, design: { type: "builtin" }, eng: { type: "builtin" }, implementer: { type: "builtin" }, codeReview: { type: "builtin" } };
	recordGaudTrace("planning", "methodology sources", Object.entries(promptSources).map(([role, source]) => `${role}: ${source?.type ?? "builtin"}`));
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
		recordGaudTrace("planning", "worker assignment failed", ["reason: buildWorkerPlans returned 0"]);
		ctx.ui.notify("No worker assignments were generated.", "error");
		return;
	}
	recordGaudTrace("planning", "worker assignments generated", workerPlans.map((plan) => `${plan.id}: ${plan.role}/${plan.agent} files=${plan.files.join(",")}`));
	ctx.ui.notify(`Gaud derived ${workerPlans.length} worker${workerPlans.length === 1 ? "" : "s"} from the plan: ${workerPlans.map((plan) => `${plan.role}/${plan.agent}`).join(", ")}.`, "info");
	const planDir = path.join(ctx.cwd, ".gaud", "plans");
	await mkdir(planDir, { recursive: true });
	const outPath = path.join(planDir, `${makeRunId()}-plan.md`);
	const generatedMarkdown = renderPlanMarkdown(approvedFocus, sourceLabel, workerPlans, planText);
	await writeFile(outPath, generatedMarkdown, "utf8");
	recordGaudTrace("planning", "plan written", [`path: ${outPath}`, `focus: ${summarizeForTrace(approvedFocus)}`]);
	await launchRun(pi, ctx, `${approvedFocus}\n\nExecution plan: ${outPath}`, workerPlans.map((plan) => plan.agent), parsed.fake, "Auto-launched from planning wizard.", workerPlans);
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
		else if (matchesKey(data, "c")) {
			void pollOnce(this.pi, this.ctx).then(() => {
				if (!activeRun) return;
				const lines = [`Gaud ${activeRun.id} — status check`];
				if (activeRun.milestones?.length) {
					const progress = activeRun.milestones.map((ms) => {
						const icon = ms.status === "done" ? "✓" : ms.status === "in-progress" ? "●" : "○";
						return `${icon} ${ms.id} ${ms.name} (${ms.status})`;
					}).join("\n");
					lines.push(`Milestones:\n${progress}`);
				}
				for (const w of Object.values(activeRun.workers)) {
					const activity = formatAge(workerLastActivity(w));
					const symbol = workerStatusSymbol(w.status);
					const detail = w.summary || w.objective || "";
					lines.push(`${symbol} ${w.id} (${w.agent}/${w.role}) — ${w.status} · last ${activity}${detail ? `\n  ${detail.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
				}
				this.ctx.ui.notify(lines.join("\n"), "info");
				this.tui.requestRender();
			});
		}
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
		lines.push(line(th.fg("muted", `${activeRun ? activeRun.id : "no active run"} · ${activeRun ? activeRun.status : ""}`)));
		lines.push(line(th.fg("muted", "j/k/↑↓ navigate · p pane output · c check status · s relaunch · x cancel · r refresh · q close")));
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
				lines.push(line());
				lines.push(line(th.fg("accent", "Milestones")));
				for (const milestone of activeRun.milestones) {
					const icon = milestone.status === "done" ? th.fg("success", "✓") : milestone.status === "in-progress" ? th.fg("accent", "●") : th.fg("muted", "○");
					const name = milestone.status === "done" ? th.fg("success", milestone.name) : milestone.status === "in-progress" ? th.fg("accent", milestone.name) : th.fg("muted", milestone.name);
					lines.push(line(` ${icon} ${milestone.id} — ${name}`));
				}
				lines.push(line());
			}
			const currentWorkers = workers.filter((worker) => worker.status !== "done").map((worker) => `${worker.role}:${worker.id}`).join(", ");
			lines.push(line(`current milestone workers: ${currentWorkers || "none active"}`));
			const needsAttention = workers.filter((w) => w.status === "stuck" || w.status === "waiting-user" || w.status === "waiting-permission" || w.status === "dead");
			if (needsAttention.length > 0) {
				lines.push(line(th.fg("error", `⚠ action needed: ${needsAttention.map((w) => `${w.id}/${w.role}:${w.status}`).join(", ")}`)));
			}
			lines.push(line());
			lines.push(line(th.fg("muted", "status · role · worker · agent · last activity")));
			for (let index = 0; index < workers.length; index++) {
				const worker = workers[index]!;
				const marker = index === this.selected ? th.fg("accent", "▸") : " ";
				const symbol = workerStatusSymbol(worker.status);
				const status = th.fg(workerStatusColor(worker.status), `${symbol} ${worker.status}`);
				const activity = formatAge(workerLastActivity(worker));
				const role = (worker.role || "").padEnd(14);
				const id = worker.id.padEnd(18);
				const agent = worker.agent.padEnd(10);
				lines.push(line(`${marker} ${status.padEnd(12)} ${role} ${id} ${agent} ${activity}`));
				const subtitle = (worker.summary || worker.objective || "").replace(/\s+/g, " ").trim();
				if (subtitle) lines.push(line(` ${th.fg("dim", subtitle.slice(0, innerW - 4))}`));
				if (index < workers.length - 1) lines.push(line(th.fg("dim", "─".repeat(Math.min(innerW, 52)))));
			}
			const worker = this.selectedWorker();
			if (worker) {
				lines.push(line(th.fg("dim", "═".repeat(Math.min(innerW, 60)))));
				lines.push(line(th.fg("accent", `${workerStatusSymbol(worker.status)} ${worker.id}`) + ` · ${worker.role || ""} · ${worker.agent} · ${worker.status}${worker.restartCount ? ` · ${worker.restartCount} restart${worker.restartCount > 1 ? "s" : ""}` : ""}`));
				if (worker.objective) lines.push(line(` ${worker.objective.replace(/\s+/g, " ").slice(0, innerW - 4)}`));
				if (worker.summary) lines.push(line(th.fg("dim", ` ${worker.summary.replace(/\s+/g, " ").slice(0, innerW - 4)}`)));
				if (worker.status === "waiting-permission") lines.push(line(th.fg("warning", " Needs permission approval or press s to relaunch / x to cancel")));
				if (worker.status === "stuck" || worker.status === "dead") lines.push(line(th.fg("warning", " No activity for >2m — press s to relaunch or x to cancel")));
				lines.push(line(` tmux: ${tmuxWorkerViewCommand(activeRun, worker)}`));
				if (this.showPane) {
					lines.push(line(th.fg("dim", "─".repeat(Math.min(innerW, 40)))));
					lines.push(line(" latest pane output:"));
					const paneLines = (worker.lastPeek || "(no output captured yet)").split("\n").slice(-30);
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
		anchor: "top-left",
		width: "100%",
		minWidth: 56,
		maxHeight: "40%",
		margin: 0,
		offsetX: 0,
		offsetY: 0,
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

export function analyzeGaudRouting(text: string): GaudRoutingDecision {
	const trimmed = text.trim();
	const lower = trimmed.toLowerCase();
	const signals: string[] = [];
	const blockers: string[] = [];
	let score = 0;

	if (!trimmed) {
		blockers.push("empty input");
		return { shouldPrompt: false, score, threshold: GAUD_ROUTING_THRESHOLD, signals, blockers, explanation: "skip: empty input" };
	}
	if (trimmed.startsWith("/")) {
		blockers.push("slash command");
		return { shouldPrompt: false, score, threshold: GAUD_ROUTING_THRESHOLD, signals, blockers, explanation: "skip: slash command" };
	}

	const action = /\b(implement|build|make|refactor|migrate|rewrite|fix|ship|create|add|update|integrate|scaffold)\b/.test(lower);
	if (action) signals.push("implementation action");
	else blockers.push("no implementation action");

	const informational = /^(what|why|how|can you explain|tell me|show me)\b/.test(lower) && !action;
	if (informational) blockers.push("informational question");

	const bigTask = /\b(build|make|create|scaffold)\b.*\b(app|site|website|dashboard|tool|system|workflow|flow|integration)\b/.test(lower);
	if (bigTask) {
		score += 4;
		signals.push("new product/system sized task (+4)");
	}

	const productNoun = /\b(app|site|website|dashboard|feature|workflow|flow|integration|api|cli|sdk|tool|system|ui|ux|backend|frontend|database)\b/.test(lower);
	const breadth = /\b(and|plus|multiple|several|all|frontend|backend|api|database|docs|tests|ui|ux|auth|payments|deploy|polish|end-to-end|full stack|full-stack)\b/.test(lower);
	if (productNoun && breadth) {
		score += 2;
		signals.push("product area plus breadth term (+2)");
	}

	const multiPart = trimmed.split(/\b(?:and|plus|then|also)\b|[,;]/i).filter((part) => part.trim().length > 8).length >= 2;
	if (multiPart) {
		score += 1;
		signals.push("multiple clauses (+1)");
	}

	const scopeTerms = ["frontend", "backend", "api", "database", "ui", "ux", "auth", "payments", "deploy"].filter((term) => new RegExp(`\\b${term}\\b`).test(lower));
	if (new Set(scopeTerms).size >= 2) {
		score += 2;
		signals.push(`cross-module scope: ${[...new Set(scopeTerms)].join("+")} (+2)`);
	}

	if (trimmed.length > 120) {
		score += 1;
		signals.push("long detailed request (+1, weak signal)");
	}

	if (action && score < GAUD_ROUTING_THRESHOLD) blockers.push("single-agent sized by score");
	const shouldPrompt = action && !informational && score >= GAUD_ROUTING_THRESHOLD;
	return {
		shouldPrompt,
		score,
		threshold: GAUD_ROUTING_THRESHOLD,
		signals,
		blockers,
		explanation: shouldPrompt ? `prompt: score ${score} >= ${GAUD_ROUTING_THRESHOLD}` : `skip: score ${score} < ${GAUD_ROUTING_THRESHOLD}`,
	};
}

export default function gaudExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		extensionActive = true;
		lastCtx = ctx;

		// Auto-resume any active cwd-local run silently — no user action required.
		// Prefer a live session entry, but fall back to scanning .gaud/runs if the entry is stale or terminal.
		try {
			if (!activeRun) {
				const entries = ctx.sessionManager.getEntries();
				const latestEntry = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "gaud-state") as { data?: { statePath?: string } } | undefined;
				const entryState = latestEntry?.data?.statePath ? await readRunState(latestEntry.data.statePath) : undefined;
				const state = entryState && isActiveRunStatus(entryState.status) ? entryState : await findLatestActiveRun(ctx.cwd);
				if (state && isActiveRunStatus(state.status)) {
					activeRun = state;
					ensurePollerLogPath(state);
					appendPollerLog(state, "auto_resume", { source: state === entryState ? "session-entry" : "cwd-scan" });
					recordGaudTrace("session", "auto-resumed run", [`id: ${state.id}`, `status: ${state.status}`, `source: ${state === entryState ? "session-entry" : "cwd-scan"}`]);
					await reattachPaneLogs(state);
					startPolling(pi, ctx);
				}
			}
		} catch (error) {
			recordGaudTrace("session_start", `failed to auto-resume run: ${error}`);
		}

		refreshUi(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeRun || activeRun.status !== "running") {
			if (event.systemPrompt.includes("[GAUD")) return;
			const awareness = `\n\n[GAUD AVAILABLE]\nGaud is a parallel tmux worker system accessible via the gaud_start_run tool. Use it when a task benefits from parallel execution:\n- Multi-file changes spanning 2+ independent modules or workstreams\n- Tasks with clearly parallelizable slices (e.g. frontend + backend, design + implementation, research + build)\n- Work that benefits from frequent check-backs rather than one long unsupervised run\n\nHow to use Gaud:\n1. Read or create a local markdown execution plan with concrete current-milestone tickets.\n2. Derive explicit parallel workers from the plan (agent, role, objective, files, doneCriteria).\n3. Call gaud_start_run with those workers. The extension handles tmux, polling, and callback routing automatically.\n\nDo NOT use Gaud for single-file fixes, trivial changes, typos, or informational questions — handle those directly.`;
			return { systemPrompt: event.systemPrompt + awareness };
		}
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
			clearTerminalActiveRun();
		}
		extensionActive = false;
		refreshUi(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const explicitTask = explicitGaudRequest(event.text);
		if (explicitTask !== undefined) {
			recordGaudTrace("routing", "explicit Gaud request", [`input: ${summarizeForTrace(event.text)}`, `task: ${explicitTask || "(empty)"}`]);
			if (explicitTask === "status") {
				refreshUi(ctx);
				ctx.ui.notify(statusText(), "info");
				return { action: "handled" as const };
			}
			const parsed = parseArgs(explicitTask);
			if (parsed.fake) await launchRun(pi, ctx, parsed.task, parsed.agents, true, "User explicitly requested fake Gaud smoke run.");
			else delegateGaudPlanningToAgent(pi, ctx, explicitTask);
			return { action: "handled" as const };
		}

		if (!activeRun) {
			const routing = analyzeGaudRouting(event.text);
			recordGaudTrace("routing", "auto prompt skipped; foreground agent decides", routingTraceDetails(event.text, routing));
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
		description: "Launch Gaud workers from an explicit plan-derived worker assignment. The foreground agent decides the count and roles from parallel current-milestone workstreams.",
		promptSnippet: "Use Gaud only after you have a plan-derived list of parallel workers. The workers array is required for real runs; do not rely on extension templates.",
		promptGuidelines: [
			"**You are the orchestrator. Plan first.** Read or create the local markdown execution plan before launching real workers.",
			"The plan should identify the current milestone, DONE criteria, and current-milestone tickets/workstreams.",
			"Worker count comes from the plan: one worker per independent parallel workstream that can start now.",
			"Combine sequential/dependent tickets into one worker. Omit TPM, UX, reviewer, or integrator roles unless the plan gives them concrete current work.",
			"Use as many workers as the plan requires and no arbitrary extras. Configured agents are a pool, not a launch checklist.",
			"Do not make the user manually add or choose worker assignments. Derive the workers yourself, call this tool with them, and let the extension ask for approval before launch.",
			"For tiny or single-file work, handle it yourself instead of launching Gaud.",
			"Every worker needs a specific objective, primary files/areas, and concrete doneCriteria tied to the plan.",
			"If the plan is too vague to derive workers, tighten the plan yourself or call ask_user for the decision that changes the worker plan.",
			"Do NOT invoke the gaud-mode skill. Callbacks arrive as GAUDMODE messages automatically. Stuck workers include tmux commands to investigate.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The user's task to parallelize, an explicit plan path, or empty to discover existing plans." }),
			reason: Type.String({ description: "Why this task benefits from Gaud parallelization." }),
			workers: Type.Optional(Type.Array(Type.Object({
				agent: Type.String({ description: "Agent CLI to use: claude, codex, gemini, opencode, antigravity, etc." }),
				role: Type.String({ description: "Worker role label from the plan workstream, e.g. Implementer, Reviewer, Investigator, Designer, Tester." }),
				objective: Type.String({ description: "The exact plan ticket/workstream this worker should accomplish." }),
				files: Type.Array(Type.String(), { description: "Primary files or file patterns this plan workstream should focus on." }),
				doneCriteria: Type.Array(Type.String(), { description: "Plan-tied done criteria. Concrete, verifiable." }),
			}), { description: "Required for real runs. Explicit plan-derived worker assignments chosen by the foreground agent." })),
			agents: Type.Optional(Type.Array(Type.String(), { description: "Deprecated shorthand. For real runs, choose agents per explicit worker instead." })),
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
				const approved = params.fake ? true : await confirmWorkerLaunch(ctx, workerPlans, planPath);
				if (!approved) {
					const summary = formatWorkerApprovalSummary(workerPlans, planPath);
					return { content: [{ type: "text", text: `Gaud plan saved, but no workers were launched because user approval is required.\n\n${summary}` }], details: { run: activeRun, reason: params.reason, approved: false, workers: workerPlans.length, planPath } };
				}
				await launchRun(pi, ctx, `${params.task}\n\nExecution plan: ${planPath}`, allAgents, params.fake ?? false, params.reason, workerPlans);
				return { content: [{ type: "text", text: statusText() }], details: { run: activeRun, reason: params.reason, approved: true, workers: workerPlans.length } };
			}
			if (params.fake && params.agents?.length) {
				await launchRun(pi, ctx, params.task, params.agents, true, params.reason || "Fake Gaud smoke run requested through gaud_start_run.");
				return { content: [{ type: "text", text: statusText() }], details: { run: activeRun, reason: params.reason, fake: true } };
			}
			const guidance = buildGaudDelegationPrompt(params.task);
			return {
				content: [{ type: "text", text: `No Gaud workers launched: gaud_start_run requires explicit plan-derived workers for real runs.\n\n${guidance}` }],
				details: { run: activeRun, reason: params.reason, workersRequired: true },
			};
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Ask the user a clarifying question with suggested options and your recommendation. Use when you need user input to proceed — never guess when you can ask.",
		promptSnippet: "When the user's intent is unclear or you need to align on approach before launching Gaud workers, call ask_user with analyzed options and your recommendation.",
		promptGuidelines: [
			"Only use ask_user when genuinely unclear — not for confirmation of obvious choices. The user should align the plan with you BEFORE Gaud workers start.",
			"Use ask_user for: ambiguous scope, competing implementation approaches, missing constraints that change the plan, priority tradeoffs the user must decide.",
			"Do NOT use ask_user for: discoverable facts (read the codebase), yes/no confirmations on clear defaults, questions you can answer by reasoning.",
			"Each option must have a short label and a description explaining the tradeoff. Put your recommended option first.",
			"Keep it to 2-5 options. More than 5 means you haven't analyzed the choices enough.",
			"The user navigates with ↑↓ or j/k, selects with Enter, or types a custom answer. Esc cancels.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user. Be specific about what decision is needed." }),
			options: Type.Array(Type.Object({
				label: Type.String({ description: "Short option label (1-5 words)" }),
				description: Type.String({ description: "What this option means, tradeoffs, when it's the right choice" }),
			}), { description: "2-5 analyzed options. Put your recommended option first." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Cannot ask question: no interactive UI available." }], details: {} };
			}
			const allOptions = [...params.options, { label: "Other — type my own answer", description: "Custom answer" }];
			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;
					let cachedWidth: number | undefined;
					const editor = new Editor(tui, {
						borderColor: (s) => theme.fg("accent", s),
						selectList: { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: (s) => s },
					});

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) { done({ answer: trimmed, wasCustom: true }); }
						else { editMode = false; editor.setText(""); cachedLines = undefined; tui.requestRender(); }
					};

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) { editMode = false; editor.setText(""); cachedLines = undefined; tui.requestRender(); return; }
							editor.handleInput(data);
							cachedLines = undefined; tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.up) || data === "k") { optionIndex = Math.max(0, optionIndex - 1); cachedLines = undefined; tui.requestRender(); return; }
						if (matchesKey(data, Key.down) || data === "j") { optionIndex = Math.min(allOptions.length - 1, optionIndex + 1); cachedLines = undefined; tui.requestRender(); return; }
						if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected === allOptions[allOptions.length - 1]) { editMode = true; cachedLines = undefined; tui.requestRender(); }
							else { done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 }); }
							return;
						}
						if (matchesKey(data, Key.escape)) done(null);
					}

					function render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						const editorWidth = Math.max(1, width - 4);
						cachedLines = renderAskUserDialogLines({
							question: params.question,
							options: allOptions,
							optionIndex,
							editMode,
							editorLines: editMode ? editor.render(editorWidth) : undefined,
							width,
							theme,
						});
						cachedWidth = width;
						return cachedLines;
					}

					return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
				},
			);
			if (!result) {
				return { content: [{ type: "text", text: "User cancelled." }], details: { cancelled: true } };
			}
			if (result.wasCustom) {
				return { content: [{ type: "text", text: `User wrote: ${result.answer}` }], details: { answer: result.answer, custom: true } };
			}
			return { content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }], details: { answer: result.answer, index: result.index } };
		},
	});

	pi.registerCommand("gaud-setup", {
		description: "Configure Gaud default agents and prompt sources",
		handler: async (_args, ctx) => {
			await runSetupWizard(ctx);
		},
	});

	pi.registerCommand("gaud-plan", {
		description: "Hand PLAN.md or another plan request to the foreground agent to derive parallel Gaud workers",
		handler: async (args, ctx) => {
			delegateGaudPlanningToAgent(pi, ctx, args.trim() || "PLAN.md");
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

	pi.registerCommand("gaud-trace", {
		description: "Show recent Gaud routing and planning instrumentation",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				gaudTraceEntries.length = 0;
				ctx.ui.notify("Gaud trace cleared.", "info");
				return;
			}
			const limit = Number.parseInt(args.trim(), 10);
			ctx.ui.notify(formatGaudTrace(Number.isFinite(limit) ? limit : 20), "info");
		},
	});

	pi.registerCommand("gaud", {
		description: "Ask the foreground agent to plan a Gaud run and launch explicit plan-derived workers. Usage: /gaud [doctor|status|setup|plan] [--fake] [--agents claude,opencode,antigravity] [task or PLAN.md]",
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
			delegateGaudPlanningToAgent(pi, ctx, parsed.task === "plan" ? "PLAN.md" : args.trim());
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

	pi.registerCommand("gaud-logs", {
		description: "Show failure logs and recent pane output for debugging",
		handler: async (_args, ctx) => {
			if (!activeRun) {
				ctx.ui.notify("No active Gaud run.", "info");
				return;
			}
			const workers = Object.values(activeRun.workers);
			const failed = workers.filter((w) => w.status === "failed" || w.status === "dead");
			const lines: string[] = [`Gaud ${activeRun.id} — ${failed.length} failed/dead workers`];
			for (const w of failed) {
				lines.push(`\n--- ${w.id} (${w.agent}/${w.role}) — ${w.status} ---`);
				if (w.summary) lines.push(`Summary: ${w.summary}`);
				const failLog = path.join(activeRun.runDir, "workers", w.id, "failure.log");
				try { const logContent = await readFile(failLog, "utf8"); lines.push(`Failure log: ${logContent.slice(0, 2000)}`); } catch { /* no log */ }
				if (w.lastPeek) lines.push(`Last output:\n${w.lastPeek.split("\n").slice(-20).join("\n")}`);
			}
			if (failed.length === 0) {
				lines.push("\nNo failures. Workers are: " + workers.map((w) => `${w.id}:${w.status}`).join(", "));
			}
			ctx.ui.notify(lines.join("\n").slice(-7000), "info");
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
			let run = latest?.data?.statePath ? await readRunState(latest.data.statePath) : undefined;
			if (!run) {
				run = await findLatestActiveRun(ctx.cwd);
			}
			activeRun = run;
			if (activeRun) {
				ensurePollerLogPath(activeRun);
				appendPollerLog(activeRun, "manual_resume", { source: latest?.data?.statePath ? "session-entry" : "cwd-scan" });
				await reattachPaneLogs(activeRun);
				startPolling(pi, ctx);
			}
			refreshUi(ctx);
			ctx.ui.notify(activeRun ? `Resumed ${statusText()}` : "No persisted Gaud run found.", "info");
		},
	});
}
