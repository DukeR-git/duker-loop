import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	clearState,
	createState,
	loadState,
	newRunId,
	planFileFor,
	recordPhase,
	runsDir,
	saveState,
	statePath,
} from "../../extensions/duker-loop/state.ts";

function tmpProject(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "duker-state-"));
}

test("state: create/save/load/clear round-trip", () => {
	const cwd = tmpProject();
	try {
		assert.equal(loadState(cwd), undefined);
		const s = createState({ runId: "r1", stepId: "1.3", title: "T", description: "D", headAtStepStart: "abc" });
		assert.equal(s.phase, "PLAN");
		assert.equal(s.round, 0);
		assert.equal(planFileFor(s), "currentPlan");
		s.phase = "TEST";
		s.round = 1;
		recordPhase(s, { phase: "PLAN", round: 1, agent: "planner", startedAt: s.startedAt, ms: 12, ok: true });
		saveState(cwd, s);
		assert.ok(fs.existsSync(statePath(cwd)));
		assert.equal(fs.readdirSync(path.dirname(statePath(cwd))).filter((f) => f.endsWith(".tmp")).length, 0, "no tmp left behind");

		const loaded = loadState(cwd)!;
		assert.equal(loaded.stepId, "1.3");
		assert.equal(loaded.phase, "TEST");
		assert.equal(loaded.round, 1);
		assert.equal(planFileFor(loaded), "fixingPlan");
		assert.equal(loaded.headAtStepStart, "abc");
		assert.equal(loaded.history.length, 1);
		assert.ok(loaded.updatedAt >= loaded.startedAt);

		assert.equal(clearState(cwd), true);
		assert.equal(clearState(cwd), false);
		assert.equal(loadState(cwd), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("state: corrupt or foreign file throws a clear error", () => {
	const cwd = tmpProject();
	try {
		fs.mkdirSync(path.dirname(statePath(cwd)), { recursive: true });
		fs.writeFileSync(statePath(cwd), "{not json");
		assert.throws(() => loadState(cwd), /not valid JSON/);
		fs.writeFileSync(statePath(cwd), JSON.stringify({ version: 2, foo: 1 }));
		assert.throws(() => loadState(cwd), /unexpected shape/);
		fs.writeFileSync(statePath(cwd), JSON.stringify({ ...createState({ runId: "r", stepId: "1", title: "t", description: "d" }), phase: "BOGUS" }));
		assert.throws(() => loadState(cwd), /unexpected shape/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("state: ids and paths", () => {
	const id = newRunId(new Date("2026-09-13T10:22:05.123Z"));
	assert.equal(id, "2026-09-13_10-22-05-123");
	assert.equal(runsDir("/p", id), path.join("/p", ".duker", "runs", id));
});
