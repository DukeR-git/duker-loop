/**
 * Formatting + TUI rendering for the duker_loop tool row and the transcript notes
 * (IMPLEMENTATION_PLAN.md §9).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { LoopSummary, PhaseInfo, StepSummary } from "./loop.ts";
import { type ChildUsage, formatDuration } from "./runtime.ts";

/** `details` of a duker_loop tool result (partial while running, final at the end). */
export interface DukerDetails {
	cwd: string;
	steps: number;
	startedAt: string;
	current?: PhaseInfo;
	notes: string[];
	stepsDone: StepSummary[];
	summary?: LoopSummary;
}

export function formatPhase(info: PhaseInfo): string {
	const round = info.round > 0 ? ` · fix ${info.round}` : "";
	const agent = info.agent ? ` · ${info.agent} ⏳ ${formatDuration(info.elapsedMs)}` : "";
	const detail = info.detail ? ` · ${info.detail}` : "";
	return `duker ${info.stepId}${round} · ${info.phase}${agent}${detail}`;
}

export function formatUsage(u: ChildUsage): string {
	return `${u.turns} turns · ↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)} tokens · $${u.cost.toFixed(4)}`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function stepIcon(outcome: StepSummary["outcome"]): string {
	return outcome === "passed" ? "✓" : outcome === "halted" ? "✗" : "◌";
}

export function formatStepLine(step: StepSummary): string {
	return `${stepIcon(step.outcome)} step ${step.stepId} — ${step.title}: ${step.outcome} after ${step.rounds} fix round(s), ${formatDuration(step.durationMs)}${step.commit ? `, commit ${step.commit.slice(0, 10)}` : ""}${step.reason ? ` — ${step.reason}` : ""}`;
}

export function formatPhaseChain(step: StepSummary): string {
	return step.phases.map((p) => `${p.phase}${p.agent ? `(${p.agent})` : ""}${p.ok ? "" : "✗"} ${formatDuration(p.ms)}`).join(" → ");
}

export function summaryTitle(s: LoopSummary): string {
	const passed = s.steps.filter((x) => x.outcome === "passed").length;
	switch (s.stopped) {
		case "steps-done":
			return `duker: ${passed} step(s) passed`;
		case "plan-complete":
			return `duker: Full_Plan.md complete (${passed} step(s) passed this run)`;
		case "halted":
			return `duker: halted after ${passed} passed step(s)`;
		case "aborted":
			return `duker: aborted after ${passed} passed step(s)`;
	}
}

export function formatLoopSummary(s: LoopSummary, notes: string[]): { title: string; body: string } {
	const lines = [
		`${formatDuration(s.durationMs)} · ${formatUsage(s.usage)}`,
		...(s.reason ? [`reason: ${s.reason}`] : []),
		...s.steps.map((st) => `${formatStepLine(st)}\n    ${formatPhaseChain(st)}`),
		...(notes.length ? ["", ...notes] : []),
	];
	return { title: summaryTitle(s), body: lines.join("\n") };
}

/** Text the parent model receives from the duker_loop tool. */
export function formatToolContent(s: LoopSummary, notes: string[]): string {
	const lines = [summaryTitle(s), `Duration ${formatDuration(s.durationMs)}, ${formatUsage(s.usage)}.`];
	if (s.reason) lines.push(`Reason: ${s.reason}`);
	for (const st of s.steps) lines.push(formatStepLine(st));
	const important = notes.filter((n) => /\[(warning|error)\]/.test(n));
	if (important.length) lines.push("", "Warnings:", ...important.map((n) => `- ${n.replace(/^\S+ /, "")}`));
	if (s.stopped === "halted") {
		lines.push("", "The step's artifacts (CURRENT_PLAN.md, FIXING_PLAN.md, ISSUES.md, CURRENT_REPORT.md) and code changes were left in place for inspection. Re-running duker_loop resumes the step; /duker clean discards it.");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// TUI renderers
// ---------------------------------------------------------------------------------------------

export function renderCall(args: { steps?: number; cwd?: string }, theme: Theme): Text {
	const steps = args.steps ?? 1;
	let text = `${theme.fg("toolTitle", theme.bold("duker_loop"))} ${theme.fg("accent", `${steps} step${steps === 1 ? "" : "s"}`)}`;
	if (args.cwd) text += ` ${theme.fg("muted", args.cwd)}`;
	return new Text(text, 0, 0);
}

export function renderResult(
	details: DukerDetails | undefined,
	fallbackText: string,
	opts: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Container | Text {
	if (!details) return new Text(fallbackText, 0, 0);
	const c = new Container();
	const add = (s: string) => c.addChild(new Text(s, 0, 0));

	if (opts.isPartial || !details.summary) {
		const cur = details.current;
		add(cur ? theme.fg("accent", formatPhase(cur)) : theme.fg("dim", "duker ⏳ starting"));
		for (const st of details.stepsDone) add(theme.fg(st.outcome === "passed" ? "success" : "error", formatStepLine(st)));
		if (opts.expanded) for (const n of details.notes.slice(-15)) add(theme.fg("dim", n));
		return c;
	}

	const s = details.summary;
	const color = s.stopped === "halted" ? "error" : s.stopped === "aborted" ? "warning" : "success";
	add(theme.fg(color, theme.bold(summaryTitle(s))));
	add(theme.fg("dim", `${formatDuration(s.durationMs)} · ${formatUsage(s.usage)}`));
	if (s.reason) add(theme.fg("warning", `reason: ${s.reason}`));
	for (const st of s.steps) {
		add(theme.fg(st.outcome === "passed" ? "success" : "error", formatStepLine(st)));
		if (opts.expanded) add(theme.fg("dim", `    ${formatPhaseChain(st)}`));
	}
	if (opts.expanded) {
		for (const n of details.notes) add(theme.fg(/\[error\]/.test(n) ? "error" : /\[warning\]/.test(n) ? "warning" : "dim", n));
	} else if (details.notes.length) {
		add(theme.fg("dim", `(${details.notes.length} note(s) — Ctrl+O to expand)`));
	}
	return c;
}
