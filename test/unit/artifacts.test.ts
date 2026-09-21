import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	artifactExists,
	artifactFingerprint,
	checkPlanFormat,
	cleanTempArtifacts,
	ensureCurrentState,
	ensureIssuesFile,
	milestoneLine,
	openIssueLines,
	parseIssues,
	parseMilestones,
	parseOrchestratorOutput,
	parseVerdict,
	readArtifact,
	writeArtifact,
} from "../../extensions/duker-loop/artifacts.ts";

function tmpProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "duker-art-"));
}

// ---------------------------------------------------------------------------------------------
// VERDICT
// ---------------------------------------------------------------------------------------------

test("parseVerdict: strict first line", () => {
	assert.deepEqual(parseVerdict("VERDICT: PASS\n\n## Summary\nok"), { verdict: "PASS", found: true, line: 1 });
	assert.deepEqual(parseVerdict("VERDICT: FAIL\n"), { verdict: "FAIL", found: true, line: 1 });
});

test("parseVerdict: tolerates markdown decoration and a leading title", () => {
	assert.equal(parseVerdict("**VERDICT: PASS**").verdict, "PASS");
	assert.equal(parseVerdict("# Report\n\n`VERDICT: pass`").verdict, "PASS");
	assert.equal(parseVerdict("VERDICT = FAIL").verdict, "FAIL");
	assert.equal(parseVerdict("Verdict: Pass").verdict, "PASS");
});

test("parseVerdict: missing or buried verdict ⇒ FAIL, found=false", () => {
	assert.deepEqual(parseVerdict(undefined), { verdict: "FAIL", found: false });
	assert.deepEqual(parseVerdict(""), { verdict: "FAIL", found: false });
	assert.deepEqual(parseVerdict("Everything looks fine.\nAll good."), { verdict: "FAIL", found: false });
	// beyond the 5-line scan window
	const buried = "a\nb\nc\nd\ne\nf\nVERDICT: PASS";
	assert.equal(parseVerdict(buried).found, false);
	// "PASSED" is not a verdict
	assert.equal(parseVerdict("VERDICT: PASSED").found, false);
});

// ---------------------------------------------------------------------------------------------
// ISSUES.md
// ---------------------------------------------------------------------------------------------

const ISSUES = `# Issues — step 1.3

- [OPEN] (tester) tests/test_api.py:42 — test_cancel_open_task: AssertionError 400 != 200
  Traceback (most recent call last):
    File "tests/test_api.py", line 42
  assert response.status_code == 200
- [FIXED] (reviewer) app/api/routes/tasks.py:88 — missing 403 branch -> add requester check (fixed: added check)
- [NOTE] (implementer) - — schema file has an unused import, out of scope
* [open] (Reviewer) app/models.py — lowercase status and star bullet, single hyphen
- [OPEN] (tester) — no location at all
- [BROKEN] (tester) x — unknown status
- [OPEN] tester missing parens
Some prose that is not an entry.
- [NOTE] (reviewer) app/x.py:1 – en dash separator
`;

test("parseIssues: counts and fields", () => {
	const p = parseIssues(ISSUES);
	assert.equal(p.open, 3);
	assert.equal(p.fixed, 1);
	assert.equal(p.notes, 2);
	assert.equal(p.entries.length, 6);
	const first = p.entries[0]!;
	assert.equal(first.status, "OPEN");
	assert.equal(first.author, "tester");
	assert.equal(first.location, "tests/test_api.py:42");
	assert.equal(first.text, "test_cancel_open_task: AssertionError 400 != 200");
	assert.deepEqual(first.detail, ["Traceback (most recent call last):", 'File "tests/test_api.py", line 42', "assert response.status_code == 200"]);
	assert.equal(first.line, 3);
});

test("parseIssues: tolerant variants", () => {
	const p = parseIssues(ISSUES);
	const fixed = p.entries.find((e) => e.status === "FIXED")!;
	assert.equal(fixed.location, "app/api/routes/tasks.py:88");
	assert.match(fixed.text, /\(fixed: added check\)$/);
	const dashLoc = p.entries.find((e) => e.author === "implementer")!;
	assert.equal(dashLoc.location, "-");
	assert.equal(dashLoc.text, "schema file has an unused import, out of scope");
	const star = p.entries.find((e) => e.location === "app/models.py")!;
	assert.equal(star.status, "OPEN");
	assert.equal(star.author, "reviewer");
	const noLoc = p.entries.find((e) => e.text === "no location at all")!;
	assert.equal(noLoc.location, "-");
	const enDash = p.entries.find((e) => e.location === "app/x.py:1")!;
	assert.equal(enDash.text, "en dash separator");
});

