// The fleet view (below-editor list + viewer overlay) driven through a fake ctx.ui, plus one
// real runLoop() with the fake pi feeding it. Keys are sent as their names (the pi-tui stub's
// matchesKey accepts either the escape sequence or the name).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Activity, type ChildInfo } from "../../extensions/duker-loop/activity.ts";
import { ChildViewer, DukerFleet, type FleetComponent, type FleetTheme, type FleetTui, type FleetUI, rightAlign } from "../../extensions/duker-loop/fleet.ts";
import { runLoop } from "../../extensions/duker-loop/loop.ts";
import { loopOptions, makeProject, recordingSink, removeProject, useFakePi } from "../support/project.ts";

// ---- fake ctx.ui ------------------------------------------------------------------------------

const theme: FleetTheme = { fg: (_c, t) => t, bold: (t) => t };

interface FakeUI extends FleetUI {
	widget?: FleetComponent;
	widgetOptions?: unknown;
	handler?: (data: string) => { consume?: boolean } | undefined;
	editorText: string;
	notifications: string[];
	overlay?: FleetComponent;
	overlayDone?: (v: unknown) => void;
	overlayOptions?: unknown;
	tui: FleetTui & { renders: number };
	/** send a key the way pi would: through onTerminalInput first, then to the overlay when open */
	key(data: string): { consume?: boolean } | undefined;
	/** the open overlay, read fresh (a method so TS narrowing from an earlier assert does not stick) */
	ov(): FleetComponent | undefined;
	lines(width?: number): string[];
}

