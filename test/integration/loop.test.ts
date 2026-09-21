// Drives runLoop() end-to-end with the fake pi (test/support/fake-pi.mjs). No LLM involved.
// Run via `npm test` (needs the stub loader: node --import ./test/support/register.mjs).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { runLoop } from "../../extensions/duker-loop/loop.ts";
import { loadState } from "../../extensions/duker-loop/state.ts";
import { commitCount, git, loopOptions, makeProject, recordingSink, removeProject, useFakePi } from "../support/project.ts";

const TEMP = ["CURRENT_PLAN.md", "FIXING_PLAN.md", "ISSUES.md", "CURRENT_REPORT.md"];
const projects: string[] = [];
const project = (opts?: Parameters<typeof makeProject>[0]) => {
	const cwd = makeProject(opts);
	projects.push(cwd);
	return cwd;
};
after(() => projects.forEach(removeProject));

test("clean pass: three steps, then plan-complete", async () => {
	const cwd = project();
	useFakePi();
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink, { steps: 4 }));

	assert.equal(r.stopped, "plan-complete");
	assert.equal(r.steps.length, 3);
	assert.ok(r.steps.every((s) => s.outcome === "passed" && s.rounds === 0));
	assert.equal(commitCount(cwd), 4, "init + one commit per step");
	assert.equal(git(cwd, "log", "--format=%s", "-3"), "duker(1.3): Third thing\nduker(1.2): Second thing\nduker(1.1): First thing");
	const state = fs.readFileSync(path.join(cwd, "Current_State.md"), "utf8");
	for (const id of ["1.1", "1.2", "1.3"]) assert.match(state, new RegExp(`- \\[DONE\\] ${id.replace(".", "\\.")} —`));
	assert.ok(TEMP.every((f) => !fs.existsSync(path.join(cwd, f))), "temp artifacts cleaned");
	assert.equal(loadState(cwd), undefined);
	assert.equal(git(cwd, "status", "--porcelain"), "", "tree clean after run");
	assert.match(fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8"), /\.duker\//);
	assert.equal(sink.phases.slice(0, 7).map((p) => p.split("/")[2]).join(">"), "SELECT>PLAN>IMPLEMENT>TEST>REVIEW>REPORT>PERSIST");
	assert.equal(r.usage.turns, 21, "7 agents × 3 steps");
	assert.ok(r.usage.cost > 0.02);

	const runs = fs.readdirSync(path.join(cwd, ".duker", "runs"));
	const withSummary = runs.filter((d) => fs.existsSync(path.join(cwd, ".duker", "runs", d, "summary.json")));
	assert.equal(runs.length, 4, "3 step runs + the final select-only run");
	assert.equal(withSummary.length, 3);
	for (const d of withSummary) {
		const logs = fs.readdirSync(path.join(cwd, ".duker", "runs", d)).filter((f) => f.endsWith(".jsonl"));
		assert.equal(logs.length, 7, `one JSONL log per agent in ${d}`);
	}
});

test("two failing validations → two fix rounds → pass", async () => {
	const cwd = project();
	useFakePi({ testerFailures: { "1.1": 2 } });
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink));

	assert.equal(r.stopped, "steps-done");
	assert.equal(r.steps[0]!.outcome, "passed");
	assert.equal(r.steps[0]!.rounds, 2);
	assert.equal(sink.phases.filter((p) => p.endsWith("/PLAN/planner")).length, 3, "initial plan + two fixing plans");
	assert.equal(sink.notes.filter((n) => n.includes("fix round")).length, 2);
	const verdicts = sink.notes.filter((n) => /\] verdict (PASS|FAIL) \(open/.test(n)).map((n) => /verdict (\w+)/.exec(n)![1]);
	assert.deepEqual(verdicts, ["FAIL", "FAIL", "PASS"]);
	assert.equal(fs.readFileSync(path.join(cwd, "src", "step-1.1.txt"), "utf8"), "implemented 1.1\nfix 1\nfix 2\n");
	assert.equal(commitCount(cwd), 2);
});

