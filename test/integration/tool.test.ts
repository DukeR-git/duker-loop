// Exercises the extension entry point with a mock ExtensionAPI: the duker_loop tool (execute,
// onUpdate stream, usage, renderers), the /duker command routing, and the shared run registry.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import extension from "../../extensions/duker-loop/index.ts";
import { makeProject, recordingSink, removeProject, useFakePi } from "../support/project.ts";

// ---- mock pi API ----------------------------------------------------------------------------

type AnyFn = (...args: any[]) => any;
interface Registered {
	tools: Record<string, any>;
	commands: Record<string, { handler: AnyFn; getArgumentCompletions?: AnyFn }>;
	flags: Record<string, { default?: unknown }>;
	renderers: Record<string, AnyFn>;
	entries: { type: string; data: any }[];
}
const reg: Registered = { tools: {}, commands: {}, flags: {}, renderers: {}, entries: [] };
const flagValues: Record<string, unknown> = { "duker-max-rounds": "2" };
const pi = {
	registerFlag: (n: string, o: { default?: unknown }) => (reg.flags[n] = o),
	getFlag: (n: string) => flagValues[n] ?? reg.flags[n]?.default,
	registerCommand: (n: string, o: any) => (reg.commands[n] = o),
	registerTool: (t: any) => (reg.tools[t.name] = t),
	registerEntryRenderer: (t: string, r: AnyFn) => (reg.renderers[t] = r),
	appendEntry: (type: string, data: any) => reg.entries.push({ type, data }),
	on: () => {},
};
await extension(pi as any);

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
const ctx = (cwd: string) => ({ hasUI: false, cwd, model: { provider: "fake", id: "m" }, thinkingLevel: "low", ui: { setStatus() {}, notify() {} } });
const projects: string[] = [];
const project = () => {
	const cwd = makeProject({ plan: "# Plan\n\n- 1.1 First: create file one\n- 1.2 Second: create file two\n" });
	projects.push(cwd);
	return cwd;
};
after(() => projects.forEach(removeProject));

test("registration surface", () => {
	assert.deepEqual(Object.keys(reg.flags).sort(), ["duker-allow-dirty", "duker-child-timeout", "duker-max-cost", "duker-max-rounds"]);
	assert.deepEqual(Object.keys(reg.commands), ["duker"]);
	assert.deepEqual(Object.keys(reg.tools), ["duker_loop"]);
	const t = reg.tools.duker_loop;
	assert.equal(t.parameters.type, "object");
	assert.equal(typeof t.promptSnippet, "string");
	assert.ok(t.promptGuidelines.every((g: string) => g.includes("duker_loop")));
});

test("tool: two passing steps → content, usage, details, onUpdate snapshots, renderers", async () => {
	const cwd = project();
	useFakePi();
	const tool = reg.tools.duker_loop;
	const updates: any[] = [];
	const r = await tool.execute("tc1", { steps: 2 }, undefined, (u: any) => updates.push(u), ctx(cwd));

	const text: string = r.content[0].text;
	assert.match(text, /^duker: 2 step\(s\) passed/);
	assert.match(text, /✓ step 1\.1 — First: passed/);
	assert.match(text, /✓ step 1\.2 — Second: passed/);
	assert.equal(r.usage.totalTokens, 14 * 120, "7 agents × 2 steps × 120 tokens");
	assert.ok(r.usage.cost.total > 0.01);
	assert.equal(r.details.summary.stopped, "steps-done");
	assert.equal(r.details.stepsDone.length, 2);

	assert.ok(updates.length > 20);
	assert.ok(updates.every((u) => u.details && typeof u.content[0].text === "string"));
	const phases = new Set(updates.map((u) => u.details.current?.phase).filter(Boolean));
	for (const p of ["SELECT", "PLAN", "IMPLEMENT", "TEST", "REVIEW", "REPORT", "PERSIST"]) assert.ok(phases.has(p), p);
	assert.equal(updates[0].details.stepsDone.length, 0, "early snapshots are not mutated later");
	assert.equal(updates[updates.length - 1].details.stepsDone.length, 2);

	const call = tool.renderCall({ steps: 2 }, theme, {});
	assert.equal(call.constructor.name, "Text");
	assert.equal(tool.renderResult(updates[5], { expanded: false, isPartial: true }, theme, {}).constructor.name, "Container");
	const final = tool.renderResult(r, { expanded: true, isPartial: false }, theme, {});
	assert.equal(final.constructor.name, "Container");
	const lines: string[] = final.render(120);
	assert.ok(lines.some((l) => l.includes("step 1.1")));
	assert.ok(lines.some((l) => l.includes("SELECT(orchestrator)")));
	const fallback = tool.renderResult({ content: [{ type: "text", text: "plain" }], details: undefined }, { expanded: false, isPartial: false }, theme, {});
	assert.equal(fallback.constructor.name, "Text");

	// registry released → a further call runs and finds the plan complete
	const r2 = await tool.execute("tc1b", {}, undefined, undefined, ctx(cwd));
	assert.equal(r2.details.summary.stopped, "plan-complete");
});

