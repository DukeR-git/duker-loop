/**
 * Fleet view (decision #34): a Claude-Code-style list of the current duker run's children below
 * the editor, plus a live viewer overlay for one child.
 *
 *   ↓ or ← at an empty prompt activates the list · ↑/↓ select · Enter opens the viewer ·
 *   Esc (or ↑ past the top) returns to the prompt. `/duker watch` and the shortcut open the
 *   viewer for the running child directly.
 *
 * Mechanics (same as pi-subagents' FleetView): the list is a render-only `belowEditor` widget;
 * keys arrive through `ctx.ui.onTerminalInput`, which fires before the focused editor and may
 * consume them, gated on an empty editor so typing is never intercepted. The viewer is a
 * `ctx.ui.custom({ overlay: true })` component that re-renders on every Activity change.
 */
import { Editor, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Activity, type ChildRow, type TranscriptEntry } from "./activity.ts";
import { fmtTokens } from "./render.ts";
import { formatDuration } from "./runtime.ts";

/** Structural subset of ctx.ui the fleet needs (so tests can pass a fake). */
export interface FleetUI {
	setWidget(key: string, content: undefined | ((tui: FleetTui, theme: FleetTheme) => FleetComponent), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (tui: FleetTui, theme: FleetTheme, keybindings: unknown, done: (result: T) => void) => FleetComponent,
		options?: { overlay?: boolean; overlayOptions?: unknown },
	): Promise<T>;
}

export interface FleetTui {
	requestRender(): void;
	terminal: { rows: number; columns: number };
	focusedComponent?: unknown;
}

export interface FleetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface FleetComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	dispose?(): void;
}

const WIDGET_KEY = "duker-fleet";
const TICK_MS = 500;
/** How long the list stays after the run ends. */
const LINGER_MS = 6000;
const MAX_ROWS = 8;
/** Overlay height as a share of the terminal; the viewer caps its viewport to the same figure. */
const VIEWPORT_HEIGHT_PCT = 70;

type Entry = { kind: "main" } | { kind: "child"; row: ChildRow };

export class DukerFleet {
	private ui: FleetUI | undefined;
	private tui: FleetTui | undefined;
	private inputUnsub: (() => void) | undefined;
	private widgetRegistered = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** arrows navigate the list (true) or flow to the editor (false) */
	private active = false;
	/** 0 = main, 1..N = children */
	private selected = 0;
	private viewerClose: (() => void) | undefined;
	private viewingId: number | undefined;
	private readonly activity: Activity;
	/** aborts the current run; returns false when nothing is running */
	private readonly abortRun: () => boolean;

	constructor(activity: Activity, abortRun: () => boolean = () => false) {
		this.activity = activity;
		this.abortRun = abortRun;
		activity.subscribe(() => this.update());
	}

	/** Capture ctx.ui (session_start, or any command/tool with a UI) and register the key hook once per ui. */
	setUICtx(ui: FleetUI): void {
		if (ui === this.ui) return;
		// A ui without these (a pi older than 0.84, or a minimal harness) simply gets no fleet view.
		if (typeof ui.onTerminalInput !== "function" || typeof ui.setWidget !== "function" || typeof ui.custom !== "function") return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
		this.update();
	}

