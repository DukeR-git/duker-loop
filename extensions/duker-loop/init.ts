/**
 * /duker init — get a project into the state the loop expects (decision #33):
 *
 *   agents load → git on PATH / repo → no half-finished step → Full_Plan.md in the right
 *   format (else convert an existing plan document or draft one from a description via the
 *   plan-writer agent) → Current_State.md exists → plan files committed on a clean tree.
 *
 * Pure orchestration, no pi imports: dialogs go through an InitPrompter so the command can
 * pass ctx.ui and the tests a scripted one. Without a prompter nothing is discarded or
 * overwritten — the result just says what is in the way.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildHooks, ChildInfo } from "./activity.ts";
import { bundledAgentsDir, discoverAgents, findAgent } from "./agents.ts";
import { artifactExists, artifactPath, checkPlanFormat, cleanTempArtifacts, ensureCurrentState, readArtifact } from "./artifacts.ts";
import { changedFiles, commitAll, commitPaths, ensureExcluded, gitAvailable, gitHead, gitInit, isGitRepo } from "./git.ts";
import { type PlanSource, planWriterPrompt } from "./prompts.ts";
import { addUsage, ChildAbortedError, type ChildResult, type ChildUsage, emptyUsage, isFailedResult, resultErrorText, runChild } from "./runtime.ts";
import { clearState, loadState, runsDir, statePath } from "./state.ts";
import { ARTIFACTS, DUKER_DIR, PLAN_BACKUP, PLAN_CANDIDATE_NAMES, PLAN_DRAFT, TEMP_ARTIFACTS, type ThinkingLevel } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** The blocking dialogs init may need; mirrors the subset of ctx.ui it uses. */
export interface InitPrompter {
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	editor(title: string, prefill: string): Promise<string | undefined>;
}

export interface InitOptions {
	cwd: string;
	/** plan document to convert into Full_Plan.md (relative to cwd or absolute); overrides discovery */
	planPath?: string;
	/** undefined → non-interactive: never asks, never discards or overwrites */
	ui?: InitPrompter;
	inheritModel?: string;
	inheritThinking?: ThinkingLevel;
	/** 0 = agent frontmatter */
	childTimeoutMinutes: number;
	signal?: AbortSignal;
	agentsDir?: string;
	/** status-line text while the plan-writer runs */
	onProgress?: (text: string) => void;
	/** feeds the live fleet view while the plan-writer runs */
	hooks?: ChildHooks;
}

export type InitStatus = "ok" | "done" | "warn" | "fail" | "skip";

export interface InitCheck {
	status: InitStatus;
	label: string;
	detail?: string;
}

export interface InitResult {
	/** true when the next /duker can start */
	ready: boolean;
	checks: InitCheck[];
	/** what still prevents the loop from starting, in user terms */
	blockers: string[];
	/** plan-writer usage, when it ran */
	usage?: ChildUsage;
	/** the plan-writer's closing summary, when it ran */
	planWriterSummary?: string;
}

