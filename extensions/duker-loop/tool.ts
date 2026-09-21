/**
 * The `duker_loop` tool: lets the parent model start the loop. Same code path as /duker
 * (IMPLEMENTATION_PLAN.md §9, decision #26: blocking, progress via onUpdate).
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LoopOptions, type LoopSummary, type ProgressSink, runLoop } from "./loop.ts";
import { type DukerDetails, formatPhase, formatStepLine, formatToolContent, renderCall, renderResult } from "./render.ts";
import type { ChildUsage } from "./runtime.ts";
import { ARTIFACTS } from "./types.ts";

export const DukerLoopParams = Type.Object({
	steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "How many Full_Plan.md steps to attempt in sequence. Default 1." })),
	cwd: Type.Optional(Type.String({ description: "Project directory containing Full_Plan.md. Default: the session's working directory." })),
});

export interface RunRegistry {
	/** Called before a run starts; returns false when another run is active (and why). */
	acquire(via: "command" | "tool", controller: AbortController): string | undefined;
	release(): void;
}

export interface ToolDeps {
	registry: RunRegistry;
	/** Builds LoopOptions minus cwd/steps/signal/sink from flags + ctx. */
	baseOptions(ctx: ExtensionContext): Pick<LoopOptions, "maxRounds" | "maxCost" | "childTimeoutMinutes" | "allowDirty" | "inheritModel" | "inheritThinking">;
}

export function registerDukerTool(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool<typeof DukerLoopParams, DukerDetails>({
		name: "duker_loop",
		label: "Duker loop",
		description: [
			`Runs the duker delivery loop on the project: reads ${ARTIFACTS.fullPlan} and ${ARTIFACTS.currentState}, selects the next undone step, then plans → implements → tests → reviews → reports, with up to N corrective rounds, and on PASS records the step in ${ARTIFACTS.currentState} and commits.`,
			"Blocking: returns when the requested steps have passed, the plan is complete, or the loop halted. Halts are reported as errors with the reason; the step's artifacts and code stay in place and the next call resumes it.",
			"Requires Full_Plan.md in the project root and a clean git tree (or the --duker-allow-dirty flag); the user prepares both with /duker init. Only one loop may run at a time.",
		].join(" "),
		promptSnippet: "Run the duker plan→implement→validate loop over Full_Plan.md steps",
		promptGuidelines: [
			"Use duker_loop when the user asks to execute, continue, or advance the project plan (Full_Plan.md); do not implement plan steps by hand in that case.",
			"After duker_loop halts, read ISSUES.md and CURRENT_REPORT.md before deciding whether to re-run it.",
		],
		parameters: DukerLoopParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ? (params.cwd.startsWith("@") ? params.cwd.slice(1) : params.cwd) : ctx.cwd;
			const steps = params.steps ?? 1;
			const controller = new AbortController();
			const busy = deps.registry.acquire("tool", controller);
			if (busy) throw new Error(busy);
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener("abort", () => controller.abort(), { once: true });
			}

			const details: DukerDetails = { cwd, steps, startedAt: new Date().toISOString(), notes: [], stepsDone: [] };
			const snapshot = (): DukerDetails => ({ ...details, notes: [...details.notes], stepsDone: [...details.stepsDone], current: details.current ? { ...details.current } : undefined });
			const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: snapshot() });
			const sink = makeToolSink(details, emit, ctx);
			const setStatus = (t: string | undefined) => ctx.hasUI && ctx.ui.setStatus("duker", t);

			let summary: LoopSummary;
			try {
				setStatus("duker ⏳ starting");
				summary = await runLoop({ ...deps.baseOptions(ctx), cwd, steps, signal: controller.signal, sink });
			} catch (err) {
				const msg = (err as Error).message;
				throw new Error(`${msg.startsWith("duker") ? "" : "duker: "}${msg}${details.notes.length ? `\n${details.notes.join("\n")}` : ""}`);
			} finally {
				deps.registry.release();
				setStatus(undefined);
			}

			details.summary = summary;
			details.current = undefined;
			const content = formatToolContent(summary, details.notes);
			if (summary.stopped === "halted" || summary.stopped === "aborted") {
				throw new Error(content);
			}
			const result: AgentToolResult<DukerDetails> = {
				content: [{ type: "text", text: content }],
				details,
				usage: toUsage(summary.usage),
			};
			return result;
		},
		renderCall(args, theme) {
			return renderCall(args, theme);
		},
		renderResult(result, options, theme) {
			const text = result.content.find((c) => c.type === "text");
			return renderResult(result.details, text && "text" in text ? text.text : "", options, theme);
		},
	});
}

function makeToolSink(details: DukerDetails, emit: (text: string) => void, ctx: ExtensionContext): ProgressSink & { notes: string[] } {
	const stamp = () => new Date().toISOString().slice(11, 19);
	return {
		notes: details.notes,
		phase(info) {
			details.current = info;
			const text = formatPhase(info);
			if (ctx.hasUI) ctx.ui.setStatus("duker", text);
			emit(text);
		},
		note(level, text) {
			details.notes.push(`${stamp()} [${level}] ${text}`);
			if (ctx.hasUI && level !== "info") ctx.ui.notify(`duker: ${text}`, level);
			emit(details.current ? formatPhase(details.current) : text);
		},
		stepDone(step) {
			details.stepsDone.push(step);
			details.notes.push(`${stamp()} ${formatStepLine(step)}`);
			emit(formatStepLine(step));
		},
	};
}

/** Child usage → pi's Usage so nested LLM cost shows up in the session totals. */
export function toUsage(u: ChildUsage) {
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
	};
}

