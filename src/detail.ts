// Detail overlay for one agent: stats, prompt, live activity, report, transcript (docs/07 §6).
//
// Scrolling is done here, not with pi-tui's ScrollView: a ScrollView only scrolls as a node of the fullscreen
// layout tree (its offset comes from updateLayout, scroll-view.ts:183-200, while render() returns every line),
// and overlays are rendered by calling component.render() and cutting to maxHeight (tui.ts:1395-1410).
// Wheel events over an overlay go to its handleMouse (tui-alt-screen.ts:726), which scrolls this view.

import { copyToClipboard, getMarkdownTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentRecord } from "./manager.js";
import { contextPercent, displayTokens, type ProgressSnapshot, type ToolCallEntry } from "./observer.js";
import { formatCost, formatTokens } from "./render.js";
import { durationOf, formatDuration } from "./result.js";
import type { AgentStatus } from "./run.js";
import { ARMED_HINT, StopConfirm } from "./stop-confirm.js";

export interface DetailSource {
	get(agentId: string): AgentRecord | undefined;
	progress(agentId: string): ProgressSnapshot | undefined;
	subscribe(listener: (record: AgentRecord) => void): () => void;
	stop(agentId: string): void;
	/** The final report of a finished agent: the result file, else the in-memory text. */
	report(record: AgentRecord): string;
	/** The transcript path when the file exists. */
	transcript(record: AgentRecord): string | undefined;
	/** x must be pressed twice (docs/07 §4.4); default true. */
	confirmStop?(): boolean;
}

export interface DetailHost {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}

export const PROMPT_PREVIEW_LINES = 8;
const RENDER_THROTTLE_MS = 100;
const TICK_MS = 1000;
const FLASH_MS = 2000;
export const OVERLAY_OPTIONS = { width: "90%", maxHeight: "80%", anchor: "center" } as const;

const ICONS: Record<AgentStatus, string> = {
	queued: "◌",
	running: "●",
	completed: "✓",
	failed: "✗",
	aborted: "■",
	max_turns: "↻",
	context_limit: "◔",
};
const COLORS: Record<AgentStatus, "accent" | "warning" | "success" | "error" | "dim"> = {
	queued: "dim",
	running: "accent",
	completed: "success",
	failed: "error",
	aborted: "warning",
	max_turns: "warning",
	context_limit: "warning",
};
const STATUS_TEXT: Partial<Record<AgentStatus, string>> = { max_turns: "out of turns", context_limit: "context full" };

export function isRunningStatus(status: AgentStatus): boolean {
	return status === "queued" || status === "running";
}

/**
 * x can stop it: queued or running, and no stop requested yet. A stopped run keeps its status until the run
 * returns (up to a few seconds), and an x in that window must not arm a second stop.
 */
export function isStoppable(record: Pick<AgentRecord, "status" | "stoppedBy">): boolean {
	return isRunningStatus(record.status) && record.stoppedBy === undefined;
}

/** Between the stop request and the run's end: the list and the overlay title say "stopping". */
export function isStopping(record: Pick<AgentRecord, "status" | "stoppedBy">): boolean {
	return isRunningStatus(record.status) && record.stoppedBy !== undefined;
}

/** Keys that move (a selection or a scroll position): they cancel an armed stop and still move. */
export function isMoveKey(data: string, keybindings: KeybindingsManager): boolean {
	return (
		keybindings.matches(data, "tui.select.up") ||
		keybindings.matches(data, "tui.select.down") ||
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		matchesKey(data, "home") ||
		matchesKey(data, "end")
	);
}

export function openCommand(transcript: string): string {
	return `pi --session "${transcript}"`;
}

/**
 * `ctx 42%` for the title row, left of the duration; undefined until the child reports a fill. Thresholds
 * match pi-hud's context bar: warning from 70%, error from 85%, dim below.
 */
export function contextLabel(record: Pick<AgentRecord, "context">, theme: Theme): string | undefined {
	if (!record.context) return undefined;
	const percent = contextPercent(record.context);
	const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
	return theme.fg(color, `ctx ${percent}%`);
}

