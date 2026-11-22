// One run of a child session: prompt -> judge the outcome -> extract the final report (docs/02 §7-§9).

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { ThinkingLevel } from "./config.js";
import type { ModelRef } from "./models.js";
import { CONTEXT_GRACE_TURNS, ChildObserver, type ContextUsageLike, type ProgressSnapshot } from "./observer.js";
import { CONTEXT_BUDGET_MESSAGE_TYPE, contextBudgetReminder, TURN_BUDGET_MESSAGE_TYPE, turnBudgetReminder } from "./prompts.js";
import type { AgentType } from "./types.js";

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "max_turns" | "context_limit";
export type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

export const PARENT_INTERRUPTED = "parent interrupted";
export const SESSION_ENDED = "session ended";
/** agent_stop: the model stopped it, so it is not notified (docs/06 §5.2). */
export const STOPPED_BY_PARENT = "stopped by parent";
/** HUD focus mode, the detail overlay or the /agents list: the model is notified. */
export const STOPPED_BY_USER = "stopped by the user";
export const NO_FINAL_REPORT = "(no final report)";

/** The narrow view of a pi AgentSession that runs depend on; tests substitute a fake. */
export interface ChildSession {
	readonly sessionFile: string | undefined;
	/** provider/id the session actually uses, when it has a model. */
	readonly model: string | undefined;
	readonly messages: readonly unknown[];
	/** AgentSession.getContextUsage: undefined when the model has no known context window. */
	contextUsage(): ContextUsageLike | undefined;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	/** Sends the task as the first user message, verbatim (no prompt-template expansion). */
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Context-only custom message delivered as steering (sendCustomMessage, deliverAs: "steer"). */
	steer(customType: string, content: string): void;
	/** A user message delivered after the current turn (AgentSession.steer): agent_send to a running agent. */
	steerUser(text: string): Promise<void>;
	dispose(): void;
}

export interface ChildSpec {
	agentId: string;
	description: string;
	/** Effective type: config overrides and the Windows shell swap already applied. */
	type: AgentType;
	cwd: string;
	model?: ModelRef;
	thinking?: ThinkingLevel;
	/** Directory for the child session file; undefined for an in-memory parent. */
	sessionDir?: string;
	parentSessionFile?: string;
	/** agent_send to a finished agent: reopen this transcript instead of creating a new one (docs/06 §6). */
	resumeFile?: string;
}

export interface ChildSessionFactory {
	create(spec: ChildSpec): Promise<ChildSession>;
}

export interface RunOutcome {
	status: TerminalStatus;
	reason?: string;
	/** Text of the final assistant message; empty when there is none. */
	text: string;
	notes: string[];
}

interface StopRequest {
	status: "aborted" | "max_turns" | "context_limit";
	reason: string;
}

export interface ChildRunOptions {
	maxTurns: number;
	/** Percent of the context window that starts the wrap-up (docs/02 §9); undefined: no context budget. */
	contextLimit?: number;
	cwd?: string;
	onProgress?: (snapshot: ProgressSnapshot) => void;
}

export class ChildRun {
	readonly observer: ChildObserver;
	private stopRequest: StopRequest | undefined;

	constructor(
		private readonly session: ChildSession,
		private readonly options: ChildRunOptions,
	) {
		this.observer = new ChildObserver({
			maxTurns: options.maxTurns,
			contextLimit: options.contextLimit,
			cwd: options.cwd,
			onBudgetReminder: (left) => session.steer(TURN_BUDGET_MESSAGE_TYPE, turnBudgetReminder(left)),
			onTurnLimit: () => void this.stop("max_turns", `ran out of turns (${options.maxTurns})`),
			onContextReminder: (percent) => session.steer(CONTEXT_BUDGET_MESSAGE_TYPE, contextBudgetReminder(percent)),
			onContextLimit: () =>
				void this.stop(
					"context_limit",
					`still calling tools ${CONTEXT_GRACE_TURNS} turns after its context passed ${options.contextLimit}%`,
				),
			onChange: () => options.onProgress?.(this.observer.snapshot()),
			contextUsage: () => session.contextUsage(),
		});
	}

	get stopped(): StopRequest | undefined {
		return this.stopRequest;
	}

	/** First stop request wins; abort() waits for the session to become idle (agent-session.ts:2519). */
	stop(status: StopRequest["status"], reason: string): Promise<void> {
		this.stopRequest ??= { status, reason };
		return this.session.abort();
	}

	async run(task: string, signal?: AbortSignal): Promise<RunOutcome> {
		// abort() before the run starts has no effect, so check first (docs/02 §8).
		if (signal?.aborted) return { status: "aborted", reason: PARENT_INTERRUPTED, text: "", notes: [] };
		if (this.stopRequest) return { ...this.stopRequest, text: "", notes: [] };

		const unsubscribe = this.session.subscribe((event) => {
			this.observer.onEvent(event);
			// A stop requested while prompt() was still in preflight was a no-op; repeat it once the run starts.
			if (this.stopRequest && (event.type === "agent_start" || event.type === "turn_start")) void this.session.abort();
		});
		const onAbort = (): void => void this.stop("aborted", PARENT_INTERRUPTED);
		signal?.addEventListener("abort", onAbort, { once: true });

		// A resumed session (agent_send) already holds earlier runs; judge only what this run added.
		const firstMessage = this.session.messages.length;
		let thrown: unknown;
		try {
			await this.session.prompt(task);
		} catch (error) {
			thrown = error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}
		return judge(this.session.messages.slice(firstMessage), this.stopRequest, thrown);
	}
}

interface AssistantLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type: string; text?: string }>;
}

function isAssistant(message: unknown): message is AssistantLike {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

export function assistantText(message: AssistantLike): string {
	return (message.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * The final report: text of the last assistant message. Trailing aborted messages without text are skipped:
 * they are stubs an abort leaves, not the model's last words. After a stop we requested (max_turns, context_limit,
 * parent interrupted, shutdown) every empty trailing assistant message is such a stub, whatever its stopReason:
 * a request aborted before it streamed can be recorded as "error" (seen with pi-ai's faux provider).
 */
export function finalReport(messages: readonly unknown[], afterStop = false): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistant(message)) continue;
		const text = assistantText(message);
		if (!text && (afterStop || message.stopReason === "aborted")) continue;
		return text;
	}
	return "";
}

export function judge(messages: readonly unknown[], stopRequest: StopRequest | undefined, thrown: unknown): RunOutcome {
	const text = finalReport(messages, stopRequest !== undefined);
	if (stopRequest) return { status: stopRequest.status, reason: stopRequest.reason, text, notes: [] };
	if (thrown !== undefined) return { status: "failed", reason: errorMessage(thrown), text, notes: [] };

	const last = [...messages].reverse().find(isAssistant);
	if (!last) return { status: "failed", reason: "the subagent produced no response", text, notes: [] };
	switch (last.stopReason) {
		case "stop":
			return { status: "completed", text, notes: [] };
		case "length":
			return { status: "completed", text, notes: ["the final message hit the output token limit"] };
		case "error":
			// Provider errors are recorded on the message, not thrown.
			return { status: "failed", reason: `provider error: ${last.errorMessage ?? "unknown error"}`, text, notes: [] };
		case "aborted":
			return { status: "aborted", reason: last.errorMessage ?? "aborted", text, notes: [] };
		default:
			return { status: "failed", reason: `unexpected stop reason: ${last.stopReason ?? "none"}`, text, notes: [] };
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
