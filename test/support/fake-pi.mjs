// A deterministic stand-in for the `pi` CLI used by the integration tests (DUKER_PI_BIN points
// here). It plays the agent named by DUKER_AGENT: writes the artifacts a real agent would and
// emits a minimal `--mode json` event stream on stdout. Behaviour is steered by FAKE_SCENARIO
// (JSON): { testerFailures: {"<stepId>": n}, skipMilestone, crashAgent, errorAgent, noVerdict, reporterLies,
// badDraft (plan-writer writes a draft without step ids), noDraft (plan-writer writes nothing) }.
import fs from "node:fs";
import path from "node:path";

const agent = process.env.DUKER_AGENT ?? "?";
const cwd = process.cwd();
const scenario = JSON.parse(process.env.FAKE_SCENARIO ?? "{}");
const task = process.argv[process.argv.length - 1];
const counters = path.join(cwd, ".duker", "fake-counters.json");
const load = (f) => {
	try {
		return fs.readFileSync(path.join(cwd, f), "utf8");
	} catch {
		return undefined;
	}
};
const append = (f, s) => fs.appendFileSync(path.join(cwd, f), s);
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const say = (text, stopReason = "stop") =>
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 } },
			model: "fake-model",
			stopReason,
		},
	});
const tool = (name, args) => emit({ type: "tool_execution_start", toolCallId: "t", toolName: name, args });
const idOf = () => (/Step id: (\S+)/.exec(task) ?? /step (\S+) —/.exec(task))?.[1] ?? "?";

emit({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd });
if (scenario.crashAgent === agent) {
	process.stderr.write(`fake ${agent}: simulated crash\n`);
	process.exit(1);
}
if (scenario.errorAgent === agent) {
	say("", "error");
	process.exit(0);
}

