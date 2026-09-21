// Shared helpers for the integration tests: throwaway git projects and a recording sink.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopOptions, PhaseInfo, ProgressSink, StepSummary } from "../../extensions/duker-loop/loop.ts";

export const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

/** Points the runtime at the fake pi and sets the scenario for the children it spawns. */
export function useFakePi(scenario: Record<string, unknown> = {}): void {
	process.env.DUKER_PI_BIN = FAKE_PI;
	process.env.FAKE_SCENARIO = JSON.stringify(scenario);
}

export const PLAN = "# Plan\n\n## Phase 1\n- 1.1 First thing: create the first file\n- 1.2 Second thing: create the second file\n- 1.3 Third thing: create the third file\n";

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

export function makeProject(opts: { git?: boolean; plan?: string } = {}): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "duker-it-"));
	fs.writeFileSync(path.join(cwd, "Full_Plan.md"), opts.plan ?? PLAN);
	fs.writeFileSync(path.join(cwd, "README.md"), "demo\n");
	if (opts.git !== false) {
		git(cwd, "init", "-q");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-qm", "init");
	}
	return cwd;
}

export function removeProject(cwd: string): void {
	fs.rmSync(cwd, { recursive: true, force: true });
}

export function commitCount(cwd: string): number {
	return Number(git(cwd, "rev-list", "--count", "HEAD"));
}

export interface RecordingSink extends ProgressSink {
	notes: string[];
	/** distinct "<step>/<round>/<phase>/<agent>" keys in order */
	phases: string[];
	steps: StepSummary[];
}

export function recordingSink(): RecordingSink {
	const sink: RecordingSink = {
		notes: [],
		phases: [],
		steps: [],
		phase(info: PhaseInfo) {
			const key = `${info.stepId}/${info.round}/${info.phase}/${info.agent}`;
			if (sink.phases[sink.phases.length - 1] !== key) sink.phases.push(key);
		},
		note(level, text) {
			sink.notes.push(`[${level}] ${text}`);
		},
		stepDone(step) {
			sink.steps.push(step);
		},
	};
	return sink;
}

export function loopOptions(cwd: string, sink: ProgressSink, extra: Partial<LoopOptions> = {}): LoopOptions {
	return { cwd, steps: 1, maxRounds: 3, maxCost: 0, childTimeoutMinutes: 0, allowDirty: false, sink, ...extra };
}