export interface DetailContentOptions {
	width: number;
	now: number;
	fullPrompt: boolean;
	progress?: ProgressSnapshot;
	report?: string;
	transcript?: string;
	renderMarkdown?: (text: string, width: number) => string[];
}

/** The scrollable body of the overlay. Pure, for tests. */
export function detailContent(record: AgentRecord, theme: Theme, options: DetailContentOptions): string[] {
	const dim = (text: string) => theme.fg("dim", text);
	const lines: string[] = [];
	const progress = options.progress;
	const turns = progress?.turns ?? record.stats.turns;
	const tools = progress?.toolCalls ?? record.stats.toolCalls;
	const usage = record.totalUsage;
	const turnText = record.status === "running" ? `turn ${turns + 1}${record.maxTurns ? `/${record.maxTurns}` : ""}` : `${turns} turn${turns === 1 ? "" : "s"}`;
	const stats = [record.model, turnText, `${tools} tool${tools === 1 ? "" : "s"}`, formatTokens(displayTokens(usage))];
	if (usage.cost > 0) stats.push(formatCost(usage.cost));
	if (record.runs > 1) stats.push(`run ${record.runs}`);
	lines.push(dim(stats.join(" · ")));
	if (record.reason && record.status !== "completed") lines.push(theme.fg(COLORS[record.status], `reason: ${record.reason}`));
	for (const note of record.notes) lines.push(dim(`note: ${note}`));

	lines.push("", theme.bold("Prompt"));
	const promptLines = record.prompt.replace(/\r\n?/g, "\n").trim().split("\n");
	const shown = options.fullPrompt ? promptLines : promptLines.slice(0, PROMPT_PREVIEW_LINES);
	for (const line of shown) lines.push(`  ${line}`);
	if (!options.fullPrompt && promptLines.length > PROMPT_PREVIEW_LINES) {
		lines.push(dim(`  … ${promptLines.length - PROMPT_PREVIEW_LINES} more lines (e to expand)`));
	}

	lines.push("", theme.bold("Activity"));
	const activity = record.activity;
	if (!activity) lines.push(dim(record.status === "queued" ? "  (queued)" : "  (not recorded in this pi process; open the transcript)"));
	else if (activity.length === 0) lines.push(dim("  (no tool calls yet)"));
	else for (const entry of activity) lines.push(`  ${activityLine(entry, theme, options.now)}`);

	if (isRunningStatus(record.status)) {
		const recent = progress?.recentText.trim().split(/\r?\n/).filter(Boolean).at(-1);
		if (recent) lines.push("", `${dim("Writing: ")}${recent}`);
	} else {
		lines.push("", theme.bold("Report"));
		const report = options.report?.trim() ?? "";
		if (!report) lines.push(dim("  (no final report)"));
		else {
			const rendered = options.renderMarkdown?.(report, Math.max(20, options.width - 2)) ?? report.split("\n");
			for (const line of rendered) lines.push(`  ${line}`);
		}
	}

	if (options.transcript) {
		lines.push("", `${dim("Transcript: ")}${options.transcript}`);
		if (!isRunningStatus(record.status)) lines.push(`${dim("Open it in pi: ")}${openCommand(options.transcript)}`);
	}
	return lines;
}

function activityLine(entry: ToolCallEntry, theme: Theme, now: number): string {
	if (entry.endedAt === undefined) {
		return `${theme.fg("accent", "●")} ${entry.line}${theme.fg("dim", ` · ${formatDuration(now - entry.startedAt)}`)}`;
	}
	const icon = entry.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	return `${icon} ${entry.line}${theme.fg("dim", ` · ${formatDuration(entry.endedAt - entry.startedAt)}`)}`;
}

/** Scroll state with follow-the-end behaviour: following until the user scrolls up, again at the bottom. */
export class ScrollState {
	top = 0;
	following: boolean;
	private maxTop = 0;
	private viewport = 1;

	constructor(follow: boolean) {
		this.following = follow;
	}

	/** Fit to the latest content; returns the first visible line. */
	layout(contentLines: number, viewport: number): number {
		this.viewport = Math.max(1, viewport);
		this.maxTop = Math.max(0, contentLines - this.viewport);
		this.top = this.following ? this.maxTop : Math.min(this.top, this.maxTop);
		return this.top;
	}

