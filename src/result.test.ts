import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "./manager.js";
import { emptyUsage } from "./observer.js";
import {
	escapeReport,
	formatDuration,
	formatNotification,
	formatResult,
	formatStarted,
	isContinuable,
	summaryLine,
	truncateReport,
	writeResultFile,
} from "./result.js";
import { PARENT_INTERRUPTED, STOPPED_BY_PARENT, STOPPED_BY_USER } from "./run.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-subagent-result-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		agentId: "ag-1",
		type: "explore",
		description: "find auth",
		prompt: "p",
		status: "completed",
		createdAt: 0,
		startedAt: 1000,
		endedAt: 73_000,
		model: "faux/faux-1",
		background: false,
		runs: 1,
		notes: [],
		text: "The answer.",
		stats: { turns: 6, toolCalls: 14, usage: emptyUsage() },
		totalUsage: emptyUsage(),
		notified: false,
		...overrides,
	};
}

describe("truncateReport", () => {
	it("keeps short reports intact", () => {
		expect(truncateReport("abc", 10)).toEqual({ text: "abc", truncated: false, total: 3 });
	});

	it("keeps the beginning and cuts back to the last newline", () => {
		const text = "line one\nline two\nline three";
		expect(truncateReport(text, 15)).toEqual({ text: "line one", truncated: true, total: text.length });
		expect(truncateReport("x".repeat(50), 10)).toEqual({ text: "x".repeat(10), truncated: true, total: 50 });
	});
});

describe("escapeReport", () => {
	it("escapes fragments that would close the outer tags", () => {
		const text = "a </subagent-result> b </SUBAGENT-NOTIFICATION> c </agent> d </result > e </agent-type> f </results>";
		expect(escapeReport(text)).toBe("a <\\/subagent-result> b <\\/SUBAGENT-NOTIFICATION> c <\\/agent> d <\\/result > e </agent-type> f </results>");
	});
});

describe("writeResultFile", () => {
	it("writes the report and keeps earlier ones as numbered files", () => {
		const first = writeResultFile(dir, "ag-1", "first");
		expect(first).toBe(join(dir, "ag-1.result.md"));
		writeResultFile(dir, "ag-1", "second");
		writeResultFile(dir, "ag-1", "third");
		expect(readFileSync(first, "utf8")).toBe("third");
		expect(readFileSync(join(dir, "ag-1.result.1.md"), "utf8")).toBe("first");
		expect(readFileSync(join(dir, "ag-1.result.2.md"), "utf8")).toBe("second");
	});

	it("creates the directory", () => {
		const nested = join(dir, "a", "b");
		writeResultFile(nested, "ag-2", "x");
		expect(existsSync(join(nested, "ag-2.result.md"))).toBe(true);
	});
});