test("never passes → halt after maxRounds, artifacts kept, resumable with a higher cap", async () => {
	const cwd = project();
	useFakePi({ testerFailures: { "1.1": 99 } });
	const r = await runLoop(loopOptions(cwd, recordingSink(), { maxRounds: 3 }));

	assert.equal(r.stopped, "halted");
	assert.match(r.reason ?? "", /after 3 corrective round/);
	assert.ok(TEMP.every((f) => fs.existsSync(path.join(cwd, f))), "artifacts kept");
	const st = loadState(cwd);
	assert.equal(st?.phase, "REPORT");
	assert.equal(st?.round, 3);
	assert.equal(commitCount(cwd), 1, "no commit");
	assert.ok(fs.existsSync(path.join(cwd, "src", "step-1.1.txt")), "code changes kept");

	useFakePi({ testerFailures: { "1.1": 4 } });
	const sink2 = recordingSink();
	const r2 = await runLoop(loopOptions(cwd, sink2, { maxRounds: 5 }));
	assert.ok(sink2.notes.some((n) => n.includes("resuming step 1.1 at REPORT (round 3)")), sink2.notes[0]);
	assert.equal(r2.stopped, "steps-done");
	assert.equal(r2.steps[0]!.outcome, "passed");
	assert.equal(r2.steps[0]!.rounds, 4);
	assert.ok(!sink2.notes.some((n) => n.includes("dirty")), "dirty-tree check skipped on resume");
});

test("child crash → halt at that phase; rerun resumes there without re-planning", async () => {
	const cwd = project();
	useFakePi({ crashAgent: "reviewer" });
	const r = await runLoop(loopOptions(cwd, recordingSink()));
	assert.equal(r.stopped, "halted");
	assert.match(r.reason ?? "", /reviewer failed in REVIEW/);
	assert.equal(loadState(cwd)?.phase, "REVIEW");

	useFakePi();
	const sink2 = recordingSink();
	const r2 = await runLoop(loopOptions(cwd, sink2));
	assert.match(sink2.notes[0] ?? "", /resuming step 1\.1 at REVIEW/);
	assert.ok(!sink2.phases.some((p) => p.includes("/PLAN/") || p.includes("/IMPLEMENT/")));
	assert.equal(r2.steps[0]?.outcome, "passed");
});

test("child ending with stopReason=error → halt", async () => {
	const cwd = project();
	useFakePi({ errorAgent: "planner" });
	const r = await runLoop(loopOptions(cwd, recordingSink()));
	assert.equal(r.stopped, "halted");
	assert.match(r.reason ?? "", /planner failed in PLAN/);
});

test("state-updater forgets the milestone → code appends it", async () => {
	const cwd = project();
	useFakePi({ skipMilestone: true });
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink));
	assert.equal(r.steps[0]?.outcome, "passed");
	assert.ok(sink.notes.some((n) => n.includes("did not add the milestone line")));
	assert.match(fs.readFileSync(path.join(cwd, "Current_State.md"), "utf8"), /- \[DONE\] 1\.1 — First thing \(/);
});

test("reporter says PASS while ISSUES.md has OPEN entries → treated as FAIL", async () => {
	const cwd = project();
	useFakePi({ reporterLies: true, testerFailures: { "1.1": 1 } });
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink));
	assert.ok(sink.notes.some((n) => n.includes("reporter said PASS but")));
	assert.equal(r.steps[0]?.outcome, "passed");
	assert.equal(r.steps[0]?.rounds, 1);
});

test("missing VERDICT line → FAIL every round → halt", async () => {
	const cwd = project();
	useFakePi({ noVerdict: true });
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink, { maxRounds: 1 }));
	assert.equal(r.stopped, "halted");
	assert.equal(sink.notes.filter((n) => n.includes("no VERDICT line")).length, 2);
});

test("dirty tree is refused unless allowDirty", async () => {
	const cwd = project();
	fs.writeFileSync(path.join(cwd, "junk.txt"), "x");
	useFakePi();
	await assert.rejects(runLoop(loopOptions(cwd, recordingSink())), /working tree is dirty/);
	const r = await runLoop(loopOptions(cwd, recordingSink(), { allowDirty: true }));
	assert.equal(r.steps[0]?.outcome, "passed");
});

test("non-git project: no commits, reviewer gets the plan's file list", async () => {
	const cwd = project({ git: false });
	useFakePi();
	const sink = recordingSink();
	const r = await runLoop(loopOptions(cwd, sink));
	assert.equal(r.steps[0]?.outcome, "passed", r.reason);
	assert.ok(sink.notes.some((n) => n.includes("not a git repository")));
	assert.ok(!fs.existsSync(path.join(cwd, ".git")));
	const runDir = fs.readdirSync(path.join(cwd, ".duker", "runs")).map((d) => path.join(cwd, ".duker", "runs", d))[0]!;
	const reviewerLog = fs.readdirSync(runDir).find((f) => f.includes("reviewer") && f.endsWith(".jsonl"))!;
	assert.match(fs.readFileSync(path.join(runDir, reviewerLog), "utf8"), /"type":"session"/);
});

test("missing Full_Plan.md is a preflight error", async () => {
	const cwd = project();
	fs.unlinkSync(path.join(cwd, "Full_Plan.md"));
	useFakePi();
	await assert.rejects(runLoop(loopOptions(cwd, recordingSink())), /Full_Plan\.md not found/);
});
