// Coalesces finished items into as few model wake-ups as possible (docs/06 §5.3).
// Generic copy of pi-background-shell src/batcher.ts; change both together (docs/08 §2).
//
// Idle agent: the first finished item opens a fixed window (not a sliding debounce).
// Items finishing inside it join the same message. If nothing else is running there is
// nothing to wait for, so the batch goes out immediately.
//
// Busy agent: pi's steer queue hands the model one message per turn
// (steeringMode "one-at-a-time"), so N separate notifications would cost N turns.
// Finished items are held here and drained in one piece at the next turn boundary.

export interface BatcherDeps<T> {
	isIdle(): boolean;
	hasRunning(): boolean;
	/** Deliver a batch while the agent is idle (starts a turn). */
	deliverIdle(batch: T[]): void;
	windowMs: number;
}

export const DEFAULT_WINDOW_MS = 3000;

/** Holds finished items until they can be delivered as a single notification. */
export class NotificationBatcher<T> {
	private readonly deps: BatcherDeps<T>;
	private pending: T[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(deps: BatcherDeps<T>) {
		this.deps = deps;
	}

	/** Number of items waiting for delivery. */
	get size(): number {
		return this.pending.length;
	}

	/** Queue a finished item and deliver now, later, or at the next turn boundary. */
	enqueue(item: T): void {
		this.pending.push(item);
		if (!this.deps.isIdle()) return;
		if (!this.deps.hasRunning()) {
			this.flushIdle();
			return;
		}
		this.timer ??= setTimeout(() => this.onWindowEnd(), this.deps.windowMs);
	}

	/** Remove and return everything pending; used at turn boundaries while the agent is busy. */
	take(): T[] {
		this.clearTimer();
		const batch = this.pending;
		this.pending = [];
		return batch;
	}

	/** Deliver everything pending through the idle path right away. */
	flushIdle(): void {
		const batch = this.take();
		if (batch.length > 0) this.deps.deliverIdle(batch);
	}

	/** Drop pending items and timers without delivering. */
	dispose(): void {
		this.take();
	}

	private onWindowEnd(): void {
		this.timer = undefined;
		// A busy agent picks the batch up at its next turn boundary instead.
		if (this.deps.isIdle()) this.flushIdle();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
