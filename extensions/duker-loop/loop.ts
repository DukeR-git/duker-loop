/**
 * The orchestration loop (IMPLEMENTATION_PLAN.md §5–§6).
 *
 *   SELECT → PLAN → IMPLEMENT → TEST → REVIEW → REPORT ─PASS→ PERSIST → CLEAN → COMMIT → (next step)
 *                ▲                                  └FAIL→ round++ (≤ maxRounds) ─┘
 *
 * Pure orchestration: no pi API here. Progress goes through a ProgressSink so the slash command
 * and the tool can render it differently. State is persisted after every phase so a killed run
 * resumes where it stopped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bundledAgentsDir, discoverAgents, findAgent } from "./agents.ts";
import {
	artifactExists,
	artifactFingerprint,
	cleanTempArtifacts,
	ensureCurrentState,
	ensureIssuesFile,
	milestoneLine,
	parseIssues,
	parseMilestones,
	parseOrchestratorOutput,
	parseVerdict,
	readArtifact,
	writeArtifact,
} from "./artifacts.ts";
import { changedFiles, commitAll, ensureExcluded, gitHead, isDirty, isGitRepo } from "./git.ts";
import {
	implementerPrompt,
	orchestratorPrompt,
	planChangedFiles,
	plannerPrompt,
	reporterPrompt,
	reviewerPrompt,
	stateUpdaterPrompt,
	type StepRef,
	testerPrompt,
} from "./prompts.ts";
import {
	addUsage,
	ChildAbortedError,
	type ChildEvent,
	type ChildResult,
	type ChildUsage,
	emptyUsage,
	isFailedResult,
	resultErrorText,
	runChild,
} from "./runtime.ts";
import { clearState, createState, loadState, newRunId, planFileFor, recordPhase, runsDir, saveState } from "./state.ts";
import { type AgentDiscovery, type AgentName, ARTIFACTS, DUKER_DIR, type LoopState, type Phase, type ThinkingLevel } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface LoopOptions {
	cwd: string;
	/** Full_Plan steps to attempt in this invocation */
	steps: number;
	maxRounds: number;
	/** 0 = unlimited */
	maxCost: number;
	/** 0 = use agent frontmatter */
	childTimeoutMinutes: number;
	allowDirty: boolean;
	inheritModel?: string;
	inheritThinking?: ThinkingLevel;
	signal?: AbortSignal;
	sink: ProgressSink;
	agentsDir?: string;
}

export interface PhaseInfo {
	stepId: string;
	title: string;
	round: number;
	phase: Phase;
	agent?: string;
	/** ms since the phase started */
	elapsedMs: number;
	/** last tool call / status text from the child */
	detail?: string;
}

export interface ProgressSink {
	phase(info: PhaseInfo): void;
	note(level: "info" | "warning" | "error", text: string): void;
	stepDone(step: StepSummary): void;
}

export interface StepSummary {
	stepId: string;
	title: string;
	runId: string;
	rounds: number;
	outcome: "passed" | "halted" | "aborted";
	reason?: string;
	commit?: string;
	durationMs: number;
	usage: ChildUsage;
	phases: LoopState["history"];
}

export interface LoopSummary {
	stopped: "steps-done" | "plan-complete" | "halted" | "aborted";
	reason?: string;
	steps: StepSummary[];
	usage: ChildUsage;
	durationMs: number;
}

export class DukerHalt extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "DukerHalt";
	}
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function runLoop(opts: LoopOptions): Promise<LoopSummary> {
	const started = Date.now();
	const summary: LoopSummary = { stopped: "steps-done", steps: [], usage: emptyUsage(), durationMs: 0 };
	const ctx = await preflight(opts);

	for (let i = 0; i < opts.steps; i++) {
		const step = await runStep(ctx);
		if (step === "plan-complete") {
			summary.stopped = "plan-complete";
			break;
		}
		summary.steps.push(step);
		addUsage(summary.usage, step.usage);
		if (step.outcome !== "passed") {
			summary.stopped = step.outcome;
			summary.reason = step.reason;
			break;
		}
	}
	summary.durationMs = Date.now() - started;
	return summary;
}

