/**
 * Shared types for the duker-loop extension.
 * See IMPLEMENTATION_PLAN.md §3–§6 for the contracts these model.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The seven agents the loop needs, in the order they run within a cycle. */
export const REQUIRED_AGENTS = [
	"orchestrator",
	"planner",
	"implementer",
	"tester",
	"reviewer",
	"reporter",
	"state-updater",
] as const;
export type AgentName = (typeof REQUIRED_AGENTS)[number];

/** Parsed and validated agents/<name>.md file. */
export interface AgentConfig {
	name: string;
	description: string;
	/** provider/id (or bare id); undefined → inherit the parent session's model */
	model?: string;
	/** undefined → inherit the parent's thinking level */
	thinking?: ThinkingLevel;
	/** --tools allowlist; undefined → pi defaults */
	tools?: string[];
	timeoutMinutes: number;
	/** false → --no-context-files */
	contextFiles: boolean;
	/** each becomes -e <source> in the child */
	extensions: string[];
	/** "all" → skill discovery left on; list → --skill <path> each; [] → --no-skills */
	skills: string[] | "all";
	/** globs (relative to cwd) the child's edit/write may touch; [] → everything not denied */
	writeAllow: string[];
	/** globs the child may never write; merged with GLOBAL_WRITE_DENY */
	writeDeny: string[];
	/** markdown body → appended to the child's system prompt */
	systemPrompt: string;
	/** absolute path of the source file (for diagnostics) */
	filePath: string;
}

export interface AgentLoadError {
	file: string;
	message: string;
}

export interface AgentDiscovery {
	agents: AgentConfig[];
	errors: AgentLoadError[];
	/** required agents that did not load */
	missing: AgentName[];
	agentsDir: string;
}

/** Working artifacts in the project root (fixed names — decision #9). */
export const ARTIFACTS = {
	fullPlan: "Full_Plan.md",
	currentState: "Current_State.md",
	currentPlan: "CURRENT_PLAN.md",
	fixingPlan: "FIXING_PLAN.md",
	issues: "ISSUES.md",
	report: "CURRENT_REPORT.md",
} as const;

export const TEMP_ARTIFACTS = [
	ARTIFACTS.currentPlan,
	ARTIFACTS.fixingPlan,
	ARTIFACTS.issues,
	ARTIFACTS.report,
] as const;

/** Extension-internal state and logs live here (relative to cwd). */
export const DUKER_DIR = ".duker";

/** Paths no child may ever write, regardless of its own allowlist. */
export const GLOBAL_WRITE_DENY = [ARTIFACTS.fullPlan, `${DUKER_DIR}/**`, ".git/**", ".pi/**"] as const;

// ---------------------------------------------------------------------------------------------
// Loop state (IMPLEMENTATION_PLAN.md §5–§6)
// ---------------------------------------------------------------------------------------------

export const PHASES = ["SELECT", "PLAN", "IMPLEMENT", "TEST", "REVIEW", "REPORT", "PERSIST", "CLEAN", "COMMIT"] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseRecord {
	phase: Phase;
	round: number;
	agent?: string;
	startedAt: string;
	ms: number;
	ok: boolean;
	note?: string;
	usage?: { input: number; output: number; cost: number; turns: number };
}

/** Persisted at .duker/state.json for the duration of one Full_Plan step. */
export interface LoopState {
	version: 1;
	runId: string;
	stepId: string;
	title: string;
	description: string;
	/** corrective rounds completed so far (0 = first implementation) */
	round: number;
	phase: Phase;
	/** `git rev-parse HEAD` when the step was selected (undefined outside a git repo) */
	headAtStepStart?: string;
	startedAt: string;
	updatedAt: string;
	history: PhaseRecord[];
}

// ---------------------------------------------------------------------------------------------
// Parsed artifact shapes
// ---------------------------------------------------------------------------------------------

export type IssueStatus = "OPEN" | "FIXED" | "NOTE";

export interface IssueEntry {
	status: IssueStatus;
	author: string;
	/** `file:line`, `file`, or "-" */
	location: string;
	text: string;
	detail: string[];
	/** 1-based line number in ISSUES.md */
	line: number;
}

export interface ParsedIssues {
	entries: IssueEntry[];
	open: number;
	fixed: number;
	notes: number;
	/** lines that start like an entry but do not match the contract */
	malformed: { line: number; text: string }[];
}

export interface ParsedVerdict {
	verdict: "PASS" | "FAIL";
	/** false when no VERDICT line was found (verdict is then FAIL by policy) */
	found: boolean;
	/** 1-based line number of the verdict line when found */
	line?: number;
}

export type OrchestratorStep =
	| { kind: "step"; id: string; title: string; description: string; reason: string }
	| { kind: "none"; reason: string }
	| { kind: "blocked"; reason: string }
	| { kind: "invalid"; error: string; raw: string };