	/** Release the UI (session_shutdown). The fleet stays subscribed and re-attaches on the next setUICtx. */
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		this.viewerClose?.();
		this.viewerClose = undefined;
		this.viewingId = undefined;
		if (this.ui && this.widgetRegistered) this.ui.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.active = false;
		this.ui = undefined;
	}

	// ---- keys -------------------------------------------------------------------------------

	/** `{ consume: true }` swallows the key; undefined lets it reach the editor. Exported for tests. */
	handleKey(data: string): { consume?: boolean } | undefined {
		if (!this.ui) return undefined;
		if (isKeyRelease(data)) return undefined;
		if (this.viewerClose) return undefined; // the overlay owns the keyboard
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}
		if (!this.active) {
			const activator = matchesKey(data, "down") || matchesKey(data, "left");
			if (activator && this.roster().length > 1 && this.ui.getEditorText() === "") {
				this.active = true;
				this.selected = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.roster().length - 1, this.selected + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selected === 0) this.deactivate();
			else {
				this.selected--;
				this.update();
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			this.openSelected();
			return { consume: true };
		}
		this.deactivate();
		return undefined;
	}

	/** pi's prompt editor is an `Editor`; dialogs and menus are not. Unknown focus counts as the editor. */
	private editorHasFocus(): boolean {
		const focused = this.tui?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}

	private deactivate(): void {
		this.active = false;
		this.selected = 0;
		this.update();
	}

	// ---- roster -----------------------------------------------------------------------------

	private roster(): Entry[] {
		if (!this.visible()) return [{ kind: "main" }];
		return [{ kind: "main" }, ...this.activity.rows.map((row) => ({ kind: "child" as const, row }))];
	}

	private visible(): boolean {
		const run = this.activity.run;
		if (!run || !this.activity.rows.length) return false;
		if (run.endedAt === undefined) return true;
		return this.viewingId !== undefined || Date.now() - run.endedAt < LINGER_MS;
	}

	// ---- widget -----------------------------------------------------------------------------

	private update(): void {
		if (!this.ui) return;
		if (!this.visible()) {
			if (this.widgetRegistered) {
				this.ui.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			this.active = false;
			this.selected = 0;
			return;
		}
		this.selected = Math.min(this.selected, this.roster().length - 1);
		if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
		if (!this.widgetRegistered) {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (w: number) => this.renderList(w, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	renderList(width: number, theme: FleetTheme): string[] {
		const rows = this.activity.rows;
		const run = this.activity.run;
		if (!run || !rows.length) return [];
		const sel = Math.min(this.selected, rows.length);
		const hint = this.active ? "↑↓ select · enter view · esc back" : "← ↓ duker children · /duker watch";
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
		lines.push("");
		const head = runLabel(run, rows);
		const runStats = `${formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}${run.outcome ? ` · ${run.outcome}` : ""}`;
		lines.push(rightAlign(`  ${bullet(0, sel, theme)} ${theme.fg(sel === 0 ? "text" : "muted", "main")}  ${theme.fg("accent", head)}`, theme.fg("dim", runStats), width));

		const visible = Math.min(MAX_ROWS, rows.length);
		const selRow = Math.max(0, sel - 1);
		const start = selRow < visible ? 0 : selRow - visible + 1;
		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let i = start; i < start + visible; i++) lines.push(this.renderRow(i + 1, sel, rows[i]!, width, theme));
		const hiddenBelow = rows.length - (start + visible);
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
		return lines;
	}

	private renderRow(index: number, sel: number, row: ChildRow, width: number, theme: FleetTheme): string {
		const selected = index === sel;
		const dimOrText = (t: string) => theme.fg(selected ? "text" : "dim", t);
		const icon = row.status === "running" ? "⏳" : row.status === "ok" ? theme.fg("success", "✓") : row.status === "failed" ? theme.fg("error", "✗") : theme.fg("dim", "·");
		const phase = row.info.phase === "manual" || row.info.phase === "init" ? "" : `${row.info.phase.padEnd(9)} `;
		const name = theme.fg(selected ? "text" : row.status === "pending" ? "dim" : "muted", row.info.agent.padEnd(13));
		let detail: string;
		if (row.status === "pending") detail = theme.fg("dim", "pending");
		else if (row.status === "running") detail = dimOrText(row.lastTool ? truncateToWidth(row.lastTool, 60) : row.streaming ? "responding" : "starting");
		else detail = dimOrText(row.note ? truncateToWidth(row.note, 60) : "done");
		const left = `  ${bullet(index, sel, theme)} ${icon} ${theme.fg(selected ? "text" : "dim", phase)}${name} ${detail}`;
		let stats = "";
		if (row.status !== "pending") {
			const elapsed = formatDuration((row.endedAt ?? Date.now()) - row.startedAt);
			const u = row.usage;
			stats = u ? `${elapsed} · ${u.turns} turns · ↓ ${fmtTokens(u.output)} tokens` : elapsed;
		}
		return rightAlign(left, dimOrText(stats), width);
	}

	// ---- viewer -----------------------------------------------------------------------------

	private openSelected(): void {
		const entry = this.roster()[this.selected];
		if (!entry || entry.kind === "main") {
			this.deactivate();
			return;
		}
		if (entry.row.status === "pending") {
			this.ui?.notify(`${entry.row.info.agent} has not started yet`, "info");
			return;
		}
		this.openViewer(entry.row.id);
	}

	/**
	 * Open the viewer for a child (default: the running one, else the last one). Used by the
	 * list, `/duker watch` and the shortcut. Returns false when there is nothing to show.
	 */
	openViewer(rowId?: number): boolean {
		if (!this.ui) return false;
		if (this.viewerClose) return true;
		const row = rowId !== undefined ? this.activity.row(rowId) : (this.activity.runningRow() ?? this.activity.rows.filter((r) => r.status !== "pending").at(-1));
		if (!row) return false;
		this.viewingId = row.id;
		void this.ui
			.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					this.viewerClose = () => done(undefined);
					return new ChildViewer(tui, theme, this.activity, row.id, done, this.abortRun);
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` } },
			)
			.then(
				() => this.clearViewer(),
				() => this.clearViewer(),
			);
		return true;
	}

	private clearViewer(): void {
		const idx = this.activity.rows.findIndex((r) => r.id === this.viewingId);
		if (idx >= 0) this.selected = idx + 1;
		this.viewerClose = undefined;
		this.viewingId = undefined;
		this.update();
	}
}

// ---------------------------------------------------------------------------------------------
// Viewer overlay
// ---------------------------------------------------------------------------------------------

const CHROME_LINES = 6; // top border, header, separator, separator, footer, bottom border
const MIN_VIEWPORT = 3;
const RESULT_PREVIEW_LINES = 4;

export class ChildViewer implements FleetComponent {
	private unsubscribe: (() => void) | undefined;
	private closed = false;
	private scrollOffset = 0;
	private autoScroll = true;
	private abortArmed = false;
	private lastInnerW = 80;
	private readonly tui: FleetTui;
	private readonly theme: FleetTheme;
	private readonly activity: Activity;
	private readonly rowId: number;
	private readonly done: (result: undefined) => void;
	private readonly abortRun: () => boolean;

	constructor(tui: FleetTui, theme: FleetTheme, activity: Activity, rowId: number, done: (result: undefined) => void, abortRun: () => boolean) {
		this.tui = tui;
		this.theme = theme;
		this.activity = activity;
		this.rowId = rowId;
		this.done = done;
		this.abortRun = abortRun;
		this.unsubscribe = activity.subscribe(() => {
			if (!this.closed) this.tui.requestRender();
		});
	}

	private row(): ChildRow | undefined {
		return this.activity.row(this.rowId);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "x")) {
			const row = this.row();
			if (row?.status === "running" && this.activity.active) {
				if (this.abortArmed) {
					this.abortArmed = false;
					this.abortRun();
				} else this.abortArmed = true;
				this.tui.requestRender();
			}
			return;
		}
		this.abortArmed = false;
		const total = this.contentLines(this.lastInnerW).length;
		const vh = this.viewportHeight();
		const maxScroll = Math.max(0, total - vh);
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - vh);
			this.autoScroll = false;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + vh);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		}
		this.tui.requestRender();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	render(width: number): string[] {
		if (width < 8) return [];
		const th = this.theme;
		const innerW = width - 4;
		this.lastInnerW = innerW;
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const boxRow = (s: string) => `${th.fg("border", "│")} ${truncateToWidth(pad(s), innerW)} ${th.fg("border", "│")}`;
		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(width - 2)}╮`));
		lines.push(boxRow(this.header(innerW)));
		lines.push(boxRow(th.fg("dim", "─".repeat(innerW))));

		const content = this.contentLines(innerW);
		const vh = this.viewportHeight();
		const maxScroll = Math.max(0, content.length - vh);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		else this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const slice = content.slice(this.scrollOffset, this.scrollOffset + vh);
		for (const l of slice) lines.push(boxRow(l));
		for (let i = slice.length; i < vh; i++) lines.push(boxRow(""));

		lines.push(boxRow(th.fg("dim", "─".repeat(innerW))));
		lines.push(boxRow(this.footer(maxScroll)));
		lines.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	invalidate(): void {
		/* nothing cached across themes */
	}

	dispose(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private viewportHeight(): number {
		const maxRows = Math.floor(((this.tui.terminal?.rows ?? 40) * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
	}

	private header(innerW: number): string {
		const th = this.theme;
		const row = this.row();
		if (!row) return th.fg("dim", "child gone");
		const i = row.info;
		const status = row.status === "running" ? "⏳" : row.status === "ok" ? th.fg("success", "✓") : th.fg("error", "✗");
		const where = i.stepId ? `step ${i.stepId}${i.title ? ` — ${i.title}` : ""}${i.round ? ` · fix ${i.round}` : ""}` : i.phase;
		const left = `${status} ${th.bold(th.fg("accent", i.agent))}${i.stepId ? ` ${th.fg("muted", i.phase)}` : ""} ${th.fg("dim", where)}`;
		const u = row.usage;
		const elapsed = formatDuration((row.endedAt ?? Date.now()) - row.startedAt);
		const stats = [elapsed, u ? `${u.turns} turns · ↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)} · $${u.cost.toFixed(4)}` : undefined, row.guardBlocks ? th.fg("warning", `guard ${row.guardBlocks}`) : undefined]
			.filter(Boolean)
			.join(" · ");
		return rightAlign(left, th.fg("dim", stats), innerW);
	}

	private footer(maxScroll: number): string {
		const th = this.theme;
		const row = this.row();
		const bits = ["↑↓ scroll", "pgup/pgdn", "end follow", "esc close"];
		if (row?.status === "running" && this.activity.active) bits.push(this.abortArmed ? th.fg("error", "x again to abort the run") : "x x abort run");
		const pos = maxScroll > 0 ? `${this.scrollOffset}/${maxScroll}${this.autoScroll ? " ▼" : ""}` : this.autoScroll ? "▼" : "";
		return rightAlign(th.fg("dim", bits.join(" · ")), th.fg("dim", pos), this.lastInnerW);
	}

	/** Transcript → wrapped lines. Rebuilt on every render; bounded by the Activity caps. */
	private contentLines(innerW: number): string[] {
		const th = this.theme;
		const row = this.row();
		if (!row) return [];
		const out: string[] = [];
		const wrap = (s: string, color?: string) => {
			for (const line of s.split(/\r?\n/)) {
				const w = wrapTextWithAnsi(line, innerW);
				for (const l of w.length ? w : [""]) out.push(color ? th.fg(color, l) : l);
			}
		};
		const started = row.startedAt;
		const stamp = (at: number) => th.fg("dim", `+${formatDuration(at - started).padStart(6)} `);
		for (const e of row.transcript) out.push(...this.renderEntry(e, stamp, innerW));
		if (row.streaming) {
			out.push("");
			wrap(row.streaming);
		}
		if (row.status !== "running" && row.finalText && !row.transcript.some((e) => e.kind === "text" && e.text === row.finalText)) {
			out.push("", th.fg("accent", "final:"));
			wrap(row.finalText);
		}
		return out;
	}

	private renderEntry(e: TranscriptEntry, stamp: (at: number) => string, innerW: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const push = (s: string) => lines.push(truncateToWidth(s, innerW));
		switch (e.kind) {
			case "tool":
				push(`${stamp(e.at)}${th.fg("accent", "▸ ")}${th.bold(e.name)}${e.detail ? ` ${th.fg("muted", e.detail)}` : ""}`);
				break;
			case "toolEnd": {
				const text = e.text.split(/\r?\n/);
				const preview = text.slice(0, RESULT_PREVIEW_LINES);
				for (const l of preview) push(`${" ".repeat(9)}${th.fg(e.isError ? "error" : "dim", `${e.isError ? "✗ " : ""}${l}`)}`);
				if (text.length > preview.length) push(`${" ".repeat(9)}${th.fg("dim", `… ${text.length - preview.length} more line(s)`)}`);
				break;
			}
			case "text": {
				const collected: string[] = [];
				const w = (s: string) => {
					for (const line of s.split(/\r?\n/)) for (const l of wrapTextWithAnsi(line, innerW - 9)) collected.push(l);
				};
				w(e.text);
				collected.forEach((l, i) => lines.push(`${i === 0 ? stamp(e.at) : " ".repeat(9)}${l}`));
				break;
			}
			case "retry":
				push(`${stamp(e.at)}${th.fg("warning", `↻ retry ${e.attempt}: ${e.message}`)}`);
				break;
			case "stderr":
				push(`${stamp(e.at)}${th.fg(e.line.includes("duker-guard[") ? "warning" : "dim", e.line)}`);
				break;
			case "note":
				push(`${stamp(e.at)}${th.fg("dim", e.text)}`);
				break;
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function runLabel(run: { kind: string; label: string }, rows: ChildRow[]): string {
	const last = rows.filter((r) => r.status !== "pending").at(-1);
	if (run.kind === "loop" && last?.info.stepId && last.info.stepId !== "?") {
		return `duker step ${last.info.stepId}${last.info.title ? ` — ${last.info.title}` : ""}${last.info.round ? ` · fix ${last.info.round}` : ""}`;
	}
	return run.label;
}

function bullet(index: number, sel: number, theme: FleetTheme): string {
	return index === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
}

/** Right-aligns `right`, truncating `left` first so the stats survive; never exceeds `width`. */
export function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightW - 1);
	const l = truncateToWidth(left, maxLeft);
	const gap = Math.max(1, width - visibleWidth(l) - rightW);
	return truncateToWidth(l + " ".repeat(gap) + right, width);
}