function fakeUi(): FakeUI {
	const tui = { renders: 0, requestRender: () => tui.renders++, terminal: { rows: 30, columns: 100 }, focusedComponent: undefined as unknown };
	const ui: FakeUI = {
		editorText: "",
		notifications: [],
		tui,
		setWidget(_key, content, options) {
			ui.widget = content ? content(tui, theme) : undefined;
			ui.widgetOptions = options;
		},
		onTerminalInput(handler) {
			ui.handler = handler;
			return () => {
				if (ui.handler === handler) ui.handler = undefined;
			};
		},
		getEditorText: () => ui.editorText,
		notify: (m) => ui.notifications.push(m),
		custom<T>(factory: (tui: FleetTui, theme: FleetTheme, kb: unknown, done: (r: T) => void) => FleetComponent, options?: unknown): Promise<T> {
			ui.overlayOptions = options;
			return new Promise<T>((resolve) => {
				const done = (v: T) => {
					ui.overlay?.dispose?.();
					ui.overlay = undefined;
					ui.overlayDone = undefined;
					resolve(v);
				};
				ui.overlayDone = done as (v: unknown) => void;
				ui.overlay = factory(tui, theme, undefined, done);
			});
		},
		key(data) {
			const r = ui.handler?.(data);
			if (!r?.consume && ui.overlay) ui.overlay.handleInput?.(data);
			return r;
		},
		lines: (width = 100) => ui.widget?.render(width) ?? [],
		ov: () => ui.overlay,
	};
	return ui;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const info = (over: Partial<ChildInfo> = {}): ChildInfo => ({ runId: "r1", stepId: "1.1", title: "First thing", phase: "PLAN", round: 0, agent: "planner", seq: 2, ...over });

const fleets: DukerFleet[] = [];
const projects: string[] = [];
after(() => {
	fleets.forEach((f) => f.dispose());
	projects.forEach(removeProject);
});
function makeFleet(activity: Activity, abort?: () => boolean): DukerFleet {
	const f = new DukerFleet(activity, abort);
	fleets.push(f);
	return f;
}

// ---- widget + keys -------------------------------------------------------------------------------

test("fleet: no widget while idle; appears with a run; ↓/← at an empty prompt activate the list", () => {
	const activity = new Activity();
	const fleet = makeFleet(activity);
	const ui = fakeUi();
	fleet.setUICtx(ui);
	assert.ok(!ui.widget);
	assert.equal(ui.key("down"), undefined, "nothing to navigate → key flows to the editor");

	activity.startRun("loop", "duker 1 step(s)");
	assert.ok(!ui.widget, "a run with no child yet renders nothing");
	activity.childStart(info({ phase: "SELECT", agent: "orchestrator", seq: 1, stepId: "?" }));
	assert.ok(ui.widget, "widget registered once a child starts");
	assert.deepEqual(ui.widgetOptions, { placement: "belowEditor" });
	let lines = ui.lines();
	assert.match(lines[0]!, /← ↓ duker children · \/duker watch/);
	assert.match(lines[2]!, /● main/, "inactive: the prompt (main) is where you are");
	assert.match(lines[3]!, /○ ⏳ SELECT +orchestrator +starting/);
	assert.match(lines[4]!, /· PLAN +planner +pending/);
	assert.equal(lines.length, 3 + 7, "hint, blank, main, 7 phase rows");

	// typing in the editor: ↓ is not intercepted
	ui.editorText = "hello";
	assert.equal(ui.key("down"), undefined);
	ui.editorText = "";
	// a dialog holds the keyboard: not intercepted either
	ui.tui.focusedComponent = { notTheEditor: true };
	assert.equal(ui.key("down"), undefined);
	ui.tui.focusedComponent = undefined;
	// key releases are ignored
	assert.equal(ui.key("release:down"), undefined);

	assert.deepEqual(ui.key("left"), { consume: true }, "← activates");
	lines = ui.lines();
	assert.match(lines[0]!, /↑↓ select · enter view · esc back/);
	assert.match(lines[2]!, /● main/);
	assert.deepEqual(ui.key("down"), { consume: true });
	assert.match(ui.lines()[3]!, /● ⏳ SELECT/);
	assert.deepEqual(ui.key("down"), { consume: true });
	assert.match(ui.lines()[4]!, /● · PLAN/);
	for (let i = 0; i < 20; i++) ui.key("down");
	assert.match(ui.lines().at(-1)!, /● · PERSIST/, "selection clamps at the last row");
	assert.deepEqual(ui.key("escape"), { consume: true });
	assert.match(ui.lines()[0]!, /← ↓ duker children/, "esc deactivates");

	ui.key("down");
	assert.deepEqual(ui.key("up"), { consume: true }, "↑ past main returns to the prompt");
	assert.match(ui.lines()[0]!, /← ↓ duker children/);

	ui.key("down");
	assert.equal(ui.key("a"), undefined, "any other key deactivates and flows to the editor");
	assert.match(ui.lines()[0]!, /← ↓ duker children/);
});

test("fleet: Enter on a pending row notifies; on a running row opens the live viewer; esc closes it", async () => {
	const activity = new Activity();
	let aborted = 0;
	const fleet = makeFleet(activity, () => (aborted++, true));
	const ui = fakeUi();
	fleet.setUICtx(ui);
	activity.startRun("loop", "duker 1 step(s)");
	const plan = info();
	activity.childStart(plan);
	activity.childEvent(plan, { kind: "tool", agent: "planner", toolName: "bash", args: { command: "pytest -q" } });
	activity.childEvent(plan, { kind: "toolEnd", agent: "planner", toolName: "bash", isError: false, text: "3 passed\nin 0.1s" });
	activity.childEvent(plan, { kind: "textDelta", agent: "planner", text: "Writing the plan now" });
	assert.match(ui.lines()[3]!, /○ ⏳ PLAN +planner +bash \$ pytest -q/);

	ui.key("down");
	ui.key("down");
	ui.key("down"); // IMPLEMENT (pending)
	ui.key("enter");
	assert.deepEqual(ui.notifications, ["implementer has not started yet"]);
	assert.ok(!ui.ov());

	ui.key("up"); // PLAN (running)
	ui.key("enter");
	assert.ok(ui.ov() instanceof ChildViewer);
	assert.deepEqual(ui.overlayOptions, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } });
	assert.equal(ui.key("down"), undefined, "list stays out of the overlay's keys");

	const view = ui.ov()!.render(80);
	assert.match(view[0]!, /^╭─+╮$/);
	assert.match(view[1]!, /⏳ planner PLAN step 1\.1 — First thing/);
	const body = view.join("\n");
	assert.match(body, /▸ bash \$ pytest -q/);
	assert.match(body, /3 passed/);
	assert.match(body, /Writing the plan now/, "streaming text is shown");
	assert.match(view.at(-2)!, /↑↓ scroll · pgup\/pgdn · end follow · esc close · x x abort run/);
	assert.match(view.at(-1)!, /^╰─+╯$/);
	assert.ok(view.every((l) => l.length <= 80), "no line exceeds the width");

	// live update re-renders the overlay
	const before = ui.tui.renders;
	activity.childEvent(plan, { kind: "text", agent: "planner", text: "Plan written." });
	assert.ok(ui.tui.renders > before);
	assert.match(ui.ov()!.render(80).join("\n"), /Plan written\./);

	// x twice aborts the run; a stray key in between disarms
	ui.key("x");
	assert.match(ui.ov()!.render(80).at(-2)!, /x again to abort the run/);
	ui.key("down");
	ui.key("x");
	assert.equal(aborted, 0, "disarmed by the intervening key");
	ui.key("x");
	ui.key("x");
	assert.equal(aborted, 1);

	ui.key("escape");
	await tick();
	assert.ok(!ui.ov());
	assert.match(ui.lines()[0]!, /↑↓ select/, "back in the list, still active");
	assert.match(ui.lines()[3]!, /● ⏳ PLAN/, "cursor stays on the viewed row");

	// finished row: viewer shows the final text; run end keeps the list for a while
	activity.childEnd(plan, { ok: true, finalText: "Summary: plan has 3 changes.", usage: { input: 1000, output: 250, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 0, turns: 4 } });
	assert.match(ui.lines()[3]!, /● ✓ PLAN +planner +done .*4 turns · ↓ 250 tokens/);
	ui.key("enter");
	const done = ui.ov()!.render(100).join("\n");
	assert.match(done, /✓ planner PLAN/);
	assert.match(done, /4 turns · ↑1\.0k ↓250 · \$0\.0123/);
	assert.match(done, /final:[^\n]*\n[^\n]*Summary: plan has 3 changes\./);
	assert.doesNotMatch(ui.ov()!.render(100).at(-2)!, /abort/, "no abort affordance on a finished child");
	ui.key("q");
	await tick();
	activity.endRun("halted");
	assert.ok(ui.widget, "list lingers after the run ends");
	assert.match(ui.lines()[2]!, /halted/);
});

