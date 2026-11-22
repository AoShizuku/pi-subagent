import { describe, expect, it, vi } from "vitest";

import { ChildObserver, displayTokens } from "./observer.js";
import { FakeSession } from "./test-helpers.js";

function observed(maxTurns: number) {
	const onBudgetReminder = vi.fn();
	const onTurnLimit = vi.fn();
	const session = new FakeSession();
	const observer = new ChildObserver({ maxTurns, onBudgetReminder, onTurnLimit, cwd: "/repo" });
	session.subscribe(observer.onEvent);
	return { session, observer, onBudgetReminder, onTurnLimit };
}

describe("ChildObserver", () => {
	it("counts turns, tool calls, usage and keeps the recent text", async () => {
		const { session, observer } = observed(10);
		await session.turn({ text: "looking", tools: [{ name: "grep", args: { pattern: "auth", path: "src" } }, { name: "read", args: { path: "a.ts" } }], usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 50, cost: 0.01 } });
		await session.turn({ text: "x".repeat(300), usage: { input: 10, output: 5 } });
		const snapshot = observer.snapshot();
		expect(snapshot.turns).toBe(2);
		expect(snapshot.toolCalls).toBe(2);
		expect(snapshot.activeTools).toEqual([]);
		expect(snapshot.recentText).toHaveLength(200);
		expect(snapshot.usage).toEqual({ input: 110, output: 25, cacheRead: 1000, cacheWrite: 50, cost: 0.01 });
		expect(displayTokens(snapshot.usage)).toBe(185);
	});

	it("reads the context fill on events but streamed deltas and keeps the last known one", async () => {
		const session = new FakeSession();
		const contextUsage = vi.fn(() => session.context);
		const observer = new ChildObserver({ maxTurns: 10, contextUsage });
		session.subscribe(observer.onEvent);
		await session.turn({ text: "x" });
		expect(observer.snapshot().context).toBeUndefined();
		// turn_start, message_start, message_end, turn_end: the text delta does not read it.
		expect(contextUsage).toHaveBeenCalledTimes(4);
		session.context = { tokens: 42_000, contextWindow: 200_000 };
		await session.turn({ text: "y" });
		expect(observer.snapshot().context).toEqual({ tokens: 42_000, window: 200_000 });
		// Unknown right after a compaction: keep the last figure rather than blank the title.
		session.context = { tokens: null, contextWindow: 200_000 };
		await session.turn({ text: "z" });
		expect(observer.context).toEqual({ tokens: 42_000, window: 200_000 });
	});

	it("does not count the empty stub turn a failed or aborted run ends with", async () => {
		const { session, observer } = observed(10);
		await session.turn({ text: "work", tools: [{ name: "read" }] });
		await session.turn({ stopReason: "error", errorMessage: "This operation was aborted" });
		await session.turn({ text: "partial", stopReason: "error" });
		expect(observer.turns).toBe(2);
	});

	it("tracks running tools with a one-line summary", () => {
		const { session, observer } = observed(10);
		session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: { pattern: "authenticate", path: "src" } });
		session.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "/repo/src/auth.ts", offset: 40, limit: 81 } });
		expect(observer.snapshot().activeTools.map((tool) => tool.line)).toEqual(["Grep (/authenticate/ in src)", "Read (src/auth.ts:40-120)"]);
		session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "grep", result: {}, isError: false });
		expect(observer.snapshot().activeTools.map((tool) => tool.name)).toEqual(["read"]);
	});

	it("reminds exactly once when 2 turns are left", async () => {
		const { session, onBudgetReminder, onTurnLimit } = observed(5);
		for (let i = 0; i < 4; i++) await session.turn({ tools: [{ name: "read" }] });
		expect(onBudgetReminder).toHaveBeenCalledTimes(1);
		expect(onBudgetReminder).toHaveBeenCalledWith(2);
		expect(onTurnLimit).not.toHaveBeenCalled();
	});

	it("does not remind or abort after a final turn", async () => {
		const { session, onBudgetReminder, onTurnLimit } = observed(4);
		await session.turn({ tools: [{ name: "read" }] });
		// Turn 2 leaves 2 turns and turn 4 uses the budget up, but both are final answers.
		await session.turn({ text: "final report" });
		await session.turn({ text: "final report" });
		await session.turn({ text: "final report" });
		expect(onBudgetReminder).not.toHaveBeenCalled();
		expect(onTurnLimit).not.toHaveBeenCalled();
	});

	it("signals the turn limit exactly once", async () => {
		const { session, onTurnLimit, onBudgetReminder } = observed(3);
		for (let i = 0; i < 5; i++) await session.turn({ tools: [{ name: "read" }] });
		expect(onBudgetReminder).toHaveBeenCalledTimes(1);
		expect(onTurnLimit).toHaveBeenCalledTimes(1);
	});
});

