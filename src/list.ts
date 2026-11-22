// /agents list: every agent of the session; the fallback entry when the HUD rows are not available
// (pi-hud missing, /hud off) and the target of the HUD's "+N more" row (docs/07 §7).
// It sits in the editor slot at the bottom like pi's own selectors (not an overlay), so it stays short and
// leaves the transcript visible. Enter opens the detail overlay on top of it; the list stays open underneath
// and gets the keyboard back when the overlay closes.

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isMoveKey, isRunningStatus, isStoppable, isStopping } from "./detail.js";
import { focusOrder, windowAround } from "./hud-state.js";
import type { AgentRecord } from "./manager.js";
import { durationOf, formatDuration } from "./result.js";
import type { AgentStatus } from "./run.js";
import { ARMED_HINT, StopConfirm } from "./stop-confirm.js";

export interface ListSource {
	list(): AgentRecord[];
	stop(agentId: string): void;
	/** Show the agent's detail overlay on top of the list; the list stays open. */
	open(agentId: string): void;
	/** x must be pressed twice (docs/07 §4.4); default true. */
	confirmStop?(): boolean;
}

export interface ListHost {
	requestRender(): void;
	readonly terminal: { readonly rows: number };
}

/**
 * Agent rows the list shows at once. The bottom slot is not height-bounded by pi, so the list keeps to a
 * small share of the terminal: at most 10 rows or 40% of the height, never fewer than 3.
 */
export function listRowLimit(terminalRows: number): number {
	return Math.max(3, Math.min(10, Math.floor(terminalRows * 0.4)));
}

const STATUS_COLORS: Record<AgentStatus, "accent" | "warning" | "success" | "error" | "dim" | "muted"> = {
	queued: "muted",
	running: "accent",
	completed: "success",
	failed: "error",
	aborted: "warning",
	max_turns: "warning",
	context_limit: "warning",
};

const STATUS_TEXT: Record<AgentStatus, string> = {
	queued: "queued",
	running: "running",
	completed: "completed",
	failed: "failed",
	aborted: "stopped",
	max_turns: "out of turns",
	context_limit: "context full",
};

/**
 * Put a row on the theme's selection surface. Truncation leaves a full reset inside the row, and that
 * reset would drop the background for everything after it, so the background is re-applied after each one.
 */