export const INIT_COMMIT_MESSAGE = "duker: init";

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function runInit(opts: InitOptions): Promise<InitResult> {
	const { cwd, ui } = opts;
	const result: InitResult = { ready: false, checks: [], blockers: [] };
	const check = (status: InitStatus, label: string, detail?: string) => result.checks.push({ status, label, detail });
	const block = (why: string) => {
		if (!result.blockers.includes(why)) result.blockers.push(why);
	};

	if (!fs.existsSync(cwd)) throw new Error(`duker: directory does not exist: ${cwd}`);

	// 1. agents ------------------------------------------------------------------------------
	const agents = discoverAgents(opts.agentsDir ?? bundledAgentsDir());
	if (agents.missing.length || agents.errors.length) {
		const errs = agents.errors.map((e) => `${path.basename(e.file)}: ${e.message}`);
		check("fail", "agents", `missing: [${agents.missing.join(", ")}] errors: [${errs.join("; ")}] (${agents.agentsDir})`);
		block("agent definitions incomplete; see /duker agents");
	} else {
		check("ok", "agents", `${agents.agents.length} loaded from ${agents.agentsDir}`);
	}
	const planWriter = findAgent(agents, "plan-writer");

	// 2. git ---------------------------------------------------------------------------------
	const gitOk = await gitAvailable();
	let repo = gitOk && (await isGitRepo(cwd));
	if (!gitOk) check("warn", "git", "not on PATH — no per-step commits, no diff-based review, no dirty-tree protection");
	else check(repo ? "ok" : "warn", "git repository", repo ? "yes" : "not a repository yet (will run git init)");

	// 3. half-finished step ------------------------------------------------------------------
	let state: ReturnType<typeof loadState>;
	let corruptState = false;
	try {
		state = loadState(cwd);
	} catch {
		corruptState = true;
	}
	const temp = TEMP_ARTIFACTS.filter((f) => fs.existsSync(path.join(cwd, f)));
	/** a kept half-finished step freezes everything that mutates: no plan rewrite, no commit */
	let frozen = false;
	if (state || corruptState || temp.length) {
		const what = [
			state ? `step ${state.stepId} — ${state.title} at ${state.phase} (round ${state.round})` : corruptState ? `unreadable ${path.relative(cwd, statePath(cwd))}` : undefined,
			temp.length ? `temp artifacts: ${temp.join(", ")}` : undefined,
		]
			.filter(Boolean)
			.join("; ");
		const discard = ui ? await ui.confirm("Discard the half-finished duker step?", `${what}\n\nCode changes stay; only the loop's temp files and state are deleted (same as /duker clean).`) : false;
		if (discard) {
			const deleted = cleanTempArtifacts(cwd);
			const hadState = clearState(cwd);
			check("done", "half-finished step", `discarded ${[...deleted, ...(hadState || corruptState ? ["state.json"] : [])].join(", ")}`);
		} else {
			frozen = true;
			check("fail", "half-finished step", what);
			block(ui ? "half-finished step kept; run /duker to resume it or /duker clean to discard it" : "half-finished step present; run /duker clean or /duker init interactively");
		}
	} else {
		check("ok", "no half-finished step");
	}
	if (!frozen && fs.existsSync(path.join(cwd, PLAN_DRAFT))) {
		fs.unlinkSync(path.join(cwd, PLAN_DRAFT));
		check("done", "stale draft", `deleted ${PLAN_DRAFT}`);
	}

	// 4. Full_Plan.md ------------------------------------------------------------------------
	const existing = readArtifact(cwd, "fullPlan");
	const existingCheck = existing === undefined ? undefined : checkPlanFormat(existing);
	let source: PlanSource | undefined;

	if (frozen) {
		if (existingCheck?.ok) check("ok", ARTIFACTS.fullPlan, describePlan(existingCheck));
		else check("skip", ARTIFACTS.fullPlan, `${existingCheck ? `not in the loop's format: ${existingCheck.problems.join("; ")}` : "missing"} — not touched while a step is in progress`);
	} else if (opts.planPath) {
		const abs = path.resolve(cwd, opts.planPath);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
			check("fail", ARTIFACTS.fullPlan, `plan document not found: ${opts.planPath}`);
			block(`plan document not found: ${opts.planPath}`);
		} else {
			source = { kind: "file", path: relPath(cwd, abs) };
		}
	} else if (existingCheck?.ok) {
		check("ok", ARTIFACTS.fullPlan, describePlan(existingCheck));
		for (const w of existingCheck.warnings) check("warn", ARTIFACTS.fullPlan, w);
		const candidates = findPlanCandidates(cwd);
		if (candidates.length) check("skip", "other plan documents", `${candidates.join(", ")} — ignored; /duker init <path> converts one`);
	} else if (existingCheck) {
		check("warn", ARTIFACTS.fullPlan, `present but not in the loop's format: ${existingCheck.problems.join("; ")}`);
		source = { kind: "file", path: ARTIFACTS.fullPlan };
	} else {
		source = await chooseSource(cwd, ui, check, block);
	}

	if (source) await writePlan(opts, source, planWriter, existing !== undefined, result, check, block);

	// 5. Current_State.md --------------------------------------------------------------------
	if (artifactExists(cwd, "currentState")) check("ok", ARTIFACTS.currentState, "present");
	else if (frozen) check("skip", ARTIFACTS.currentState, "missing — not created while a step is in progress");
	else if (ensureCurrentState(cwd)) check("done", ARTIFACTS.currentState, "created");

	// 6. git init + commit -------------------------------------------------------------------
	if (gitOk && !frozen && !opts.signal?.aborted) {
		if (!repo) {
			const r = await gitInit(cwd);
			if (r.error) {
				check("fail", "git init", r.error);
				block(`git init failed: ${r.error}`);
			} else {
				check("done", "git init", "created repository");
				repo = true;
			}
		}
		if (repo) {
			const excluded: string[] = [];
			for (const pattern of [`${DUKER_DIR}/`, PLAN_DRAFT, PLAN_BACKUP]) if (await ensureExcluded(cwd, pattern)) excluded.push(pattern);
			if (excluded.length) check("done", ".git/info/exclude", `added ${excluded.join(", ")}`);

			const fresh = (await gitHead(cwd)) === undefined;
			const r = fresh ? await commitAll(cwd, INIT_COMMIT_MESSAGE) : await commitPaths(cwd, [ARTIFACTS.fullPlan, ARTIFACTS.currentState], INIT_COMMIT_MESSAGE);
			if (r.error) {
				check("fail", "git commit", r.error);
				block(`git commit failed: ${r.error}`);
			} else if (r.sha) {
				check("done", "git commit", `${r.sha.slice(0, 10)} "${INIT_COMMIT_MESSAGE}" (${fresh ? "initial commit of the whole tree" : "plan files"})`);
			} else {
				check("ok", "git commit", "plan files already committed");
			}

			const dirty = await changedFiles(cwd, [ARTIFACTS.currentState]);
			if (dirty.length) {
				check("warn", "working tree", `${dirty.length} uncommitted change(s): ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}`);
				block("working tree is dirty; commit/stash first or pass --duker-allow-dirty");
			} else {
				check("ok", "working tree", "clean");
			}
		}
	}

	if (!artifactExists(cwd, "fullPlan")) block(`${ARTIFACTS.fullPlan} missing`);
	result.ready = result.blockers.length === 0;
	return result;
}