	scrollBy(lines: number): void {
		if (lines === 0) return;
		const start = this.following ? this.maxTop : this.top;
		this.top = Math.max(0, Math.min(this.maxTop, start + lines));
		// Scrolling up stops following; scrolling down to the bottom resumes it.
		this.following = lines > 0 && this.top >= this.maxTop;
	}

	page(direction: 1 | -1): void {
		this.scrollBy(direction * Math.max(1, this.viewport - 1));
	}

	toStart(): void {
		this.top = 0;
		this.following = false;
	}

	toEnd(): void {
		this.following = true;
		this.top = this.maxTop;
	}
}

export class AgentDetailView implements Component {
	private readonly scroll: ScrollState;
	private fullPrompt = false;
	private flash: { text: string; until: number } | undefined;
	private readonly unsubscribe: () => void;
	private pending: ReturnType<typeof setTimeout> | undefined;
	private lastRender = 0;
	private readonly tick: ReturnType<typeof setInterval>;
	private markdownCache: { key: string; lines: string[] } | undefined;
	private closed = false;
	private readonly confirm: StopConfirm;

	constructor(
		private readonly host: DetailHost,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly source: DetailSource,
		private readonly agentId: string,
		private readonly done: () => void,
	) {
		this.confirm = new StopConfirm(() => source.confirmStop?.() ?? true);
		const record = source.get(agentId);
		// A running agent opens at the bottom and follows new activity; a finished one opens at the top.
		this.scroll = new ScrollState(record ? isRunningStatus(record.status) : false);
		this.unsubscribe = source.subscribe((changed) => {
			if (changed.agentId === agentId) this.scheduleRender();
		});
		this.tick = setInterval(() => {
			const current = this.source.get(this.agentId);
			if ((current && isRunningStatus(current.status)) || this.flash) this.host.requestRender();
		}, TICK_MS);
	}

	render(width: number): string[] {
		const theme = this.theme;
		const record = this.source.get(this.agentId);
		if (!record || width < 10) return [];
		const now = Date.now();
		const inner = width - 4;
		const height = Math.max(8, Math.floor(this.host.terminal.rows * 0.8));
		const viewport = height - 3;

		const transcript = this.source.transcript(record);
		const report = isRunningStatus(record.status) ? undefined : this.source.report(record);
		const content = detailContent(record, theme, {
			width: inner,
			now,
			fullPrompt: this.fullPrompt,
			progress: this.source.progress(this.agentId),
			report,
			transcript,
			renderMarkdown: (text, w) => this.markdown(text, w, record),
		});
		const top = this.scroll.layout(content.length, viewport);
		const body = content.slice(top, top + viewport);
		// A fixed-height box, as /background's detail: a centred overlay that grew with each activity line
		// would breathe up and down until it filled the 80%.
		while (body.length < viewport) body.push("");

		const border = (text: string) => theme.fg("dim", text);
		const title = ` ${record.agentId} · ${record.type} · ${record.description} `;
		const statusText = isStopping(record) ? "stopping" : (STATUS_TEXT[record.status] ?? record.status);
		const context = contextLabel(record, theme);
		const status = ` ${theme.fg(COLORS[record.status], `${ICONS[record.status]} ${statusText}`)}${context ? `${theme.fg("dim", " · ")}${context}` : ""}${theme.fg("dim", ` · ${formatDuration(durationOf(record, now))}`)} `;
		// `╭─` title, at least one `─`, status, `─╮`: the right label keeps a dash before the corner, as the
		// boxes in /provider and /sessions do.
		const titleText = truncateToWidth(theme.bold(title), Math.max(4, width - 5 - visibleWidth(status)), "…");
		const fill = Math.max(1, width - 4 - visibleWidth(titleText) - visibleWidth(status));
		const topBorder = `${border("╭─")}${titleText}${border("─".repeat(fill))}${status}${border("─╮")}`;
		const lines = [truncateToWidth(topBorder, width, "")];
		const row = (text: string) => {
			const cut = truncateToWidth(text, inner, "…");
			return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
		};
		for (const line of body) lines.push(row(line));
		lines.push(row(this.hint(record, transcript, content.length > viewport)));
		lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines;
	}