// ---------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------

interface LoopCtx {
	opts: LoopOptions;
	agents: AgentDiscovery;
	git: boolean;
}

async function preflight(opts: LoopOptions): Promise<LoopCtx> {
	const { cwd, sink } = opts;
	if (!fs.existsSync(cwd)) throw new Error(`duker: directory does not exist: ${cwd}`);
	if (!artifactExists(cwd, "fullPlan")) throw new Error(`duker: ${ARTIFACTS.fullPlan} not found in ${cwd}`);

	const agents = discoverAgents(opts.agentsDir ?? bundledAgentsDir());
	if (agents.missing.length || agents.errors.length) {
		const errs = agents.errors.map((e) => `${path.basename(e.file)}: ${e.message}`);
		throw new Error(`duker: agent definitions incomplete — missing: [${agents.missing.join(", ")}] errors: [${errs.join("; ")}]`);
	}

	const git = await isGitRepo(cwd);
	if (git) {
		if (await ensureExcluded(cwd, `${DUKER_DIR}/`)) sink.note("info", `added ${DUKER_DIR}/ to .git/info/exclude`);
	} else {
		sink.note("warning", "not a git repository: no per-step commits, reviewer falls back to the plan's file list");
	}
	if (ensureCurrentState(cwd)) sink.note("info", `created ${ARTIFACTS.currentState}`);
	return { opts, agents, git };
}

// ---------------------------------------------------------------------------------------------
// One Full_Plan step
// ---------------------------------------------------------------------------------------------

const ref = (s: LoopState): StepRef => ({ id: s.stepId, title: s.title, description: s.description });

async function runStep(ctx: LoopCtx): Promise<StepSummary | "plan-complete"> {
	const { opts } = ctx;
	const { cwd, sink } = opts;
	const stepStarted = Date.now();
	const usage = emptyUsage();

	// Pseudo state while selecting; never persisted (see child()).
	let state: LoopState = createState({ runId: newRunId(), stepId: "?", title: "selecting next step", description: "" });
	state.phase = "SELECT";

	const finish = (outcome: StepSummary["outcome"], reason?: string, commit?: string): StepSummary => {
		const s: StepSummary = {
			stepId: state.stepId,
			title: state.title,
			runId: state.runId,
			rounds: state.round,
			outcome,
			reason,
			commit,
			durationMs: Date.now() - stepStarted,
			usage,
			phases: state.history,
		};
		writeSummary(cwd, state, s);
		sink.stepDone(s);
		return s;
	};
	const persist = () => {
		if (state.phase !== "SELECT") saveState(cwd, state);
	};

	try {
		const existing = loadState(cwd);
		if (existing) {
			state = sanitizeResumedState(existing, cwd);
			sink.note("info", `resuming step ${state.stepId} at ${state.phase} (round ${state.round})`);
		} else {
			if (ctx.git && !opts.allowDirty && (await isDirty(cwd))) {
				throw new Error("duker: working tree is dirty; commit/stash first, run /duker clean, or pass --duker-allow-dirty");
			}
			const selected = await selectStep(ctx, state, usage);
			if (selected === "plan-complete") return "plan-complete";
			state = selected;
		}

		let commit: string | undefined;
		while (true) {
			switch (state.phase) {
				case "SELECT":
					// only reachable via a hand-edited state file; treat as a fresh plan
					state.phase = "PLAN";
					break;
				case "PLAN":
					await phasePlan(ctx, state, usage);
					state.phase = "IMPLEMENT";
					break;
				case "IMPLEMENT":
					await phaseImplement(ctx, state, usage);
					state.phase = "TEST";
					break;
				case "TEST":
					await child(ctx, state, usage, "tester", testerPrompt(ref(state), ARTIFACTS[planFileFor(state)]));
					state.phase = "REVIEW";
					break;
				case "REVIEW":
					await phaseReview(ctx, state, usage);
					state.phase = "REPORT";
					break;
				case "REPORT": {
					const verdict = await phaseReport(ctx, state, usage);
					if (verdict === "PASS") {
						state.phase = "PERSIST";
					} else if (state.round >= opts.maxRounds) {
						throw new DukerHalt(`step ${state.stepId} still failing after ${state.round} corrective round(s); artifacts and code left in place`);
					} else {
						state.round++;
						state.phase = "PLAN";
						sink.note("warning", `step ${state.stepId}: verdict FAIL → fix round ${state.round}/${opts.maxRounds}`);
					}
					break;
				}
				case "PERSIST":
					await phasePersist(ctx, state, usage);
					state.phase = "CLEAN";
					break;
				case "CLEAN": {
					const t = Date.now();
					const deleted = cleanTempArtifacts(cwd);
					recordPhase(state, { phase: "CLEAN", round: state.round, startedAt: new Date(t).toISOString(), ms: Date.now() - t, ok: true, note: deleted.join(", ") });
					state.phase = "COMMIT";
					break;
				}
				case "COMMIT": {
					commit = await phaseCommit(ctx, state);
					clearState(cwd);
					return finish("passed", undefined, commit);
				}
			}
			persist();
		}
	} catch (err) {
		persist();
		if (err instanceof ChildAbortedError) {
			sink.note("warning", state.phase === "SELECT" ? "aborted while selecting the next step" : `aborted during ${state.phase}; run /duker again to resume`);
			return finish("aborted", err.message);
		}
		if (err instanceof DukerHalt) {
			sink.note("error", `halted: ${err.message}`);
			return finish("halted", err.message);
		}
		throw err;
	}
}

