// Result handoff: truncation, result files, tag escaping and the <subagent-result> text (docs/05 §3-§4, docs/03 §4).

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentRecord } from "./manager.js";
import { NO_FINAL_REPORT, PARENT_INTERRUPTED, SESSION_ENDED, STOPPED_BY_PARENT, STOPPED_BY_USER } from "./run.js";

/**
 * Rewrite fragments that would close an outer tag early (`</subagent-result`, `</subagent-notification`,
 * `</agent>`, `</result>`) as `<\/…`. No full XML escaping: reports are mostly code.
 */
export function escapeReport(text: string): string {
	return text.replace(/<\/(subagent-result|subagent-notification|agent|result)(?=[\s>]|$)/gi, "<\\/$1");
}

export interface Truncated {
	text: string;
	truncated: boolean;
	total: number;
}

/** Keep the beginning (reports lead with the conclusion); cut back to the last newline when there is one. */
export function truncateReport(text: string, max: number): Truncated {
	if (text.length <= max) return { text, truncated: false, total: text.length };
	const head = text.slice(0, max);
	const newline = head.lastIndexOf("\n");
	return { text: newline > 0 ? head.slice(0, newline) : head, truncated: true, total: text.length };
}

export function resultFileName(agentId: string): string {
	return `${agentId}.result.md`;
}

/**
 * Write the full report to `<dir>/<agentId>.result.md`. An existing file is kept as
 * `<agentId>.result.<n>.md` with the next free n (a continued agent overwrites with its latest run).
 */
export function writeResultFile(dir: string, agentId: string, text: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, resultFileName(agentId));
	if (existsSync(path)) {
		let n = 1;
		while (existsSync(join(dir, `${agentId}.result.${n}.md`))) n++;
		renameSync(path, join(dir, `${agentId}.result.${n}.md`));
	}
	writeFileSync(path, text, "utf8");
	return path;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function durationOf(record: Pick<AgentRecord, "startedAt" | "endedAt" | "createdAt">, now = Date.now()): number {
	const start = record.startedAt ?? record.createdAt;
	return (record.endedAt ?? now) - start;
}

/**
 * What the parent should do next, by status (docs/03 §4.2). `continuable`: the transcript exists, so
 * agent_send can resume the agent (not for an in-memory parent, docs/06 §6).
 */
export function nextStep(record: Pick<AgentRecord, "status" | "reason">, continuable = false): string | undefined {
	switch (record.status) {
		case "failed":
			return "Retry with a new agent call, or do the task yourself.";
		case "max_turns":
			return continuable
				? "The subagent ran out of turns. Continue it with agent_send if the partial report is useful, or split the task."
				: "The subagent ran out of turns. Use the partial report if it is useful, or split the task into smaller agent calls.";
		case "context_limit":
			// Never continuable: a continuation would start with the context already past the limit.
			return "The subagent filled its context window before writing a report. Use the partial report if it is useful, or split the task into smaller agent calls.";
		case "aborted":
			// The parent interrupted itself, stopped it with agent_stop, or the session is ending: nothing to add.
			if (record.reason === PARENT_INTERRUPTED || record.reason === STOPPED_BY_PARENT || record.reason === SESSION_ENDED) return undefined;
			return "The user stopped this subagent. Do not restart it unless the user asks.";
		default:
			return undefined;
	}
}

/** agent_send can resume it: its transcript exists and its context stayed below the limit (docs/06 §6). */
export function isContinuable(record: Pick<AgentRecord, "contextLimited">, transcript: string | undefined): boolean {
	return transcript !== undefined && !record.contextLimited;
}

export function followUpHint(agentId: string): string {
	return `Use agent_send with agent_id "${agentId}" to ask this subagent a follow-up; it keeps its context.`;
}

export interface FormatOptions {
	maxChars: number;
	/** Full report file; mentioned only when the inline text was truncated. */
	resultFile?: string;
	/** Child transcript; omitted when the child never wrote one. Its presence makes the agent continuable (see isContinuable). */
	transcript?: string;
	now?: number;
}

