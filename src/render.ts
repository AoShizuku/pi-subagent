// The `agent` tool card, drawn with renderShell: "self" (docs/07 §1).
//
// renderCall returns one long-lived component that draws the whole card from the row's shared renderer
// state at render time; renderResult only records the latest result there. That keeps the header and the
// progress lines in one block whose height does not jump while the agent runs.
//
// A background start's card follows the agent's record instead of its one tool result (docs/07 §1.4): it
// looks the record up through a CardLink at render time and is redrawn when the record ends.

import { readFileSync } from "node:fs";

import { getMarkdownTheme, type Theme, type ThemeColor, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, truncateToWidth } from "@earendil-works/pi-tui";

import { type AgentRecord, isTerminal } from "./manager.js";
import { displayTokens, type ProgressSnapshot, type UsageTotals } from "./observer.js";
import { durationOf, formatDuration } from "./result.js";
import { type AgentStatus, SESSION_ENDED } from "./run.js";
import { clip } from "./tool-line.js";

export interface AgentToolDetails {
	agentId: string;
	type: string;
	description: string;
	status: AgentStatus;
	reason?: string;
	turns: number;
	toolCalls: number;
	durationMs: number;
	usage: UsageTotals;
	/** provider/id actually used. */
	model: string;
	maxTurns?: number;
	sessionFile?: string;
	resultFile?: string;
	truncated: boolean;
	/** Only in onUpdate partial results. */
	progress?: ProgressSnapshot;
	/** 1-based queue position while queued. */
	queuePosition?: number;
	/** A background start: the card shows one line that follows the agent's record (docs/07 §1.4). */
	background?: boolean;
	/** The record's run number when this card started it; a later agent_send run is not this card's. */
	run?: number;
}

export interface AgentCallArgs {
	description?: string;
	prompt?: string;
	agent_type?: string;
	model?: string;
	/** agent_send */
	agent_id?: string;
	message?: string;
}

interface CardResult {
	content: Array<{ type: string; text?: string }>;
	details?: AgentToolDetails;
	isError: boolean;
	partial: boolean;
}

interface CardState {
	card?: AgentCard;
	result?: CardResult;
	/** Background card: the report read from the result file (the record's text is memory only). */
	report?: string;
}

/** What a background card reads from the session's AgentManager. */
export interface CardSource {
	get(agentId: string): AgentRecord | undefined;
	/** How one run ended, kept per (agent, run) so a later agent_send run does not hide it. */
	runOutcome(agentId: string, run: number): AgentRecord | undefined;
	subscribe(listener: (record: AgentRecord) => void): () => void;
}

/**
 * Connects background cards to the current session's manager (docs/07 §1.4). One per extension instance:
 * session_start attaches the manager, session_shutdown detaches it, and a card asks for its record at render
 * time. A card whose agent has not ended yet registers its row's invalidate here; the record entering a
 * terminal state redraws those rows once. Progress redraws nothing: it is shown in the HUD.
 */
export class CardLink {
	private source: CardSource | undefined;
	private unsubscribe: (() => void) | undefined;
	/** toolCallId -> the card waiting for its agent to end. A rebuilt row replaces its tool call's entry. */
	private readonly waiting = new Map<string, { agentId: string; invalidate: () => void }>();
	private readonly statuses = new Map<string, AgentStatus>();

	get attached(): boolean {
		return this.source !== undefined;
	}

	attach(source: CardSource): void {
		this.unsubscribe?.();
		this.statuses.clear();
		this.source = source;
		this.unsubscribe = source.subscribe((record) => this.changed(record));
		// Rows drawn before session_start (resume, /reload) can find their records now.
		this.redraw(() => true);
	}

	/** Detach `source`; a no-op when a later session_start already attached another one. */
	detach(source: CardSource): void {
		if (this.source !== source) return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.source = undefined;
		this.statuses.clear();
	}

	get(agentId: string): AgentRecord | undefined {
		return this.source?.get(agentId);
	}

	runOutcome(agentId: string, run: number): AgentRecord | undefined {
		return this.source?.runOutcome(agentId, run);
	}

	wait(toolCallId: string, agentId: string, invalidate: () => void): void {
		this.waiting.set(toolCallId, { agentId, invalidate });
	}

	forget(toolCallId: string): void {
		this.waiting.delete(toolCallId);
	}

	private changed(record: AgentRecord): void {
		const before = this.statuses.get(record.agentId);
		this.statuses.set(record.agentId, record.status);
		if (before === record.status || !isTerminal(record.status)) return;
		this.redraw((agentId) => agentId === record.agentId);
	}