test("parseIssues: malformed entries are reported, not counted", () => {
	const p = parseIssues(ISSUES);
	assert.deepEqual(
		p.malformed.map((m) => m.text),
		["- [BROKEN] (tester) x — unknown status", "- [OPEN] tester missing parens"],
	);
});

test("parseIssues: empty / header only", () => {
	assert.equal(parseIssues(undefined).open, 0);
	assert.equal(parseIssues("# Issues — step 1\n\n").entries.length, 0);
});

test("openIssueLines: reconstructs canonical OPEN lines", () => {
	const lines = openIssueLines(parseIssues(ISSUES));
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "- [OPEN] (tester) tests/test_api.py:42 — test_cancel_open_task: AssertionError 400 != 200");
});

// ---------------------------------------------------------------------------------------------
// Orchestrator output
// ---------------------------------------------------------------------------------------------

test("parseOrchestratorOutput: canonical", () => {
	const r = parseOrchestratorOutput("STEP: 1.3\nTITLE: Deliverable Routing\nDESCRIPTION: Create dedicated REST endpoints so agents can list deliverables.\nREASON: 1.1 and 1.2 are done.");
	assert.deepEqual(r, {
		kind: "step",
		id: "1.3",
		title: "Deliverable Routing",
		description: "Create dedicated REST endpoints so agents can list deliverables.",
		reason: "1.1 and 1.2 are done.",
	});
});

test("parseOrchestratorOutput: NONE / BLOCKED", () => {
	assert.deepEqual(parseOrchestratorOutput("STEP: NONE\nTITLE: -\nDESCRIPTION: -\nREASON: all done"), { kind: "none", reason: "all done" });
	assert.deepEqual(parseOrchestratorOutput("STEP: BLOCKED\nTITLE: -\nDESCRIPTION: -\nREASON: 2.1 needs auth"), { kind: "blocked", reason: "2.1 needs auth" });
	assert.equal(parseOrchestratorOutput("**STEP:** none").kind, "none");
});

test("parseOrchestratorOutput: tolerates chatter, fences, markdown, continuation lines", () => {
	const messy = [
		"Sure! Here is the next step:",
		"```",
		"**STEP:** `2.1`",
		"TITLE: Identity & Authorization",
		"DESCRIPTION: Replace the insecure client-asserted requester_id",
		"  with a proper auth layer (API keys or JWTs).",
		"REASON: Phase 1 is complete.",
		"```",
		"Let me know if you need anything else.",
	].join("\n");
	const r = parseOrchestratorOutput(messy);
	assert.equal(r.kind, "step");
	if (r.kind === "step") {
		assert.equal(r.id, "2.1");
		assert.equal(r.title, "Identity & Authorization");
		assert.equal(r.description, "Replace the insecure client-asserted requester_id with a proper auth layer (API keys or JWTs).");
	}
});

test("parseOrchestratorOutput: id extraction from decorated STEP values", () => {
	const a = parseOrchestratorOutput("STEP: Step 1.2.\nTITLE: X\nDESCRIPTION: Y\nREASON: Z");
	assert.equal(a.kind === "step" && a.id, "1.2");
	const b = parseOrchestratorOutput("STEP: 3\nTITLE: X\nDESCRIPTION: Y");
	assert.equal(b.kind === "step" && b.id, "3");
});

test("parseOrchestratorOutput: invalid cases", () => {
	assert.equal(parseOrchestratorOutput("I think we should do the auth step next.").kind, "invalid");
	assert.equal(parseOrchestratorOutput(undefined).kind, "invalid");
	const noTitle = parseOrchestratorOutput("STEP: 1.4\nTITLE: -\nDESCRIPTION: -\nREASON: x");
	assert.equal(noTitle.kind, "invalid");
});

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------

test("parseMilestones / milestoneLine", () => {
	const line = milestoneLine("1.3", "Deliverable Routing", new Date("2026-09-13T10:00:00Z"));
	assert.equal(line, "- [DONE] 1.3 — Deliverable Routing (2026-09-13)");
	const ms = parseMilestones(`# State\n\n## Milestones\n${line}\n- [DONE] 1.1 - Data Model (2026-09-01)\n* [done] 1.2: Cancel endpoint\n- [ ] 1.4 not done\n`);
	assert.deepEqual(ms.map((m) => m.id), ["1.3", "1.1", "1.2"]);
	assert.equal(ms[0]!.title, "Deliverable Routing (2026-09-13)");
});

