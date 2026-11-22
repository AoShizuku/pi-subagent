// Agent records, the shared FIFO queue, the single terminal writer, follow-ups, stops, persistence and restore
// (docs/06 §1, §3, §4, §6-§9).

import { type ContextFill, emptyUsage, type ProgressSnapshot, type ToolCallEntry, type UsageTotals } from "./observer.js";
import {
	type AgentStatus,
	ChildRun,
	type ChildSession,
	type ChildSessionFactory,
	type ChildSpec,
	errorMessage,
	PARENT_INTERRUPTED,
	type RunOutcome,
	SESSION_ENDED,
	STOPPED_BY_PARENT,
	STOPPED_BY_USER,
	type TerminalStatus,
} from "./run.js";

export type StoppedBy = "parent" | "user";

export interface AgentRecord {
	agentId: string;
	type: string;
	description: string;
	/** The task of the latest run (the original prompt, or the agent_send message of a continuation). */
	prompt: string;
	status: AgentStatus;
	/** Why a run did not complete: provider error text, parent interrupted, session ended... */
	reason?: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	/** provider/id actually used. */
	model: string;
	/** Whether the latest run is a background run (notified on completion). */
	background: boolean;
	/** 1 for the first run; agent_send to a finished agent adds one. */
	runs: number;
	maxTurns?: number;
	sessionFile?: string;
	resultFile?: string;
	/** Final report text of the latest run. Memory only: the result file is the durable copy. */
	text?: string;
	notes: string[];
	/** Statistics of the latest run; live while it runs. */
	stats: { turns: number; toolCalls: number; usage: UsageTotals };
	/** All runs together (docs/07 §3.5). */
	totalUsage: UsageTotals;
	/** Latest known fill of the child's context window; it carries over into a continuation. */
	context?: ContextFill;
	/** The context reached the type's context limit: agent_send cannot continue this agent (docs/06 §6). */
	contextLimited?: boolean;
	/** Set when an explicit stop ended the run; decides whether the model is notified (docs/06 §5.2). */
	stoppedBy?: StoppedBy;
	/** The latest run's end has been handed to the model, or must never be. Memory only. */
	notified: boolean;
	/** Tool calls of the latest run, for the detail overlay. Memory only. */
	activity?: ToolCallEntry[];
}

/** What pi.appendEntry stores: everything but the memory-only fields. */
export type AgentEntry = Omit<AgentRecord, "notified" | "activity" | "text">;

export const ENTRY_TYPE = "subagent";

export interface CreateRecordInput {
	type: string;
	description: string;
	prompt: string;
	model: string;
	background?: boolean;
	maxTurns?: number;
}

export interface ManagerOptions {
	factory: ChildSessionFactory;
	/** Read on every dequeue, so a reloaded config applies to the next start. */
	maxConcurrent: () => number;
	/** Number for the first `ag-<n>` id. */
	firstId?: number;
	now?: () => number;
	/** Status transitions (queued, running, terminal): persist a snapshot. */
	persist?: (record: AgentRecord) => void;
	/** Called once per run when it reaches a terminal state, before that state is persisted. */
	onFinished?: (record: AgentRecord) => void;
}

export interface ExecuteOptions {
	spec: ChildSpec;
	task: string;
	signal?: AbortSignal;
	/** Called with the 1-based queue position while waiting (and again when it changes). */
	onQueued?: (position: number) => void;
	onStart?: () => void;
	onProgress?: (snapshot: ProgressSnapshot) => void;
}

export type SendResult = { kind: "steered" } | { kind: "appended" } | { kind: "finished" };

interface Waiter {
	agentId: string;
	resolve: (started: { ok: true } | { ok: false; reason: string }) => void;
	onQueued?: (position: number) => void;
}

interface RunHandle {
	run?: ChildRun;
	session?: ChildSession;
	/** The task has been handed to session.prompt(); later messages are steered. */
	prompted: boolean;
	/** A stop that landed before the run object existed. */
	stopRequest?: string;
}

const TERMINAL: readonly AgentStatus[] = ["completed", "failed", "aborted", "max_turns", "context_limit"];
export const SHUTDOWN_WAIT_MS = 5000;
export const STOP_WAIT_MS = 5000;
export const APPENDED_INSTRUCTION = "\n\nAdditional instruction from the parent:\n";

