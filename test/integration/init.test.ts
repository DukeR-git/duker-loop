// Drives runInit() end-to-end with the fake pi playing the plan-writer. No LLM involved.
// Run via `npm test` (needs the stub loader: node --import ./test/support/register.mjs).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { findPlanCandidates, formatInitResult, INIT_COMMIT_MESSAGE, type InitOptions, type InitPrompter, type InitResult, runInit } from "../../extensions/duker-loop/init.ts";
import { createState, loadState, saveState } from "../../extensions/duker-loop/state.ts";
import { commitCount, git, makeProject, PLAN, removeProject, useFakePi } from "../support/project.ts";

const projects: string[] = [];
after(() => projects.forEach(removeProject));

/** A throwaway directory: optionally a git repo, optionally with files. Not a duker project yet. */
function dir(opts: { git?: boolean; files?: Record<string, string> } = {}): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "duker-init-"));
	projects.push(cwd);
	for (const [name, content] of Object.entries(opts.files ?? {})) {
		fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
		fs.writeFileSync(path.join(cwd, name), content);
	}
	if (opts.git) {
		git(cwd, "init", "-q");
		if (Object.keys(opts.files ?? {}).length) {
			git(cwd, "add", "-A");
			git(cwd, "commit", "-qm", "init");
		}
	}
	return cwd;
}

/** Scripted dialogs: answers are consumed in order; every call is recorded. */
function scriptedUi(answers: { confirm?: boolean[]; select?: (string | undefined)[]; editor?: (string | undefined)[] } = {}): InitPrompter & { calls: string[] } {
	const confirm = [...(answers.confirm ?? [])];
	const select = [...(answers.select ?? [])];
	const editor = [...(answers.editor ?? [])];
	const ui: InitPrompter & { calls: string[] } = {
		calls: [],
		async confirm(title) {
			ui.calls.push(`confirm: ${title}`);
			assert.ok(confirm.length, `unexpected confirm: ${title}`);
			return confirm.shift()!;
		},
		async select(title, options) {
			ui.calls.push(`select: ${title} [${options.join(", ")}]`);
			assert.ok(select.length, `unexpected select: ${title}`);
			return select.shift();
		},
		async editor(title) {
			ui.calls.push(`editor: ${title}`);
			assert.ok(editor.length, `unexpected editor: ${title}`);
			return editor.shift();
		},
	};
	return ui;
}

function init(cwd: string, extra: Partial<InitOptions> = {}): Promise<InitResult> {
	return runInit({ cwd, childTimeoutMinutes: 0, ...extra });
}

const statusOf = (r: InitResult, label: string) => r.checks.filter((c) => c.label === label).map((c) => c.status);
/** all details recorded under a label, joined (a label may get a warn and then a done/fail entry) */
const detailOf = (r: InitResult, label: string) => r.checks.filter((c) => c.label === label).map((c) => c.detail ?? "").join("\n");
const read = (cwd: string, f: string) => fs.readFileSync(path.join(cwd, f), "utf8");
const exists = (cwd: string, f: string) => fs.existsSync(path.join(cwd, f));

// ---------------------------------------------------------------------------------------------

