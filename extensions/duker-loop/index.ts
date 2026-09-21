/**
 * duker-loop — deterministic Full_Plan.md → plan → implement → test/review → report → persist loop.
 * Entry point: registers the /duker command, the duker_loop tool, flags, and session lifecycle.
 * See IMPLEMENTATION_PLAN.md.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { bundledAgentsDir, discoverAgents, findAgent, formatAgentList } from "./agents.ts";
import { artifactExists, cleanTempArtifacts, parseIssues, parseVerdict, readArtifact } from "./artifacts.ts";
import { type ProgressSink, runLoop } from "./loop.ts";
import { formatLoopSummary, formatPhase, formatStepLine } from "./render.ts";
import { ChildAbortedError, formatDuration, isFailedResult, killAllChildren, resultErrorText, runChild } from "./runtime.ts";
import { clearState, loadState, statePath } from "./state.ts";
import { registerDukerTool, type RunRegistry } from "./tool.ts";
import { ARTIFACTS, DUKER_DIR, TEMP_ARTIFACTS } from "./types.ts";

const STATUS_KEY = "duker";
const ENTRY_TYPE = "duker-note";

/** The one loop that may run per session (command or tool). */
let activeRun: { controller: AbortController; startedAt: number; via: "command" | "tool" } | undefined;

const registry: RunRegistry = {
	acquire(via, controller) {
		if (activeRun) {
			return `a duker loop is already running (started ${formatDuration(Date.now() - activeRun.startedAt)} ago via ${activeRun.via}); use /duker abort first`;
		}
		activeRun = { controller, startedAt: Date.now(), via };
		return undefined;
	},
	release() {
		activeRun = undefined;
	},
};

export default function (pi: ExtensionAPI) {
	// pi 0.85 flags are "string" | "boolean" only; numeric flags are parsed via numberFlag().
	pi.registerFlag("duker-max-rounds", {
		description: "duker: max corrective rounds per Full_Plan step",
		type: "string",
		default: "3",
	});
	pi.registerFlag("duker-max-cost", {
		description: "duker: halt when the accumulated child cost (USD) exceeds this value (0 = unlimited)",
		type: "string",
		default: "0",
	});
	pi.registerFlag("duker-child-timeout", {
		description: "duker: per-child timeout in minutes; overrides agent frontmatter when > 0",
		type: "string",
		default: "0",
	});
	pi.registerFlag("duker-allow-dirty", {
		description: "duker: start a new step even if the git working tree is dirty",
		type: "boolean",
		default: false,
	});

	// Transcript notes (not part of LLM context) used for command output.
	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { title: string; body: string };
		const title = theme.fg("accent", theme.bold(data.title));
		return new Text(`${title}\n${theme.fg("dim", data.body)}`, 0, 0);
	});

	registerDukerTool(pi, { registry, baseOptions: (ctx) => baseOptions(pi, ctx) });

	pi.registerCommand("duker", {
		description: "Run the duker loop: /duker [n] | status | clean | abort | agents | run <agent> <task>",
		getArgumentCompletions: (prefix) =>
			["agents", "run", "status", "clean", "abort"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub) {
				case "agents":
					return cmdAgents(pi, ctx);
				case "run":
					return cmdRun(pi, ctx, rest);
				case "status":
					return cmdStatus(pi, ctx);
				case "clean":
					return cmdClean(pi, ctx);
				case "abort":
					return cmdAbort(pi, ctx);
				default: {
					const n = sub === "" ? 1 : Number(sub);
					if (!Number.isInteger(n) || n < 1 || rest.length) {
						return note(pi, ctx, "duker", "usage: /duker [n] | status | clean | abort | agents | run <agent> <task>");
					}
					return cmdLoop(pi, ctx, n);
				}
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", async () => {
		activeRun?.controller.abort();
		killAllChildren();
	});
}

/** Loop options shared by the command and the tool: flags + parent model/thinking. */
function baseOptions(pi: ExtensionAPI, ctx: ExtensionContext) {
	return {
		maxRounds: numberFlag(pi, "duker-max-rounds", 3),
		maxCost: numberFlag(pi, "duker-max-cost", 0),
		childTimeoutMinutes: numberFlag(pi, "duker-child-timeout", 0),
		allowDirty: pi.getFlag("duker-allow-dirty") === true,
		inheritModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		inheritThinking: ctx.thinkingLevel,
	};
}

