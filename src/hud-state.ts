// HUD agent rows: which agents to show, in which order, and the windowing in focus mode (docs/07 §3.2-§3.3).
// pi-hud draws the rows exactly as given; it never decides which agents appear.

import { displayTokens, type UsageTotals } from "./observer.js";
import type { AgentStatus } from "./run.js";
import { clip } from "./tool-line.js";

/** pi.events channels (docs/07 §3.3). */
export const STATE_CHANNEL = "subagent:state";
export const STATE_REQUEST_CHANNEL = "subagent:state:request";
export const HUD_CHANNEL = "subagent:hud";
export const HUD_REQUEST_CHANNEL = "subagent:hud:request";
export const OPEN_CHANNEL = "subagent:open";

/** Finished agents stay visible this long outside focus mode (claude-hud's COMPLETED_RETENTION_MS). */
export const RETENTION_MS = 60_000;
export const MAX_ROWS = 4;
export const FOCUS_WINDOW = 8;
const DETAIL_MAX = 30;

export interface AgentRow {
	id: string;
	type: string;
	description: string;
	status: AgentStatus;
	startedAt?: number;
	endedAt?: number;
	/** Current turn number, while running. */
	turn?: number;
	/** Short model name, only when it differs from the parent's model. */
	model?: string;
	/** Failure reason and the like, already shortened. */
	detail?: string;
}

export interface HudState {
	rows: AgentRow[];
	/** Rows hidden above the window (focus mode only). */
	above: number;
	/** Rows hidden below; outside focus mode the N of "+N more agents". */
	below: number;
	/** `armed`: the selected agent got the first x and waits for the second (docs/07 §4.4). */
	focus: { selectedId: string; armed?: true } | null;
	/** input + output + cacheWrite over all agents and runs (docs/07 §3.5). */
	tokens: number;
	cost: number;
}

export const EMPTY_STATE: HudState = { rows: [], above: 0, below: 0, focus: null, tokens: 0, cost: 0 };

/** The record fields the HUD needs; satisfied by AgentRecord. */
export interface HudRecord {
	agentId: string;
	type: string;
	description: string;
	status: AgentStatus;
	reason?: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	model: string;
	stats: { turns: number };
	totalUsage: UsageTotals;
	/** Set once a stop was requested; the run keeps its status until it returns. */
	stoppedBy?: string;
}

function isActive(status: AgentStatus): boolean {
	return status === "queued" || status === "running";
}

/** Running first, then queued, each in start order (queued ones by creation). */
function activeOrder(a: HudRecord, b: HudRecord): number {
	if (a.status !== b.status) return a.status === "running" ? -1 : 1;
	return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt) || a.createdAt - b.createdAt;
}

function endedOrder(a: HudRecord, b: HudRecord): number {
	return (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

/** Outside focus mode: active agents, then those that ended within the retention window, newest first. */
export function shownRecords<T extends HudRecord>(records: readonly T[], now: number): T[] {
	const active = records.filter((record) => isActive(record.status)).sort(activeOrder);
	const recent = records
		.filter((record) => !isActive(record.status) && record.endedAt !== undefined && now - record.endedAt <= RETENTION_MS)
		.sort(endedOrder);
	return [...active, ...recent];
}

/** Focus mode and the /agents list: every agent of the session, active first, the rest by end time. */
export function focusOrder<T extends HudRecord>(records: readonly T[]): T[] {
	const active = records.filter((record) => isActive(record.status)).sort(activeOrder);
	const ended = records.filter((record) => !isActive(record.status)).sort(endedOrder);
	return [...active, ...ended];
}

/** Model id without the provider prefix, when it differs from the parent's provider/id. */
export function shortModel(model: string, parentModel: string | undefined): string | undefined {
	if (!model || model === "(default)" || model === parentModel) return undefined;
	const slash = model.indexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

export function toRow(record: HudRecord, parentModel: string | undefined): AgentRow {
	const row: AgentRow = { id: record.agentId, type: record.type, description: record.description, status: record.status };
	if (record.status !== "queued" && record.startedAt !== undefined) row.startedAt = record.startedAt;
	if (record.endedAt !== undefined && !isActive(record.status)) row.endedAt = record.endedAt;
	// A stop was requested and the run has not returned yet: "stopping" in place of the turn.
	const stopping = isActive(record.status) && record.stoppedBy !== undefined;
	if (record.status === "running" && !stopping) row.turn = record.stats.turns + 1;
	const model = shortModel(record.model, parentModel);
	if (model) row.model = model;
	if (stopping) row.detail = "stopping";
	else if (record.status === "failed") row.detail = clip(record.reason ?? "failed", DETAIL_MAX);
	else if (record.status === "max_turns") row.detail = "out of turns";
	else if (record.status === "context_limit") row.detail = "context full";
	return row;
}

/** Window of `size` rows that keeps `index` roughly centred. */
export function windowAround(count: number, index: number, size = FOCUS_WINDOW): { start: number; end: number } {
	if (count <= size) return { start: 0, end: count };
	const start = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
	return { start, end: start + size };
}

export interface BuildOptions {
	now: number;
	/** provider/id of the parent session's model. */
	parentModel?: string;
	/** Selected agent in focus mode; undefined outside it. */
	focusId?: string;
	/** The selected agent waits for the second x. */
	focusArmed?: boolean;
}

export function buildHudState(records: readonly HudRecord[], options: BuildOptions): HudState {
	let tokens = 0;
	let cost = 0;
	for (const record of records) {
		tokens += displayTokens(record.totalUsage);
		cost += record.totalUsage.cost;
	}

	if (options.focusId !== undefined) {
		const ordered = focusOrder(records);
		const index = Math.max(
			0,
			ordered.findIndex((record) => record.agentId === options.focusId),
		);
		const { start, end } = windowAround(ordered.length, index);
		return {
			rows: ordered.slice(start, end).map((record) => toRow(record, options.parentModel)),
			above: start,
			below: ordered.length - end,
			focus: options.focusArmed ? { selectedId: options.focusId, armed: true } : { selectedId: options.focusId },
			tokens,
			cost,
		};
	}

	const shown = shownRecords(records, options.now);
	return {
		rows: shown.slice(0, MAX_ROWS).map((record) => toRow(record, options.parentModel)),
		above: 0,
		below: Math.max(0, shown.length - MAX_ROWS),
		focus: null,
		tokens,
		cost,
	};
}

/** When the next finished row drops out of the retention window, so the HUD can be refreshed then. */
export function nextExpiry(records: readonly HudRecord[], now: number): number | undefined {
	let next: number | undefined;
	for (const record of records) {
		if (isActive(record.status) || record.endedAt === undefined) continue;
		const expiry = record.endedAt + RETENTION_MS;
		if (expiry > now && (next === undefined || expiry < next)) next = expiry;
	}
	return next;
}