	handleInput(data: string): void {
		const record = this.source.get(this.agentId);
		const kb = this.keybindings;
		// Armed (docs/07 §4.4): only x goes on to stop. Scroll keys cancel and still scroll; every other key,
		// Esc included, only cancels, so backing out of the stop does not also close the overlay.
		this.confirm.keep(this.agentId, record !== undefined && isStoppable(record));
		if (this.confirm.isArmed(this.agentId) && data !== "x") {
			this.confirm.cancel();
			if (!isMoveKey(data, kb)) {
				this.host.requestRender();
				return;
			}
		}
		if (kb.matches(data, "tui.select.cancel") || data === "q") {
			this.close();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (kb.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.page(-1);
		else if (matchesKey(data, "pageDown")) this.scroll.page(1);
		else if (matchesKey(data, "home")) this.scroll.toStart();
		else if (matchesKey(data, "end")) this.scroll.toEnd();
		else if (data === "e") this.fullPrompt = !this.fullPrompt;
		else if (data === "x" && record && isStoppable(record)) {
			if (this.confirm.press(this.agentId)) {
				this.source.stop(this.agentId);
				this.setFlash(`stopping ${this.agentId}…`);
			}
		} else if (data === "c" && record) {
			const transcript = this.source.transcript(record);
			if (transcript) {
				const command = openCommand(transcript);
				copyToClipboard(command).then(
					() => this.setFlash("copied: " + command),
					() => this.setFlash("could not copy to the clipboard"),
				);
			}
		} else return;
		this.host.requestRender();
	}

	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		// Scrolling moves, like the scroll keys: it cancels an armed stop.
		this.confirm.cancel();
		this.scroll.scrollBy(event.wheelDelta);
		return { handled: true };
	}

	invalidate(): void {
		this.markdownCache = undefined;
	}

	dispose(): void {
		this.cleanup();
	}

	private close(): void {
		if (this.closed) return;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		this.closed = true;
		this.unsubscribe();
		clearInterval(this.tick);
		if (this.pending) clearTimeout(this.pending);
		this.pending = undefined;
	}

	private hint(record: AgentRecord, transcript: string | undefined, scrollable: boolean): string {
		// The agent may have ended on its own since the first x: the arm goes with it.
		this.confirm.keep(this.agentId, isStoppable(record));
		if (this.confirm.isArmed(this.agentId)) return this.theme.fg("error", ARMED_HINT);
		if (this.flash && this.flash.until > Date.now()) return this.theme.fg("warning", this.flash.text);
		this.flash = undefined;
		const parts = [scrollable ? "↑↓/wheel scroll" : undefined, "e prompt", isStoppable(record) ? "x stop" : undefined];
		if (transcript && !isRunningStatus(record.status)) parts.push("c copy open command");
		parts.push("esc close");
		return this.theme.fg("dim", parts.filter(Boolean).join(" · "));
	}

	private setFlash(text: string): void {
		this.flash = { text, until: Date.now() + FLASH_MS };
		this.host.requestRender();
	}

	/** Observer updates arrive per streamed token; redraw at most every 100 ms (docs/07 §6). */
	private scheduleRender(): void {
		if (this.closed || this.pending) return;
		const wait = Math.max(0, RENDER_THROTTLE_MS - (Date.now() - this.lastRender));
		this.pending = setTimeout(() => {
			this.pending = undefined;
			this.lastRender = Date.now();
			this.host.requestRender();
		}, wait);
	}

	private markdown(text: string, width: number, record: AgentRecord): string[] {
		const key = `${record.runs}:${record.endedAt ?? ""}:${width}:${text.length}`;
		if (this.markdownCache?.key === key) return this.markdownCache.lines;
		let lines: string[];
		try {
			lines = new Markdown(text, 0, 0, getMarkdownTheme()).render(width).map((line) => line.trimEnd());
		} catch {
			lines = text.split("\n");
		}
		this.markdownCache = { key, lines };
		return lines;
	}
}