/** A resumed state whose plan file vanished restarts at PLAN; nothing else needs repair. */
function sanitizeResumedState(state: LoopState, cwd: string): LoopState {
	const needsPlan: Phase[] = ["IMPLEMENT", "TEST", "REVIEW", "REPORT"];
	if (needsPlan.includes(state.phase) && !artifactExists(cwd, planFileFor(state))) state.phase = "PLAN";
	return state;
}

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

async function selectStep(ctx: LoopCtx, pseudo: LoopState, usage: ChildUsage): Promise<LoopState | "plan-complete"> {
	const { cwd, sink } = ctx.opts;
	const runId = pseudo.runId;
	const head = ctx.git ? await gitHead(cwd) : undefined;

	const result = await child(ctx, pseudo, usage, "orchestrator", orchestratorPrompt());
	const parsed = parseOrchestratorOutput(result.finalText);
	switch (parsed.kind) {
		case "none":
			sink.note("info", `${ARTIFACTS.fullPlan} complete: ${parsed.reason || "no remaining steps"}`);
			return "plan-complete";
		case "blocked":
			throw new DukerHalt(`orchestrator reports BLOCKED: ${parsed.reason || "(no reason given)"}`);
		case "invalid":
			throw new DukerHalt(`orchestrator output unparseable (${parsed.error}). Output was:\n${parsed.raw.slice(0, 600)}`);
		case "step": {
			const done = parseMilestones(readArtifact(cwd, "currentState")).map((m) => m.id);
			if (done.includes(parsed.id)) {
				throw new DukerHalt(`orchestrator selected step ${parsed.id}, which ${ARTIFACTS.currentState} already lists as DONE`);
			}
			const state = createState({ runId, stepId: parsed.id, title: parsed.title, description: parsed.description, headAtStepStart: head });
			state.history = pseudo.history;
			ensureIssuesFile(cwd, state.stepId);
			saveState(cwd, state);
			sink.note("info", `selected step ${state.stepId} — ${state.title}${parsed.reason ? ` (${parsed.reason})` : ""}`);
			return state;
		}
	}
}

async function phasePlan(ctx: LoopCtx, state: LoopState, usage: ChildUsage): Promise<void> {
	const { cwd } = ctx.opts;
	const key = planFileFor(state);
	ensureIssuesFile(cwd, state.stepId);
	const before = artifactFingerprint(cwd, key);
	await child(ctx, state, usage, "planner", plannerPrompt(ref(state), state.round));
	const after = artifactFingerprint(cwd, key);
	const text = readArtifact(cwd, key);
	if (!text || text.trim().length < 50) throw new DukerHalt(`planner did not write ${ARTIFACTS[key]}`);
	if (before && before === after) throw new DukerHalt(`planner left ${ARTIFACTS[key]} unchanged`);
}