export function formatResult(record: AgentRecord, options: FormatOptions): { text: string; truncated: boolean } {
	const report = record.text ?? "";
	const cut = truncateReport(report, options.maxChars);
	const attrs = [
		`agent-id="${record.agentId}"`,
		`type="${record.type}"`,
		`status="${record.status}"`,
		`turns="${record.stats.turns}"`,
		`tool-calls="${record.stats.toolCalls}"`,
		`duration="${formatDuration(durationOf(record, options.now))}"`,
	];
	const body: string[] = [];
	if (record.status === "completed") {
		body.push(escapeReport(cut.text) || NO_FINAL_REPORT);
	} else {
		body.push(`reason: ${record.reason ?? record.status}`);
		body.push(cut.text ? `partial report:\n${escapeReport(cut.text)}` : `partial report: ${NO_FINAL_REPORT}`);
	}

	const lines = [`<subagent-result ${attrs.join(" ")}>`, ...body, "</subagent-result>"];
	if (cut.truncated && options.resultFile) {
		lines.push(`full report: ${options.resultFile} (truncated at ${cut.text.length} of ${cut.total} characters; read the file for the rest)`);
	}
	for (const note of record.notes) lines.push(`note: ${note}`);
	if (options.transcript) lines.push(`transcript: ${options.transcript}`);
	const continuable = isContinuable(record, options.transcript);
	if (continuable && record.status === "completed") lines.push(followUpHint(record.agentId));
	const next = nextStep(record, continuable);
	if (next) lines.push(next);
	return { text: lines.join("\n"), truncated: cut.truncated };
}

/** Immediate result of a background agent or agent_send call (docs/03 §4.3). */
export function formatStarted(record: Pick<AgentRecord, "agentId" | "type" | "description">, position: number, verb: "Started" | "Continuing" = "Started"): string {
	const queuedVerb = verb === "Started" ? "Queued" : "Queued continuation of";
	const first =
		position > 0
			? `${queuedVerb} subagent ${record.agentId} (${record.type}, position ${position}): ${record.description}`
			: `${verb} subagent ${record.agentId} (${record.type}): ${record.description}`;
	return [
		first,
		"You will be notified with a <subagent-notification> message when it finishes. Do not poll; continue with other work or end your turn.",
	].join("\n");
}

export interface NotificationLimits {
	/** Per agent (notifyMaxChars). */
	perAgent: number;
	/** Whole batch (notifyBatchMaxChars). */
	batch: number;
}

export interface NotificationItem {
	record: AgentRecord;
	/** Whether agent_send can continue it (isContinuable). */
	continuable: boolean;
}

/** One summary line per agent, worded per status (docs/06 §5.1). */
export function summaryLine(record: Pick<AgentRecord, "agentId" | "description" | "status" | "reason" | "maxTurns">): string {
	const head = `Subagent ${record.agentId} "${record.description}"`;
	switch (record.status) {
		case "completed":
			return `${head} completed.`;
		case "failed":
			return `${head} failed: ${trimPeriod(record.reason ?? "unknown error")}.`;
		case "max_turns":
			return `${head} ran out of turns${record.maxTurns ? ` (${record.maxTurns})` : ""}.`;
		case "context_limit":
			return `${head} filled its context window before writing a report.`;
		case "aborted":
			return record.reason === STOPPED_BY_USER ? `${head} was stopped by the user.` : `${head} was aborted: ${trimPeriod(record.reason ?? "aborted")}.`;
		default:
			return `${head} is ${record.status}.`;
	}
}

/**
 * The model-facing <subagent-notification> for a batch (docs/06 §5.1, docs/05 §3.2): each report is cut to
 * `perAgent` characters; once the batch budget is spent, later agents get only their header and result file.
 */
export function formatNotification(items: readonly NotificationItem[], limits: NotificationLimits, now = Date.now()): string {
	let budget = limits.batch;
	const blocks: string[] = [];
	for (const { record } of items) {
		const attrs = [
			`agent-id="${record.agentId}"`,
			`type="${record.type}"`,
			`status="${record.status}"`,
			`turns="${record.stats.turns}"`,
			`tool-calls="${record.stats.toolCalls}"`,
			`duration="${formatDuration(durationOf(record, now))}"`,
		];
		const lines = [`<agent ${attrs.join(" ")}>`, `<description>${escapeXml(record.description)}</description>`];
		if (record.status !== "completed" && record.reason) lines.push(`<reason>${escapeXml(record.reason)}</reason>`);
		const report = record.text ?? "";
		const cut = truncateReport(report, limits.perAgent);
		const body = escapeReport(cut.text);
		const fits = body.length <= budget;
		if (fits) {
			budget -= body.length;
			lines.push("<result>", body || NO_FINAL_REPORT, "</result>");
		}
		if ((cut.truncated || !fits) && record.resultFile) lines.push(`<result-file>${escapeXml(record.resultFile)}</result-file>`);
		for (const note of record.notes) lines.push(`<note>${escapeXml(note)}</note>`);
		lines.push("</agent>");
		blocks.push(lines.join("\n"));
	}
	const summaries = items.map(({ record }) => summaryLine(record));
	const out = ["<subagent-notification>", ...blocks, "</subagent-notification>", "", ...summaries];
	if (items.some((item) => item.continuable)) out.push("Use agent_send with an agent id to ask a follow-up; the subagent keeps its context.");
	return out.join("\n");
}

function trimPeriod(text: string): string {
	return text.replace(/[.\s]+$/, "");
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