test("tool: halt → throws with the summary, state kept for resume", async () => {
	const cwd = project();
	useFakePi({ testerFailures: { "1.1": 99 } });
	await assert.rejects(reg.tools.duker_loop.execute("tc2", {}, undefined, undefined, ctx(cwd)), (err: Error) => {
		assert.match(err.message, /halted after 0 passed/);
		assert.match(err.message, /after 2 corrective round/);
		assert.match(err.message, /resumes the step/);
		return true;
	});
	assert.ok(fs.existsSync(path.join(cwd, ".duker", "state.json")));
});

test("tool: second call while running is refused; abort via signal; next call continues", async () => {
	const cwd = project();
	useFakePi();
	const tool = reg.tools.duker_loop;
	const ac = new AbortController();
	const first = tool.execute("tc3", { steps: 2 }, ac.signal, undefined, ctx(cwd));
	await assert.rejects(tool.execute("tc4", {}, undefined, undefined, ctx(cwd)), /already running/);
	setTimeout(() => ac.abort(), 150);
	await assert.rejects(first, /aborted/);
	const r = await tool.execute("tc5", { steps: 2 }, undefined, undefined, ctx(cwd));
	assert.notEqual(r.details.summary.stopped, "halted", r.content[0].text);
});

test("tool: cwd parameter (with a stray @) and a missing Full_Plan.md", async () => {
	const cwd = project();
	fs.unlinkSync(path.join(cwd, "Full_Plan.md"));
	useFakePi();
	await assert.rejects(reg.tools.duker_loop.execute("tc6", { cwd: `@${cwd}` }, undefined, undefined, ctx("/nowhere")), /Full_Plan\.md not found in .*duker-it-/);
});

test("command: routing, status, clean, agents", async () => {
	const cwd = project();
	useFakePi();
	const cmd = reg.commands.duker;
	const c = ctx(cwd) as any;
	const titles = () => reg.entries.map((e) => e.data.title);

	assert.deepEqual(await cmd.getArgumentCompletions!("a"), [{ value: "agents", label: "agents" }, { value: "abort", label: "abort" }]);
	assert.deepEqual(await cmd.getArgumentCompletions!("i"), [{ value: "init", label: "init" }]);
	await cmd.handler("bogus", c);
	assert.match(reg.entries.at(-1)!.data.body, /usage: \/duker/);

	await cmd.handler("agents", c);
	assert.match(reg.entries.at(-1)!.data.title, /8 agent\(s\)/);
	assert.match(reg.entries.at(-1)!.data.body, /orchestrator[\s\S]*state-updater[\s\S]*plan-writer/);

	await cmd.handler("status", c);
	assert.match(reg.entries.at(-1)!.data.body, /no step in progress/);

	await cmd.handler("abort", c);
	assert.match(reg.entries.at(-1)!.data.body, /no loop is running/);

	reg.entries.length = 0;
	await cmd.handler("1", c);
	assert.ok(titles().some((t) => t === "duker step 1.1"), titles().join(" | "));
	assert.ok(titles().some((t) => /duker: 1 step\(s\) passed/.test(t)), titles().join(" | "));

	useFakePi({ testerFailures: { "1.2": 99 } });
	reg.entries.length = 0;
	await cmd.handler("", c);
	assert.ok(titles().some((t) => /duker: halted/.test(t)), titles().join(" | "));
	await cmd.handler("status", c);
	assert.match(reg.entries.at(-1)!.data.body, /step 1\.2[\s\S]*phase REPORT · round 2/);
	await cmd.handler("clean", c);
	assert.match(reg.entries.at(-1)!.data.body, /deleted CURRENT_PLAN\.md[\s\S]*deleted .*state\.json/);
	await cmd.handler("status", c);
	assert.match(reg.entries.at(-1)!.data.body, /no step in progress/);
});