test("init: valid Full_Plan.md in a plain directory → git init, Current_State.md, commit, ready", async () => {
	const cwd = dir({ files: { "Full_Plan.md": PLAN, "README.md": "demo\n", "src/a.txt": "a\n" } });
	useFakePi();
	const r = await init(cwd);

	assert.equal(r.ready, true, formatInitResult(r));
	assert.deepEqual(r.blockers, []);
	assert.equal(r.usage, undefined, "no agent ran");
	assert.deepEqual(statusOf(r, "git repository"), ["warn"]);
	assert.deepEqual(statusOf(r, "git init"), ["done"]);
	assert.deepEqual(statusOf(r, "Full_Plan.md"), ["ok"]);
	assert.match(detailOf(r, "Full_Plan.md"), /3 steps in 1 phase/);
	assert.deepEqual(statusOf(r, "Current_State.md"), ["done"]);
	assert.match(read(cwd, "Current_State.md"), /## Milestones/);
	assert.deepEqual(statusOf(r, "git commit"), ["done"]);
	assert.match(detailOf(r, "git commit"), /initial commit of the whole tree/);
	assert.equal(commitCount(cwd), 1);
	assert.equal(git(cwd, "log", "--format=%s", "-1"), INIT_COMMIT_MESSAGE);
	assert.equal(git(cwd, "status", "--porcelain"), "", "tree clean");
	assert.deepEqual(git(cwd, "ls-files").split("\n").sort(), ["Current_State.md", "Full_Plan.md", "README.md", "src/a.txt"]);
	const exclude = read(cwd, ".git/info/exclude");
	for (const p of [".duker/", "Full_Plan.draft.md", "Full_Plan.md.bak"]) assert.ok(exclude.includes(p), `${p} excluded`);
	assert.match(formatInitResult(r), /ready — run \/duker/);
});

test("init: idempotent on an initialised project", async () => {
	const cwd = makeProject();
	projects.push(cwd);
	useFakePi();
	const r1 = await init(cwd);
	assert.equal(r1.ready, true, formatInitResult(r1));
	const r2 = await init(cwd);
	assert.equal(r2.ready, true, formatInitResult(r2));
	assert.deepEqual(statusOf(r2, "Current_State.md"), ["ok"]);
	assert.deepEqual(statusOf(r2, "git commit"), ["ok"]);
	assert.equal(commitCount(cwd), 2, "init + one init commit (Current_State.md); second run commits nothing");
});

test("init: no Full_Plan.md, one candidate, user confirms → plan-writer converts it", async () => {
	const cwd = dir({ files: { "PLAN.md": "# Plan\n1. build the parser\n2. build the cli\n3. write docs\n", "README.md": "x\n" } });
	useFakePi();
	const ui = scriptedUi({ confirm: [true] });
	const r = await init(cwd, { ui });

	assert.equal(r.ready, true, formatInitResult(r));
	assert.deepEqual(ui.calls, ["confirm: Convert PLAN.md into Full_Plan.md?"]);
	assert.ok(r.usage && r.usage.turns === 1, "plan-writer usage recorded");
	assert.match(r.planWriterSummary ?? "", /3 steps/);
	assert.deepEqual(statusOf(r, "Full_Plan.md"), ["done"]);
	assert.match(detailOf(r, "Full_Plan.md"), /written from PLAN\.md: 3 steps in 1 phase/);
	const plan = read(cwd, "Full_Plan.md");
	assert.match(plan, /- 1\.1 build the parser/);
	assert.match(plan, /- 1\.3 write docs/);
	assert.equal(exists(cwd, "Full_Plan.draft.md"), false, "draft moved into place");
	assert.equal(exists(cwd, "Full_Plan.md.bak"), false, "nothing to back up");
	assert.ok(exists(cwd, "PLAN.md"), "source untouched");
	assert.equal(git(cwd, "status", "--porcelain"), "");
	const runs = fs.readdirSync(path.join(cwd, ".duker", "runs"));
	assert.equal(runs.length, 1);
	assert.match(runs[0]!, /^init-/);
	assert.ok(exists(cwd, `.duker/runs/${runs[0]}/1-plan-writer.jsonl`));
});

test("init: malformed Full_Plan.md in a repo → confirm, rewrite, backup kept, only plan files committed", async () => {
	const cwd = dir({ git: true, files: { "Full_Plan.md": "# Roadmap\n- build it\n- ship it\n", "README.md": "x\n" } });
	fs.writeFileSync(path.join(cwd, "untracked.txt"), "later\n");
	useFakePi();
	const ui = scriptedUi({ confirm: [true] });
	const r = await init(cwd, { ui });

	assert.deepEqual(ui.calls, ["confirm: Replace Full_Plan.md?"]);
	assert.deepEqual(statusOf(r, "Full_Plan.md"), ["warn", "done"]);
	assert.match(detailOf(r, "Full_Plan.md"), /not in the loop's format: no numbered step items/);
	assert.match(read(cwd, "Full_Plan.md"), /- 1\.1 build it/);
	assert.equal(read(cwd, "Full_Plan.md.bak"), "# Roadmap\n- build it\n- ship it\n");
	assert.equal(commitCount(cwd), 2);
	assert.match(detailOf(r, "git commit"), /plan files/);
	assert.deepEqual(git(cwd, "show", "--stat", "--format=", "HEAD").split("\n").filter((l) => l.includes("|")).map((l) => l.trim().split(" ")[0]).sort(), ["Current_State.md", "Full_Plan.md"]);
	assert.equal(r.ready, false, "the unrelated untracked file keeps the tree dirty");
	assert.match(r.blockers.join("\n"), /working tree is dirty/);
	assert.match(detailOf(r, "working tree"), /untracked\.txt/);
	assert.doesNotMatch(detailOf(r, "working tree"), /Full_Plan\.md\.bak/, "backup is git-excluded");
});

test("init: malformed Full_Plan.md, declined → untouched, not ready", async () => {
	const cwd = dir({ git: true, files: { "Full_Plan.md": "just prose\n" } });
	useFakePi();
	const r = await init(cwd, { ui: scriptedUi({ confirm: [false] }) });
	assert.equal(r.ready, false);
	assert.equal(read(cwd, "Full_Plan.md"), "just prose\n");
	assert.match(r.blockers.join("\n"), /not in the loop's format/);
	assert.equal(r.usage, undefined, "plan-writer not run");
});

test("init: non-interactive never asks, never overwrites", async () => {
	const cwd = dir({ git: true, files: { "Full_Plan.md": "just prose\n", "docs/roadmap.md": "- a\n- b\n" } });
	useFakePi();
	const r = await init(cwd);
	assert.equal(r.ready, false);
	assert.equal(read(cwd, "Full_Plan.md"), "just prose\n");
	assert.match(detailOf(r, "Full_Plan.md"), /run \/duker init interactively/);
	assert.equal(r.usage, undefined);

	// missing plan + candidates → told which command to run
	fs.unlinkSync(path.join(cwd, "Full_Plan.md"));
	const r2 = await init(cwd);
	assert.equal(r2.ready, false);
	assert.match(detailOf(r2, "Full_Plan.md"), /\/duker init docs\/roadmap\.md/);
});

test("init: explicit path converts that document even when Full_Plan.md is valid", async () => {
	const cwd = dir({ git: true, files: { "Full_Plan.md": PLAN, "notes/next.md": "- rewrite everything\n- then celebrate\n" } });
	useFakePi();
	const ui = scriptedUi({ confirm: [true] });
	const r = await init(cwd, { ui, planPath: "notes/next.md" });
	assert.equal(r.ready, true, formatInitResult(r));
	assert.match(read(cwd, "Full_Plan.md"), /- 1\.1 rewrite everything/);
	assert.equal(read(cwd, "Full_Plan.md.bak"), PLAN);

	const r2 = await init(cwd, { ui: scriptedUi(), planPath: "nope.md" });
	assert.equal(r2.ready, false);
	assert.match(r2.blockers.join("\n"), /plan document not found: nope\.md/);
});

test("init: several candidates → select dialog", async () => {
	const cwd = dir({ files: { "ROADMAP.md": "- r1\n- r2\n", "docs/implementation_plan.md": "- i1\n- i2\n", "docs/api.md": "not a plan\n" } });
	assert.deepEqual(findPlanCandidates(cwd), ["ROADMAP.md", "docs/implementation_plan.md"]);
	useFakePi();
	const ui = scriptedUi({ select: ["docs/implementation_plan.md"] });
	const r = await init(cwd, { ui });
	assert.equal(r.ready, true, formatInitResult(r));
	assert.match(ui.calls[0]!, /^select: .*\[ROADMAP\.md, docs\/implementation_plan\.md\]$/);
	assert.match(read(cwd, "Full_Plan.md"), /- 1\.1 i1/);
});

test("init: no plan anywhere → description via editor → plan-writer drafts it", async () => {
	const cwd = dir({ files: { "README.md": "x\n" } });
	useFakePi();
	const ui = scriptedUi({ editor: ["# comment line is dropped\nA tiny CLI that greets people\nAdd a --shout flag\n"] });
	const r = await init(cwd, { ui });
	assert.equal(r.ready, true, formatInitResult(r));
	assert.equal(ui.calls.length, 1);
	assert.match(ui.calls[0]!, /^editor: /);
	const plan = read(cwd, "Full_Plan.md");
	assert.match(plan, /- 1\.1 A tiny CLI that greets people/);
	assert.match(plan, /- 1\.2 Add a --shout flag/);
	assert.doesNotMatch(plan, /comment line/);

	// empty description → nothing written
	const cwd2 = dir({ files: { "README.md": "x\n" } });
	const r2 = await init(cwd2, { ui: scriptedUi({ editor: ["# only comments\n"] }) });
	assert.equal(r2.ready, false);
	assert.equal(exists(cwd2, "Full_Plan.md"), false);
	assert.match(detailOf(r2, "Full_Plan.md"), /no description given/);
});

test("init: invalid or missing draft from the plan-writer → not ready, draft left for inspection", async () => {
	const cwd = dir({ files: { "PLAN.md": "- a\n- b\n" } });
	useFakePi({ badDraft: true });
	const r = await init(cwd, { ui: scriptedUi({ confirm: [true] }) });
	assert.equal(r.ready, false);
	assert.deepEqual(statusOf(r, "plan-writer"), ["fail"]);
	assert.match(detailOf(r, "plan-writer"), /not in the loop's format/);
	assert.ok(exists(cwd, "Full_Plan.draft.md"), "draft kept");
	assert.equal(exists(cwd, "Full_Plan.md"), false);

	useFakePi({ noDraft: true });
	const r2 = await init(cwd, { ui: scriptedUi({ confirm: [true] }) });
	assert.deepEqual(statusOf(r2, "stale draft"), ["done"], "previous draft removed first");
	assert.match(detailOf(r2, "plan-writer"), /did not write Full_Plan\.draft\.md/);

	useFakePi({ crashAgent: "plan-writer" });
	const r3 = await init(cwd, { ui: scriptedUi({ confirm: [true] }) });
	assert.match(detailOf(r3, "plan-writer"), /simulated crash|exit code/);
	assert.equal(exists(cwd, "Full_Plan.md"), false);
});

test("init: half-finished step → discard on confirm, freeze on decline", async () => {
	const cwd = makeProject();
	projects.push(cwd);
	const leftover = () => {
		fs.writeFileSync(path.join(cwd, "ISSUES.md"), "- [OPEN] (tester) a:1 — x\n");
		fs.writeFileSync(path.join(cwd, "CURRENT_PLAN.md"), "# plan\n");
		saveState(cwd, createState({ runId: "r", stepId: "1.1", title: "First thing", description: "d" }));
	};
	useFakePi();

	leftover();
	const ui = scriptedUi({ confirm: [false] });
	const r = await init(cwd, { ui });
	assert.equal(r.ready, false);
	assert.match(ui.calls[0]!, /^confirm: Discard the half-finished duker step\?/);
	assert.match(detailOf(r, "half-finished step"), /step 1\.1 — First thing at PLAN \(round 0\); temp artifacts: CURRENT_PLAN\.md, ISSUES\.md/);
	assert.ok(loadState(cwd), "state kept");
	assert.ok(exists(cwd, "ISSUES.md"));
	assert.deepEqual(statusOf(r, "Current_State.md"), ["skip"]);
	assert.equal(commitCount(cwd), 1, "nothing committed while frozen");
	assert.match(r.blockers.join("\n"), /half-finished step kept/);

	const r2 = await init(cwd, { ui: scriptedUi({ confirm: [true] }) });
	assert.equal(r2.ready, true, formatInitResult(r2));
	assert.match(detailOf(r2, "half-finished step"), /discarded CURRENT_PLAN\.md, ISSUES\.md, state\.json/);
	assert.equal(loadState(cwd), undefined);
	assert.equal(exists(cwd, "ISSUES.md"), false);

	// non-interactive: cannot discard
	leftover();
	const r3 = await init(cwd);
	assert.equal(r3.ready, false);
	assert.ok(loadState(cwd));
	assert.match(r3.blockers.join("\n"), /run \/duker clean or \/duker init interactively/);
});

test("init: agents dir without plan-writer still initialises a valid plan but cannot convert", async () => {
	const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duker-agents-"));
	projects.push(agentsDir);
	const bundled = path.join(process.cwd(), "agents");
	for (const f of fs.readdirSync(bundled)) if (f !== "plan-writer.md") fs.copyFileSync(path.join(bundled, f), path.join(agentsDir, f));

	const ok = dir({ files: { "Full_Plan.md": PLAN } });
	const r = await init(ok, { agentsDir });
	assert.equal(r.ready, true, formatInitResult(r));

	const bad = dir({ files: { "PLAN.md": "- a\n- b\n" } });
	const r2 = await init(bad, { agentsDir, ui: scriptedUi({ confirm: [true] }) });
	assert.equal(r2.ready, false);
	assert.match(detailOf(r2, "plan-writer"), /agent not found/);
});
