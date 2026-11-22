// Child session events -> progress and statistics; drives the turn and context budgets (docs/06 §2, docs/02 §9).

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { toolLine } from "./tool-line.js";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ActiveTool {
	toolCallId: string;
	name: string;
	/** One-line summary, e.g. `Read (src/a.ts:1-40)`. */
	line: string;
	startedAt: number;
}

/** One child tool call, for the detail overlay's Activity block (docs/06 §2, docs/07 §6). */
export interface ToolCallEntry {
	toolCallId: string;
	name: string;
	line: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

/** How full the child's context window is: pi's own estimate (AgentSession.getContextUsage). */
export interface ContextFill {
	tokens: number;
	window: number;
}

/** What ChildSession.contextUsage returns: pi's ContextUsage, tokens null while unknown (after a compaction). */
export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
}

export const ACTIVITY_LIMIT = 200;

export interface ProgressSnapshot {
	turns: number;
	toolCalls: number;
	activeTools: ActiveTool[];
	/** Last characters the model wrote in the current assistant message. */
	recentText: string;
	usage: UsageTotals;
	/** Latest known context fill; undefined until the session reports one. */
	context?: ContextFill;
	/** The context fill has reached the context limit; such an agent cannot be continued (docs/06 §6). */
	contextLimited: boolean;
	lastEventAt: number;
}

export interface ObserverOptions {
	maxTurns: number;
	/** Called once, after the turn that leaves 2 turns (docs/02 §9). */
	onBudgetReminder?: (turnsLeft: number) => void;
	/** Called once, when the budget is used up and the model still wants another turn. */
	onTurnLimit?: () => void;
	/** Percent of the context window that starts the wrap-up; undefined: no context budget (docs/02 §9). */
	contextLimit?: number;
	/** Called once, after the first tool-use turn that ends with the context at or above the limit. */
	onContextReminder?: (percent: number) => void;
	/** Called once, when the model still calls tools CONTEXT_GRACE_TURNS turns after the reminder. */
	onContextLimit?: () => void;
	onChange?: () => void;
	/** Reads the session's context fill; called on every event but streamed deltas. */
	contextUsage?: () => ContextUsageLike | undefined;
	cwd?: string;
	now?: () => number;
}

const RECENT_TEXT_MAX = 200;
export const REMINDER_TURNS_LEFT = 2;
/** Turns the model gets after the context reminder; the last of them must not end in tool calls. */
export const CONTEXT_GRACE_TURNS = 3;

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Whole percent of the window in use, for display (the limit check compares the exact ratio). */
export function contextPercent(fill: ContextFill): number {
	return Math.max(0, Math.min(100, Math.round((fill.tokens / fill.window) * 100)));
}

/** Token figure shown in the UI: input + output + cacheWrite, not cacheRead (docs/07 §3.5). */
export function displayTokens(usage: UsageTotals): number {
	return usage.input + usage.output + usage.cacheWrite;
}