test("command: init — usage, non-interactive report, interactive conversion through ctx.ui, registry", async () => {
	const cwd = project();
	useFakePi();
	const cmd = reg.commands.duker;
	const body = () => reg.entries.at(-1)!.data.body as string;
	const title = () => reg.entries.at(-1)!.data.title as string;

	await cmd.handler("init a b", ctx(cwd));
	assert.match(body(), /usage: \/duker init \[plan file\]/);

	// already a valid, committed project → ready; Current_State.md gets created and committed
	await cmd.handler("init", ctx(cwd));
	assert.equal(title(), "duker init — ready", body());
	assert.match(body(), /✓ Full_Plan\.md: 2 steps in 1 phase/);
	assert.match(body(), /✓ Current_State\.md: created/);
	assert.match(body(), /✓ git commit: [0-9a-f]{10} "duker: init"/);
	assert.match(body(), /ready — run \/duker/);

	// malformed plan without a UI → reported, untouched
	fs.writeFileSync(path.join(cwd, "Full_Plan.md"), "prose only\n");
	await cmd.handler("init", ctx(cwd));
	assert.equal(title(), "duker init — not ready");
	assert.match(body(), /not in the loop's format/);
	assert.match(body(), /run \/duker init interactively/);
	assert.equal(fs.readFileSync(path.join(cwd, "Full_Plan.md"), "utf8"), "prose only\n");

	// with a UI: the confirm dialog is wired to ctx.ui and the plan-writer rewrites the plan
	const dialogs: string[] = [];
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	const uiCtx = {
		...ctx(cwd),
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string | undefined) => statuses.push(t),
			notify: (t: string) => notifications.push(t),
			confirm: async (t: string) => (dialogs.push(t), true),
			select: async () => undefined,
			editor: async () => undefined,
		},
	};
	fs.writeFileSync(path.join(cwd, "Full_Plan.md"), "# Old\n- make it work\n- make it fast\n");
	await cmd.handler("init", uiCtx);
	assert.deepEqual(dialogs, ["Replace Full_Plan.md?"]);
	assert.equal(title(), "duker init — ready", body());
	assert.match(body(), /written from Full_Plan\.md: 2 steps in 1 phase\(s\); previous kept as Full_Plan\.md\.bak/);
	assert.match(body(), /plan-writer: Wrote Full_Plan\.draft\.md/);
	assert.match(fs.readFileSync(path.join(cwd, "Full_Plan.md"), "utf8"), /- 1\.1 make it work/);
	assert.ok(statuses.some((s) => s?.startsWith("duker init · plan-writer")), statuses.join(" | "));
	assert.equal(statuses.at(-1), undefined, "status cleared");
	assert.deepEqual(notifications, ["duker init — ready"]);

	// init shares the run registry with the loop
	const ac = new AbortController();
	const running = reg.tools.duker_loop.execute("tc-init", { steps: 1 }, ac.signal, undefined, ctx(cwd));
	await new Promise((r) => setTimeout(r, 50));
	await cmd.handler("init", ctx(cwd));
	assert.match(body(), /already running/);
	ac.abort();
	await assert.rejects(running, /aborted/);
	await cmd.handler("clean", ctx(cwd));
});

test("entry renderer returns a Text component", () => {
	const comp = reg.renderers["duker-note"]({ data: { title: "t", body: "b" } }, { expanded: false }, theme);
	assert.equal(comp.constructor.name, "Text");
});

// keep the recording sink import used (handy when debugging a failing scenario)
void recordingSink;
