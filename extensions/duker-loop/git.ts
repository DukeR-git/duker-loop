/**
 * Minimal git helpers used by the loop (IMPLEMENTATION_PLAN.md §5, decisions #13, #28, #29, #31).
 * All functions are no-ops / undefined outside a git repository.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { ARTIFACTS, DUKER_DIR, TEMP_ARTIFACTS } from "./types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		return { ok: true, stdout, stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message: string };
		return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
	}
}

/** Is a git executable on PATH at all? (init reports this separately from "not a repo".) */
export async function gitAvailable(): Promise<boolean> {
	const r = await git(process.cwd(), ["--version"]);
	return r.ok;
}

/** `git init` in cwd. Returns the error text on failure. */
export async function gitInit(cwd: string): Promise<{ error?: string }> {
	const r = await git(cwd, ["init", "-q"]);
	return r.ok ? {} : { error: r.stderr.trim() || "git init failed" };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return r.ok && r.stdout.trim() === "true";
}

export async function gitHead(cwd: string): Promise<string | undefined> {
	const r = await git(cwd, ["rev-parse", "HEAD"]);
	return r.ok ? r.stdout.trim() : undefined; // undefined also for a repo with no commits yet
}

/** `git status --porcelain` entries minus `.duker/` and the given loop-owned files. */
export async function changedFiles(cwd: string, ignore: readonly string[] = TEMP_ARTIFACTS): Promise<string[]> {
	const r = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	if (!r.ok) return [];
	const skip = new Set<string>(ignore);
	return r.stdout
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.map((l) => l.slice(3).trim())
		.filter((f) => !skip.has(f) && !f.startsWith(`${DUKER_DIR}/`));
}

/**
 * Dirty = anything changed except Current_State.md (which preflight may have just created and
 * which the loop owns). Leftover temp artifacts DO count: they mean a crashed run → /duker clean.
 */
export async function isDirty(cwd: string): Promise<boolean> {
	return (await changedFiles(cwd, [ARTIFACTS.currentState])).length > 0;
}

/** Adds a pattern to .git/info/exclude (not .gitignore — never touches tracked files). */
export async function ensureExcluded(cwd: string, pattern: string): Promise<boolean> {
	const r = await git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
	if (!r.ok) return false;
	const file = path.resolve(cwd, r.stdout.trim());
	let current = "";
	try {
		current = fs.readFileSync(file, "utf8");
	} catch {
		/* missing */
	}
	if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) return false;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${current.length && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
	return true;
}


/** Commits everything (except excluded paths). Returns the new sha, or undefined when nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<{ sha?: string; error?: string }> {
	return commitStaged(cwd, ["add", "-A"], message);
}

/** Commits only the given paths (missing ones are skipped). Returns the new sha, or undefined when nothing to commit. */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<{ sha?: string; error?: string }> {
	const present = paths.filter((p) => fs.existsSync(path.join(cwd, p)));
	if (!present.length) return {};
	return commitStaged(cwd, ["add", "--", ...present], message);
}

async function commitStaged(cwd: string, addArgs: string[], message: string): Promise<{ sha?: string; error?: string }> {
	const add = await git(cwd, addArgs);
	if (!add.ok) return { error: add.stderr.trim() };
	const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
	if (staged.ok) return {}; // exit 0 = no staged changes

	const identity: string[] = [];
	const email = await git(cwd, ["config", "user.email"]);
	if (!email.ok || !email.stdout.trim()) identity.push("-c", "user.name=duker-loop", "-c", "user.email=duker-loop@localhost");
	const commit = await git(cwd, [...identity, "commit", "-q", "-m", message]);
	if (!commit.ok) return { error: commit.stderr.trim() };
	return { sha: await gitHead(cwd) };
}
