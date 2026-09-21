/**
 * Project-root artifacts: fixed paths, read/write/delete helpers, and the parsers for the
 * contracts agents must honour (IMPLEMENTATION_PLAN.md §3).
 * No pi imports — testable with plain node.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ARTIFACTS,
	type IssueEntry,
	type IssueStatus,
	type OrchestratorStep,
	type ParsedIssues,
	type ParsedVerdict,
	TEMP_ARTIFACTS,
} from "./types.ts";

export type ArtifactKey = keyof typeof ARTIFACTS;

// ---------------------------------------------------------------------------------------------
// Paths & file helpers
// ---------------------------------------------------------------------------------------------

export function artifactPath(cwd: string, key: ArtifactKey): string {
	return path.join(cwd, ARTIFACTS[key]);
}

export function artifactExists(cwd: string, key: ArtifactKey): boolean {
	try {
		return fs.statSync(artifactPath(cwd, key)).isFile();
	} catch {
		return false;
	}
}

export function readArtifact(cwd: string, key: ArtifactKey): string | undefined {
	try {
		return fs.readFileSync(artifactPath(cwd, key), "utf8");
	} catch {
		return undefined;
	}
}

export function writeArtifact(cwd: string, key: ArtifactKey, content: string): void {
	fs.writeFileSync(artifactPath(cwd, key), content, "utf8");
}

export function deleteArtifact(cwd: string, key: ArtifactKey): boolean {
	try {
		fs.unlinkSync(artifactPath(cwd, key));
		return true;
	} catch {
		return false;
	}
}

/** Size + mtime fingerprint, used to detect whether an agent actually changed a file. */
export function artifactFingerprint(cwd: string, key: ArtifactKey): string | undefined {
	try {
		const st = fs.statSync(artifactPath(cwd, key));
		return `${st.size}:${st.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** Cleaner: removes CURRENT_PLAN, FIXING_PLAN, ISSUES, CURRENT_REPORT. Returns what was deleted. */
export function cleanTempArtifacts(cwd: string): string[] {
	const deleted: string[] = [];
	for (const name of TEMP_ARTIFACTS) {
		try {
			fs.unlinkSync(path.join(cwd, name));
			deleted.push(name);
		} catch {
			/* not present */
		}
	}
	return deleted;
}

export function issuesHeader(stepId: string): string {
	return `# Issues — step ${stepId}\n\nOne entry per line: \`- [OPEN|FIXED|NOTE] (author) <file:line> — <text>\`; details indented below.\n\n`;
}

/** Creates ISSUES.md with the header when missing, so every agent appends to the same file. */
export function ensureIssuesFile(cwd: string, stepId: string): boolean {
	if (artifactExists(cwd, "issues")) return false;
	writeArtifact(cwd, "issues", issuesHeader(stepId));
	return true;
}

/** Creates an empty Current_State.md skeleton when missing. */
export function ensureCurrentState(cwd: string): boolean {
	if (artifactExists(cwd, "currentState")) return false;
	writeArtifact(cwd, "currentState", "# Current State\n\n## Milestones\n\n");
	return true;
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

const LINE_SPLIT = /\r?\n/;

/**
 * Strips markdown decoration small models like to add (heading markers, backticks, `**bold**`,
 * `__bold__`, `~~x~~`, and single `*`/`_` emphasis touching whitespace or punctuation) while
 * leaving underscores inside identifiers such as `requester_id` intact.
 */
function unmark(line: string): string {
	return line
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/[`~]+|\*\*|__/g, "")
		.replace(/(^|[\s(])[*_]+(?=\S)/g, "$1")
		.replace(/(?<=\S)[*_]+(?=[\s:).,;]|$)/g, "")
		.trim();
}

const VERDICT_SCAN_LINES = 5;
const VERDICT_RE = /^VERDICT\s*[:=]\s*(PASS|FAIL)\b/i;

/**
 * Contract: first line `VERDICT: PASS|FAIL`. Tolerates markdown decoration and up to
 * VERDICT_SCAN_LINES leading non-empty lines (e.g. a title). Missing ⇒ FAIL, found=false.
 */
export function parseVerdict(text: string | undefined): ParsedVerdict {
	if (!text) return { verdict: "FAIL", found: false };
	const lines = text.split(LINE_SPLIT);
	let seen = 0;
	for (let i = 0; i < lines.length && seen < VERDICT_SCAN_LINES; i++) {
		const raw = lines[i]!;
		if (!raw.trim()) continue;
		seen++;
		const m = VERDICT_RE.exec(unmark(raw));
		if (m) return { verdict: m[1]!.toUpperCase() as "PASS" | "FAIL", found: true, line: i + 1 };
	}
	return { verdict: "FAIL", found: false };
}

// `- [OPEN] (tester) src/a.py:12 — text`   (dash variants: — – -, optional location)
const ISSUE_RE = /^\s*[-*]\s*\[(OPEN|FIXED|NOTE)\]\s*\(([^)]+)\)\s*(?:(\S+?)\s+)?(?:—|–|-{1,2})\s*(.*)$/i;
const ISSUE_LIKE_RE = /^\s*[-*]\s*\[/;

export function parseIssues(text: string | undefined): ParsedIssues {
	const result: ParsedIssues = { entries: [], open: 0, fixed: 0, notes: 0, malformed: [] };
	if (!text) return result;
	const lines = text.split(LINE_SPLIT);
	let current: IssueEntry | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const m = ISSUE_RE.exec(raw);
		if (m) {
			const status = m[1]!.toUpperCase() as IssueStatus;
			let location = (m[3] ?? "-").trim();
			let body = m[4]!.trim();
			// `(author) — text` with no location: m[3] is undefined; `(author) - text` handled too.
			// Location that is itself a dash means "no location".
			if (/^[—–-]+$/.test(location)) location = "-";
			// Trailing " (fixed: …)" note on FIXED lines stays in text.
			current = { status, author: m[2]!.trim().toLowerCase(), location, text: body, detail: [], line: i + 1 };
			result.entries.push(current);
			if (status === "OPEN") result.open++;
			else if (status === "FIXED") result.fixed++;
			else result.notes++;
			continue;
		}
		if (ISSUE_LIKE_RE.test(raw)) {
			result.malformed.push({ line: i + 1, text: raw.trim() });
			current = undefined;
			continue;
		}
		if (current && /^\s+\S/.test(raw)) {
			current.detail.push(raw.trim());
			continue;
		}
		if (!raw.trim()) continue;
		// any other non-indented line ends the current entry (headings, prose)
		current = undefined;
	}
	return result;
}

export function openIssueLines(parsed: ParsedIssues): string[] {
	return parsed.entries
		.filter((e) => e.status === "OPEN")
		.map((e) => `- [OPEN] (${e.author}) ${e.location} — ${e.text}`);
}

const FIELD_RE = /^(STEP|TITLE|DESCRIPTION|REASON)\s*[:=]\s*(.*)$/i;

/**
 * Contract: exactly the lines STEP / TITLE / DESCRIPTION / REASON.
 * Tolerates markdown decoration, code fences, chatter before/after, and continuation lines
 * (appended to the previous field). STEP must be NONE, BLOCKED, or a non-empty id.
 */
export function parseOrchestratorOutput(text: string | undefined): OrchestratorStep {
	const raw = text ?? "";
	const fields: Record<string, string> = {};
	let last: string | undefined;
	for (const line of raw.split(LINE_SPLIT)) {
		const cleaned = unmark(line);
		if (!cleaned || /^```/.test(line.trim())) continue;
		const m = FIELD_RE.exec(cleaned);
		if (m) {
			last = m[1]!.toUpperCase();
			fields[last] = m[2]!.trim();
		} else if (last && last !== "STEP") {
			fields[last] = `${fields[last]} ${cleaned}`.trim();
		}
	}

	const stepRaw = (fields.STEP ?? "").replace(/[.,;]+$/, "").trim();
	if (!stepRaw) return { kind: "invalid", error: "no STEP line found", raw };
	const reason = fields.REASON ?? "";
	const upper = stepRaw.toUpperCase();
	if (upper === "NONE") return { kind: "none", reason };
	if (upper === "BLOCKED") return { kind: "blocked", reason };

	// ids look like "1.3", "2", "3.1.2", "Phase 1 / 1.2" → keep the first id-like token
	const idMatch = /\d+(?:\.\d+)*[a-z]?/i.exec(stepRaw);
	const id = idMatch ? idMatch[0] : stepRaw.split(/\s+/)[0]!;
	const title = (fields.TITLE ?? "").replace(/^-$/, "").trim();
	const description = (fields.DESCRIPTION ?? "").replace(/^-$/, "").trim();
	if (!title && !description) {
		return { kind: "invalid", error: `STEP ${id} has neither TITLE nor DESCRIPTION`, raw };
	}
	return { kind: "step", id, title: title || description.slice(0, 80), description: description || title, reason };
}

const MILESTONE_RE = /^\s*[-*]\s*\[DONE\]\s*(\S+?)\s*(?:—|–|-{1,2}|:)\s*(.*)$/i;

/** Milestone ids recorded in Current_State.md (`- [DONE] <id> — <title> (<date>)`). */
export function parseMilestones(text: string | undefined): { id: string; title: string; line: number }[] {
	if (!text) return [];
	const out: { id: string; title: string; line: number }[] = [];
	text.split(LINE_SPLIT).forEach((line, i) => {
		const m = MILESTONE_RE.exec(line);
		if (m) out.push({ id: m[1]!, title: m[2]!.trim(), line: i + 1 });
	});
	return out;
}

export function milestoneLine(id: string, title: string, date = new Date()): string {
	const d = date.toISOString().slice(0, 10);
	return `- [DONE] ${id} — ${title} (${d})`;
}
