/**
 * Task prompts per phase — the positional prompt each child receives. Agents read the artifact
 * files themselves; the prompt only tells them which step, which files, and which mode.
 * Every prompt starts with "Task:" so it can never be mistaken for a CLI flag.
 */
import { ARTIFACTS, PLAN_DRAFT } from "./types.ts";

const ISSUE_FORMAT = `Entries in ${ARTIFACTS.issues} must be exactly \`- [OPEN|FIXED|NOTE] (author) <file:line> — <text>\`, one per line, details indented by two spaces.`;

export interface StepRef {
	id: string;
	title: string;
	description: string;
}

export function orchestratorPrompt(): string {
	return [
		"Task: select the next step to execute.",
		`Read ${ARTIFACTS.fullPlan} and ${ARTIFACTS.currentState} in the current directory (use the read tool with these exact file names).`,
		"Apply the selection procedure from your instructions and answer in the strict four-line format (STEP / TITLE / DESCRIPTION / REASON) and nothing else.",
	].join("\n");
}

export function plannerPrompt(step: StepRef, round: number): string {
	if (round === 0) {
		return [
			`Task: mode initial — write ${ARTIFACTS.currentPlan} for the following step.`,
			`Step id: ${step.id}`,
			`Title: ${step.title}`,
			`Description: ${step.description}`,
			`Read ${ARTIFACTS.currentState} for the current shape of the codebase, investigate the code, then write ${ARTIFACTS.currentPlan} in the required structure. Do not modify any other file.`,
		].join("\n");
	}
	return [
		`Task: mode fix — write ${ARTIFACTS.fixingPlan} (fix round ${round}) for step ${step.id} — ${step.title}.`,
		`Read ${ARTIFACTS.report} (verdict + summary), ${ARTIFACTS.issues} (every [OPEN] entry must be addressed), ${ARTIFACTS.currentPlan} (the original plan)${round > 1 ? ` and the previous ${ARTIFACTS.fixingPlan}` : ""}.`,
		`Then write ${ARTIFACTS.fixingPlan} (overwrite) in the required structure with a root-cause fix for each [OPEN] issue. Do not modify any other file.`,
	].join("\n");
}

export function implementerPrompt(step: StepRef, round: number, planFile: string): string {
	return [
		`Task: implement ${planFile} for step ${step.id} — ${step.title}${round > 0 ? ` (fix round ${round})` : ""}.`,
		`Read ${planFile} first${round > 0 ? `, then ${ARTIFACTS.issues} and ${ARTIFACTS.currentPlan} for context` : ""}. Implement every item under "## Changes" exactly, run the "## Verification" commands, and fix failures caused by your changes.`,
		round > 0
			? `For every [OPEN] issue you fix, change its tag to [FIXED] in ${ARTIFACTS.issues} and append " (fixed: <what you did>)" to that line.`
			: `Log out-of-scope findings to ${ARTIFACTS.issues} as [NOTE] entries; do not fix them.`,
		ISSUE_FORMAT,
		"Finish with the report format from your instructions.",
	].join("\n");
}

export function testerPrompt(step: StepRef, planFile: string): string {
	return [
		`Task: validate the implementation of ${planFile} for step ${step.id} — ${step.title} by running the project's checks.`,
		`Read ${planFile}, especially "## Verification". Discover the project's real build/lint/test commands, run them, add the tests the plan asks for if they are missing, run again.`,
		`Append one [OPEN] (tester) entry per distinct failure to ${ARTIFACTS.issues}; write nothing there if everything passes. ${ISSUE_FORMAT}`,
		"You may only write ISSUES.md and test files. Finish with the report format from your instructions.",
	].join("\n");
}

const LOOP_OWNED = [ARTIFACTS.fullPlan, ARTIFACTS.currentState, ARTIFACTS.currentPlan, ARTIFACTS.fixingPlan, ARTIFACTS.issues, ARTIFACTS.report, ".duker/"];