describe("ChildObserver context budget", () => {
	function contextObserved(contextLimit: number | undefined) {
		const onContextReminder = vi.fn();
		const onContextLimit = vi.fn();
		const session = new FakeSession();
		const observer = new ChildObserver({ maxTurns: 300, contextLimit, onContextReminder, onContextLimit, contextUsage: () => session.context });
		session.subscribe(observer.onEvent);
		return { session, observer, onContextReminder, onContextLimit };
	}

	it("reminds once the fill reaches the limit, then stops a run still calling tools on the third turn after it", async () => {
		const { session, observer, onContextReminder, onContextLimit } = contextObserved(70);
		session.context = { tokens: 139_999, contextWindow: 200_000 };
		await session.turn({ tools: [{ name: "read" }] });
		expect(onContextReminder).not.toHaveBeenCalled();
		expect(observer.contextLimited).toBe(false);

		session.context = { tokens: 140_000, contextWindow: 200_000 };
		await session.turn({ tools: [{ name: "read" }] });
		expect(onContextReminder).toHaveBeenCalledExactlyOnceWith(70);
		expect(observer.snapshot().contextLimited).toBe(true);

		// Three grace turns: the first two may still call tools.
		await session.turn({ tools: [{ name: "read" }] });
		await session.turn({ tools: [{ name: "read" }] });
		expect(onContextLimit).not.toHaveBeenCalled();
		await session.turn({ tools: [{ name: "read" }] });
		expect(onContextLimit).toHaveBeenCalledTimes(1);
		await session.turn({ tools: [{ name: "read" }] });
		expect(onContextLimit).toHaveBeenCalledTimes(1);
		expect(onContextReminder).toHaveBeenCalledTimes(1);
	});

	it("lets a run end with its report within the grace turns", async () => {
		const { session, onContextLimit } = contextObserved(70);
		session.context = { tokens: 150_000, contextWindow: 200_000 };
		await session.turn({ tools: [{ name: "read" }] });
		await session.turn({ tools: [{ name: "read" }] });
		await session.turn({ text: "final report" });
		expect(onContextLimit).not.toHaveBeenCalled();
	});

	it("does not remind after a final turn, but still marks the run as limited", async () => {
		const { session, observer, onContextReminder } = contextObserved(70);
		session.context = { tokens: 180_000, contextWindow: 200_000 };
		await session.turn({ text: "final report" });
		expect(onContextReminder).not.toHaveBeenCalled();
		expect(observer.contextLimited).toBe(true);
	});

	it("does nothing without a limit or a known context window", async () => {
		const unlimited = contextObserved(undefined);
		unlimited.session.context = { tokens: 199_000, contextWindow: 200_000 };
		const unknown = contextObserved(70);
		for (let i = 0; i < 5; i++) {
			await unlimited.session.turn({ tools: [{ name: "read" }] });
			await unknown.session.turn({ tools: [{ name: "read" }] });
		}
		for (const { observer, onContextReminder, onContextLimit } of [unlimited, unknown]) {
			expect(observer.contextLimited).toBe(false);
			expect(onContextReminder).not.toHaveBeenCalled();
			expect(onContextLimit).not.toHaveBeenCalled();
		}
	});
});