// ---------------------------------------------------------------------------------------------
// Plan discovery / conversion
// ---------------------------------------------------------------------------------------------

const NOT_CANDIDATES = new Set<string>([ARTIFACTS.fullPlan, PLAN_DRAFT, PLAN_BACKUP, ...TEMP_ARTIFACTS].map((f) => f.toLowerCase()));

/** Plan-looking markdown files in cwd and docs/ (known names, or `plan`/`roadmap` in the name). */
export function findPlanCandidates(cwd: string): string[] {
	const known = new Set(PLAN_CANDIDATE_NAMES.map((n) => n.toLowerCase()));
	const out: string[] = [];
	for (const dir of ["", "docs"]) {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isFile()) continue;
			const lower = e.name.toLowerCase();
			if (!lower.endsWith(".md") || NOT_CANDIDATES.has(lower)) continue;
			if (known.has(lower) || /plan|roadmap/.test(lower)) out.push(dir ? `${dir}/${e.name}` : e.name);
		}
	}
	return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

async function chooseSource(
	cwd: string,
	ui: InitPrompter | undefined,
	check: (s: InitStatus, l: string, d?: string) => void,
	block: (why: string) => void,
): Promise<PlanSource | undefined> {
	const candidates = findPlanCandidates(cwd);
	if (candidates.length === 1) {
		const c = candidates[0]!;
		if (!ui) {
			check("fail", ARTIFACTS.fullPlan, `missing; found ${c} — run /duker init ${c} to convert it`);
			block(`${ARTIFACTS.fullPlan} missing; /duker init ${c} converts the plan found`);
			return undefined;
		}
		if (await ui.confirm(`Convert ${c} into ${ARTIFACTS.fullPlan}?`, `No ${ARTIFACTS.fullPlan} found. The plan-writer agent will read ${c} and the codebase and write a phased, numbered roadmap.`)) {
			return { kind: "file", path: c };
		}
		check("fail", ARTIFACTS.fullPlan, `missing; conversion of ${c} declined`);
		block(`${ARTIFACTS.fullPlan} missing`);
		return undefined;
	}
	if (candidates.length > 1) {
		if (!ui) {
			check("fail", ARTIFACTS.fullPlan, `missing; candidates: ${candidates.join(", ")} — run /duker init <path> to convert one`);
			block(`${ARTIFACTS.fullPlan} missing; several plan documents found, pass one to /duker init <path>`);
			return undefined;
		}
		const picked = await ui.select(`No ${ARTIFACTS.fullPlan} — convert which document?`, candidates);
		if (picked) return { kind: "file", path: picked };
		check("fail", ARTIFACTS.fullPlan, "missing; no document selected");
		block(`${ARTIFACTS.fullPlan} missing`);
		return undefined;
	}
	if (!ui) {
		check("fail", ARTIFACTS.fullPlan, "missing and no plan document found — write one, or run /duker init interactively to describe the project");
		block(`${ARTIFACTS.fullPlan} missing`);
		return undefined;
	}
	const text = await ui.editor(
		`No plan found — describe the project and the plan-writer drafts ${ARTIFACTS.fullPlan}`,
		"# What is this project, what should exist when it is done, and in what order?\n# (lines starting with # are ignored; leave empty to cancel)\n",
	);
	const description = (text ?? "")
		.split(/\r?\n/)
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n")
		.trim();
	if (!description) {
		check("fail", ARTIFACTS.fullPlan, "missing; no description given");
		block(`${ARTIFACTS.fullPlan} missing`);
		return undefined;
	}
	return { kind: "description", text: description };
}