test("fleet: openViewer() (shortcut / /duker watch) targets the running child, else the last one, else nothing", async () => {
	const activity = new Activity();
	const fleet = makeFleet(activity);
	const ui = fakeUi();
	fleet.setUICtx(ui);
	assert.equal(fleet.openViewer(), false);

	activity.startRun("manual", "duker run planner");
	const i = info({ runId: "m1", stepId: undefined, title: undefined, phase: "manual", seq: 1 });
	activity.childStart(i);
	assert.equal(fleet.openViewer(), true);
	assert.match(ui.ov()!.render(80)[1]!, /⏳ planner manual/);
	assert.equal(fleet.openViewer(), true, "already open → no second overlay");
	ui.key("escape");
	await tick();
	activity.childEnd(i, { ok: false, note: "exit code 1" });
	activity.endRun("failed");
	assert.equal(fleet.openViewer(), true, "last (finished) child");
	assert.match(ui.ov()!.render(80)[1]!, /✗ planner manual/);
	ui.key("ctrl+c");
	await tick();
	assert.ok(!ui.ov());
});

test("fleet: viewer scrolling follows the tail until scrolled up; end re-follows", () => {
	const activity = new Activity();
	activity.startRun("manual", "x");
	const i = info({ phase: "manual", stepId: undefined, seq: 1 });
	activity.childStart(i);
	for (let n = 0; n < 60; n++) activity.childEvent(i, { kind: "stderr", agent: "planner", line: `line ${n}` });
	const tui = { renders: 0, requestRender() {}, terminal: { rows: 30, columns: 80 } };
	const viewer = new ChildViewer(tui, theme, activity, activity.rows[0]!.id, () => {}, () => false);
	const bodyOf = () => viewer.render(80).slice(3, -3).join("\n");
	assert.match(bodyOf(), /line 59/, "follows the tail");
	assert.doesNotMatch(bodyOf(), /line 0$/m);
	viewer.handleInput("up");
	assert.doesNotMatch(bodyOf(), /line 59/);
	activity.childEvent(i, { kind: "stderr", agent: "planner", line: "line 60" });
	assert.doesNotMatch(bodyOf(), /line 60/, "scrolled up → new lines do not yank the view");
	viewer.handleInput("end");
	assert.match(bodyOf(), /line 60/);
	viewer.handleInput("home");
	assert.match(bodyOf(), /started:|line 0/);
	viewer.handleInput("pageDown");
	viewer.handleInput("pageDown");
	viewer.handleInput("pageDown");
	viewer.handleInput("pageDown");
	assert.match(bodyOf(), /line 60/, "paging down far enough re-follows");
	viewer.dispose();
});