	/** Drops the matching entries and invalidates their rows; a row whose agent still runs registers again. */
	private redraw(matches: (agentId: string) => boolean): void {
		for (const [toolCallId, entry] of [...this.waiting]) {
			if (!matches(entry.agentId)) continue;
			this.waiting.delete(toolCallId);
			try {
				entry.invalidate();
			} catch {
				// A row that is gone must not break the run that ended.
			}
		}
	}
}

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;

const EMPTY: Component = { render: () => [], invalidate: () => {} };
const PROMPT_PREVIEW_LINES = 6;
const REPORT_PREVIEW_LINES = 40;
const LABEL_MAX = 60;

const ICONS: Record<AgentStatus, string> = {
	queued: "●",
	running: "●",
	completed: "✓",
	failed: "✗",
	aborted: "■",
	max_turns: "↻",
	context_limit: "◔",
};

const ICON_COLORS: Record<AgentStatus, "accent" | "warning" | "success" | "error" | "dim" | "muted"> = {
	queued: "muted",
	running: "accent",
	completed: "success",
	failed: "error",
	aborted: "warning",
	max_turns: "warning",
	context_limit: "warning",
};

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens} tok`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K tok`;
	return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

export function formatCost(cost: number): string {
	return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

/** description, or the first line of the prompt cut to 60 columns. */
export function callLabel(args: AgentCallArgs): string {
	const description = args.description?.replace(/\s+/g, " ").trim();
	if (description) return description;
	const firstLine = (args.prompt ?? "").trim().split(/\r?\n/)[0] ?? "";
	return clip(firstLine, LABEL_MAX);
}

/** Gutter convention (pi-shizuku README.md): markers sit in column 0, so rows ignore pi's outputPad. */
const MARKER_COLUMN = 0;

export class AgentCard implements Component {
	args: AgentCallArgs = {};
	theme: Theme | undefined;
	expanded = false;
	/** Left padding shared with pi's other tool rows, so the icon lines up with them. */
	pad = 0;
	/** Where a background card finds its agent's record; undefined draws the start result as is. */
	link: CardLink | undefined;

	constructor(private readonly state: CardState) {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || width <= 0) return [];
		const pad = " ".repeat(this.pad);
		const lines = this.lines(theme, Math.max(1, width - this.pad));
		return lines.map((line) => truncateToWidth(pad + line, width));
	}

	invalidate(): void {
		// Everything is derived from the shared state at render time.
	}

	private lines(theme: Theme, width: number): string[] {
		const result = this.state.result;
		const details = result?.details;
		const followUp = this.args.agent_id !== undefined;
		const typeName = details?.type ?? this.args.agent_type?.trim() ?? (followUp ? "" : "general");
		const label = details?.description ?? (followUp ? `${this.args.agent_id ?? ""} ← ${clip(firstLine(this.args.message ?? ""), LABEL_MAX)}` : callLabel(this.args));
		const head: Head = (status, extra, faded = false) => {
			// Faded: the whole line in one dim run, extras passed uncolored.
			const fg = faded ? (_color: ThemeColor, text: string) => text : (color: ThemeColor, text: string) => theme.fg(color, text);
			const icon = status === "error" ? fg("error", "✗") : fg(ICON_COLORS[status], ICONS[status]);
			const model = this.args.model?.trim() ? [this.args.model.trim()] : [];
			const parts = [fg("accent", typeName), label, ...(followUp ? [fg("dim", "follow-up")] : []), ...model, ...extra];
			const title = faded ? "Agent" : theme.bold(theme.fg("toolTitle", "Agent"));
			const line = `${icon} ${title} ${parts.filter(Boolean).join(fg("dim", " · "))}`;
			return faded ? theme.fg("dim", line) : line;
		};

		if (!result) return [head("running", [])];
		const message = result.content.find((part) => part.type === "text")?.text ?? "";
		if (!details) {
			// Thrown before the agent was created (unknown type, invalid model...), or a follow-up that was
			// only queued for a running agent.
			if (result.isError) return [head("error", [theme.fg("error", firstLine(message) || "failed")])];
			return [head("queued", [theme.fg("dim", firstLine(message))])];
		}
		if (details.background && !result.partial) return this.backgroundLines(theme, details, head, width);
		if (result.partial) return this.runningLines(theme, details, head);
		return this.finishedLines(theme, details, resultBody(result), head, width);
	}

	/** docs/07 §1.4: the start result while the agent runs, then the record's outcome. */
	private backgroundLines(theme: Theme, details: AgentToolDetails, head: Head, width: number): string[] {
		const startLine = (status: AgentStatus, faded = false): string => {
			const where = status === "queued" ? `queued in background${details.queuePosition ? ` (${details.queuePosition})` : ""}` : "running in background";
			const text = `${details.agentId} ${where}`;
			return head(status, [faded ? text : theme.fg("dim", text)], faded);
		};
		const started: AgentStatus = details.status === "queued" ? "queued" : "running";
		if (!this.link) return [startLine(started)];
		const record = backgroundRecord(details, this.link);
		// The record is gone (cleaned up, or not restored yet) or belongs to a later agent_send run.
		if (!record) return [startLine(started, true)];
		if (!isTerminal(record.status)) return [startLine(record.status)];
		const current = recordDetails(record, details);
		const duration = formatDuration(current.durationMs);
		switch (record.status) {
			case "failed":
				return [head("failed", [theme.fg("error", "failed"), theme.fg("dim", clip(record.reason ?? "unknown error", 60)), theme.fg("dim", duration)])];
			case "aborted":
				return [head("aborted", [theme.fg("dim", record.reason === SESSION_ENDED ? "stopped · session ended" : `stopped after ${duration}`)])];
			default:
				return this.finishedLines(theme, current, this.expanded ? backgroundReport(this.state, record) : "", head, width);
		}
	}

	private runningLines(theme: Theme, details: AgentToolDetails, head: Head): string[] {
		if (details.status === "queued") {
			return [head("queued", [theme.fg("muted", `queued${details.queuePosition ? ` (${details.queuePosition})` : ""}`)])];
		}
		const progress = details.progress;
		const first = head("running", [theme.fg("dim", formatDuration(details.durationMs))]);
		let activity: string;
		if (progress && progress.activeTools.length > 0) {
			activity = progress.activeTools
				.slice(-2)
				.map((tool) => tool.line)
				.join(theme.fg("dim", " · "));
		} else {
			const recent = progress?.recentText.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
			activity = theme.fg("dim", recent || "thinking…");
		}
		const tools = progress?.toolCalls ?? details.toolCalls;
		const turn = (progress?.turns ?? details.turns) + 1;
		const tokens = formatTokens(displayTokens(progress?.usage ?? details.usage));
		const stats = theme.fg("dim", `${tools} tool${tools === 1 ? "" : "s"} · turn ${turn} · ${tokens}`);
		return [first, `  ${theme.fg("dim", "├")} ${activity}`, `  ${theme.fg("dim", "└")} ${stats}`];
	}

	private finishedLines(
		theme: Theme,
		details: AgentToolDetails,
		report: string,
		head: Head,
		width: number,
	): string[] {
		const extra: string[] = [];
		switch (details.status) {
			case "completed":
				extra.push(theme.fg("dim", `${details.toolCalls} tool${details.toolCalls === 1 ? "" : "s"}`));
				extra.push(theme.fg("dim", formatTokens(displayTokens(details.usage))));
				break;
			case "failed":
				extra.push(theme.fg("error", `failed: ${clip(details.reason ?? "unknown error", 60)}`));
				break;
			case "aborted":
				extra.push(theme.fg("dim", "stopped"));
				break;
			case "max_turns":
				extra.push(theme.fg("warning", `out of turns${details.maxTurns ? ` (${details.maxTurns})` : ""}`));
				break;
			case "context_limit":
				extra.push(theme.fg("warning", "context full"));
				break;
			default:
				break;
		}
		extra.push(theme.fg("dim", formatDuration(details.durationMs)));
		const first = `${head(details.status, extra)} ${theme.fg("dim", this.expanded ? "▾" : "▸")}`;
		if (!this.expanded) return [first];

		const bar = theme.fg("dim", "│");
		const lines = [first];
		const meta = [details.agentId, details.model, `${details.turns} turn${details.turns === 1 ? "" : "s"}`];
		if (details.usage.cost > 0) meta.push(formatCost(details.usage.cost));
		lines.push(`  ${theme.fg("dim", meta.join(" · "))}`);

		lines.push(`  ${theme.fg("dim", this.args.agent_id !== undefined ? "┌ follow-up" : "┌ prompt")}`);
		const promptLines = (this.args.prompt ?? this.args.message ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
		for (const line of promptLines.slice(0, PROMPT_PREVIEW_LINES)) lines.push(`  ${bar} ${line}`);
		if (promptLines.length > PROMPT_PREVIEW_LINES) {
			lines.push(`  ${bar} ${theme.fg("dim", `… ${promptLines.length - PROMPT_PREVIEW_LINES} more lines`)}`);
		}

		lines.push(`  ${theme.fg("dim", "├ report")}`);
		const body = reportLines(report, width - 4);
		for (const line of body.slice(0, REPORT_PREVIEW_LINES)) lines.push(`  ${bar} ${line}`);
		if (body.length > REPORT_PREVIEW_LINES) {
			const more = `… ${body.length - REPORT_PREVIEW_LINES} more lines${details.resultFile ? ` · ${details.resultFile}` : ""}`;
			lines.push(`  ${bar} ${theme.fg("dim", more)}`);
		}
		const tail = details.sessionFile ? `transcript: ${details.sessionFile}` : details.resultFile ? `report: ${details.resultFile}` : "";
		lines.push(`  ${theme.fg("dim", `└ ${tail}`)}`);
		return lines;
	}
}

/** The card's first line; `faded` draws it as one dim run (a background card without its record). */
type Head = (status: AgentStatus | "error", extra: string[], faded?: boolean) => string;

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/)[0] ?? "";
}