// ---------------------------------------------------------------------------------------------
// /duker [n]
// ---------------------------------------------------------------------------------------------

async function cmdLoop(pi: ExtensionAPI, ctx: ExtensionCommandContext, steps: number) {
	const controller = new AbortController();
	const busy = registry.acquire("command", controller);
	if (busy) return note(pi, ctx, "duker", busy);
	const sink = makeSink(pi, ctx);
	const setStatus = (t: string | undefined) => ctx.hasUI && ctx.ui.setStatus(STATUS_KEY, t);
	setStatus("duker ⏳ starting");
	try {
		const summary = await runLoop({ ...baseOptions(pi, ctx), cwd: ctx.cwd, steps, signal: controller.signal, sink });
		const { title, body } = formatLoopSummary(summary, sink.notes);
		note(pi, ctx, title, body);
		if (ctx.hasUI) ctx.ui.notify(title, summary.stopped === "halted" ? "error" : summary.stopped === "aborted" ? "warning" : "info");
	} catch (err) {
		const msg = (err as Error).message;
		note(pi, ctx, "duker: error", `${msg}${sink.notes.length ? `\n\n${sink.notes.join("\n")}` : ""}`);
		if (ctx.hasUI) ctx.ui.notify(`duker: ${msg}`, "error");
	} finally {
		registry.release();
		setStatus(undefined);
	}
}

function cmdAbort(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	if (!activeRun) return note(pi, ctx, "duker abort", "no loop is running");
	activeRun.controller.abort();
	note(pi, ctx, "duker abort", "abort requested; the running child is being stopped and the step state is kept for resume");
}

function makeSink(pi: ExtensionAPI, ctx: ExtensionCommandContext): ProgressSink & { notes: string[] } {
	const notes: string[] = [];
	const stamp = () => new Date().toISOString().slice(11, 19);
	return {
		notes,
		phase(info) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatPhase(info));
		},
		note(level, text) {
			notes.push(`${stamp()} [${level}] ${text}`);
			if (ctx.hasUI && level !== "info") ctx.ui.notify(`duker: ${text}`, level);
			else if (!ctx.hasUI) console.log(`duker [${level}] ${text}`);
		},
		stepDone(step) {
			const line = formatStepLine(step);
			notes.push(`${stamp()} ${line}`);
			pi.appendEntry(ENTRY_TYPE, { title: `duker step ${step.stepId}`, body: line });
		},
	};
}

function cmdStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const lines: string[] = [];
	let state: ReturnType<typeof loadState>;
	try {
		state = loadState(ctx.cwd);
	} catch (err) {
		return note(pi, ctx, "duker status", (err as Error).message);
	}
	if (state) {
		const last = state.history[state.history.length - 1];
		lines.push(`step ${state.stepId} — ${state.title}`);
		lines.push(`phase ${state.phase} · round ${state.round} · run ${state.runId} · started ${state.startedAt}`);
		if (state.headAtStepStart) lines.push(`head at step start: ${state.headAtStepStart.slice(0, 12)}`);
		if (last) lines.push(`last phase: ${last.phase}${last.agent ? ` (${last.agent})` : ""} ${last.ok ? "ok" : "FAILED"} ${Math.round(last.ms / 1000)}s${last.note ? ` — ${last.note}` : ""}`);
	} else {
		lines.push("no step in progress");
	}
	const present = (Object.keys(ARTIFACTS) as (keyof typeof ARTIFACTS)[])
		.filter((k) => artifactExists(ctx.cwd, k))
		.map((k) => ARTIFACTS[k]);
	lines.push(`artifacts: ${present.length ? present.join(", ") : "none"}`);
	const issues = parseIssues(readArtifact(ctx.cwd, "issues"));
	if (issues.entries.length || issues.malformed.length) {
		lines.push(`ISSUES.md: ${issues.open} open · ${issues.fixed} fixed · ${issues.notes} notes${issues.malformed.length ? ` · ${issues.malformed.length} malformed` : ""}`);
	}
	if (artifactExists(ctx.cwd, "report")) {
		const v = parseVerdict(readArtifact(ctx.cwd, "report"));
		lines.push(`CURRENT_REPORT.md: VERDICT ${v.verdict}${v.found ? "" : " (no verdict line found)"}`);
	}
	note(pi, ctx, "duker status", lines.join("\n"));
}

