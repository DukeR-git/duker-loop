/**
 * Live activity model behind the fleet view (decision #34): which children ran or are running
 * in the current duker run, with a bounded transcript per child. Pure (no pi imports): the loop,
 * `/duker run` and `/duker init` feed it through ChildHooks, fleet.ts renders it.
 */
import type { ChildEvent, ChildUsage } from "./runtime.ts";

export type RunKind = "loop" | "manual" | "init";

export interface ActivityRun {
	kind: RunKind;
	/** `duker step 1.2 — title`, `duker run planner`, `duker init` */
	label: string;
	startedAt: number;
	endedAt?: number;
	outcome?: string;
}

/** Identifies one child run; the loop fills every field, manual/init runs leave step fields empty. */
export interface ChildInfo {
	runId: string;
	stepId?: string;
	title?: string;
	/** loop phase, or "manual" / "init" */
	phase: string;
	round: number;
	agent: string;
	/** 1-based within the run */
	seq: number;
	logPath?: string;
}

export interface ChildOutcome {
	ok: boolean;
	note?: string;
	usage?: ChildUsage;
	guardBlocks?: number;
	finalText?: string;
}

/** What a runner reports; ProgressSink extends this (all optional there). */
export interface ChildHooks {
	childStart(info: ChildInfo): void;
	childEvent(info: ChildInfo, ev: ChildEvent): void;
	childEnd(info: ChildInfo, outcome: ChildOutcome): void;
}

export type TranscriptEntry =
	| { kind: "tool"; at: number; name: string; detail: string }
	| { kind: "toolEnd"; at: number; name: string; isError: boolean; text: string }
	/** a completed assistant message */
	| { kind: "text"; at: number; text: string }
	| { kind: "retry"; at: number; attempt: number; message: string }
	| { kind: "stderr"; at: number; line: string }
	| { kind: "note"; at: number; text: string };

export type RowStatus = "running" | "ok" | "failed" | "pending";

export interface ChildRow {
	/** unique for the session */
	id: number;
	info: ChildInfo;
	status: RowStatus;
	startedAt: number;
	endedAt?: number;
	note?: string;
	usage?: ChildUsage;
	guardBlocks: number;
	transcript: TranscriptEntry[];
	/** assistant text streamed since the last completed message */
	streaming: string;
	/** last tool call, for the list row */
	lastTool?: string;
	finalText?: string;
}

/** Loop phases in the order they run, with the agent each spawns — used to show pending rows. */
export const PHASE_AGENTS: readonly { phase: string; agent: string }[] = [
	{ phase: "SELECT", agent: "orchestrator" },
	{ phase: "PLAN", agent: "planner" },
	{ phase: "IMPLEMENT", agent: "implementer" },
	{ phase: "TEST", agent: "tester" },
	{ phase: "REVIEW", agent: "reviewer" },
	{ phase: "REPORT", agent: "reporter" },
	{ phase: "PERSIST", agent: "state-updater" },
];

const MAX_TRANSCRIPT = 500;
const MAX_TEXT_CHARS = 6000;
const MAX_STREAMING_CHARS = 8000;

export class Activity implements ChildHooks {
	run: ActivityRun | undefined;
	rows: ChildRow[] = [];
	private nextId = 1;
	private listeners = new Set<() => void>();

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	// ---- run lifecycle (called by the command/tool owning the run) ----

	startRun(kind: RunKind, label: string): void {
		this.run = { kind, label, startedAt: Date.now() };
		this.rows = [];
		this.emit();
	}

	endRun(outcome: string): void {
		if (!this.run) return;
		for (const r of this.rows) {
			if (r.status === "running") {
				r.status = "failed";
				r.endedAt = Date.now();
				r.note = r.note ?? outcome;
			}
		}
		this.rows = this.rows.filter((r) => r.status !== "pending");
		this.run.endedAt = Date.now();
		this.run.outcome = outcome;
		this.emit();
	}

	// ---- ChildHooks ----

	childStart(info: ChildInfo): void {
		// Pending rows are placeholders; the real row replaces them from this phase on. The loop
		// gives every step its own runId, so a new step's first child clears the previous chain.
		this.rows = this.rows.filter((r) => r.status !== "pending" && r.info.runId === info.runId);
		const row: ChildRow = { id: this.nextId++, info, status: "running", startedAt: Date.now(), guardBlocks: 0, transcript: [], streaming: "" };
		this.rows.push(row);
		if (info.stepId && this.run?.kind === "loop") {
			for (const p of pendingAfter(info.phase)) {
				this.rows.push({
					id: this.nextId++,
					info: { ...info, phase: p.phase, agent: p.agent, seq: 0, logPath: undefined },
					status: "pending",
					startedAt: 0,
					guardBlocks: 0,
					transcript: [],
					streaming: "",
				});
			}
		}
		this.emit();
	}

