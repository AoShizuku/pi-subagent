import { describe, expect, it } from "vitest";

import { CONTEXT_BUDGET_MESSAGE_TYPE, contextBudgetReminder, TURN_BUDGET_MESSAGE_TYPE } from "./prompts.js";
import { ChildRun, finalReport, PARENT_INTERRUPTED } from "./run.js";
import { assistantMessage, blockUntilAborted, FakeSession, runUntilAborted } from "./test-helpers.js";

function run(session: FakeSession, maxTurns = 10, signal?: AbortSignal) {
	return new ChildRun(session, { maxTurns }).run("do the task", signal);
}

describe("ChildRun", () => {
	it("completes on stopReason stop and returns the last assistant text", async () => {
		const session = new FakeSession(async (s) => {
			await s.turn({ text: "searching", tools: [{ name: "grep" }] });
			await s.turn({ text: "  The answer.  " });
		});
		expect(await run(session)).toEqual({ status: "completed", text: "The answer.", notes: [] });
		expect(session.prompts).toEqual(["do the task"]);
	});

	it("treats length as completed with a note", async () => {
		const session = new FakeSession((s) => s.turn({ text: "cut off", stopReason: "length" }));
		expect(await run(session)).toEqual({ status: "completed", text: "cut off", notes: ["the final message hit the output token limit"] });
	});

	it("fails on a provider error recorded on the message", async () => {
		const session = new FakeSession((s) => s.turn({ text: "partial", stopReason: "error", errorMessage: "529 overloaded" }));
		expect(await run(session)).toMatchObject({ status: "failed", reason: "provider error: 529 overloaded", text: "partial" });
	});

	it("reports aborted when the message says so", async () => {
		const session = new FakeSession((s) => s.turn({ text: "half", stopReason: "aborted" }));
		expect(await run(session)).toMatchObject({ status: "aborted", text: "half" });
	});

	it("fails when prompt() throws", async () => {
		const session = new FakeSession(async () => {
			throw new Error('No API key found for "faux"');
		});
		expect(await run(session)).toMatchObject({ status: "failed", reason: 'No API key found for "faux"', text: "" });
	});

	it("does not prompt when the signal is already aborted", async () => {
		const session = new FakeSession();
		const controller = new AbortController();
		controller.abort();
		expect(await run(session, 10, controller.signal)).toMatchObject({ status: "aborted", reason: PARENT_INTERRUPTED });
		expect(session.prompts).toEqual([]);
	});

	it("aborts the child when the parent's signal fires", async () => {
		const session = new FakeSession(blockUntilAborted);
		const controller = new AbortController();
		const pending = run(session, 10, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		expect(await pending).toEqual({ status: "aborted", reason: PARENT_INTERRUPTED, text: "", notes: [] });
		expect(session.aborts).toBeGreaterThan(0);
	});

	it("returns an empty report when the last assistant message has no text", async () => {
		const session = new FakeSession((s) => s.turn({ stopReason: "stop" }));
		expect(await run(session)).toMatchObject({ status: "completed", text: "" });
	});

	it("stops at the turn budget with max_turns, after one reminder, keeping the last real text", async () => {
		const session = new FakeSession(runUntilAborted);
		const outcome = await run(session, 4);
		expect(outcome).toEqual({ status: "max_turns", reason: "ran out of turns (4)", text: "still working", notes: [] });
		expect(session.steered).toEqual([{ customType: TURN_BUDGET_MESSAGE_TYPE, content: "You have 2 turns left. Stop exploring and write your final report now." }]);
		expect(session.aborts).toBe(1);
	});

	it("stops with context_limit when tools go on after the context reminder, keeping the last real text", async () => {
		const session = new FakeSession(runUntilAborted);
		session.context = { tokens: 150_000, contextWindow: 200_000 };
		const outcome = await new ChildRun(session, { maxTurns: 300, contextLimit: 70 }).run("task");
		expect(outcome).toEqual({
			status: "context_limit",
			reason: "still calling tools 3 turns after its context passed 70%",
			text: "still working",
			notes: [],
		});
		expect(session.steered).toEqual([{ customType: CONTEXT_BUDGET_MESSAGE_TYPE, content: contextBudgetReminder(75) }]);
		expect(contextBudgetReminder(75)).toContain("Your context window is 75% full.");
		expect(session.aborts).toBe(1);
	});

	it("keeps the first stop reason", async () => {
		const session = new FakeSession(blockUntilAborted);
		const child = new ChildRun(session, { maxTurns: 10 });
		const pending = child.run("task");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await child.stop("aborted", "session ended");
		await child.stop("max_turns", "later");
		expect(await pending).toMatchObject({ status: "aborted", reason: "session ended" });
	});
});

describe("finalReport", () => {
	it("skips trailing aborted stubs without text but not earlier assistant text", () => {
		const messages = [assistantMessage({ text: "report" }), { role: "user" }, assistantMessage({ stopReason: "aborted" })];
		expect(finalReport(messages)).toBe("report");
		expect(finalReport([assistantMessage({ text: "report" }), assistantMessage({ text: "" })])).toBe("");
		expect(finalReport([])).toBe("");
	});

	it("after a requested stop, skips any empty trailing stub, including one recorded as an error", () => {
		const messages = [assistantMessage({ text: "step 2", tools: [{ name: "ls" }] }), { role: "toolResult" }, assistantMessage({ stopReason: "error", errorMessage: "This operation was aborted" })];
		expect(finalReport(messages, true)).toBe("step 2");
		expect(finalReport(messages, false)).toBe("");
	});
});