async function phaseImplement(ctx: LoopCtx, state: LoopState, usage: ChildUsage): Promise<void> {
	const { cwd, sink } = ctx.opts;
	const planFile = ARTIFACTS[planFileFor(state)];
	const before = ctx.git ? await changedFiles(cwd) : [];
	await child(ctx, state, usage, "implementer", implementerPrompt(ref(state), state.round, planFile));
	if (ctx.git) {
		const after = await changedFiles(cwd);
		if (after.length === before.length && after.every((f, i) => f === before[i])) {
			sink.note("warning", `implementer made no file changes (round ${state.round}); validation continues`);
		}
	}
}

async function phaseReview(ctx: LoopCtx, state: LoopState, usage: ChildUsage): Promise<void> {
	const { cwd } = ctx.opts;
	const planKey = planFileFor(state);
	let material: Parameters<typeof reviewerPrompt>[2];
	if (ctx.git && state.headAtStepStart) {
		material = { kind: "diff", sha: state.headAtStepStart };
	} else {
		material = { kind: "files", files: planChangedFiles(readArtifact(cwd, planKey)) };
	}
	await child(ctx, state, usage, "reviewer", reviewerPrompt(ref(state), ARTIFACTS[planKey], material));
}

async function phaseReport(ctx: LoopCtx, state: LoopState, usage: ChildUsage): Promise<"PASS" | "FAIL"> {
	const { cwd, sink } = ctx.opts;
	await child(ctx, state, usage, "reporter", reporterPrompt(ref(state), state.round));
	const verdict = parseVerdict(readArtifact(cwd, "report"));
	const issues = parseIssues(readArtifact(cwd, "issues"));
	if (!verdict.found) {
		sink.note("warning", `${ARTIFACTS.report} has no VERDICT line → treated as FAIL`);
		return "FAIL";
	}
	if (verdict.verdict === "PASS" && issues.open > 0) {
		sink.note("warning", `reporter said PASS but ${ARTIFACTS.issues} has ${issues.open} [OPEN] entr${issues.open === 1 ? "y" : "ies"} → FAIL`);
		return "FAIL";
	}
	if (issues.malformed.length) {
		sink.note("warning", `${ARTIFACTS.issues} has ${issues.malformed.length} malformed entry line(s) (ignored)`);
	}
	sink.note(verdict.verdict === "PASS" ? "info" : "warning", `verdict ${verdict.verdict} (open ${issues.open}, fixed ${issues.fixed}, notes ${issues.notes})`);
	return verdict.verdict;
}