function onSelectionSurface(theme: Theme, content: string, armed: boolean): string {
	// An armed row (first x pressed) swaps the selection surface for the error surface (docs/07 §4.4).
	const surface = armed ? "toolErrorBg" : "selectedBg";
	const band = theme.getBgAnsi(surface);
	return theme.bg(surface, content.replace(/\x1b\[0m/g, `\x1b[0m${band}`));
}

/** Cut a row to the width and pad it, so the selection surface reaches the right edge. */
function fillToWidth(content: string, width: number): string {
	const cut = truncateToWidth(content, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * A titled rule, `─ left ───── right ─`, the full width (design_style.md §4.1): a bottom panel's top edge, and
 * the same shape for a divider inside a panel. Labels come in already colored; only the rule is painted here.
 * When the row is narrow the fill shrinks to one `─` first, then each right label is tried in turn (full form,
 * then shorter ones) and finally dropped, and last the left label is cut with `…`. The leading `─ ` and the
 * closing `─` always stay.
 */
export function titledRule(
	width: number,
	paint: (rule: string) => string,
	left: string,
	right: string | readonly string[] = [],
): string {
	const rule = (count: number) => paint("─".repeat(count));
	if (width < 4) return rule(Math.max(0, width));
	const leftWidth = visibleWidth(left);
	for (const label of typeof right === "string" ? [right] : right) {
		// `─ ` left ` ` fill ` ` right ` ─`
		const fill = width - leftWidth - visibleWidth(label) - 6;
		if (label && fill >= 1) return `${rule(1)} ${left} ${rule(fill)} ${label} ${rule(1)}`;
	}
	const shown = leftWidth <= width - 4 ? left : truncateToWidth(left, width - 4, "…");
	return `${rule(1)} ${shown} ${rule(width - 3 - visibleWidth(shown))}`;
}

/** Plain-text list for modes without a TUI. */
export function describeAgents(records: readonly AgentRecord[], now = Date.now()): string {
	if (records.length === 0) return "No subagents in this session.";
	return focusOrder(records)
		.map((record) => {
			const duration = record.status === "queued" ? "" : `  ${formatDuration(durationOf(record, now))}`;
			const reason = record.reason && record.status !== "completed" ? `  (${record.reason})` : "";
			return `${record.agentId}  ${STATUS_TEXT[record.status]}${duration}  ${record.type}  ${record.description}${reason}`;
		})
		.join("\n");
}

export class AgentListView implements Component {
	private selectedId: string | undefined;
	private readonly refresh: ReturnType<typeof setInterval>;
	private closed = false;
	private readonly confirm: StopConfirm;

	constructor(
		private readonly host: ListHost,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly source: ListSource,
		private readonly done: () => void,
	) {
		this.confirm = new StopConfirm(() => source.confirmStop?.() ?? true);
		// Durations and states change while the list is open.
		this.refresh = setInterval(() => this.host.requestRender(), 1000);
	}

	private ordered(): AgentRecord[] {
		return focusOrder(this.source.list());
	}

	private index(records: readonly AgentRecord[]): number {
		const index = records.findIndex((record) => record.agentId === this.selectedId);
		return index === -1 ? 0 : index;
	}

	render(width: number): string[] {
		const { theme } = this;
		const records = this.ordered();
		const selected = this.index(records);
		const selectedRecord = records[selected];
		this.selectedId = selectedRecord?.agentId;
		// The armed agent may have ended on its own or moved since the first x: the arm goes with it.
		this.confirm.keep(this.selectedId, selectedRecord !== undefined && isStoppable(selectedRecord));
		const armed = this.confirm.isArmed(this.selectedId);
		const active = records.filter((record) => isRunningStatus(record.status)).length;
		// The title sits on the top edge, which carries on the editor's top border; the counts go on its right.
		const counts = [`${active} active, ${records.length} total`, `${records.length} total`].map((text) => theme.fg("dim", text));
		const lines = [titledRule(width, (rule) => theme.fg("borderMuted", rule), theme.bold(theme.fg("accent", "Subagents")), counts), ""];
		if (records.length === 0) lines.push(theme.fg("dim", "  No subagents in this session."));
		const { start, end } = windowAround(records.length, selected, listRowLimit(this.host.terminal.rows));
		if (start > 0) lines.push(theme.fg("dim", `  ↑ ${start} more`));
		const now = Date.now();
		for (let i = start; i < end; i++) {
			const record = records[i];
			if (!record) continue;
			const isSelected = i === selected;
			// The selected row is marked twice: a bar at the left edge and the theme's selection surface.
			// Armed, the bar turns to the error color along with the surface.
			const cursor = isSelected ? theme.fg(armed ? "error" : "accent", "▎ ") : "  ";
			const status = isStopping(record)
				? theme.fg(isSelected ? "muted" : "dim", "stopping".padEnd(12))
				: theme.fg(STATUS_COLORS[record.status], STATUS_TEXT[record.status].padEnd(12));
			// The selection surface is lighter than the terminal background, so dim text fades on it.
			// The selected row steps one level up to stay readable.
			const duration = theme.fg(
				isSelected ? "muted" : "dim",
				(record.status === "queued" ? "" : formatDuration(durationOf(record, now))).padStart(7),
			);
			const content = `${cursor}${theme.fg("text", record.agentId.padEnd(6))} ${status} ${duration}  ${theme.fg("accent", record.type)}  ${record.description}`;
			// The selected row fills the line: the surface runs to the right edge. It is cut to the width
			// first, because cutting it afterwards would drop the background at the cut.
			lines.push(isSelected ? onSelectionSurface(theme, fillToWidth(content, width), armed) : content);
		}
		if (end < records.length) lines.push(theme.fg("dim", `  ↓ ${records.length - end} more`));
		// Armed, the whole key line gives way to the confirmation prompt.
		lines.push("", armed ? theme.fg("error", ARMED_HINT) : theme.fg("dim", "↑↓ select · enter details · x stop · esc close"));
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	handleInput(data: string): void {
		const records = this.ordered();
		const index = this.index(records);
		const kb = this.keybindings;
		const current = records[index];
		// Armed (docs/07 §4.4): only x goes on to stop. ↑↓ cancel and still move; every other key, Esc and
		// Enter included, only cancels, so backing out of the stop does not also close the list or open a detail.
		this.confirm.keep(current?.agentId, current !== undefined && isStoppable(current));
		if (this.confirm.isArmed(current?.agentId) && data !== "x") {
			this.confirm.cancel();
			if (!isMoveKey(data, kb)) return this.host.requestRender();
		}
		if (kb.matches(data, "tui.select.cancel") || data === "q") return this.close();
		if (kb.matches(data, "tui.select.up")) this.selectedId = records[Math.max(0, index - 1)]?.agentId;
		else if (kb.matches(data, "tui.select.down")) this.selectedId = records[Math.min(records.length - 1, index + 1)]?.agentId;
		else if (kb.matches(data, "tui.select.confirm")) {
			const id = records[index]?.agentId;
			if (id && !this.closed) this.source.open(id);
			return;
		} else if (data === "x") {
			if (current && isStoppable(current) && this.confirm.press(current.agentId)) this.source.stop(current.agentId);
		} else return;
		this.host.requestRender();
	}

	invalidate(): void {
		// Rendered from live records every time.
	}

	dispose(): void {
		clearInterval(this.refresh);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.refresh);
		this.done();
	}
}
