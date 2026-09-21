import assert from "node:assert/strict";
import { test } from "node:test";
import { Activity, type ChildInfo, describeArgs } from "../../extensions/duker-loop/activity.ts";

// runtime.ts pulls in the pi packages; the unit suite runs without the stub loader
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

const info = (over: Partial<ChildInfo> = {}): ChildInfo => ({ runId: "r1", stepId: "1.2", title: "Second", phase: "PLAN", round: 0, agent: "planner", seq: 2, ...over });

test("activity: loop run → running row + pending chain, events fill the transcript, end settles the row", () => {
	const a = new Activity();
	let changes = 0;
	a.subscribe(() => changes++);
	assert.equal(a.active, false);

	a.startRun("loop", "duker 1 step(s)");
	assert.equal(a.active, true);
	a.childStart(info({ phase: "SELECT", agent: "orchestrator", seq: 1, stepId: "?" }));
	assert.deepEqual(
		a.rows.map((r) => `${r.info.phase}:${r.status}`),
		["SELECT:running", "PLAN:pending", "IMPLEMENT:pending", "TEST:pending", "REVIEW:pending", "REPORT:pending", "PERSIST:pending"],
	);
	a.childEnd(info({ phase: "SELECT", agent: "orchestrator", seq: 1, stepId: "?" }), { ok: true, usage: { ...emptyUsage(), turns: 1 }, finalText: "STEP: 1.2" });
	assert.equal(a.rows[0]!.status, "ok");
	assert.equal(a.rows[0]!.finalText, "STEP: 1.2");

	const plan = info();
	a.childStart(plan);
	assert.deepEqual(
		a.rows.map((r) => `${r.info.phase}:${r.status}`),
		["SELECT:ok", "PLAN:running", "IMPLEMENT:pending", "TEST:pending", "REVIEW:pending", "REPORT:pending", "PERSIST:pending"],
	);
	const row = a.runningRow()!;
	assert.equal(row.info.agent, "planner");

	a.childEvent(plan, { kind: "start", agent: "planner", argv: ["pi", "-p", "Task: mode initial\nmore"] });
	a.childEvent(plan, { kind: "textDelta", agent: "planner", text: "Looking at " });
	a.childEvent(plan, { kind: "textDelta", agent: "planner", text: "the code…" });
	assert.equal(row.streaming, "Looking at the code…");
	a.childEvent(plan, { kind: "tool", agent: "planner", toolName: "bash", args: { command: "ls src\necho x" } });
	assert.equal(row.streaming, "", "streamed text is flushed into the transcript when a tool starts");
	assert.equal(row.lastTool, "bash $ ls src");
	a.childEvent(plan, { kind: "toolEnd", agent: "planner", toolName: "bash", isError: false, text: "a.py\nb.py" });
	a.childEvent(plan, { kind: "text", agent: "planner", text: "I wrote the plan." });
	a.childEvent(plan, { kind: "stderr", agent: "planner", line: "duker-guard[planner]: blocked write to Full_Plan.md" });
	a.childEvent(plan, { kind: "retry", agent: "planner", attempt: 1, errorMessage: "overloaded" });
	assert.deepEqual(
		row.transcript.map((e) => e.kind),
		["note", "text", "tool", "toolEnd", "text", "stderr", "retry"],
	);
	assert.equal((row.transcript[0] as { text: string }).text, "started: Task: mode initial");
	assert.equal((row.transcript[1] as { text: string }).text, "Looking at the code…");
	assert.equal(row.guardBlocks, 1);

	// events for an unknown child are ignored
	a.childEvent(info({ seq: 99 }), { kind: "text", agent: "x", text: "nope" });
	assert.equal(row.transcript.length, 7);

	a.childEnd(plan, { ok: false, note: "timed out after 30m00s", usage: { ...emptyUsage(), turns: 3, output: 500 }, guardBlocks: 2 });
	assert.equal(row.status, "failed");
	assert.equal(row.note, "timed out after 30m00s");
	assert.equal(row.guardBlocks, 2, "the runtime's count wins");
	assert.equal(row.usage?.turns, 3);
	assert.equal(row.transcript.at(-1)?.kind, "note");
	assert.equal(a.runningRow(), undefined);

	a.endRun("halted");
	assert.equal(a.active, false);
	assert.equal(a.run?.outcome, "halted");
	assert.ok(a.rows.every((r) => r.status !== "pending"), "pending placeholders dropped at run end");
	assert.ok(changes > 10);
});

test("activity: a new step (new runId) replaces the previous chain; endRun fails still-running rows", () => {
	const a = new Activity();
	a.startRun("loop", "duker 2 step(s)");
	a.childStart(info({ runId: "r1", phase: "PERSIST", agent: "state-updater", seq: 7 }));
	a.childEnd(info({ runId: "r1", phase: "PERSIST", agent: "state-updater", seq: 7 }), { ok: true });
	a.childStart(info({ runId: "r2", stepId: "?", phase: "SELECT", agent: "orchestrator", seq: 1 }));
	assert.equal(a.rows.filter((r) => r.info.runId === "r1").length, 0);
	assert.equal(a.rows[0]!.info.phase, "SELECT");
	a.endRun("aborted");
	assert.equal(a.rows[0]!.status, "failed");
	assert.equal(a.rows[0]!.note, "aborted");
});

test("activity: manual and init runs have no pending chain; hooks() are bound", () => {
	const a = new Activity();
	const hooks = a.hooks();
	a.startRun("manual", "duker run planner");
	const i = info({ runId: "manual-1", stepId: undefined, title: undefined, phase: "manual", seq: 1 });
	hooks.childStart(i);
	assert.equal(a.rows.length, 1);
	hooks.childEvent(i, { kind: "tool", agent: "planner", toolName: "read", args: { path: "README.md" } });
	assert.equal(a.rows[0]!.lastTool, "read README.md");
	hooks.childEnd(i, { ok: true, finalText: "done" });
	assert.equal(a.rows[0]!.status, "ok");
	a.endRun("done");
	assert.equal(a.row(a.rows[0]!.id)?.finalText, "done");
});

test("activity: transcript and text caps hold", () => {
	const a = new Activity();
	a.startRun("manual", "x");
	const i = info({ phase: "manual", stepId: undefined, seq: 1 });
	a.childStart(i);
	for (let n = 0; n < 600; n++) a.childEvent(i, { kind: "stderr", agent: "planner", line: `line ${n}` });
	assert.equal(a.rows[0]!.transcript.length, 500);
	assert.equal((a.rows[0]!.transcript[0] as { line: string }).line, "line 100");
	a.childEvent(i, { kind: "text", agent: "planner", text: "x".repeat(10_000) });
	assert.equal((a.rows[0]!.transcript.at(-1) as { text: string }).text.length, 6000);
	for (let n = 0; n < 100; n++) a.childEvent(i, { kind: "textDelta", agent: "planner", text: "y".repeat(100) });
	assert.equal(a.rows[0]!.streaming.length, 8000);
});

test("describeArgs", () => {
	assert.equal(describeArgs("bash", { command: "pytest -q\nls" }), "$ pytest -q");
	assert.equal(describeArgs("edit", { path: "src/a.py", oldText: "x" }), "src/a.py");
	assert.equal(describeArgs("grep", { pattern: "foo", path: "src" }), "foo in src");
	assert.equal(describeArgs("grep", { pattern: "foo" }), "foo");
	assert.equal(describeArgs("ls", { path: "." }), ".");
	assert.equal(describeArgs("custom_tool", { n: 1, q: "first string\nsecond" }), "first string");
	assert.equal(describeArgs("custom_tool", {}), "");
});
