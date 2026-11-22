// Same cases as pi-background-shell src/batcher.test.ts, on the generic copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationBatcher } from "./batcher.js";

function setup(state: { idle: boolean; running: number }) {
	const delivered: string[][] = [];
	const batcher = new NotificationBatcher<string>({
		isIdle: () => state.idle,
		hasRunning: () => state.running > 0,
		deliverIdle: (batch) => delivered.push(batch),
		windowMs: 3000,
	});
	return { batcher, delivered };
}

describe("NotificationBatcher", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("delivers at once when the agent is idle and nothing else runs", () => {
		const { batcher, delivered } = setup({ idle: true, running: 0 });
		batcher.enqueue("ag-1");
		expect(delivered).toEqual([["ag-1"]]);
	});

	it("holds a fixed window while other agents run and merges what finishes inside it", () => {
		const state = { idle: true, running: 2 };
		const { batcher, delivered } = setup(state);
		batcher.enqueue("ag-1");
		vi.advanceTimersByTime(2000);
		state.running = 1;
		batcher.enqueue("ag-2");
		expect(delivered).toEqual([]);
		// Fixed window: the second item does not extend it.
		vi.advanceTimersByTime(1000);
		expect(delivered).toEqual([["ag-1", "ag-2"]]);
	});

	it("flushes early when the last running agent finishes inside the window", () => {
		const state = { idle: true, running: 1 };
		const { batcher, delivered } = setup(state);
		batcher.enqueue("ag-1");
		state.running = 0;
		batcher.enqueue("ag-2");
		expect(delivered).toEqual([["ag-1", "ag-2"]]);
		vi.advanceTimersByTime(5000);
		expect(delivered).toHaveLength(1);
	});

	it("never delivers while busy; the boundary takes everything in one batch", () => {
		const { batcher, delivered } = setup({ idle: false, running: 3 });
		batcher.enqueue("ag-1");
		batcher.enqueue("ag-2");
		vi.advanceTimersByTime(10_000);
		expect(delivered).toEqual([]);
		expect(batcher.take()).toEqual(["ag-1", "ag-2"]);
		expect(batcher.size).toBe(0);
	});

	it("leaves the batch for the boundary when the agent became busy during the window", () => {
		const state = { idle: true, running: 1 };
		const { batcher, delivered } = setup(state);
		batcher.enqueue("ag-1");
		state.idle = false;
		vi.advanceTimersByTime(3000);
		expect(delivered).toEqual([]);
		expect(batcher.size).toBe(1);
	});

	it("take() cancels a pending window; dispose() drops everything", () => {
		const { batcher, delivered } = setup({ idle: true, running: 1 });
		batcher.enqueue("ag-1");
		batcher.take();
		vi.advanceTimersByTime(3000);
		expect(delivered).toEqual([]);
		batcher.enqueue("ag-2");
		batcher.dispose();
		vi.advanceTimersByTime(3000);
		expect(delivered).toEqual([]);
		expect(batcher.size).toBe(0);
	});
});
