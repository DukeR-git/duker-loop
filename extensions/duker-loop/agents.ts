/**
 * Agent discovery: loads and validates the bundled agents/*.md files.
 * One malformed file must never prevent the others from loading (IMPLEMENTATION_PLAN.md §4.1).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentDiscovery,
	type AgentLoadError,
	type AgentName,
	REQUIRED_AGENTS,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./types.ts";

const DEFAULT_TIMEOUT_MINUTES = 30;

/** The package root is two levels above extensions/duker-loop/. */
export function packageRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function bundledAgentsDir(): string {
	return path.join(packageRoot(), "agents");
}

export function discoverAgents(agentsDir: string = bundledAgentsDir()): AgentDiscovery {
	const agents: AgentConfig[] = [];
	const errors: AgentLoadError[] = [];

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch (err) {
		errors.push({ file: agentsDir, message: `cannot read agents dir: ${(err as Error).message}` });
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(agentsDir, entry.name);
		try {
			agents.push(loadAgentFile(filePath));
		} catch (err) {
			errors.push({ file: filePath, message: (err as Error).message });
		}
	}

	agents.sort((a, b) => agentOrder(a.name) - agentOrder(b.name) || a.name.localeCompare(b.name));
	const loaded = new Set(agents.map((a) => a.name));
	const missing = REQUIRED_AGENTS.filter((name) => !loaded.has(name));
	return { agents, errors, missing, agentsDir };
}

function agentOrder(name: string): number {
	const i = (REQUIRED_AGENTS as readonly string[]).indexOf(name);
	return i === -1 ? REQUIRED_AGENTS.length : i;
}

export function loadAgentFile(filePath: string): AgentConfig {
	const raw = fs.readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const fm = frontmatter ?? {};
	const expectedName = path.basename(filePath, ".md");

	const name = requireString(fm.name, "name");
	if (name !== expectedName) {
		throw new Error(`frontmatter name "${name}" must equal the file name "${expectedName}"`);
	}
	const description = requireString(fm.description, "description");

	const thinking = optionalString(fm.thinking, "thinking");
	if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
		throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")} (got "${thinking}")`);
	}

	const skillsRaw = fm.skills;
	const skills: string[] | "all" = skillsRaw === "all" ? "all" : (optionalList(skillsRaw, "skills") ?? []);

	return {
		name,
		description,
		model: optionalString(fm.model, "model"),
		thinking: thinking as ThinkingLevel | undefined,
		tools: optionalList(fm.tools, "tools"),
		timeoutMinutes: optionalPositiveNumber(fm.timeoutMinutes, "timeoutMinutes") ?? DEFAULT_TIMEOUT_MINUTES,
		contextFiles: optionalBoolean(fm.contextFiles, "contextFiles") ?? true,
		extensions: optionalList(fm.extensions, "extensions") ?? [],
		skills,
		writeAllow: optionalList(fm.writeAllow, "writeAllow") ?? [],
		writeDeny: optionalList(fm.writeDeny, "writeDeny") ?? [],
		systemPrompt: (body ?? "").trim(),
		filePath,
	};
}

// ---- frontmatter value coercion (values come from a real YAML parser → unknown) ----

function requireString(value: unknown, key: string): string {
	const s = optionalString(value, key);
	if (s === undefined || s.length === 0) throw new Error(`missing required frontmatter field "${key}"`);
	return s;
}

function optionalString(value: unknown, key: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	throw new Error(`frontmatter field "${key}" must be a string`);
}

/** Accepts `a, b, c` (string) or a YAML list; trims and drops empties. */
function optionalList(value: unknown, key: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	let items: unknown[];
	if (typeof value === "string") items = value.split(",");
	else if (Array.isArray(value)) items = value;
	else throw new Error(`frontmatter field "${key}" must be a comma-separated string or a list`);
	const out: string[] = [];
	for (const item of items) {
		if (typeof item !== "string" && typeof item !== "number") {
			throw new Error(`frontmatter field "${key}" contains a non-string item`);
		}
		const s = String(item).trim();
		if (s) out.push(s);
	}
	return out;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`frontmatter field "${key}" must be true or false`);
}

function optionalPositiveNumber(value: unknown, key: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`frontmatter field "${key}" must be a positive number`);
	return n;
}

// ---- helpers for the command surface ----

export function findAgent(discovery: AgentDiscovery, name: AgentName | string): AgentConfig | undefined {
	return discovery.agents.find((a) => a.name === name);
}

export function formatAgentList(discovery: AgentDiscovery): string {
	const lines: string[] = [];
	for (const a of discovery.agents) {
		const bits: string[] = [];
		bits.push(a.model ? `model=${a.model}` : "model=inherit");
		bits.push(a.thinking ? `thinking=${a.thinking}` : "thinking=inherit");
		bits.push(a.tools ? `tools=${a.tools.join(",")}` : "tools=default");
		bits.push(`timeout=${a.timeoutMinutes}m`);
		if (!a.contextFiles) bits.push("no-context-files");
		if (a.extensions.length) bits.push(`ext=${a.extensions.join(",")}`);
		if (a.skills === "all") bits.push("skills=all");
		else if (a.skills.length) bits.push(`skills=${a.skills.join(",")}`);
		bits.push(a.writeAllow.length ? `write=${a.writeAllow.join(",")}` : "write=any");
		lines.push(`  ${a.name.padEnd(14)} ${a.description}`);
		lines.push(`  ${"".padEnd(14)} ${bits.join("  ")}`);
	}
	if (discovery.missing.length) lines.push(`  MISSING: ${discovery.missing.join(", ")}`);
	for (const e of discovery.errors) lines.push(`  ERROR ${path.basename(e.file)}: ${e.message}`);
	return lines.join("\n");
}
