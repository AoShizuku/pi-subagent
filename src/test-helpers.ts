// Test doubles: a scriptable child session and factory, so no test calls a model.

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { ContextUsageLike } from "./observer.js";
import type { ChildSession, ChildSessionFactory, ChildSpec } from "./run.js";
import type { AgentType } from "./types.js";

type Listener = (event: AgentSessionEvent) => void;

export interface FakeTurn {
	text?: string;
	/** Tool calls made in this turn; the turn then ends with stopReason "toolUse". */
	tools?: Array<{ name: string; args?: Record<string, unknown> }>;
	stopReason?: "stop" | "length" | "error" | "aborted";
	errorMessage?: string;
	usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number };
}

export type FakeScript = (session: FakeSession, task: string) => Promise<void>;

export function assistantMessage(turn: FakeTurn): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [];
	if (turn.text) content.push({ type: "text", text: turn.text });
	for (const [index, tool] of (turn.tools ?? []).entries()) {
		content.push({ type: "toolCall", id: `call-${index}`, name: tool.name, arguments: tool.args ?? {} });
	}
	const usage = turn.usage ?? { input: 10, output: 5 };
	return {
		role: "assistant",
		content,
		stopReason: turn.tools?.length ? "toolUse" : (turn.stopReason ?? "stop"),
		errorMessage: turn.errorMessage,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			cost: { total: usage.cost ?? 0 },
		},
	};
}

export class FakeSession implements ChildSession {
	sessionFile: string | undefined;
	model: string | undefined = "faux/faux-1";
	readonly messages: unknown[] = [];
	readonly steered: Array<{ customType: string; content: string }> = [];
	readonly userSteers: string[] = [];
	aborts = 0;
	disposed = false;
	prompts: string[] = [];
	private listeners: Listener[] = [];
	private abortWaiters: Array<() => void> = [];
	private abortRequested = false;
	/** When true, abort() never resolves (a hung provider request). */
	hangOnAbort = false;
	/** What contextUsage() returns; undefined like a model without a known context window. */
	context: ContextUsageLike | undefined;

	constructor(
		private readonly script: FakeScript = async (session) => session.turn({ text: "done" }),
		sessionFile?: string,
	) {
		this.sessionFile = sessionFile;
	}

	contextUsage(): ContextUsageLike | undefined {
		return this.context;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((entry) => entry !== listener);
		};
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of [...this.listeners]) listener(event as unknown as AgentSessionEvent);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.messages.push({ role: "user", content: [{ type: "text", text }] });
		this.emit({ type: "agent_start" });
		await this.script(this, text);
		this.emit({ type: "agent_end", messages: this.messages, willRetry: false });
	}

	/** One full turn: message events, tool execution events, turn_end. */
	async turn(turn: FakeTurn): Promise<void> {
		this.emit({ type: "turn_start" });
		const message = assistantMessage(turn);
		this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		if (turn.text) {
			this.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: turn.text } });
		}
		this.messages.push(message);
		this.emit({ type: "message_end", message });
		for (const [index, tool] of (turn.tools ?? []).entries()) {
			this.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: tool.name, args: tool.args ?? {} });
			this.emit({ type: "tool_execution_end", toolCallId: `call-${index}`, toolName: tool.name, result: {}, isError: false });
		}
		this.emit({ type: "turn_end", message, toolResults: [] });
		await Promise.resolve();
	}

	/** Resolves once abort() is called; then records an aborted, empty assistant message like pi does. */
	waitForAbort(): Promise<void> {
		if (this.abortRequested) return Promise.resolve();
		return new Promise((resolve) => this.abortWaiters.push(resolve));
	}

	get isAbortRequested(): boolean {
		return this.abortRequested;
	}

	async abort(): Promise<void> {
		this.aborts += 1;
		this.abortRequested = true;
		for (const resolve of this.abortWaiters.splice(0)) resolve();
		if (this.hangOnAbort) await new Promise(() => {});
	}

	steer(customType: string, content: string): void {
		this.steered.push({ customType, content });
	}

	async steerUser(text: string): Promise<void> {
		this.userSteers.push(text);
	}

	dispose(): void {
		this.disposed = true;
	}
}

/** Script: keep making tool calls until aborted, then leave pi's aborted stub. */
export const runUntilAborted: FakeScript = async (session) => {
	while (!session.isAbortRequested) {
		await session.turn({ text: "still working", tools: [{ name: "read", args: { path: "a.ts" } }] });
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	session.messages.push(assistantMessage({ stopReason: "aborted" }));
};

/** Script: block until aborted. */
export const blockUntilAborted: FakeScript = async (session) => {
	await session.waitForAbort();
	session.messages.push(assistantMessage({ stopReason: "aborted" }));
};

export class FakeFactory implements ChildSessionFactory {
	readonly specs: ChildSpec[] = [];
	readonly sessions: FakeSession[] = [];
	failWith: Error | undefined;

	constructor(private readonly makeScript: (spec: ChildSpec) => FakeScript = () => async (session) => session.turn({ text: "done" })) {}

	async create(spec: ChildSpec): Promise<FakeSession> {
		this.specs.push(spec);
		if (this.failWith) throw this.failWith;
		const file = spec.resumeFile ?? (spec.sessionDir ? `${spec.sessionDir}/child-${spec.agentId}.jsonl` : undefined);
		const session = new FakeSession(this.makeScript(spec), file);
		this.sessions.push(session);
		return session;
	}
}

export function testType(overrides: Partial<AgentType> = {}): AgentType {
	return {
		name: "general",
		description: "General",
		tools: ["read", "bash"],
		maxTurns: 60,
		contextLimit: 70,
		contextFiles: true,
		skills: false,
		background: false,
		body: "",
		source: "builtin",
		path: "general.md",
		...overrides,
	};
}

export function testSpec(overrides: Partial<ChildSpec> = {}): ChildSpec {
	return { agentId: "ag-1", description: "test", type: testType(), cwd: process.cwd(), ...overrides };
}

export async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