export function isTerminal(status: AgentStatus): status is TerminalStatus {
	return TERMINAL.includes(status);
}

export function isActive(status: AgentStatus): boolean {
	return status === "queued" || status === "running";
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

export class AgentManager {
	private readonly records = new Map<string, AgentRecord>();
	private readonly queue: Waiter[] = [];
	/** Agents holding a concurrency slot. */
	private readonly slots = new Set<string>();
	private readonly runs = new Map<string, RunHandle>();
	/** Task text not yet handed to a session; agent_send appends to it while queued. */
	private readonly tasks = new Map<string, string>();
	/** Settles when the agent's current execute() is over. */
	private readonly done = new Map<string, Promise<AgentRecord>>();
	/** Usage of earlier runs, so totalUsage stays live during a continuation. */
	private readonly usageBefore = new Map<string, UsageTotals>();
	private readonly listeners = new Set<(record: AgentRecord) => void>();
	/** `${agentId}#${run}` -> the record as that run ended; kept when agent_send reopens the agent. */
	private readonly outcomes = new Map<string, AgentRecord>();
	private nextId: number;
	private closed = false;
	private readonly now: () => number;

	constructor(private readonly options: ManagerOptions) {
		this.nextId = Math.max(1, options.firstId ?? 1);
		this.now = options.now ?? Date.now;
	}

	create(input: CreateRecordInput): AgentRecord {
		const record: AgentRecord = {
			agentId: `ag-${this.nextId++}`,
			type: input.type,
			description: input.description,
			prompt: input.prompt,
			model: input.model,
			background: input.background ?? false,
			maxTurns: input.maxTurns,
			status: "queued",
			createdAt: this.now(),
			runs: 1,
			notes: [],
			stats: { turns: 0, toolCalls: 0, usage: emptyUsage() },
			totalUsage: emptyUsage(),
			notified: false,
		};
		this.records.set(record.agentId, record);
		this.transition(record);
		return record;
	}

	get(agentId: string): AgentRecord | undefined {
		return this.records.get(agentId);
	}

	list(): AgentRecord[] {
		return [...this.records.values()];
	}

	get runningCount(): number {
		return this.slots.size;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	/** 1-based position in the queue, 0 when not queued. */
	position(agentId: string): number {
		return this.queue.findIndex((waiter) => waiter.agentId === agentId) + 1;
	}

	/** Called on every change, progress included (HUD, detail overlay). Returns an unsubscribe function. */
	subscribe(listener: (record: AgentRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Live progress of a running agent, undefined otherwise. */
	progress(agentId: string): ProgressSnapshot | undefined {
		return this.runs.get(agentId)?.run?.observer.snapshot();
	}

	/** How run `run` of an agent ended (a snapshot of its record then); undefined while it runs or when unknown. */
	runOutcome(agentId: string, run: number): AgentRecord | undefined {
		return this.outcomes.get(runKey(agentId, run));
	}

	/**
	 * Load records from persisted entries (the last entry per id wins). Agents that were still queued or running
	 * belonged to a pi process that is gone: they become aborted ("session ended"). Returns those, so the caller
	 * can persist the correction. Ids continue after the highest restored one. Every run's last entry also
	 * becomes that run's outcome, so a background card of an earlier run still finds how it ended.
	 */
	restore(entries: readonly AgentEntry[]): AgentRecord[] {
		const latest = new Map<string, AgentEntry>();
		const perRun = new Map<string, AgentEntry>();
		for (const entry of entries) {
			if (!entry || typeof entry.agentId !== "string") continue;
			latest.set(entry.agentId, entry);
			perRun.set(runKey(entry.agentId, entry.runs ?? 1), entry);
		}
		const closed: AgentRecord[] = [];
		for (const entry of latest.values()) {
			const record = this.fromEntry(entry);
			if (isActive(entry.status)) closed.push(record);
			this.records.set(record.agentId, record);
			const n = Number(/^ag-(\d+)$/.exec(record.agentId)?.[1]);
			if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
		}
		for (const [key, entry] of perRun) {
			const record = latest.get(entry.agentId) === entry ? this.records.get(entry.agentId) : this.fromEntry(entry);
			if (record && isTerminal(record.status)) this.outcomes.set(key, { ...record });
		}
		return closed;
	}

	/** A persisted entry as a record; one still queued or running is closed as "session ended". */
	private fromEntry(entry: AgentEntry): AgentRecord {
		const record: AgentRecord = {
			...entry,
			background: entry.background ?? false,
			runs: entry.runs ?? 1,
			notes: entry.notes ?? [],
			stats: entry.stats ?? { turns: 0, toolCalls: 0, usage: emptyUsage() },
			totalUsage: entry.totalUsage ?? emptyUsage(),
			// The old process either notified it or can no longer; never notify on restore.
			notified: true,
		};
		if (isActive(record.status)) {
			record.status = "aborted";
			record.reason = SESSION_ENDED;
			record.endedAt = this.now();
		}
		return record;
	}

	/**
	 * The only way into a terminal state. Effective once per run: a later call only backfills the report
	 * text when the first one had none (for example a stop that landed before the run returned).
	 */
	finish(agentId: string, outcome: RunOutcome, stats?: AgentRecord["stats"]): boolean {
		const record = this.records.get(agentId);
		if (!record) return false;
		if (isTerminal(record.status)) {
			if (!record.text && outcome.text) record.text = outcome.text;
			if (stats) this.setStats(record, stats);
			this.outcomes.set(runKey(agentId, record.runs), { ...record });
			return false;
		}
		record.status = outcome.status;
		record.reason = outcome.status === "completed" ? undefined : outcome.reason;
		record.text = outcome.text;
		record.notes = [...record.notes, ...outcome.notes];
		record.endedAt = this.now();
		if (stats) this.setStats(record, stats);
		// Before the snapshot is persisted, so the caller can attach the result file to it.
		this.options.onFinished?.(record);
		// Before listeners hear of it, so a card redrawn by the transition finds its run's outcome.
		this.outcomes.set(runKey(agentId, record.runs), { ...record });
		this.transition(record);
		return true;
	}

	/** Queue -> create session -> run -> finish -> dispose. Resolves with the record in its terminal state. */
	execute(record: AgentRecord, options: ExecuteOptions): Promise<AgentRecord> {
		const id = record.agentId;
		this.tasks.set(id, options.task);
		const promise = this.executeRun(record, options).finally(() => {
			if (this.done.get(id) === promise) this.done.delete(id);
			this.tasks.delete(id);
		});
		this.done.set(id, promise);
		return promise;
	}

	/**
	 * agent_send: a running agent gets the message as a steering user message; a queued one (or one whose
	 * session is still being built) gets it appended to its task. A finished agent must be reopened.
	 */
	async send(agentId: string, message: string): Promise<SendResult> {
		const record = this.records.get(agentId);
		if (!record || isTerminal(record.status)) return { kind: "finished" };
		const handle = this.runs.get(agentId);
		if (handle?.prompted && handle.session) {
			await handle.session.steerUser(message);
			return { kind: "steered" };
		}
		this.tasks.set(agentId, `${this.tasks.get(agentId) ?? record.prompt}${APPENDED_INSTRUCTION}${message}`);
		return { kind: "appended" };
	}

	/** Prepare a finished agent for another run on its transcript (docs/06 §6). Execute it afterwards. */
	reopen(agentId: string, input: { prompt: string; model: string; background: boolean; maxTurns?: number }): AgentRecord {
		const record = this.records.get(agentId);
		if (!record) throw new Error(`unknown agent ${agentId}`);
		if (!isTerminal(record.status)) throw new Error(`${agentId} is still ${record.status}`);
		if (record.contextLimited) throw new Error(`${agentId} reached its context limit and cannot be continued`);
		this.usageBefore.set(agentId, { ...record.totalUsage });
		Object.assign(record, {
			status: "queued",
			prompt: input.prompt,
			model: input.model,
			background: input.background,
			maxTurns: input.maxTurns,
			runs: record.runs + 1,
			reason: undefined,
			text: undefined,
			notes: [],
			startedAt: undefined,
			endedAt: undefined,
			stoppedBy: undefined,
			notified: false,
			activity: undefined,
			stats: { turns: 0, toolCalls: 0, usage: emptyUsage() },
		} satisfies Partial<AgentRecord>);
		this.transition(record);
		return record;
	}

	/**
	 * agent_stop (by "parent") or a user stop (by "user"). Queued: leaves the queue. Running: aborted, waiting at
	 * most `waitMs` for the run to return its partial report; after that the record is finished regardless.
	 * Already finished: returned as is.
	 */
	async stop(agentId: string, by: StoppedBy, waitMs = STOP_WAIT_MS): Promise<AgentRecord | undefined> {
		const record = this.records.get(agentId);
		if (!record || isTerminal(record.status)) return record;
		const reason = by === "parent" ? STOPPED_BY_PARENT : STOPPED_BY_USER;
		record.stoppedBy = by;

		const index = this.queue.findIndex((waiter) => waiter.agentId === agentId);
		if (index !== -1) {
			const [waiter] = this.queue.splice(index, 1);
			this.finish(agentId, { status: "aborted", reason, text: "", notes: [] });
			waiter?.resolve({ ok: false, reason });
			this.pump();
			return record;
		}

		const handle = this.runs.get(agentId);
		if (handle?.run) void handle.run.stop("aborted", reason).catch(() => {});
		else if (handle) handle.stopRequest = reason;
		const pending = this.done.get(agentId);
		if (pending) {
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				pending.then(
					() => {},
					() => {},
				),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, waitMs);
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		// A hung provider request must not leave the agent "running" forever.
		this.finish(agentId, { status: "aborted", reason, text: "", notes: [] });
		return record;
	}

	/** Start queued agents while slots are free; call after maxConcurrent changes. */
	pump(): void {
		while (!this.closed && this.queue.length > 0 && this.slots.size < this.options.maxConcurrent()) {
			const waiter = this.queue.shift();
			if (!waiter) break;
			this.slots.add(waiter.agentId);
			waiter.resolve({ ok: true });
		}
		this.queue.forEach((waiter, index) => waiter.onQueued?.(index + 1));
	}

	/**
	 * session_shutdown: drop the queue, mark running agents aborted, abort them and wait at most
	 * `waitMs` so a hung provider request cannot hold pi's exit, then dispose every session.
	 */
	async shutdown(waitMs = SHUTDOWN_WAIT_MS): Promise<void> {
		this.closed = true;
		for (const waiter of this.queue.splice(0)) waiter.resolve({ ok: false, reason: SESSION_ENDED });
		const aborts: Array<Promise<void>> = [];
		for (const [id, handle] of this.runs) {
			this.finish(id, { status: "aborted", reason: SESSION_ENDED, text: "", notes: [] });
			if (handle.run) aborts.push(handle.run.stop("aborted", SESSION_ENDED).catch(() => {}));
			else handle.stopRequest = SESSION_ENDED;
		}
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.all(aborts),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, waitMs);
			}),
		]);
		if (timer) clearTimeout(timer);
		for (const handle of this.runs.values()) disposeQuietly(handle.session);
		this.listeners.clear();
	}

	private async executeRun(record: AgentRecord, options: ExecuteOptions): Promise<AgentRecord> {
		const id = record.agentId;
		const slot = await this.acquire(id, options.signal, options.onQueued);
		if (!slot.ok) {
			this.finish(id, { status: "aborted", reason: slot.reason, text: "", notes: [] });
			return record;
		}

		const handle: RunHandle = { prompted: false };
		this.runs.set(id, handle);
		record.status = "running";
		record.startedAt = this.now();
		this.transition(record);
		options.onStart?.();
		try {
			handle.session = await this.options.factory.create(options.spec);
			record.sessionFile = handle.session.sessionFile;
			if (handle.session.model) record.model = handle.session.model;
			// The "running" entry was written before the session existed. Persist again so a parent that
			// crashes mid-run restores a record that still points at the transcript and can be continued.
			if (record.sessionFile) this.options.persist?.(record);
			const run = new ChildRun(handle.session, {
				maxTurns: options.spec.type.maxTurns,
				contextLimit: options.spec.type.contextLimit,
				cwd: options.spec.cwd,
				onProgress: (snapshot) => {
					this.setStats(record, { turns: snapshot.turns, toolCalls: snapshot.toolCalls, usage: snapshot.usage });
					if (snapshot.context) record.context = snapshot.context;
					if (snapshot.contextLimited && !record.contextLimited) {
						record.contextLimited = true;
						// Persist now: a parent that crashes mid-run must not restore it as continuable.
						this.options.persist?.(record);
					}
					options.onProgress?.(snapshot);
					this.changed(record);
				},
			});
			handle.run = run;
			record.activity = run.observer.activity;
			// Shutdown, a stop or the parent's abort may have landed while the session was being built.
			if (this.closed) void run.stop("aborted", SESSION_ENDED);
			else if (handle.stopRequest) void run.stop("aborted", handle.stopRequest);
			const task = this.tasks.get(id) ?? options.task;
			handle.prompted = true;
			const outcome = await run.run(task, options.signal);
			// agent_end and the final turn_end refresh it without an onProgress; take it before finish persists.
			if (run.observer.context) record.context = { ...run.observer.context };
			if (run.observer.contextLimited) record.contextLimited = true;
			this.finish(id, outcome, statsOf(run));
		} catch (error) {
			const aborted = this.closed || options.signal?.aborted || handle.stopRequest !== undefined;
			this.finish(id, {
				status: aborted ? "aborted" : "failed",
				reason: this.closed
					? SESSION_ENDED
					: options.signal?.aborted
						? PARENT_INTERRUPTED
						: (handle.stopRequest ?? errorMessage(error)),
				text: "",
				notes: [],
			});
		} finally {
			this.runs.delete(id);
			disposeQuietly(handle.session);
			this.release(id);
		}
		return record;
	}

	private setStats(record: AgentRecord, stats: AgentRecord["stats"]): void {
		record.stats = { turns: stats.turns, toolCalls: stats.toolCalls, usage: { ...stats.usage } };
		record.totalUsage = addUsage(this.usageBefore.get(record.agentId) ?? emptyUsage(), stats.usage);
	}

	private acquire(
		agentId: string,
		signal: AbortSignal | undefined,
		onQueued: ((position: number) => void) | undefined,
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (this.closed) return Promise.resolve({ ok: false, reason: SESSION_ENDED });
		if (signal?.aborted) return Promise.resolve({ ok: false, reason: PARENT_INTERRUPTED });
		const record = this.records.get(agentId);
		if (record && isTerminal(record.status)) return Promise.resolve({ ok: false, reason: record.reason ?? "aborted" });
		if (this.queue.length === 0 && this.slots.size < this.options.maxConcurrent()) {
			this.slots.add(agentId);
			return Promise.resolve({ ok: true });
		}
		return new Promise((resolve) => {
			const onAbort = (): void => {
				const index = this.queue.indexOf(waiter);
				if (index === -1) return;
				this.queue.splice(index, 1);
				resolve({ ok: false, reason: PARENT_INTERRUPTED });
				this.pump();
			};
			const waiter: Waiter = {
				agentId,
				onQueued,
				resolve: (result) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
			};
			this.queue.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			onQueued?.(this.queue.length);
		});
	}

	private release(agentId: string): void {
		if (this.slots.delete(agentId)) this.pump();
	}

	/** A status transition: persisted and announced. */
	private transition(record: AgentRecord): void {
		this.options.persist?.(record);
		this.changed(record);
	}

	private changed(record: AgentRecord): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(record);
			} catch {
				// A UI listener must not break a run.
			}
		}
	}
}

function runKey(agentId: string, run: number): string {
	return `${agentId}#${run}`;
}

/** The persisted form of a record. */
export function toEntry(record: AgentRecord): AgentEntry {
	const { notified: _notified, activity: _activity, text: _text, ...entry } = record;
	return {
		...entry,
		notes: [...entry.notes],
		stats: { ...entry.stats, usage: { ...entry.stats.usage } },
		totalUsage: { ...entry.totalUsage },
		...(entry.context ? { context: { ...entry.context } } : {}),
	};
}

function statsOf(run: ChildRun): AgentRecord["stats"] {
	return { turns: run.observer.turns, toolCalls: run.observer.toolCalls, usage: { ...run.observer.usage } };
}

function disposeQuietly(session: ChildSession | undefined): void {
	try {
		session?.dispose();
	} catch {
		// Disposal must not mask the run's outcome.
	}
}