/**
 * The record of the run a background card started: the live record while that run is going, then the manager's
 * outcome snapshot of that run, so a later agent_send run does not repaint it. A start result without a run
 * number (stored before runs were tracked) follows the latest record. Undefined when the session has no such
 * run (cleaned up, or not restored yet).
 */
function backgroundRecord(details: AgentToolDetails, link: CardLink): AgentRecord | undefined {
	const record = link.get(details.agentId);
	if (details.run === undefined) return record;
	if (record && record.runs === details.run && !isTerminal(record.status)) return record;
	return link.runOutcome(details.agentId, details.run) ?? (record?.runs === details.run ? record : undefined);
}

/** The card's details rebuilt from its agent's record (docs/07 §1.4). */
function recordDetails(record: AgentRecord, start: AgentToolDetails): AgentToolDetails {
	return {
		...start,
		status: record.status,
		reason: record.reason,
		turns: record.stats.turns,
		toolCalls: record.stats.toolCalls,
		durationMs: durationOf(record),
		usage: { ...record.stats.usage },
		model: record.model,
		maxTurns: record.maxTurns ?? start.maxTurns,
		sessionFile: record.sessionFile,
		resultFile: record.resultFile,
		progress: undefined,
		queuePosition: undefined,
	};
}

/** The report of an ended background run: the record's text, or its result file after a restart (read once). */
function backgroundReport(state: CardState, record: AgentRecord): string {
	if (record.text) return record.text;
	if (state.report === undefined) {
		try {
			state.report = record.resultFile ? readFileSync(record.resultFile, "utf8") : "";
		} catch {
			state.report = "";
		}
	}
	return state.report;
}

