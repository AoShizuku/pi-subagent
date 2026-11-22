import { describe, expect, it } from "vitest";

import { type AgentEntry, AgentManager, APPENDED_INSTRUCTION, toEntry } from "./manager.js";
import { emptyUsage } from "./observer.js";
import { PARENT_INTERRUPTED, SESSION_ENDED, STOPPED_BY_PARENT, STOPPED_BY_USER } from "./run.js";
import { blockUntilAborted, FakeFactory, flush, testSpec } from "./test-helpers.js";

function setup(maxConcurrent = 4, factory = new FakeFactory(() => blockUntilAborted)) {
	const manager = new AgentManager({ factory, maxConcurrent: () => maxConcurrent });
	const start = (signal?: AbortSignal, onQueued?: (position: number) => void) => {
		const record = manager.create({ type: "general", description: "d", prompt: "p", model: "faux/faux-1" });
		const done = manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p", signal, onQueued });
		return { record, done };
	};
	return { manager, factory, start };
}

describe("AgentManager", () => {
	it("numbers agents ag-1, ag-2… from firstId", () => {
		const manager = new AgentManager({ factory: new FakeFactory(), maxConcurrent: () => 4, firstId: 7 });
		expect(manager.create({ type: "t", description: "d", prompt: "p", model: "m" }).agentId).toBe("ag-7");
		expect(manager.create({ type: "t", description: "d", prompt: "p", model: "m" }).agentId).toBe("ag-8");
	});

	it("runs at most maxConcurrent at once and queues the rest in FIFO order", async () => {
		const { manager, factory, start } = setup(4);
		const positions: number[][] = [[], []];
		const runs = Array.from({ length: 6 }, (_, i) => start(undefined, i >= 4 ? (p) => positions[i - 4]?.push(p) : undefined));
		await flush();
		expect(manager.runningCount).toBe(4);
		expect(manager.queuedCount).toBe(2);
		expect(runs.map((r) => r.record.status)).toEqual(["running", "running", "running", "running", "queued", "queued"]);
		expect(manager.position(runs[5]!.record.agentId)).toBe(2);

		await factory.sessions[0]!.abort();
		await runs[0]!.done;
		await flush();
		expect(runs[4]!.record.status).toBe("running");
		expect(positions[1]).toEqual([2, 1]);
		await manager.shutdown(100);
	});

	it("removes a queued agent when its signal aborts, without creating a session", async () => {
		const { manager, factory, start } = setup(1);
		const first = start();
		const controller = new AbortController();
		const second = start(controller.signal);
		const third = start();
		await flush();
		controller.abort();
		await second.done;
		expect(second.record).toMatchObject({ status: "aborted", reason: PARENT_INTERRUPTED });
		expect(manager.position(third.record.agentId)).toBe(1);
		expect(factory.specs.map((spec) => spec.agentId)).toEqual([first.record.agentId]);
		await manager.shutdown(100);
	});

	it("finish is effective once; a later finish only backfills missing text", () => {
		const { manager } = setup();
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		expect(manager.finish(record.agentId, { status: "aborted", reason: "stopped by parent", text: "", notes: [] })).toBe(true);
		expect(manager.finish(record.agentId, { status: "completed", text: "late report", notes: ["n"] })).toBe(false);
		expect(record).toMatchObject({ status: "aborted", reason: "stopped by parent", text: "late report", notes: [] });
	});

	it("records stats, model and session file from a completed run and disposes the session", async () => {
		const factory = new FakeFactory(() => async (s) => {
			await s.turn({ text: "x", tools: [{ name: "read" }, { name: "ls" }], usage: { input: 3, output: 4 } });
			await s.turn({ text: "final", usage: { input: 5, output: 6 } });
		});
		const { start } = setup(4, factory);
		const { record, done } = start();
		await done;
		expect(record).toMatchObject({ status: "completed", text: "final", model: "faux/faux-1", stats: { turns: 2, toolCalls: 2, usage: { input: 8, output: 10 } } });
		expect(record.startedAt).toBeDefined();
		expect(record.endedAt).toBeDefined();
		expect(factory.sessions[0]?.disposed).toBe(true);
	});

	it("keeps the child's last context fill on the record and in the persisted entry", async () => {
		const factory = new FakeFactory(() => async (s) => {
			await s.turn({ text: "x", tools: [{ name: "read" }] });
			s.context = { tokens: 30_000, contextWindow: 100_000 };
			await s.turn({ text: "final" });
		});
		const { start } = setup(4, factory);
		const { record, done } = start();
		await done;
		expect(record.context).toEqual({ tokens: 30_000, window: 100_000 });
		expect(toEntry(record).context).toEqual({ tokens: 30_000, window: 100_000 });
	});

	it("marks and persists an agent whose context reached the limit, and refuses to reopen it", async () => {
		const persisted: AgentEntry[] = [];
		const factory = new FakeFactory(() => async (s) => {
			s.context = { tokens: 75_000, contextWindow: 100_000 };
			await s.turn({ text: "x", tools: [{ name: "read" }] });
			await s.turn({ text: "final" });
		});
		const manager = new AgentManager({ factory, maxConcurrent: () => 4, persist: (record) => persisted.push(toEntry(record)) });
		const record = manager.create({ type: "general", description: "d", prompt: "p", model: "faux/faux-1" });
		await manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		expect(record).toMatchObject({ status: "completed", text: "final", contextLimited: true });
		// Persisted while running, so a crash mid-run restores it as not continuable too.
		expect(persisted.find((entry) => entry.status === "running" && entry.contextLimited)).toBeDefined();
		expect(factory.sessions[0]?.steered.map((message) => message.customType)).toEqual(["subagent-context-budget"]);
		expect(() => manager.reopen(record.agentId, { prompt: "more", model: "faux/faux-1", background: false })).toThrow(
			"reached its context limit",
		);
	});

	it("fails the agent when the session cannot be created and frees the slot", async () => {
		const factory = new FakeFactory();
		factory.failWith = new Error("No models available");
		const { manager, start } = setup(1, factory);
		const { record, done } = start();
		await done;
		expect(record).toMatchObject({ status: "failed", reason: "No models available" });
		expect(manager.runningCount).toBe(0);
	});

	it("shutdown clears the queue, aborts running agents and does not wait for a hung abort", async () => {
		const { manager, factory, start } = setup(1);
		const running = start();
		const queued = start();
		await flush();
		factory.sessions[0]!.hangOnAbort = true;
		const startedAt = Date.now();
		await manager.shutdown(200);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(running.record).toMatchObject({ status: "aborted", reason: SESSION_ENDED });
		expect(factory.sessions[0]?.disposed).toBe(true);
		await queued.done;
		expect(queued.record).toMatchObject({ status: "aborted", reason: SESSION_ENDED });
		expect(factory.specs).toHaveLength(1);
	});

	it("persists every status transition and calls onFinished before the terminal snapshot", async () => {
		const log: string[] = [];
		const manager = new AgentManager({
			factory: new FakeFactory(),
			maxConcurrent: () => 4,
			persist: (record) => log.push(`persist ${record.status}${record.resultFile ? ` ${record.resultFile}` : ""}`),
			onFinished: (record) => {
				log.push(`finished ${record.status}`);
				record.resultFile = "r.md";
			},
		});
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		await manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		expect(log).toEqual(["persist queued", "persist running", "finished completed", "persist completed r.md"]);
	});

	it("persists the session file while running, so a parent crash still restores a continuable record", async () => {
		const entries: AgentEntry[] = [];
		const factory = new FakeFactory(() => blockUntilAborted);
		const manager = new AgentManager({ factory, maxConcurrent: () => 4, persist: (record) => entries.push(toEntry(record)) });
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		const done = manager.execute(record, { spec: testSpec({ agentId: record.agentId, sessionDir: "/s" }), task: "p" });
		await flush();
		// The parent process dies here: only what was persisted so far survives.
		const transcript = `/s/child-${record.agentId}.jsonl`;
		expect(entries.at(-1)).toMatchObject({ status: "running", sessionFile: transcript });
		const restored = new AgentManager({ factory: new FakeFactory(), maxConcurrent: () => 4 });
		restored.restore(entries);
		expect(restored.get(record.agentId)).toMatchObject({ status: "aborted", reason: SESSION_ENDED, sessionFile: transcript });
		await factory.sessions[0]!.abort();
		await done;
	});

	it("restore keeps the last entry per id, closes active ones and continues ids", () => {
		const manager = new AgentManager({ factory: new FakeFactory(), maxConcurrent: () => 4, firstId: 3, now: () => 99 });
		const base = { type: "t", description: "d", prompt: "p", model: "m", createdAt: 1, background: true, runs: 1, notes: [], stats: { turns: 0, toolCalls: 0, usage: emptyUsage() }, totalUsage: emptyUsage() };
		const closed = manager.restore([
			{ ...base, agentId: "ag-1", status: "running" },
			{ ...base, agentId: "ag-1", status: "completed", endedAt: 5 },
			{ ...base, agentId: "ag-2", status: "queued" },
			{ ...base, agentId: "ag-9", status: "running" },
		]);
		expect(closed.map((r) => [r.agentId, r.status, r.reason, r.endedAt])).toEqual([
			["ag-2", "aborted", SESSION_ENDED, 99],
			["ag-9", "aborted", SESSION_ENDED, 99],
		]);
		expect(manager.get("ag-1")).toMatchObject({ status: "completed", notified: true });
		expect(manager.create({ type: "t", description: "d", prompt: "p", model: "m" }).agentId).toBe("ag-10");
		// Restoring fewer ids than the result files suggested keeps the higher number.
		const other = new AgentManager({ factory: new FakeFactory(), maxConcurrent: () => 4, firstId: 12 });
		other.restore([{ ...base, agentId: "ag-4", status: "completed" }]);
		expect(other.create({ type: "t", description: "d", prompt: "p", model: "m" }).agentId).toBe("ag-12");
	});

	it("stop by the parent removes a queued agent; by the user aborts a running one", async () => {
		const { manager, factory, start } = setup(1);
		const running = start();
		const queued = start();
		await flush();
		await manager.stop(queued.record.agentId, "parent");
		expect(queued.record).toMatchObject({ status: "aborted", reason: STOPPED_BY_PARENT, stoppedBy: "parent" });
		await queued.done;
		expect(factory.specs).toHaveLength(1);

		const stopped = await manager.stop(running.record.agentId, "user");
		expect(stopped).toMatchObject({ status: "aborted", reason: STOPPED_BY_USER, stoppedBy: "user" });
		expect(factory.sessions[0]?.aborts).toBeGreaterThan(0);
		// Stopping a finished agent changes nothing.
		expect(await manager.stop(running.record.agentId, "parent")).toMatchObject({ reason: STOPPED_BY_USER });
	});

	it("stop finishes the record after waitMs even when the run hangs", async () => {
		const hang = new FakeFactory(() => async () => {
			await new Promise(() => {});
		});
		const manager = new AgentManager({ factory: hang, maxConcurrent: () => 4 });
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		void manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		await flush();
		const startedAt = Date.now();
		await manager.stop(record.agentId, "user", 100);
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(record).toMatchObject({ status: "aborted", reason: STOPPED_BY_USER });
	});

	it("a stop that lands while the session is being built aborts the run once it exists", async () => {
		let release: () => void = () => {};
		const factory = new FakeFactory(() => blockUntilAborted);
		const slow = {
			specs: factory.specs,
			create: async (spec: Parameters<FakeFactory["create"]>[0]) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return factory.create(spec);
			},
		};
		const manager = new AgentManager({ factory: slow, maxConcurrent: () => 4 });
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		const done = manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		await flush();
		const stopping = manager.stop(record.agentId, "parent", 2000);
		release();
		await stopping;
		await done;
		expect(record).toMatchObject({ status: "aborted", reason: STOPPED_BY_PARENT });
		expect(factory.sessions[0]?.isAbortRequested).toBe(true);
	});

	it("send steers a running agent, appends to a queued one and reports a finished one", async () => {
		const { manager, factory, start } = setup(1);
		const running = start();
		const queued = start();
		await flush();
		expect(await manager.send(running.record.agentId, "more")).toEqual({ kind: "steered" });
		expect(factory.sessions[0]?.userSteers).toEqual(["more"]);
		expect(await manager.send(queued.record.agentId, "first")).toEqual({ kind: "appended" });
		expect(await manager.send(queued.record.agentId, "second")).toEqual({ kind: "appended" });
		await manager.stop(running.record.agentId, "parent");
		await flush();
		expect(factory.sessions[1]?.prompts).toEqual([`p${APPENDED_INSTRUCTION}first${APPENDED_INSTRUCTION}second`]);
		expect(await manager.send(running.record.agentId, "late")).toEqual({ kind: "finished" });
		await manager.shutdown(100);
	});

	it("reopen runs a finished agent again on its transcript and keeps total usage", async () => {
		const factory = new FakeFactory(() => async (s, task) => s.turn({ text: `re: ${task}`, usage: { input: 10, output: 5, cost: 0.5 } }));
		const manager = new AgentManager({ factory, maxConcurrent: () => 4 });
		const record = manager.create({ type: "t", description: "d", prompt: "first", model: "m" });
		await manager.execute(record, { spec: testSpec({ agentId: record.agentId, sessionDir: "/s" }), task: "first" });
		expect(() => manager.reopen("ag-9", { prompt: "x", model: "m", background: false })).toThrow(/unknown agent/);

		manager.reopen(record.agentId, { prompt: "second", model: "m2", background: true, maxTurns: 5 });
		expect(record).toMatchObject({ status: "queued", runs: 2, prompt: "second", model: "m2", background: true, notified: false, text: undefined, stats: { turns: 0 } });
		expect(() => manager.reopen(record.agentId, { prompt: "x", model: "m", background: false })).toThrow(/still queued/);
		await manager.execute(record, { spec: testSpec({ agentId: record.agentId, resumeFile: record.sessionFile }), task: "second" });
		expect(factory.specs[1]?.resumeFile).toBe("/s/child-ag-1.jsonl");
		expect(record).toMatchObject({ status: "completed", text: "re: second", stats: { turns: 1, usage: { input: 10 } }, totalUsage: { input: 20, output: 10, cost: 1 } });
	});

	it("keeps live stats, total usage and the activity list while running, and tells subscribers", async () => {
		let release: () => void = () => {};
		const factory = new FakeFactory(() => async (s) => {
			await s.turn({ text: "looking", tools: [{ name: "read", args: { path: "a.ts" } }], usage: { input: 7, output: 3 } });
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			await s.turn({ text: "done" });
		});
		const manager = new AgentManager({ factory, maxConcurrent: () => 4 });
		const seen: string[] = [];
		manager.subscribe((record) => seen.push(record.status));
		const record = manager.create({ type: "t", description: "d", prompt: "p", model: "m" });
		const done = manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		await flush();
		expect(record.stats).toMatchObject({ turns: 1, toolCalls: 1 });
		expect(record.totalUsage).toMatchObject({ input: 7, output: 3 });
		expect(record.activity).toEqual([expect.objectContaining({ name: "read", line: "Read (a.ts)", isError: false })]);
		expect(manager.progress(record.agentId)?.turns).toBe(1);
		release();
		await done;
		expect(manager.progress(record.agentId)).toBeUndefined();
		expect(seen).toContain("running");
		expect(seen.at(-1)).toBe("completed");
	});

	it("applies a raised maxConcurrent on pump()", async () => {
		let limit = 1;
		const factory = new FakeFactory(() => blockUntilAborted);
		const manager = new AgentManager({ factory, maxConcurrent: () => limit });
		const records = [0, 1, 2].map(() => manager.create({ type: "t", description: "d", prompt: "p", model: "m" }));
		for (const record of records) void manager.execute(record, { spec: testSpec({ agentId: record.agentId }), task: "p" });
		await flush();
		expect(manager.runningCount).toBe(1);
		limit = 3;
		manager.pump();
		await flush();
		expect(manager.runningCount).toBe(3);
		await manager.shutdown(100);
	});
});