	childEvent(info: ChildInfo, ev: ChildEvent): void {
		const row = this.running(info);
		if (!row) return;
		const at = Date.now();
		switch (ev.kind) {
			case "start":
				push(row, { kind: "note", at, text: `started: ${ev.argv.slice(-1)[0]?.split("\n")[0] ?? ""}`.slice(0, 200) });
				break;
			case "tool": {
				const detail = describeArgs(ev.toolName, ev.args);
				row.lastTool = `${ev.toolName}${detail ? ` ${detail}` : ""}`;
				this.flushStreaming(row, at);
				push(row, { kind: "tool", at, name: ev.toolName, detail });
				break;
			}
			case "toolEnd":
				push(row, { kind: "toolEnd", at, name: ev.toolName, isError: ev.isError, text: ev.text });
				break;
			case "textDelta":
				row.streaming = (row.streaming + ev.text).slice(-MAX_STREAMING_CHARS);
				break;
			case "text":
				row.streaming = "";
				push(row, { kind: "text", at, text: ev.text.slice(0, MAX_TEXT_CHARS) });
				break;
			case "retry":
				push(row, { kind: "retry", at, attempt: ev.attempt, message: ev.errorMessage });
				break;
			case "stderr":
				if (ev.line.includes("duker-guard[") && ev.line.includes("blocked")) row.guardBlocks++;
				push(row, { kind: "stderr", at, line: ev.line.slice(0, 500) });
				break;
			case "end":
				break;
		}
		this.emit();
	}

	childEnd(info: ChildInfo, outcome: ChildOutcome): void {
		const row = this.running(info);
		if (!row) return;
		this.flushStreaming(row, Date.now());
		row.status = outcome.ok ? "ok" : "failed";
		row.endedAt = Date.now();
		row.note = outcome.note;
		row.usage = outcome.usage;
		if (outcome.guardBlocks !== undefined) row.guardBlocks = outcome.guardBlocks;
		row.finalText = outcome.finalText;
		push(row, { kind: "note", at: row.endedAt, text: outcome.ok ? `finished${outcome.note ? ` (${outcome.note})` : ""}` : `failed: ${outcome.note ?? "?"}` });
		this.emit();
	}

	/** Bound hooks, ready to spread into a ProgressSink. */
	hooks(): ChildHooks {
		return {
			childStart: (info) => this.childStart(info),
			childEvent: (info, ev) => this.childEvent(info, ev),
			childEnd: (info, outcome) => this.childEnd(info, outcome),
		};
	}

	// ---- queries ----

	get active(): boolean {
		return !!this.run && this.run.endedAt === undefined;
	}

	runningRow(): ChildRow | undefined {
		return this.rows.find((r) => r.status === "running");
	}

	row(id: number): ChildRow | undefined {
		return this.rows.find((r) => r.id === id);
	}

	private running(info: ChildInfo): ChildRow | undefined {
		for (let i = this.rows.length - 1; i >= 0; i--) {
			const r = this.rows[i]!;
			if (r.status === "running" && r.info.runId === info.runId && r.info.seq === info.seq) return r;
		}
		return undefined;
	}

	private flushStreaming(row: ChildRow, at: number): void {
		if (!row.streaming.trim()) {
			row.streaming = "";
			return;
		}
		push(row, { kind: "text", at, text: row.streaming.slice(0, MAX_TEXT_CHARS) });
		row.streaming = "";
	}
}

function push(row: ChildRow, entry: TranscriptEntry): void {
	row.transcript.push(entry);
	if (row.transcript.length > MAX_TRANSCRIPT) row.transcript.splice(0, row.transcript.length - MAX_TRANSCRIPT);
}

function pendingAfter(phase: string): { phase: string; agent: string }[] {
	const i = PHASE_AGENTS.findIndex((p) => p.phase === phase);
	return i === -1 ? [] : PHASE_AGENTS.slice(i + 1);
}

/** One-line rendering of a tool call's key argument (same spirit as loop.ts describeTool). */
export function describeArgs(name: string, args: Record<string, unknown>): string {
	const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
	switch (name) {
		case "bash":
			return `$ ${s("command").split("\n")[0]}`.slice(0, 120);
		case "read":
		case "write":
		case "edit":
			return s("path");
		case "grep":
			return `${s("pattern")}${s("path") ? ` in ${s("path")}` : ""}`.slice(0, 120);
		case "find":
		case "ls":
			return s("path") || s("pattern");
		default: {
			const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
			return (first ?? "").split("\n")[0]!.slice(0, 120);
		}
	}
}
