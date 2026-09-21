/**
 * duker child guard — loaded ONLY inside child pi processes via `-e`.
 * (Lives outside extensions/ so the package manifest never loads it into the parent.)
 *
 * Enforces, per IMPLEMENTATION_PLAN.md §8:
 *  - edit/write (and any tool with a `path` argument that mutates) may only touch paths matching
 *    DUKER_WRITE_ALLOW (empty = anything) and never DUKER_WRITE_DENY; never outside DUKER_CWD.
 *  - bash may not run git write commands or `rm -rf`.
 *  - the duker_loop tool is blocked (no recursion).
 *
 * Configuration arrives via environment variables set by the parent's runtime.ts:
 *  DUKER_AGENT, DUKER_CWD, DUKER_WRITE_ALLOW (JSON string[]), DUKER_WRITE_DENY (JSON string[]),
 *  DUKER_DEBUG ("1" → log active tools at session_start to stderr).
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MUTATING_PATH_TOOLS = new Set(["edit", "write"]);
const GIT_WRITE_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push|reset|checkout|clean|stash|rebase|merge|switch|restore|am|cherry-pick|revert|rm|mv|add)\b/;
/** True when any `rm` invocation in the command combines recursive and force flags (in any order/grouping). */
export function isRecursiveForceRm(command: string): boolean {
	for (const m of command.matchAll(/(?:^|[\s;&|(])rm\s+([^;&|)]*)/g)) {
		let recursive = false;
		let force = false;
		for (const tok of m[1]!.trim().split(/\s+/)) {
			if (tok === "--") break;
			if (tok === "--recursive") recursive = true;
			else if (tok === "--force") force = true;
			else if (/^-[a-zA-Z]+$/.test(tok)) {
				if (/[rR]/.test(tok)) recursive = true;
				if (/f/.test(tok)) force = true;
			} else if (!tok.startsWith("-")) continue; // operand; keep scanning for trailing flags (GNU rm allows them)
		}
		if (recursive && force) return true;
	}
	return false;
}

export interface GuardConfig {
	agent: string;
	cwd: string;
	allow: string[];
	deny: string[];
}

export function readGuardConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
	return {
		agent: env.DUKER_AGENT ?? "unknown",
		cwd: env.DUKER_CWD ?? process.cwd(),
		allow: parseList(env.DUKER_WRITE_ALLOW),
		deny: parseList(env.DUKER_WRITE_DENY),
	};
}

function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. Matches whole path. */
export function globToRegExp(glob: string): RegExp {
	let re = "^";
	const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	for (let i = 0; i < g.length; i++) {
		const c = g[i]!;
		if (c === "*") {
			if (g[i + 1] === "*") {
				// `**/` matches zero or more directories; bare `**` matches anything
				if (g[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") re += "[^/]";
		else if (/[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`${re}$`);
}

/** Relative (posix-style) path from cwd, or null when the target escapes cwd. */
export function relativeInside(cwd: string, target: string): string | null {
	const cleaned = target.replace(/^@/, "");
	const abs = path.resolve(cwd, cleaned);
	const rel = path.relative(cwd, abs).split(path.sep).join("/");
	if (rel === "" || rel === "." ) return ".";
	if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
	return rel;
}

export function checkWrite(cfg: GuardConfig, target: string): { ok: true } | { ok: false; reason: string } {
	const rel = relativeInside(cfg.cwd, target);
	if (rel === null) return { ok: false, reason: `path "${target}" is outside the project directory` };
	if (cfg.deny.some((g) => globToRegExp(g).test(rel))) {
		return { ok: false, reason: `"${rel}" is on this agent's deny list` };
	}
	if (cfg.allow.length && !cfg.allow.some((g) => globToRegExp(g).test(rel))) {
		return { ok: false, reason: `"${rel}" is not in this agent's write allowlist (${cfg.allow.join(", ")})` };
	}
	return { ok: true };
}

// `> file`, `>> file`, `2> file`, `&> file` targets and `tee [-a] file` targets
const REDIRECT_RE = /(?:^|[\s;&|(])(?:\d|&)?>{1,2}\s*([^\s;&|<>()]+)/g;
const TEE_RE = /\btee\s+(?:-[a-zA-Z]+\s+)*([^\s;&|<>()]+)/g;

/** Paths a bash command writes to via redirection or tee (best effort; quotes stripped). */
export function bashWriteTargets(command: string): string[] {
	const out: string[] = [];
	for (const re of [REDIRECT_RE, TEE_RE]) {
		re.lastIndex = 0;
		for (const m of command.matchAll(re)) {
			const t = m[1]!.replace(/^['"]|['"]$/g, "");
			if (!t || t === "/dev/null" || t.startsWith("&") || t.startsWith("$")) continue;
			out.push(t);
		}
	}
	return out;
}

export function checkBash(command: string, cfg?: GuardConfig): { ok: true } | { ok: false; reason: string } {
	if (GIT_WRITE_RE.test(command)) {
		return { ok: false, reason: "git commands that change the index or history (add/rm/mv/commit/push/reset/checkout/clean/stash/rebase/...) are reserved for the duker loop; use git diff/status/log/show only" };
	}
	if (isRecursiveForceRm(command)) {
		return { ok: false, reason: "recursive force delete (rm -rf) is not allowed for duker agents" };
	}
	if (cfg) {
		for (const target of bashWriteTargets(command)) {
			const r = checkWrite(cfg, target);
			if (!r.ok) return { ok: false, reason: `shell redirection to ${r.reason}; use the write/edit tools for files you are allowed to change` };
		}
	}
	return { ok: true };
}

export default function (pi: ExtensionAPI) {
	const cfg = readGuardConfig();
	const blocked = (what: string, reason: string) => {
		process.stderr.write(`duker-guard[${cfg.agent}]: blocked ${what}: ${reason}\n`);
		return { block: true, reason: `duker guard (${cfg.agent}): ${reason}` };
	};

	pi.on("session_start", async () => {
		if (process.env.DUKER_DEBUG === "1") {
			process.stderr.write(`duker-guard[${cfg.agent}]: active tools = ${pi.getActiveTools().join(",")}\n`);
		}
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "duker_loop") return blocked("duker_loop", "nested duker loops are not allowed");

		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			const r = checkBash(command, cfg);
			if (!r.ok) return blocked(`bash "${command.slice(0, 80)}"`, r.reason);
			return undefined;
		}

		if (MUTATING_PATH_TOOLS.has(event.toolName)) {
			const input = event.input as { path?: unknown };
			const target = typeof input.path === "string" ? input.path : "";
			const r = checkWrite(cfg, target);
			if (!r.ok) return blocked(`${event.toolName} ${target}`, r.reason);
		}
		return undefined;
	});
}