test("fleet: dispose releases the widget and input hook; a ui without onTerminalInput is ignored", () => {
	const activity = new Activity();
	const fleet = makeFleet(activity);
	const ui = fakeUi();
	fleet.setUICtx(ui);
	activity.startRun("manual", "x");
	activity.childStart(info({ phase: "manual", stepId: undefined, seq: 1 }));
	assert.ok(ui.widget);
	fleet.dispose();
	assert.ok(!ui.widget);
	assert.ok(!ui.handler);
	assert.equal(ui.key("down"), undefined);

	const bare = { setStatus() {}, notify() {} } as unknown as FleetUI;
	const fleet2 = makeFleet(new Activity());
	fleet2.setUICtx(bare); // must not throw
});

test("rightAlign never exceeds the width and keeps the right part", () => {
	const s = rightAlign("a".repeat(90), "12s", 40);
	assert.equal(s.length, 40);
	assert.ok(s.endsWith("12s"));
	assert.equal(rightAlign("ab", "cd", 10), "ab      cd");
});

// ---- end to end: the loop feeds the fleet -------------------------------------------------------

test("fleet: a real loop run (fake pi) drives the list through every phase", async () => {
	const cwd = makeProject();
	projects.push(cwd);
	useFakePi();
	const activity = new Activity();
	const fleet = makeFleet(activity);
	const ui = fakeUi();
	fleet.setUICtx(ui);
	const seen = new Set<string>();
	activity.subscribe(() => {
		for (const l of ui.lines(120)) {
			const m = /⏳ (\w+) +([\w-]+)/.exec(l);
			if (m) seen.add(`${m[1]}/${m[2]}`);
		}
	});
	activity.startRun("loop", "duker 1 step(s)");
	const r = await runLoop(loopOptions(cwd, { ...recordingSink(), ...activity.hooks() }));
	activity.endRun(r.stopped);

	assert.equal(r.stopped, "steps-done");
	assert.deepEqual([...seen], ["SELECT/orchestrator", "PLAN/planner", "IMPLEMENT/implementer", "TEST/tester", "REVIEW/reviewer", "REPORT/reporter", "PERSIST/state-updater"]);
	assert.deepEqual(
		activity.rows.map((r) => `${r.info.phase}:${r.status}`),
		["SELECT:ok", "PLAN:ok", "IMPLEMENT:ok", "TEST:ok", "REVIEW:ok", "REPORT:ok", "PERSIST:ok"],
	);
	const tester = activity.rows.find((r) => r.info.agent === "tester")!;
	assert.ok(tester.transcript.some((e) => e.kind === "tool" && e.name === "bash" && e.detail === "$ pytest -q"));
	assert.ok(tester.transcript.some((e) => e.kind === "text" && /pytest -q/.test(e.text)));
	assert.equal(tester.usage?.turns, 1);
	assert.match(tester.finalText ?? "", /Failures logged: 0/);
	assert.match(ui.lines(120)[2]!, /duker step 1\.1 — First thing/);
	assert.match(ui.lines(120)[2]!, /steps-done/);
});