/** details of a <subagent-notification> custom message; drives its one-line-per-agent rendering (docs/07 §2). */
export interface NotificationDetails {
	agents: Array<{
		agentId: string;
		type: string;
		description: string;
		status: AgentStatus;
		reason?: string;
		toolCalls: number;
		durationMs: number;
		resultFile?: string;
		/** First lines of the report, shown when expanded. */
		preview: string[];
	}>;
}

export const NOTIFICATION_PREVIEW_LINES = 20;

export function notificationLines(details: NotificationDetails | undefined, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	for (const agent of details?.agents ?? []) {
		const color = ICON_COLORS[agent.status];
		const tools = `${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`;
		let state: string;
		switch (agent.status) {
			case "completed":
				state = `${theme.fg(color, "completed")}${theme.fg("dim", ` · ${tools}`)}`;
				break;
			case "failed":
				state = `${theme.fg(color, "failed")}${theme.fg("dim", ` · ${clip(agent.reason ?? "unknown error", 60)}`)}`;
				break;
			case "max_turns":
				state = theme.fg(color, "out of turns");
				break;
			case "context_limit":
				state = theme.fg(color, "context full");
				break;
			case "aborted":
				state = theme.fg(color, "stopped");
				break;
			default:
				state = theme.fg(color, agent.status);
		}
		lines.push(
			`${theme.fg(color, "●")} ${theme.fg("accent", agent.agentId)} ${theme.fg("accent", agent.type)} ${agent.description} ${state}${theme.fg("dim", ` · ${formatDuration(agent.durationMs)}`)}`,
		);
		if (!expanded) continue;
		for (const line of agent.preview.slice(0, NOTIFICATION_PREVIEW_LINES)) lines.push(`  ${theme.fg("dim", "│")} ${line}`);
		if (agent.resultFile) lines.push(`  ${theme.fg("dim", `└ ${agent.resultFile}`)}`);
	}
	return lines;
}

/** The text inside <subagent-result>…</subagent-result>. */
export function resultBody(result: Pick<CardResult, "content">): string {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	const open = text.indexOf(">\n");
	const close = text.lastIndexOf("\n</subagent-result>");
	if (!text.startsWith("<subagent-result") || open === -1 || close <= open) return text;
	return text.slice(open + 2, close);
}

