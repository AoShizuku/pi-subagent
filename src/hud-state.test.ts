import { describe, expect, it } from "vitest";

import { buildHudState, focusOrder, type HudRecord, nextExpiry, RETENTION_MS, shortModel, shownRecords, toRow, windowAround } from "./hud-state.js";
import { emptyUsage } from "./observer.js";
import type { AgentStatus } from "./run.js";

const NOW = 1_000_000;

function rec(agentId: string, status: AgentStatus, overrides: Partial<HudRecord> = {}): HudRecord {
	return {
		agentId,
		type: "explore",
		description: `task ${agentId}`,
		status,
		createdAt: 0,
		startedAt: status === "queued" ? undefined : 100,
		endedAt: status === "queued" || status === "running" ? undefined : NOW - 1000,
		model: "deepseek/deepseek-pro",
		stats: { turns: 3 },
		totalUsage: emptyUsage(),
		...overrides,
	};
}

describe("shownRecords (outside focus mode)", () => {
	it("shows active agents by start time, then those that ended within 60 s, newest first", () => {
		const records = [
			rec("ag-1", "completed", { endedAt: NOW - RETENTION_MS - 1 }),
			rec("ag-2", "running", { startedAt: 300 }),
			rec("ag-3", "failed", { endedAt: NOW - 5000 }),
			rec("ag-4", "queued", { createdAt: 50 }),
			rec("ag-5", "running", { startedAt: 200 }),
			rec("ag-6", "aborted", { endedAt: NOW - 1000 }),
			rec("ag-7", "completed", { endedAt: NOW - RETENTION_MS }),
		];
		expect(shownRecords(records, NOW).map((r) => r.agentId)).toEqual(["ag-5", "ag-2", "ag-4", "ag-6", "ag-3", "ag-7"]);
	});

	it("caps at 4 rows and reports the rest as +N more", () => {
		const records = ["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6"].map((id, i) => rec(id, "running", { startedAt: i }));
		const state = buildHudState(records, { now: NOW });
		expect(state.rows.map((row) => row.id)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4"]);
		expect(state).toMatchObject({ above: 0, below: 2, focus: null });
	});

	it("takes no space when there is nothing to show", () => {
		expect(buildHudState([rec("ag-1", "completed", { endedAt: 0 })], { now: NOW })).toEqual({ rows: [], above: 0, below: 0, focus: null, tokens: 0, cost: 0 });
	});

	it("reports when the next finished row expires", () => {
		const records = [rec("ag-1", "completed", { endedAt: NOW - 1000 }), rec("ag-2", "failed", { endedAt: NOW - 30_000 }), rec("ag-3", "running")];
		expect(nextExpiry(records, NOW)).toBe(NOW - 30_000 + RETENTION_MS);
		expect(nextExpiry([rec("ag-3", "running")], NOW)).toBeUndefined();
	});
});

describe("rows", () => {
	it("carries the turn while running, a short reason on failure, and the model only when it differs", () => {
		expect(toRow(rec("ag-1", "running"), "deepseek/deepseek-pro")).toEqual({
			id: "ag-1",
			type: "explore",
			description: "task ag-1",
			status: "running",
			startedAt: 100,
			turn: 4,
		});
		expect(toRow(rec("ag-2", "running", { model: "deepseek/deepseek-flash" }), "deepseek/deepseek-pro").model).toBe("deepseek-flash");
		const failed = toRow(rec("ag-3", "failed", { reason: "provider error: 529 overloaded, retry later please" }), undefined);
		expect(failed.detail).toBe("provider error: 529 overloade…");
		expect(failed.endedAt).toBe(NOW - 1000);
		expect(toRow(rec("ag-4", "max_turns"), undefined).detail).toBe("out of turns");
		expect(toRow(rec("ag-5", "queued"), undefined)).not.toHaveProperty("startedAt");
		expect(shortModel("(default)", undefined)).toBeUndefined();
		expect(shortModel("openrouter/a/b", "x/y")).toBe("a/b");
	});

	it("says stopping instead of the turn once a stop was requested", () => {
		const row = toRow(rec("ag-1", "running", { stoppedBy: "user" }), undefined);
		expect(row.detail).toBe("stopping");
		expect(row).not.toHaveProperty("turn");
		// Once the run returned, the row is a plain stopped one.
		expect(toRow(rec("ag-1", "aborted", { stoppedBy: "user", endedAt: NOW }), undefined)).not.toHaveProperty("detail");
	});

	it("sums tokens without cacheRead, and cost, over all agents", () => {
		const usage = { input: 1000, output: 500, cacheRead: 99_999, cacheWrite: 200, cost: 0.01 };
		const state = buildHudState([rec("ag-1", "running", { totalUsage: usage }), rec("ag-2", "completed", { totalUsage: usage, endedAt: 0 })], { now: NOW });
		expect(state.tokens).toBe(3400);
		expect(state.cost).toBeCloseTo(0.02);
	});
});

describe("focus mode", () => {
	const many = Array.from({ length: 12 }, (_, i) =>
		rec(`ag-${i + 1}`, i < 2 ? "running" : "completed", { startedAt: i, endedAt: i < 2 ? undefined : NOW - (i + 1) * 100_000 }),
	);

	it("lists every agent: active first, then by end time, newest first", () => {
		expect(focusOrder(many).map((r) => r.agentId)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6", "ag-7", "ag-8", "ag-9", "ag-10", "ag-11", "ag-12"]);
	});

	it("shows an 8-row window around the selection with hidden counts at both ends", () => {
		const top = buildHudState(many, { now: NOW, focusId: "ag-1" });
		expect(top.rows.map((row) => row.id)).toEqual(["ag-1", "ag-2", "ag-3", "ag-4", "ag-5", "ag-6", "ag-7", "ag-8"]);
		expect(top).toMatchObject({ above: 0, below: 4, focus: { selectedId: "ag-1" } });

		const middle = buildHudState(many, { now: NOW, focusId: "ag-7" });
		expect(middle.rows[0]?.id).toBe("ag-3");
		expect(middle).toMatchObject({ above: 2, below: 2 });

		const bottom = buildHudState(many, { now: NOW, focusId: "ag-12" });
		expect(bottom.rows.at(-1)?.id).toBe("ag-12");
		expect(bottom).toMatchObject({ above: 4, below: 0 });
	});

	it("keeps the selected agent after the list reorders", () => {
		const before = [rec("ag-1", "running", { startedAt: 1 }), rec("ag-2", "running", { startedAt: 2 }), rec("ag-3", "running", { startedAt: 3 })];
		expect(buildHudState(before, { now: NOW, focusId: "ag-2" }).focus).toEqual({ selectedId: "ag-2" });
		expect(buildHudState(before, { now: NOW, focusId: "ag-2", focusArmed: true }).focus).toEqual({ selectedId: "ag-2", armed: true });
		// ag-1 finishes and moves below the active ones; the selection still names ag-2.
		const after = [rec("ag-1", "completed", { endedAt: NOW }), before[1]!, before[2]!];
		const state = buildHudState(after, { now: NOW, focusId: "ag-2" });
		expect(state.rows.map((row) => row.id)).toEqual(["ag-2", "ag-3", "ag-1"]);
		expect(state.focus).toEqual({ selectedId: "ag-2" });
	});

	it("windowAround clamps at both ends", () => {
		expect(windowAround(5, 4)).toEqual({ start: 0, end: 5 });
		expect(windowAround(20, 0)).toEqual({ start: 0, end: 8 });
		expect(windowAround(20, 10)).toEqual({ start: 6, end: 14 });
		expect(windowAround(20, 19)).toEqual({ start: 12, end: 20 });
	});
});