async function phasePersist(ctx: LoopCtx, state: LoopState, usage: ChildUsage): Promise<void> {
	const { cwd, sink } = ctx.opts;
	const date = new Date().toISOString().slice(0, 10);
	const before = artifactFingerprint(cwd, "currentState");
	await child(ctx, state, usage, "state-updater", stateUpdaterPrompt(ref(state), date));
	if (artifactFingerprint(cwd, "currentState") === before) {
		sink.note("warning", `state-updater left ${ARTIFACTS.currentState} unchanged`);
	}
	const text = readArtifact(cwd, "currentState") ?? "";
	if (!parseMilestones(text).some((m) => m.id === state.stepId)) {
		// Code fallback: without the milestone the orchestrator would pick this step again.
		const line = milestoneLine(state.stepId, state.title);
		const updated = /##\s*Milestones/i.test(text)
			? text.replace(/(##\s*Milestones[^\n]*\n)/i, `$1${line}\n`)
			: `${text.replace(/\s*$/, "")}\n\n## Milestones\n${line}\n`;
		writeArtifact(cwd, "currentState", updated);
		sink.note("warning", `state-updater did not add the milestone line; appended it: ${line}`);
	}
}

async function phaseCommit(ctx: LoopCtx, state: LoopState): Promise<string | undefined> {
	const { cwd, sink } = ctx.opts;
	const t = Date.now();
	if (!ctx.git) {
		recordPhase(state, { phase: "COMMIT", round: state.round, startedAt: new Date(t).toISOString(), ms: 0, ok: true, note: "not a git repo" });
		return undefined;
	}
	const r = await commitAll(cwd, `duker(${state.stepId}): ${state.title}`);
	recordPhase(state, { phase: "COMMIT", round: state.round, startedAt: new Date(t).toISOString(), ms: Date.now() - t, ok: !r.error, note: r.error ?? r.sha });
	if (r.error) sink.note("error", `git commit failed: ${r.error}`);
	else if (r.sha) sink.note("info", `committed ${r.sha.slice(0, 10)} — duker(${state.stepId}): ${state.title}`);
	else sink.note("warning", "nothing to commit");
	return r.sha;
}

/** Runs one agent, records the phase, enforces failure and cost policy. The SELECT pseudo-state is never saved. */
async function child(ctx: LoopCtx, state: LoopState, usage: ChildUsage, agentName: AgentName, task: string): Promise<ChildResult> {
	const { opts } = ctx;
	const { cwd, sink } = opts;
	const agent = findAgent(ctx.agents, agentName);
	if (!agent) throw new DukerHalt(`agent "${agentName}" is not defined`);

	const started = Date.now();
	const seq = state.history.length + 1;
	const logPath = path.join(runsDir(cwd, state.runId), `${String(seq).padStart(2, "0")}-${agentName}.jsonl`);
	let detail: string | undefined;
	const emit = () =>
		sink.phase({ stepId: state.stepId, title: state.title, round: state.round, phase: state.phase, agent: agentName, elapsedMs: Date.now() - started, detail });
	emit();
	const ticker = setInterval(emit, 5000);

	let result: ChildResult;
	try {
		result = await runChild({
			agent,
			task,
			cwd,
			inheritModel: opts.inheritModel,
			inheritThinking: opts.inheritThinking,
			timeoutMinutes: opts.childTimeoutMinutes,
			logPath,
			signal: opts.signal,
			extraEnv: { DUKER_RUN_ID: state.runId, DUKER_STEP: state.stepId },
			onEvent: (ev: ChildEvent) => {
				if (ev.kind === "tool") detail = describeTool(ev.toolName, ev.args);
				else if (ev.kind === "retry") detail = `retry ${ev.attempt}: ${ev.errorMessage.slice(0, 60)}`;
				else if (ev.kind === "text") detail = "responding";
				if (ev.kind !== "stderr") emit();
			},
		});
	} finally {
		clearInterval(ticker);
	}

	addUsage(usage, result.usage);
	const failed = isFailedResult(result);
	recordPhase(state, {
		phase: state.phase,
		round: state.round,
		agent: agentName,
		startedAt: new Date(started).toISOString(),
		ms: result.durationMs,
		ok: !failed,
		note: failed ? resultErrorText(result) : result.guardBlocks ? `${result.guardBlocks} guard block(s)` : undefined,
		usage: { input: result.usage.input, output: result.usage.output, cost: result.usage.cost, turns: result.usage.turns },
	});
	if (state.phase !== "SELECT") saveState(cwd, state);

	if (result.guardBlocks) sink.note("warning", `${agentName}: ${result.guardBlocks} tool call(s) blocked by the guard`);
	if (failed) throw new DukerHalt(`${agentName} failed in ${state.phase}: ${resultErrorText(result)} (log: ${path.relative(cwd, logPath)})`);
	if (opts.maxCost > 0 && usage.cost > opts.maxCost) throw new DukerHalt(`cost cap exceeded: $${usage.cost.toFixed(4)} > $${opts.maxCost}`);
	return result;
}

function describeTool(name: string, args: Record<string, unknown>): string {
	const p = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
	switch (name) {
		case "bash":
			return `$ ${p("command").slice(0, 70)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${path.basename(p("path"))}`;
		case "grep":
			return `grep ${p("pattern").slice(0, 40)}`;
		default:
			return name;
	}
}

function writeSummary(cwd: string, state: LoopState, s: StepSummary): void {
	try {
		const dir = runsDir(cwd, state.runId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ ...s, description: state.description, headAtStepStart: state.headAtStepStart }, null, 2));
	} catch {
		/* logging must never break the loop */
	}
}