/** Runs the plan-writer, validates its draft and moves it into place. Returns true on success. */
async function writePlan(
	opts: InitOptions,
	source: PlanSource,
	planWriter: ReturnType<typeof findAgent>,
	replacing: boolean,
	result: InitResult,
	check: (s: InitStatus, l: string, d?: string) => void,
	block: (why: string) => void,
): Promise<boolean> {
	const { cwd, ui } = opts;
	const from = source.kind === "file" ? source.path : "your description";
	if (!planWriter) {
		check("fail", "plan-writer", "agent not found; cannot write the plan");
		block(`${ARTIFACTS.fullPlan} not written: plan-writer agent missing`);
		return false;
	}
	if (replacing) {
		const ok = ui ? await ui.confirm(`Replace ${ARTIFACTS.fullPlan}?`, `The plan-writer will rewrite it from ${from}. The current file is kept as ${PLAN_BACKUP}.`) : false;
		if (!ok) {
			check("fail", ARTIFACTS.fullPlan, ui ? "replacement declined" : `needs replacing (from ${from}); run /duker init interactively to confirm`);
			block(`${ARTIFACTS.fullPlan} is not in the loop's format`);
			return false;
		}
	}

	const runId = `init-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const logPath = path.join(runsDir(cwd, runId), "1-plan-writer.jsonl");
	const info: ChildInfo = { runId, phase: "init", round: 0, agent: planWriter.name, seq: 1, logPath };
	const started = Date.now();
	const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
	opts.onProgress?.(`duker init · plan-writer ⏳ starting`);
	opts.hooks?.childStart(info);
	let r: ChildResult;
	try {
		r = await runChild({
			agent: planWriter,
			task: planWriterPrompt(source),
			cwd,
			inheritModel: opts.inheritModel,
			inheritThinking: opts.inheritThinking,
			timeoutMinutes: opts.childTimeoutMinutes,
			logPath,
			signal: opts.signal,
			extraEnv: { DUKER_RUN_ID: runId },
			onEvent: (ev) => {
				if (ev.kind === "tool") opts.onProgress?.(`duker init · plan-writer ⏳ ${elapsed()} · ${ev.toolName}`);
				else if (ev.kind === "text") opts.onProgress?.(`duker init · plan-writer ⏳ ${elapsed()} · responding`);
				opts.hooks?.childEvent(info, ev);
			},
		});
	} catch (err) {
		opts.hooks?.childEnd(info, { ok: false, note: err instanceof ChildAbortedError ? "aborted" : (err as Error).message });
		throw err;
	}
	opts.hooks?.childEnd(info, { ok: !isFailedResult(r), note: isFailedResult(r) ? resultErrorText(r) : undefined, usage: r.usage, guardBlocks: r.guardBlocks, finalText: r.finalText });
	result.usage = addUsage(result.usage ?? emptyUsage(), r.usage);
	result.planWriterSummary = r.finalText || undefined;
	const log = path.relative(cwd, logPath);
	if (isFailedResult(r)) {
		check("fail", "plan-writer", `${resultErrorText(r)} (log: ${log})`);
		block(`${ARTIFACTS.fullPlan} not written: plan-writer failed`);
		return false;
	}

	const draftPath = path.join(cwd, PLAN_DRAFT);
	let draft: string | undefined;
	try {
		draft = fs.readFileSync(draftPath, "utf8");
	} catch {
		/* not written */
	}
	if (draft === undefined) {
		check("fail", "plan-writer", `did not write ${PLAN_DRAFT} (log: ${log})`);
		block(`${ARTIFACTS.fullPlan} not written`);
		return false;
	}
	const draftCheck = checkPlanFormat(draft);
	if (!draftCheck.ok) {
		check("fail", "plan-writer", `${PLAN_DRAFT} is not in the loop's format: ${draftCheck.problems.join("; ")} — left in place for inspection (log: ${log})`);
		block(`${ARTIFACTS.fullPlan} not written: draft invalid`);
		return false;
	}

	if (replacing) fs.renameSync(artifactPath(cwd, "fullPlan"), path.join(cwd, PLAN_BACKUP));
	fs.renameSync(draftPath, artifactPath(cwd, "fullPlan"));
	check("done", ARTIFACTS.fullPlan, `written from ${from}: ${describePlan(draftCheck)}${replacing ? `; previous kept as ${PLAN_BACKUP}` : ""}`);
	for (const w of draftCheck.warnings) check("warn", ARTIFACTS.fullPlan, w);
	return true;
}

function describePlan(c: { ids: string[]; phases: number }): string {
	const top = new Set(c.ids.map((id) => id.split(".")[0]));
	return `${c.ids.length} steps in ${c.phases || top.size} phase(s)`;
}

function relPath(cwd: string, abs: string): string {
	const rel = path.relative(cwd, abs);
	return rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel.replace(/\\/g, "/");
}

/** Plain-text rendering used by the command output. */
export function formatInitResult(r: InitResult): string {
	const icon: Record<InitStatus, string> = { ok: "✓", done: "✓", warn: "!", fail: "✗", skip: "-" };
	const lines = r.checks.map((c) => `${icon[c.status]} ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
	if (r.planWriterSummary) lines.push("", `plan-writer: ${r.planWriterSummary}`);
	lines.push("", r.ready ? "ready — run /duker to execute the first step" : `not ready:\n${r.blockers.map((b) => `  • ${b}`).join("\n")}`);
	return lines.join("\n");
}
