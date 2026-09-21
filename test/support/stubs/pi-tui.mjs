// Stub of the pi-tui components duker-loop renders with. render() returns plain lines.
export class Text {
	constructor(text = "", paddingX = 0, paddingY = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}
	render() {
		return this.text.split("\n");
	}
	invalidate() {}
}

export class Container {
	constructor() {
		this.children = [];
	}
	addChild(c) {
		this.children.push(c);
	}
	render(width) {
		return this.children.flatMap((c) => c.render(width));
	}
	invalidate() {}
}

// ---- fleet view helpers (fleet.ts) ----------------------------------------------------------

/** pi's prompt editor class; the fleet checks `focusedComponent instanceof Editor`. */
export class Editor {}

const KEY_SEQUENCES = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	home: "\x1b[H",
	end: "\x1b[F",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	"ctrl+c": "\x03",
	"shift+up": "\x1b[1;2A",
	"shift+down": "\x1b[1;2B",
};

/** Tests send either the raw sequence or the key name itself. */
export function matchesKey(data, key) {
	return data === key || KEY_SEQUENCES[key] === data;
}

/** kitty-protocol key-release events end in ":3u"; tests mark them with a "release:" prefix. */
export function isKeyRelease(data) {
	return data.startsWith("release:");
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleWidth(s) {
	return s.replace(ANSI_RE, "").length;
}

export function truncateToWidth(s, width, ellipsis = "…") {
	if (visibleWidth(s) <= width) return s;
	const plain = s.replace(ANSI_RE, "");
	return width <= ellipsis.length ? plain.slice(0, width) : plain.slice(0, width - ellipsis.length) + ellipsis;
}

export function wrapTextWithAnsi(s, width) {
	if (!s) return [""];
	const out = [];
	let line = s;
	while (visibleWidth(line) > width) {
		out.push(line.slice(0, width));
		line = line.slice(width);
	}
	out.push(line);
	return out;
}
