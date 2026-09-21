/**
 * Child runtime (approach A): spawns one `pi --mode json -p` process per agent run, parses the
 * JSONL event stream, enforces timeout/abort, writes a raw log, returns a ChildResult.
 * IMPLEMENTATION_PLAN.md §7.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { packageRoot } from "./agents.ts";
import { type AgentConfig, GLOBAL_WRITE_DENY, type ThinkingLevel } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Loosely typed message from the JSON stream (pi's Message shape). */
export interface ChildMessage {
	role: string;
	content: unknown;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	timestamp?: number;
}

export interface ChildResult {
	agent: string;
	task: string;
	exitCode: number;
	timedOut: boolean;
	aborted: boolean;
	messages: ChildMessage[];
	stderr: string;
	usage: ChildUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** last assistant message's text */
	finalText: string;
	durationMs: number;
	guardBlocks: number;
	logPath?: string;
	argv: string[];
}

export type ChildEvent =
	| { kind: "start"; agent: string; argv: string[] }
	| { kind: "tool"; agent: string; toolName: string; args: Record<string, unknown> }
	| { kind: "text"; agent: string; text: string }
	| { kind: "retry"; agent: string; attempt: number; errorMessage: string }
	| { kind: "stderr"; agent: string; line: string }
	| { kind: "end"; agent: string; result: ChildResult };

export interface ChildSpec {
	agent: AgentConfig;
	/** positional prompt passed to the child */
	task: string;
	cwd: string;
	/** parent session's model as provider/id — used when the agent file pins none */
	inheritModel?: string;
	/** parent session's thinking level — used when the agent file pins neither model nor thinking */
	inheritThinking?: ThinkingLevel;
	/** overrides agent.timeoutMinutes when > 0 */
	timeoutMinutes?: number;
	/** raw JSONL event log; stderr goes to `${logPath}.stderr` */
	logPath?: string;
	signal?: AbortSignal;
	onEvent?: (event: ChildEvent) => void;
	extraEnv?: Record<string, string>;
}

export class ChildAbortedError extends Error {
	constructor(agent: string) {
		super(`duker: child "${agent}" was aborted`);
		this.name = "ChildAbortedError";
	}
}

// ---------------------------------------------------------------------------------------------
// Process registry (killed on session_shutdown / abort)
// ---------------------------------------------------------------------------------------------

const live = new Set<ChildProcess>();

export function liveChildCount(): number {
	return live.size;
}

export function killAllChildren(): void {
	for (const proc of live) killProcess(proc);
	live.clear();
}

const SIGKILL_GRACE_MS = 5000;

function killProcess(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	try {
		proc.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	const t = setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}, SIGKILL_GRACE_MS);
	t.unref();
}

// ---------------------------------------------------------------------------------------------
// pi executable resolution (same install the extension runs in)
// ---------------------------------------------------------------------------------------------

/**
 * Re-execute the same pi install this extension runs in. `DUKER_PI_BIN` overrides.
 * argv[1] is only trusted when it really is pi's CLI script — never re-exec an arbitrary
 * host script (that turns into a fork bomb when the runtime is driven from a test harness).
 */
