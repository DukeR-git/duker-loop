// Stub of the two runtime exports duker-loop uses from @earendil-works/pi-coding-agent.

/**
 * Frontmatter parser covering the YAML subset used by agents/*.md: `key: value`, quoted
 * strings, booleans, numbers, inline lists `[a, b]`, block lists (`- item`). Same return shape
 * as pi's parseFrontmatter: { frontmatter, body }.
 */
export function parseFrontmatter(raw) {
	const text = raw.replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (!m) return { frontmatter: {}, body: text };
	const fm = {};
	let listKey;
	for (const line of m[1].split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s+-\s*(.*)$/.exec(line);
		if (item && listKey) {
			fm[listKey].push(scalar(item[1]));
			continue;
		}
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const [, key, value] = kv;
		if (value === "") {
			fm[key] = [];
			listKey = key;
		} else {
			listKey = undefined;
			fm[key] = scalar(value);
		}
	}
	return { frontmatter: fm, body: text.slice(m[0].length) };
}

function scalar(v) {
	v = v.trim();
	if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map(scalar).filter((x) => x !== "");
	if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	return v;
}

const queues = new Map();
/** Serialises mutations per absolute path (pi's semantics, minus cross-process coordination). */
export function withFileMutationQueue(file, fn) {
	const prev = queues.get(file) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	queues.set(file, next.catch(() => {}));
	return next;
}