function isEmptyStub(message: MessageLike): boolean {
	if (message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted")) return false;
	return !(message.content ?? []).some((part) => part.type === "toolCall" || (part.type === "text" && Boolean(part.text?.trim())));
}

interface MessageLike {
	role?: string;
	stopReason?: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
}

export class ChildObserver {
	turns = 0;
	toolCalls = 0;
	readonly usage: UsageTotals = emptyUsage();
	private readonly active = new Map<string, ActiveTool>();
	/** Last ACTIVITY_LIMIT tool calls, oldest first. */
	readonly activity: ToolCallEntry[] = [];
	/** Latest known context fill; kept through events where pi cannot tell (tokens null). */
	context: ContextFill | undefined;
	/** The fill has reached options.contextLimit at some point of this run. */
	contextLimited = false;
	private recentText = "";
	private lastEventAt: number;
	private reminded = false;
	private limitHit = false;
	/** Turn count at which a tool-use turn ends the run; set by the context reminder. */
	private contextDeadline: number | undefined;
	private contextLimitHit = false;
	private readonly now: () => number;

	constructor(private readonly options: ObserverOptions) {
		this.now = options.now ?? Date.now;
		this.lastEventAt = this.now();
	}

	readonly onEvent = (event: AgentSessionEvent): void => {
		this.lastEventAt = this.now();
		// Not per streamed delta: getContextUsage builds the session projection. pi persists a message only
		// after its message_end reaches listeners, so that event reads one message behind; the turn_end or
		// tool event right after it catches up.
		if (event.type !== "message_update") this.refreshContext();
		switch (event.type) {
			case "turn_end":
				// A failed or aborted run ends with an empty stub message and its own turn_end
				// (agent.ts handleRunFailure); that is not a turn the model took.
				if (isEmptyStub(event.message as MessageLike)) break;
				this.turns += 1;
				this.checkBudget(event.message as MessageLike);
				break;
			case "tool_execution_start": {
				this.toolCalls += 1;
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					name: event.toolName,
					line: toolLine(event.toolName, event.args, this.options.cwd),
					startedAt: this.lastEventAt,
				};
				this.active.set(event.toolCallId, tool);
				this.activity.push({ ...tool });
				if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
				break;
			}
			case "tool_execution_end": {
				this.active.delete(event.toolCallId);
				for (let i = this.activity.length - 1; i >= 0; i--) {
					const entry = this.activity[i];
					if (entry?.toolCallId !== event.toolCallId || entry.endedAt !== undefined) continue;
					entry.endedAt = this.lastEventAt;
					entry.isError = event.isError;
					break;
				}
				break;
			}
			case "message_start":
				if ((event.message as MessageLike).role === "assistant") this.recentText = "";
				break;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") this.recentText = (this.recentText + update.delta).slice(-RECENT_TEXT_MAX);
				break;
			}
			case "message_end":
				this.addUsage(event.message as MessageLike);
				break;
			default:
				return;
		}
		this.options.onChange?.();
	};

	snapshot(): ProgressSnapshot {
		return {
			turns: this.turns,
			toolCalls: this.toolCalls,
			activeTools: [...this.active.values()],
			recentText: this.recentText,
			usage: { ...this.usage },
			...(this.context ? { context: { ...this.context } } : {}),
			contextLimited: this.contextLimited,
			lastEventAt: this.lastEventAt,
		};
	}

	private refreshContext(): void {
		let usage: ContextUsageLike | undefined;
		try {
			usage = this.options.contextUsage?.();
		} catch {
			return;
		}
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;
		this.context = { tokens: usage.tokens, window: usage.contextWindow };
		const limit = this.options.contextLimit;
		if (limit !== undefined && usage.tokens * 100 >= limit * usage.contextWindow) this.contextLimited = true;
	}

	private addUsage(message: MessageLike): void {
		if (message.role !== "assistant" || !message.usage) return;
		const usage = message.usage;
		this.usage.input += usage.input ?? 0;
		this.usage.output += usage.output ?? 0;
		this.usage.cacheRead += usage.cacheRead ?? 0;
		this.usage.cacheWrite += usage.cacheWrite ?? 0;
		this.usage.cost += usage.cost?.total ?? 0;
	}

	/**
	 * Act only after a turn that ends in tool calls: then the loop is about to start another turn anyway.
	 * A steering message after a final turn would make pi start an extra turn (agent-loop.ts:304-306),
	 * and aborting after a final turn would mislabel a finished run.
	 */
	private checkBudget(message: MessageLike): void {
		if (message.role !== "assistant" || message.stopReason !== "toolUse") return;
		this.checkContextBudget();
		this.checkTurnBudget();
	}

	/**
	 * Only a steering reminder and, if the model ignores it, an abort: both leave the transcript's prefix as it
	 * is. Removing tools instead would change the declared tool set and invalidate the prompt cache.
	 */
	private checkContextBudget(): void {
		if (this.contextDeadline !== undefined) {
			if (this.turns >= this.contextDeadline && !this.contextLimitHit) {
				this.contextLimitHit = true;
				this.options.onContextLimit?.();
			}
			return;
		}
		if (!this.contextLimited || !this.context) return;
		this.contextDeadline = this.turns + CONTEXT_GRACE_TURNS;
		this.options.onContextReminder?.(contextPercent(this.context));
	}

	private checkTurnBudget(): void {
		const left = this.options.maxTurns - this.turns;
		if (left <= 0) {
			if (!this.limitHit) {
				this.limitHit = true;
				this.options.onTurnLimit?.();
			}
			return;
		}
		if (left <= REMINDER_TURNS_LEFT && !this.reminded) {
			this.reminded = true;
			this.options.onBudgetReminder?.(left);
		}
	}
}