// ---------------------------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------------------------

test("file helpers: ensure/clean/fingerprint", () => {
	const cwd = tmpProject();
	try {
		assert.equal(ensureIssuesFile(cwd, "1.3"), true);
		assert.equal(ensureIssuesFile(cwd, "1.3"), false);
		assert.match(readArtifact(cwd, "issues")!, /^# Issues — step 1\.3/);
		assert.equal(ensureCurrentState(cwd), true);
		assert.match(readArtifact(cwd, "currentState")!, /## Milestones/);

		writeArtifact(cwd, "currentPlan", "# plan");
		writeArtifact(cwd, "report", "VERDICT: PASS");
		writeArtifact(cwd, "fullPlan", "# Full plan");
		const fp1 = artifactFingerprint(cwd, "currentPlan");
		assert.ok(fp1);
		writeArtifact(cwd, "currentPlan", "# plan changed");
		assert.notEqual(artifactFingerprint(cwd, "currentPlan"), fp1);

		const deleted = cleanTempArtifacts(cwd);
		assert.deepEqual(deleted.sort(), ["CURRENT_PLAN.md", "CURRENT_REPORT.md", "ISSUES.md"].sort());
		assert.equal(artifactExists(cwd, "fullPlan"), true, "Full_Plan.md must survive clean");
		assert.equal(artifactExists(cwd, "currentState"), true, "Current_State.md must survive clean");
		assert.equal(artifactExists(cwd, "issues"), false);
		assert.deepEqual(cleanTempArtifacts(cwd), []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------------------------
// Full_Plan.md format check (/duker init)
// ---------------------------------------------------------------------------------------------

test("checkPlanFormat: accepts the documented shapes", () => {
	const good = [
		"# Plan\n\n## Phase 1 — Base\n- 1.1 First: create a\n- 1.2 Second: create b (after 1.1)\n\n## Phase 2 — More\n- 2.1 Third: create c\n",
		"### 1.1 First\ntext\n### 1.2 Second\ntext\n",
		"1. 1.1 First\n2. 1.2 Second\n",
		"- **1.1** First\n- **1.2** Second\n",
		"- Step 1.1 — First\n- Step 1.2 — Second\n",
		"* 1.1: First\n* 2.3.1: Deep\n",
	];
	for (const text of good) {
		const c = checkPlanFormat(text);
		assert.equal(c.ok, true, `${JSON.stringify(text)} → ${c.problems.join("; ")}`);
		assert.ok(c.ids.length >= 2, text);
	}
	const c = checkPlanFormat(good[0]);
	assert.deepEqual(c.ids, ["1.1", "1.2", "2.1"]);
	assert.equal(c.phases, 2);
	assert.deepEqual(c.warnings, []);
	assert.deepEqual(checkPlanFormat(good[1]).ids, ["1.1", "1.2"]);
	assert.match(checkPlanFormat(good[1]).warnings[0] ?? "", /no phase headings/);
});

test("checkPlanFormat: rejects plain lists, empty, single item, duplicates, fenced ids", () => {
	assert.deepEqual(checkPlanFormat(undefined).problems, ["file is empty"]);
	assert.deepEqual(checkPlanFormat("  \n").problems, ["file is empty"]);
	const plain = checkPlanFormat("# Todo\n1. build it\n2. test it\n3) ship it\n");
	assert.equal(plain.ok, false);
	assert.match(plain.problems[0]!, /no dotted step ids.*3 plain/);
	const prose = checkPlanFormat("# Idea\nWe should build a thing.\n");
	assert.match(prose.problems[0]!, /no numbered step items/);
	const one = checkPlanFormat("- 1.1 Only one\n");
	assert.match(one.problems[0]!, /only 1 numbered/);
	const dup = checkPlanFormat("- 1.1 a\n- 1.1 b\n- 1.2 c\n");
	assert.equal(dup.ok, false);
	assert.match(dup.problems[0]!, /duplicate step id\(s\): 1\.1/);
	const fenced = checkPlanFormat("# Doc\n```\n- 1.1 in a fence\n- 1.2 also\n```\n");
	assert.equal(fenced.ok, false);
	assert.deepEqual(fenced.ids, []);
});