/** Discard a half-finished step: temp artifacts + state file. Logs under .duker/runs stay. */
function cmdClean(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const deleted = cleanTempArtifacts(ctx.cwd);
	const hadState = clearState(ctx.cwd);
	const parts: string[] = [];
	parts.push(deleted.length ? `deleted ${deleted.join(", ")}` : `no temp artifacts present (${TEMP_ARTIFACTS.join(", ")})`);
	parts.push(hadState ? `deleted ${path.relative(ctx.cwd, statePath(ctx.cwd))}` : "no state file present");
	note(pi, ctx, "duker clean", parts.join("\n"));
}

/** Manual entry point: run one agent with a task outside the loop (debugging, prompt tuning). */
async function cmdRun(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string[]) {
	const [agentName, ...taskWords] = rest;
	const task = taskWords.join(" ");
	if (!agentName || !task) return note(pi, ctx, "duker run", "usage: /duker run <agent> <task...>");
	const discovery = discoverAgents(bundledAgentsDir());
	const agent = findAgent(discovery, agentName);
	if (!agent) {
		return note(pi, ctx, "duker run", `unknown agent "${agentName}". Known: ${discovery.agents.map((a) => a.name).join(", ")}`);
	}

	const runId = `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const logPath = path.join(ctx.cwd, DUKER_DIR, "runs", runId, `1-${agent.name}.jsonl`);
	const setStatus = (text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};
	const started = Date.now();
	const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
	setStatus(`${agent.name} ⏳ starting`);
	try {
		const result = await runChild({
			agent,
			task,
			cwd: ctx.cwd,
			inheritModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			inheritThinking: ctx.thinkingLevel,
			timeoutMinutes: numberFlag(pi, "duker-child-timeout", 0),
			logPath,
			onEvent: (ev) => {
				if (ev.kind === "tool") setStatus(`${agent.name} ⏳ ${elapsed()} · ${ev.toolName}`);
				else if (ev.kind === "text") setStatus(`${agent.name} ⏳ ${elapsed()} · thinking`);
				else if (ev.kind === "retry") setStatus(`${agent.name} ⏳ ${elapsed()} · retry ${ev.attempt}`);
			},
		});
		const u = result.usage;
		const head = isFailedResult(result)
			? `✗ duker run ${agent.name} failed: ${resultErrorText(result)}`
			: `✓ duker run ${agent.name} done`;
		const body = [
			`${Math.round(result.durationMs / 1000)}s · ${u.turns} turns · ↑${u.input} ↓${u.output} · $${u.cost.toFixed(4)} · ${result.model ?? "?"}`,
			`guard blocks: ${result.guardBlocks} · exit ${result.exitCode} · stop ${result.stopReason ?? "?"} · log ${path.relative(ctx.cwd, logPath)}`,
			"",
			result.finalText || "(no output)",
		].join("\n");
		note(pi, ctx, head, body);
	} catch (err) {
		if (err instanceof ChildAbortedError) note(pi, ctx, `duker run ${agent.name}`, "aborted");
		else note(pi, ctx, `duker run ${agent.name}`, `error: ${(err as Error).message}`);
	} finally {
		setStatus(undefined);
	}
}

function cmdAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const discovery = discoverAgents(bundledAgentsDir());
	const body = formatAgentList(discovery);
	const summary = `${discovery.agents.length} agent(s) from ${discovery.agentsDir}`;
	note(pi, ctx, `duker agents — ${summary}`, body);
	if (discovery.missing.length || discovery.errors.length) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`duker: ${discovery.missing.length} required agent(s) missing, ${discovery.errors.length} file error(s)`,
				"error",
			);
		}
	}
}

/** Read a numeric flag registered as a string; falls back to `fallback` on garbage. */
export function numberFlag(pi: ExtensionAPI, name: string, fallback: number): number {
	const raw = pi.getFlag(name);
	if (raw === undefined || raw === null || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function note(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, body: string) {
	pi.appendEntry(ENTRY_TYPE, { title, body });
	if (!ctx.hasUI) {
		console.log(`${title}\n${body}`);
	}
}