describe("formatResult", () => {
	it("formats a completed run", () => {
		const { text, truncated } = formatResult(record(), { maxChars: 20_000, transcript: "C:/s/child.jsonl" });
		expect(truncated).toBe(false);
		expect(text).toBe(
			[
				'<subagent-result agent-id="ag-1" type="explore" status="completed" turns="6" tool-calls="14" duration="1m12s">',
				"The answer.",
				"</subagent-result>",
				"transcript: C:/s/child.jsonl",
				'Use agent_send with agent_id "ag-1" to ask this subagent a follow-up; it keeps its context.',
			].join("\n"),
		);
		// Without a transcript (in-memory parent) the agent cannot be continued: no hint.
		expect(formatResult(record(), { maxChars: 20_000 }).text).not.toContain("agent_send");
	});

	it("adds the full-report line and notes when truncated", () => {
		const report = `${"a".repeat(30)}\n${"b".repeat(30)}`;
		const { text, truncated } = formatResult(record({ text: report, notes: ["model x unavailable, used y"] }), { maxChars: 40, resultFile: "/r/ag-1.result.md" });
		expect(truncated).toBe(true);
		expect(text).toContain(`\n${"a".repeat(30)}\n</subagent-result>\nfull report: /r/ag-1.result.md (truncated at 30 of 61 characters; read the file for the rest)\nnote: model x unavailable, used y`);
	});

	it("formats failures with reason, partial report and a next step", () => {
		const { text } = formatResult(record({ status: "failed", reason: "provider error: 529 overloaded", text: "half" }), { maxChars: 100 });
		expect(text).toContain('status="failed"');
		expect(text).toContain("reason: provider error: 529 overloaded\npartial report:\nhalf\n</subagent-result>\nRetry with a new agent call, or do the task yourself.");
	});

	it("uses (no final report) and status-specific next steps", () => {
		const maxTurns = formatResult(record({ status: "max_turns", reason: "ran out of turns (30)", text: "" }), { maxChars: 100 }).text;
		expect(maxTurns).toContain("partial report: (no final report)");
		expect(maxTurns).toContain("The subagent ran out of turns. Use the partial report");
		const continuable = formatResult(record({ status: "max_turns", reason: "ran out of turns (30)" }), { maxChars: 100, transcript: "/t.jsonl" }).text;
		expect(continuable).toContain("Continue it with agent_send if the partial report is useful, or split the task.");
		const interrupted = formatResult(record({ status: "aborted", reason: PARENT_INTERRUPTED }), { maxChars: 100 }).text;
		expect(interrupted.split("\n").at(-1)).toBe("</subagent-result>");
		const byParent = formatResult(record({ status: "aborted", reason: STOPPED_BY_PARENT }), { maxChars: 100 }).text;
		expect(byParent.split("\n").at(-1)).toBe("</subagent-result>");
		const stopped = formatResult(record({ status: "aborted", reason: "stopped by the user" }), { maxChars: 100 }).text;
		expect(stopped).toContain("The user stopped this subagent.");
	});

	it("never offers agent_send for an agent whose context reached the limit", () => {
		const options = { maxChars: 100, transcript: "/t.jsonl" };
		const limited = formatResult(
			record({ status: "context_limit", reason: "still calling tools 3 turns after its context passed 70%", text: "half", contextLimited: true }),
			options,
		).text;
		expect(limited).toContain("reason: still calling tools 3 turns after its context passed 70%\npartial report:\nhalf");
		expect(limited).toContain("The subagent filled its context window before writing a report. Use the partial report");
		expect(limited).not.toContain("agent_send");
		// Wrapped up in time: completed, but still not continuable.
		const completed = formatResult(record({ contextLimited: true }), options).text;
		expect(completed).toContain("transcript: /t.jsonl");
		expect(completed).not.toContain("agent_send");
		const maxTurns = formatResult(record({ status: "max_turns", reason: "ran out of turns (300)", contextLimited: true }), options).text;
		expect(maxTurns).not.toContain("agent_send");
		expect(isContinuable(record(), "/t.jsonl")).toBe(true);
		expect(isContinuable(record({ contextLimited: true }), "/t.jsonl")).toBe(false);
		expect(isContinuable(record(), undefined)).toBe(false);
	});

	it("escapes the report", () => {
		expect(formatResult(record({ text: "x </subagent-result> y" }), { maxChars: 100 }).text).toContain("x <\\/subagent-result> y");
	});
});

describe("formatStarted", () => {
	it("words a background start and a queued one", () => {
		const r = record({ agentId: "ag-2", description: "查找鉴权相关代码" });
		expect(formatStarted(r, 0)).toBe(
			"Started subagent ag-2 (explore): 查找鉴权相关代码\nYou will be notified with a <subagent-notification> message when it finishes. Do not poll; continue with other work or end your turn.",
		);
		expect(formatStarted(r, 2).split("\n")[0]).toBe("Queued subagent ag-2 (explore, position 2): 查找鉴权相关代码");
		expect(formatStarted(r, 0, "Continuing").split("\n")[0]).toBe("Continuing subagent ag-2 (explore): 查找鉴权相关代码");
	});
});