export function getPiInvocation(): { command: string; args: string[] } {
	const override = process.env.DUKER_PI_BIN;
	if (override) {
		// A JS file is run through the current node (portable fake-pi for tests, no shell wrapper).
		if (/\.(m?js|cjs)$/i.test(override)) return { command: process.execPath, args: [override] };
		return { command: override, args: [] };
	}

	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/");
	if (script && !isBunVirtual && fs.existsSync(script) && looksLikePiCli(script)) {
		return { command: process.execPath, args: [script] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe") {
		return { command: "pi", args: [] };
	}
	return { command: process.execPath, args: [] };
}

function looksLikePiCli(script: string): boolean {
	let real = script;
	try {
		real = fs.realpathSync(script);
	} catch {
		/* keep as is */
	}
	const norm = real.replace(/\\/g, "/");
	return norm.includes("/pi-coding-agent/") || path.basename(norm) === "pi";
}

export function guardExtensionPath(): string {
	return path.join(packageRoot(), "child", "guard.ts");
}

// ---------------------------------------------------------------------------------------------
// argv / env construction (pure, testable)
// ---------------------------------------------------------------------------------------------

export function buildChildArgs(spec: ChildSpec, promptFile: string | undefined): string[] {
	const a = spec.agent;
	const args = ["--mode", "json", "-p", "--no-session", "--no-prompt-templates", "--no-themes"];

	args.push("--no-extensions", "-e", guardExtensionPath());
	for (const ext of a.extensions) args.push("-e", ext);

	if (a.skills === "all") {
		// leave discovery on
	} else if (a.skills.length === 0) {
		args.push("--no-skills");
	} else {
		for (const s of a.skills) args.push("--skill", s);
	}

	if (!a.contextFiles) args.push("--no-context-files");

	const model = a.model ?? spec.inheritModel;
	if (model) args.push("--model", model);
	const thinking = a.thinking ?? (a.model ? undefined : spec.inheritThinking);
	if (thinking) args.push("--thinking", thinking);

	if (a.tools?.length) args.push("--tools", a.tools.join(","));
	if (promptFile) args.push("--append-system-prompt", promptFile);

	args.push(spec.task);
	return args;
}

export function buildChildEnv(spec: ChildSpec): NodeJS.ProcessEnv {
	const a = spec.agent;
	return {
		...process.env,
		DUKER_AGENT: a.name,
		DUKER_CWD: spec.cwd,
		DUKER_WRITE_ALLOW: JSON.stringify(a.writeAllow),
		DUKER_WRITE_DENY: JSON.stringify([...GLOBAL_WRITE_DENY, ...a.writeDeny]),
		DUKER_DEPTH: "1",
		...spec.extraEnv,
	};
}

// ---------------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------------

export function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function addUsage(into: ChildUsage, from: ChildUsage): ChildUsage {
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.cost += from.cost;
	into.contextTokens = Math.max(into.contextTokens, from.contextTokens);
	into.turns += from.turns;
	return into;
}

export function messageText(msg: ChildMessage | undefined): string {
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((p): p is { type: "text"; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

export function lastAssistantText(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const t = messageText(m);
		if (t) return t;
	}
	return "";
}

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 120) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

export function isFailedResult(r: ChildResult): boolean {
	return r.exitCode !== 0 || r.timedOut || r.aborted || r.stopReason === "error" || r.stopReason === "aborted";
}

export function resultErrorText(r: ChildResult): string {
	if (r.timedOut) return `timed out after ${formatDuration(r.durationMs)}`;
	if (r.aborted) return "aborted";
	return r.errorMessage || r.stderr.trim().split("\n").slice(-5).join("\n") || r.finalText || `exit code ${r.exitCode}`;
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

export async function runChild(spec: ChildSpec): Promise<ChildResult> {
	const a = spec.agent;
	const started = Date.now();
	if (spec.signal?.aborted) throw new ChildAbortedError(a.name);
	if (process.env.DUKER_DEPTH) {
		throw new Error("duker: refusing to spawn a child from inside a duker child (DUKER_DEPTH is set)");
	}

	// system prompt → temp file (0600), always cleaned up
	let tmpDir: string | undefined;
	let promptFile: string | undefined;
	if (a.systemPrompt) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "duker-"));
		promptFile = path.join(tmpDir, `${a.name.replace(/[^a-z0-9_-]/gi, "_")}-system.md`);
		const file = promptFile;
		await withFileMutationQueue(file, () => fs.promises.writeFile(file, a.systemPrompt, { encoding: "utf8", mode: 0o600 }));
	}

	const argv = buildChildArgs(spec, promptFile);
	const invocation = getPiInvocation();
	const fullArgv = [invocation.command, ...invocation.args, ...argv];
	spec.onEvent?.({ kind: "start", agent: a.name, argv: fullArgv });

	const result: ChildResult = {
		agent: a.name,
		task: spec.task,
		exitCode: -1,
		timedOut: false,
		aborted: false,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		finalText: "",
		durationMs: 0,
		guardBlocks: 0,
		logPath: spec.logPath,
		argv: fullArgv,
	};

	let log: fs.WriteStream | undefined;
	let errLog: fs.WriteStream | undefined;
	if (spec.logPath) {
		fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
		log = fs.createWriteStream(spec.logPath, { flags: "a" });
		errLog = fs.createWriteStream(`${spec.logPath}.stderr`, { flags: "a" });
	}

	const timeoutMinutes = spec.timeoutMinutes && spec.timeoutMinutes > 0 ? spec.timeoutMinutes : a.timeoutMinutes;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, [...invocation.args, ...argv], {
				cwd: spec.cwd,
				env: buildChildEnv(spec),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			live.add(proc);

			let settled = false;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				live.delete(proc);
				clearTimeout(timer);
				spec.signal?.removeEventListener("abort", onAbort);
				resolve(code);
			};

			const onAbort = () => {
				result.aborted = true;
				killProcess(proc);
			};
			spec.signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				result.timedOut = true;
				killProcess(proc);
			}, timeoutMinutes * 60_000);

			let buffer = "";
			proc.stdout!.setEncoding("utf8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			});

			proc.stderr!.setEncoding("utf8");
			proc.stderr!.on("data", (chunk: string) => {
				result.stderr += chunk;
				errLog?.write(chunk);
				for (const line of chunk.split("\n")) {
					if (!line) continue;
					if (line.includes("duker-guard[") && line.includes("blocked")) result.guardBlocks++;
					spec.onEvent?.({ kind: "stderr", agent: a.name, line });
				}
			});

			proc.on("error", (err) => {
				result.stderr += `spawn error: ${err.message}\n`;
				finish(1);
			});
			proc.on("close", (code) => {
				if (buffer.trim()) handleLine(buffer);
				buffer = "";
				finish(code ?? (result.timedOut || result.aborted ? 1 : 0));
			});

			function handleLine(line: string) {
				if (!line.trim()) return;
				log?.write(`${line}\n`);
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				switch (ev.type) {
					case "message_end": {
						const msg = ev.message as ChildMessage | undefined;
						if (!msg) break;
						result.messages.push(msg);
						if (msg.role === "assistant") {
							const u = msg.usage ?? {};
							result.usage.turns++;
							result.usage.input += u.input ?? 0;
							result.usage.output += u.output ?? 0;
							result.usage.cacheRead += u.cacheRead ?? 0;
							result.usage.cacheWrite += u.cacheWrite ?? 0;
							result.usage.cost += u.cost?.total ?? 0;
							result.usage.contextTokens = u.totalTokens ?? result.usage.contextTokens;
							if (!result.model && msg.model) result.model = msg.model;
							if (msg.stopReason) result.stopReason = msg.stopReason;
							if (msg.errorMessage) result.errorMessage = msg.errorMessage;
							const text = messageText(msg);
							if (text) spec.onEvent?.({ kind: "text", agent: a.name, text });
						}
						break;
					}
					case "tool_execution_start":
						spec.onEvent?.({
							kind: "tool",
							agent: a.name,
							toolName: String(ev.toolName ?? "?"),
							args: (ev.args as Record<string, unknown>) ?? {},
						});
						break;
					case "auto_retry_start":
						spec.onEvent?.({
							kind: "retry",
							agent: a.name,
							attempt: Number(ev.attempt ?? 0),
							errorMessage: String(ev.errorMessage ?? ""),
						});
						break;
					default:
						break;
				}
			}
		});

		result.exitCode = exitCode;
		result.finalText = lastAssistantText(result.messages);
		result.durationMs = Date.now() - started;
		if (result.aborted) throw new ChildAbortedError(a.name);
		spec.onEvent?.({ kind: "end", agent: a.name, result });
		return result;
	} finally {
		log?.end();
		errLog?.end();
		if (promptFile) await fs.promises.unlink(promptFile).catch(() => {});
		if (tmpDir) await fs.promises.rmdir(tmpDir).catch(() => {});
	}
}