export function reviewerPrompt(step: StepRef, planFile: string, material: { kind: "diff"; sha: string } | { kind: "files"; files: string[] }): string {
	const scope =
		material.kind === "diff"
			? `Review material: first run \`git status --short\` — files marked \`??\` are new, read them in full; then run \`git diff ${material.sha}\` for the modified files (working tree vs. the commit at step start). Review only those changes.`
			: `Review material: the files named in ${planFile} under "## Changes"${material.files.length ? `: ${material.files.join(", ")}` : ""}. Review only those files.`;
	return [
		`Task: static review of the implementation of ${planFile} for step ${step.id} — ${step.title}.`,
		`Read ${planFile} for the intent${planFile !== ARTIFACTS.currentPlan ? ` and ${ARTIFACTS.currentPlan} for the original plan` : ""}, then read ${ARTIFACTS.issues} (verify any [FIXED] entries against the code).`,
		scope,
		`Ignore entirely — they are owned by the duker loop, not by the implementer: ${LOOP_OWNED.join(", ")}. Also ignore build caches and generated artifacts (e.g. __pycache__, *.pyc, node_modules, dist, coverage) unless the plan is about them.`,
		`Append findings to ${ARTIFACTS.issues}: [OPEN] (reviewer) only for must-fix problems, [NOTE] (reviewer) for the rest; write nothing if there is nothing to report. ${ISSUE_FORMAT}`,
		"Do not modify any other file. Finish with at most 5 summary lines and the Verdict line.",
	].join("\n");
}

export function reporterPrompt(step: StepRef, round: number): string {
	return [
		`Task: write ${ARTIFACTS.report} for step ${step.id} — ${step.title}${round > 0 ? ` after fix round ${round}` : ""}.`,
		`Read ${ARTIFACTS.issues}, ${ARTIFACTS.currentPlan}${round > 0 ? ` and ${ARTIFACTS.fixingPlan}` : ""}. Apply the verdict rules: any [OPEN] entry ⇒ FAIL, otherwise PASS.`,
		`Write ${ARTIFACTS.report} (overwrite) with \`VERDICT: PASS\` or \`VERDICT: FAIL\` as its very first line, then the Summary / Open issues / Notes sections.`,
		"Do not modify any other file. Your final chat message is the single VERDICT line.",
	].join("\n");
}

export function stateUpdaterPrompt(step: StepRef, date: string): string {
	return [
		`Task: record step ${step.id} — ${step.title} as done in ${ARTIFACTS.currentState}.`,
		`Today's date: ${date}. Append exactly \`- [DONE] ${step.id} — ${step.title} (${date})\` under "## Milestones", then update the prose sections describing the codebase to reflect what the step changed.`,
		`Read ${ARTIFACTS.currentPlan}, ${ARTIFACTS.report}, ${ARTIFACTS.fixingPlan} (if present) and the touched code to describe what now exists. Do not modify any other file.`,
	].join("\n");
}

/** What /duker init hands the plan-writer: a document to convert or a description to plan from. */
export type PlanSource = { kind: "file"; path: string } | { kind: "description"; text: string };

export function planWriterPrompt(source: PlanSource): string {
	const common = [
		`Investigate the codebase first (layout, language, build/test commands, what already exists), then write ${PLAN_DRAFT} in the required structure: phases as \`## Phase N — name\`, one bullet per step starting with \`- <phase>.<item> <Title>:\`, each ending with a \`Done when:\` criterion.`,
		`Write only ${PLAN_DRAFT}; do not modify any other file. Finish with the one-paragraph summary from your instructions.`,
	];
	if (source.kind === "file") {
		return [
			`Task: convert the existing plan document \`${source.path}\` into ${PLAN_DRAFT}.`,
			`Read \`${source.path}\` in full. Keep its intent and ordering; drop what is already implemented, merge duplicates, split oversized items, and renumber everything into the <phase>.<item> scheme.`,
			...common,
		].join("\n");
	}
	return [
		`Task: write ${PLAN_DRAFT} — a phased, numbered roadmap for this project — from the description below.`,
		...common,
		"",
		"Project description:",
		source.text.trim(),
	].join("\n");
}

/** Best-effort list of file paths mentioned in a plan's "## Changes" section (non-git fallback). */
export function planChangedFiles(planText: string | undefined): string[] {
	if (!planText) return [];
	const section = /##\s*Changes([\s\S]*?)(?:\n##\s|$)/i.exec(planText)?.[1] ?? "";
	const files = new Set<string>();
	for (const m of section.matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`/g)) files.add(m[1]!);
	return [...files];
}
