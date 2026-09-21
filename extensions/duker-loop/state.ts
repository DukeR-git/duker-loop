/**
 * .duker/state.json — persisted loop state for the in-progress Full_Plan step, plus the
 * run-log directory layout (IMPLEMENTATION_PLAN.md §6). Atomic writes (tmp + rename).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DUKER_DIR, type LoopState, PHASES, type Phase, type PhaseRecord } from "./types.ts";

export function dukerDir(cwd: string): string {
	return path.join(cwd, DUKER_DIR);
}

export function statePath(cwd: string): string {
	return path.join(dukerDir(cwd), "state.json");
}

export function runsDir(cwd: string, runId: string): string {
	return path.join(dukerDir(cwd), "runs", runId);
}

export function newRunId(now = new Date()): string {
	return now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace(/Z$/, "");
}

export function loadState(cwd: string): LoopState | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(statePath(cwd), "utf8");
	} catch {
		return undefined;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`duker: ${statePath(cwd)} is not valid JSON; run /duker clean to discard it`);
	}
	if (!isLoopState(data)) {
		throw new Error(`duker: ${statePath(cwd)} has an unexpected shape; run /duker clean to discard it`);
	}
	return data;
}

export function saveState(cwd: string, state: LoopState): void {
	const file = statePath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	state.updatedAt = new Date().toISOString();
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
	fs.renameSync(tmp, file);
}

export function clearState(cwd: string): boolean {
	try {
		fs.unlinkSync(statePath(cwd));
		return true;
	} catch {
		return false;
	}
}

export function createState(init: {
	runId: string;
	stepId: string;
	title: string;
	description: string;
	headAtStepStart?: string;
}): LoopState {
	const now = new Date().toISOString();
	return {
		version: 1,
		runId: init.runId,
		stepId: init.stepId,
		title: init.title,
		description: init.description,
		round: 0,
		phase: "PLAN",
		headAtStepStart: init.headAtStepStart,
		startedAt: now,
		updatedAt: now,
		history: [],
	};
}

export function recordPhase(state: LoopState, rec: PhaseRecord): void {
	state.history.push(rec);
}

/** Which plan file the implementer/tester/reviewer should read in the current round. */
export function planFileFor(state: LoopState): "currentPlan" | "fixingPlan" {
	return state.round === 0 ? "currentPlan" : "fixingPlan";
}

function isLoopState(v: unknown): v is LoopState {
	if (!v || typeof v !== "object") return false;
	const s = v as Record<string, unknown>;
	return (
		s.version === 1 &&
		typeof s.runId === "string" &&
		typeof s.stepId === "string" &&
		typeof s.title === "string" &&
		typeof s.description === "string" &&
		typeof s.round === "number" &&
		typeof s.phase === "string" &&
		(PHASES as readonly string[]).includes(s.phase as Phase) &&
		Array.isArray(s.history)
	);
}