switch (agent) {
	case "orchestrator": {
		const plan = load("Full_Plan.md") ?? "";
		const done = new Set([...(load("Current_State.md") ?? "").matchAll(/- \[DONE\] (\S+)/g)].map((m) => m[1]));
		const items = [...plan.matchAll(/^\s*-\s*(\d+(?:\.\d+)*)\s+([^:]+):\s*(.*)$/gm)];
		const next = items.find((m) => !done.has(m[1]));
		tool("read", { path: "Full_Plan.md" });
		if (!next) say("STEP: NONE\nTITLE: -\nDESCRIPTION: -\nREASON: everything done");
		else say(`Here you go:\n**STEP:** ${next[1]}\nTITLE: ${next[2].trim()}\nDESCRIPTION: ${next[3].trim()}\nREASON: first undone item`);
		break;
	}
	case "planner": {
		const fix = /mode fix/.test(task);
		const round = Number(/fix round (\d+)/.exec(task)?.[1] ?? 0);
		const id = idOf();
		const file = fix ? "FIXING_PLAN.md" : "CURRENT_PLAN.md";
		const openLines = (load("ISSUES.md") ?? "")
			.split("\n")
			.filter((l) => l.includes("[OPEN]"))
			.join("\n");
		const body = fix
			? `# Fix round ${round} for step ${id}\n\n## Issues addressed\n${openLines}\n\n## Changes\n1. \`src/step-${id}.txt\` — append fix marker\n\n## Verification\n- Commands: \`true\`\n`
			: `# Step ${id} — planned\n\n## Goal\nCreate the step file.\n\n## Changes\n1. \`src/step-${id}.txt\` — create with content\n\n## Verification\n- Commands: \`true\`\n- Tests to add: none\n\n## Out of scope\n- everything else\n`;
		tool("write", { path: file });
		fs.writeFileSync(path.join(cwd, file), body);
		say(`wrote ${file}`);
		break;
	}
	case "implementer": {
		const fix = /fix round (\d+)/.exec(task);
		const id = idOf();
		fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
		append(`src/step-${id}.txt`, fix ? `fix ${fix[1]}\n` : `implemented ${id}\n`);
		tool("write", { path: `src/step-${id}.txt` });
		if (fix) {
			const issues = (load("ISSUES.md") ?? "").replace(/- \[OPEN\] \((tester|reviewer)\)([^\n]*)/g, "- [FIXED] ($1)$2 (fixed: appended marker)");
			fs.writeFileSync(path.join(cwd, "ISSUES.md"), issues);
		} else {
			append("ISSUES.md", "- [NOTE] (implementer) src/other.txt:1 — unrelated typo, out of scope\n");
		}
		say(`Changed files:\n- src/step-${id}.txt\nVerification run: true\nOpen problems: none`);
		break;
	}
	case "tester": {
		const id = idOf();
		let c = {};
		try {
			c = JSON.parse(fs.readFileSync(counters, "utf8"));
		} catch {
			/* first run */
		}
		c[id] = (c[id] ?? 0) + 1;
		fs.mkdirSync(path.dirname(counters), { recursive: true });
		fs.writeFileSync(counters, JSON.stringify(c));
		const wanted = scenario.testerFailures?.[id] ?? 0;
		tool("bash", { command: "pytest -q" });
		if (c[id] <= wanted) {
			append("ISSUES.md", `- [OPEN] (tester) src/step-${id}.txt:1 — test_step_${id}: AssertionError run ${c[id]}\n  assert False\n`);
			say("Commands run:\n- `pytest -q` → fail (1 failed)\nFailures logged: 1");
		} else say("Commands run:\n- `pytest -q` → pass\nFailures logged: 0");
		break;
	}
	case "reviewer": {
		tool("bash", { command: "git diff HEAD" });
		append("ISSUES.md", "- [NOTE] (reviewer) src/x.txt:1 — could be simpler\n");
		say("Nothing blocking.\nVerdict: OK with notes");
		break;
	}
	case "reporter": {
		const open = ((load("ISSUES.md") ?? "").match(/- \[OPEN\]/g) ?? []).length;
		const verdict = scenario.reporterLies ? "PASS" : open ? "FAIL" : "PASS";
		fs.writeFileSync(path.join(cwd, "CURRENT_REPORT.md"), scenario.noVerdict ? "## Summary\nlooks fine\n" : `VERDICT: ${verdict}\n\n## Summary\n${open} open\n`);
		say(`VERDICT: ${verdict}`);
		break;
	}
	case "state-updater": {
		const m = /`(- \[DONE\][^`]+)`/.exec(task);
		if (!scenario.skipMilestone && m) {
			const cs = load("Current_State.md") ?? "# Current State\n\n## Milestones\n\n";
			fs.writeFileSync(path.join(cwd, "Current_State.md"), `${cs.replace(/(## Milestones\n)/, `$1${m[1]}\n`)}\n## Layout\n- src/ has step files\n`);
		}
		say(m ? m[1] : "no milestone");
		break;
	}
	case "plan-writer": {
		// Converts the named document's list items (or the description's lines) into `- 1.n Title: text` steps.
		const src = /convert the existing plan document `([^`]+)`/.exec(task)?.[1];
		let items = src
			? (load(src) ?? "")
					.split("\n")
					.filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l))
					.map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
			: (task.split("Project description:")[1] ?? "")
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean);
		if (!items.length) items = ["Do something", "Do another thing"];
		tool("read", { path: src ?? "README.md" });
		if (scenario.noDraft) {
			say("I could not produce a plan.");
			break;
		}
		const steps = items.map((t, i) => `- 1.${i + 1} ${t.split(/[:.]/)[0].trim()}: ${t}. Done when: it exists.`).join("\n");
		const body = scenario.badDraft
			? "# Plan\n\nno numbered steps here\n"
			: `# Demo — Full Plan\n\nConverted from ${src ?? "the description"}.\n\n## Phase 1 — Everything\n\n${steps}\n`;
		tool("write", { path: "Full_Plan.draft.md" });
		fs.writeFileSync(path.join(cwd, "Full_Plan.draft.md"), body);
		say(`Wrote Full_Plan.draft.md: 1 phase, ${items.length} steps; nothing dropped.`);
		break;
	}
	default:
		say(`unknown agent ${agent}`);
}