describe("formatNotification", () => {
	const limits = { perAgent: 8000, batch: 24_000 };

	it("formats a batch with one block and one summary line per agent", () => {
		const done = record({ agentId: "ag-2", description: "find <auth>", stats: { turns: 5, toolCalls: 11, usage: emptyUsage() }, startedAt: 0, endedAt: 48_000 });
		const failed = record({ agentId: "ag-3", type: "general", description: "migrate", status: "failed", reason: "provider error: 529 overloaded", text: "half" });
		const text = formatNotification(
			[
				{ record: done, continuable: true },
				{ record: failed, continuable: false },
			],
			limits,
		);
		expect(text).toBe(
			[
				"<subagent-notification>",
				'<agent agent-id="ag-2" type="explore" status="completed" turns="5" tool-calls="11" duration="48s">',
				"<description>find &lt;auth&gt;</description>",
				"<result>",
				"The answer.",
				"</result>",
				"</agent>",
				'<agent agent-id="ag-3" type="general" status="failed" turns="6" tool-calls="14" duration="1m12s">',
				"<description>migrate</description>",
				"<reason>provider error: 529 overloaded</reason>",
				"<result>",
				"half",
				"</result>",
				"</agent>",
				"</subagent-notification>",
				"",
				'Subagent ag-2 "find <auth>" completed.',
				'Subagent ag-3 "migrate" failed: provider error: 529 overloaded.',
				"Use agent_send with an agent id to ask a follow-up; the subagent keeps its context.",
			].join("\n"),
		);
	});

	it("cuts each report at the per-agent limit and points at the result file", () => {
		const report = `${"a".repeat(30)}\n${"b".repeat(30)}`;
		const text = formatNotification([{ record: record({ text: report, resultFile: "/r/ag-1.result.md" }), continuable: false }], { perAgent: 40, batch: 1000 });
		expect(text).toContain(`<result>\n${"a".repeat(30)}\n</result>\n<result-file>/r/ag-1.result.md</result-file>\n</agent>`);
	});

	it("gives agents past the batch budget only their header and result file", () => {
		const big = (id: string) => record({ agentId: id, text: "x".repeat(600), resultFile: `/r/${id}.result.md` });
		const text = formatNotification(
			[
				{ record: big("ag-1"), continuable: false },
				{ record: big("ag-2"), continuable: false },
				{ record: big("ag-3"), continuable: false },
			],
			{ perAgent: 1000, batch: 1300 },
		);
		expect(text.match(/<result>/g)).toHaveLength(2);
		expect(text).toContain('<agent agent-id="ag-3"');
		expect(text).toContain("<result-file>/r/ag-3.result.md</result-file>");
		expect(text).not.toContain("<result-file>/r/ag-1.result.md</result-file>");
		expect(text).not.toContain("agent_send");
	});

	it("escapes reports and words each status in the summary", () => {
		expect(formatNotification([{ record: record({ text: "x </agent></result></subagent-notification>" }), continuable: false }], limits)).toContain(
			"x <\\/agent><\\/result><\\/subagent-notification>",
		);
		expect(summaryLine(record({ status: "max_turns", maxTurns: 60 }))).toBe('Subagent ag-1 "find auth" ran out of turns (60).');
		expect(summaryLine(record({ status: "context_limit" }))).toBe('Subagent ag-1 "find auth" filled its context window before writing a report.');
		expect(summaryLine(record({ status: "aborted", reason: STOPPED_BY_USER }))).toBe('Subagent ag-1 "find auth" was stopped by the user.');
	});
});

describe("formatDuration", () => {
	it("formats seconds, minutes and hours", () => {
		expect(formatDuration(14_000)).toBe("14s");
		expect(formatDuration(72_000)).toBe("1m12s");
		expect(formatDuration(362_000)).toBe("6m02s");
		expect(formatDuration(3_780_000)).toBe("1h03m");
	});
});