function reportLines(text: string, width: number): string[] {
	try {
		return new Markdown(text, 0, 0, getMarkdownTheme()).render(Math.max(20, width)).map((line) => line.trimEnd());
	} catch {
		// No initialized theme (tests, non-TUI); plain text is fine there.
		return text.split("\n");
	}
}

/**
 * renderCall / renderResult for `agent` and `agent_send`. With a link, background cards follow their agent's
 * record (docs/07 §1.4); without one they draw the start result as is.
 */
export function agentCardRenderers(link?: CardLink): { renderCall: RenderCall; renderResult: RenderResult } {
	const renderCall: RenderCall = (args, theme, context) => {
		const state = context.state as CardState;
		const card = state.card ?? new AgentCard(state);
		state.card = card;
		card.args = (args ?? {}) as AgentCallArgs;
		card.theme = theme;
		card.expanded = context.expanded;
		card.pad = MARKER_COLUMN;
		card.link = link;
		return card;
	};

	const renderResult: RenderResult = (result, options, theme, context) => {
		const state = context.state as CardState;
		// pi stores a thrown tool error as `details: {}`, not undefined; only a result that names its agent
		// carries our details, anything else is drawn as a plain error or queued message.
		const raw = result.details as Partial<AgentToolDetails> | undefined;
		const details = raw?.agentId ? (raw as AgentToolDetails) : undefined;
		state.result = {
			content: result.content as CardResult["content"],
			details,
			isError: context.isError,
			partial: options.isPartial,
		};
		if (state.card) {
			state.card.theme = theme;
			state.card.expanded = options.expanded;
			state.card.pad = MARKER_COLUMN;
		}
		if (link && details?.background && !options.isPartial) {
			// Wait for the end while the record runs, or until session_start attaches a manager to look in.
			const record = backgroundRecord(details, link);
			const settled = record ? isTerminal(record.status) : link.attached;
			if (settled) link.forget(context.toolCallId);
			else link.wait(context.toolCallId, details.agentId, context.invalidate);
		}
		return EMPTY;
	};

	return { renderCall, renderResult };
}

const unlinked = agentCardRenderers();
export const renderAgentCall: RenderCall = unlinked.renderCall;
export const renderAgentResult: RenderResult = unlinked.renderResult;

interface StopState {
	row?: StopRow;
	result?: { line: string; isError: boolean };
}

/**
 * The `agent_stop` row: `{pad}● Agent Stop (ag-1) · Stopped subagent ag-1 (…) after 1m02s.` A successful stop is
 * dim as a whole: the stopped agent's own card (red ■) carries the outcome (docs/07 §1.4).
 */
export class StopRow implements Component {
	agentId = "";
	theme: Theme | undefined;
	pad = 0;

	constructor(private readonly state: StopState) {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme || width <= 0) return [];
		const result = this.state.result;
		const pad = " ".repeat(this.pad);
		if (result && !result.isError) {
			const detail = this.agentId ? ` (${this.agentId})` : "";
			const summary = result.line ? ` · ${result.line}` : "";
			return [truncateToWidth(`${pad}${theme.fg("dim", `● Agent Stop${detail}${summary}`)}`, width, "…")];
		}
		const marker = result ? theme.fg("error", "×") : theme.fg("accent", "●");
		const detail = this.agentId ? ` ${theme.fg("muted", `(${this.agentId})`)}` : "";
		const summary = result?.line ? theme.fg("error", ` · ${result.line}`) : "";
		return [truncateToWidth(`${pad}${marker} ${theme.fg("toolTitle", theme.bold("Agent Stop"))}${detail}${summary}`, width, "…")];
	}

	invalidate(): void {
		// Everything is derived from the shared state at render time.
	}
}

export const renderStopCall: RenderCall = (args, theme, context) => {
	const state = context.state as StopState;
	const row = state.row ?? new StopRow(state);
	state.row = row;
	row.agentId = ((args as { agent_id?: string } | undefined)?.agent_id ?? "").trim();
	row.theme = theme;
	row.pad = MARKER_COLUMN;
	return row;
};

export const renderStopResult: RenderResult = (result, _options, theme, context) => {
	const state = context.state as StopState;
	const first = result.content.find((part) => part.type === "text");
	state.result = { line: firstLine(first?.type === "text" ? first.text : ""), isError: context.isError };
	if (state.row) {
		state.row.theme = theme;
		state.row.pad = MARKER_COLUMN;
	}
	return EMPTY;
};
