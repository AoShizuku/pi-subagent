import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { editorHasFocus, createSubagentExtension, nextAgentNumber, shouldNotify } from "./index.js";
import type { HudState } from "./hud-state.js";
import type { AgentEntry } from "./manager.js";
import type { AgentToolDetails } from "./render.js";
import { SETTINGS_CHANNEL, SETTINGS_PROTOCOL, type SettingsProvider } from "./shizuku-settings.js";
import { blockUntilAborted, FakeFactory, type FakeSession, flush } from "./test-helpers.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolLike {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: string;
	renderShell?: string;
	parameters: { properties: Record<string, unknown> };
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: { details: AgentToolDetails }) => void) | undefined,
		ctx: unknown,
	): Promise<{ content: Array<{ text: string }>; details: AgentToolDetails; isError?: boolean }>;
}

interface CommandLike {
	handler(args: string, ctx: unknown): Promise<void>;
}

interface SentMessage {
	message: { customType: string; content: string; display: boolean; details: { agents: Array<{ agentId: string; status: string }> } };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

let root: string;

interface HarnessOptions {
	activeTools?: string[];
	inMemory?: boolean;
	factory?: FakeFactory;
	mode?: "tui" | "print" | "json" | "rpc";
	entries?: AgentEntry[];
	stopWaitMs?: number;
}

function harness(options: HarnessOptions = {}) {
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const factory = options.factory ?? new FakeFactory();
	const handlers = new Map<string, Handler[]>();
	const registrations: ToolLike[] = [];
	const commands = new Map<string, CommandLike>();
	const notices: Array<{ text: string; level: string }> = [];
	const sent: SentMessage[] = [];
	const appended: AgentEntry[] = [];
	const busListeners = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const inputHandlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
	const customCalls: Array<{ options: unknown }> = [];
	const ui = { idle: true, editorText: "" };

	const events = {
		emit: (channel: string, data: unknown) => {
			emitted.push({ channel, data });
			for (const listener of busListeners.get(channel) ?? []) listener(data);
		},
		on: (channel: string, listener: (data: unknown) => void) => {
			const set = busListeners.get(channel) ?? new Set();
			set.add(listener);
			busListeners.set(channel, set);
			return () => set.delete(listener);
		},
	};

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: ToolLike) => registrations.push(tool),
		registerCommand: (name: string, command: CommandLike) => commands.set(name, command),
		registerMessageRenderer: () => {},
		getActiveTools: () => options.activeTools ?? ["read", "bash", "edit", "write", "agent"],
		getThinkingLevel: () => "medium",
		appendEntry: (_type: string, data: AgentEntry) => appended.push(structuredClone(data)),
		sendMessage: (message: SentMessage["message"], opts: SentMessage["options"]) => sent.push({ message, options: opts }),
		events,
	} as unknown as ExtensionAPI;

	const parentModel = { provider: "faux", id: "faux-1" };
	const mode = options.mode ?? "tui";
	const ctx = {
		cwd,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: parentModel,
		thinkingLevel: "medium",
		isIdle: () => ui.idle,
		isProjectTrusted: () => true,
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
			setWidget: () => {},
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				inputHandlers.push(handler);
				return () => inputHandlers.splice(inputHandlers.indexOf(handler), 1);
			},
			getEditorText: () => ui.editorText,
			custom: (_factory: unknown, opts: unknown) => {
				customCalls.push({ options: opts });
				return Promise.resolve(undefined);
			},
		},
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "faux" && id === "faux-1" ? parentModel : undefined),
			getAvailable: () => [parentModel],
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionDir: () => (options.inMemory ? "" : sessionDir),
			getSessionId: () => "parent-1",
			getSessionFile: () => (options.inMemory ? undefined : join(sessionDir, "parent-1.jsonl")),
			getEntries: () => (options.entries ?? []).map((data) => ({ type: "custom", customType: "subagent", data })),
		},
	};

	createSubagentExtension({ createFactory: () => factory, agentDir: () => agentDir, windowMs: 50, stopWaitMs: options.stopWaitMs ?? 1000 })(pi);

	const emit = (event: string, payload: unknown = {}) => Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload, ctx)));
	const toolNamed = (name: string) => {
		const latest = registrations.filter((tool) => tool.name === name).at(-1);
		if (!latest) throw new Error(`${name} not registered`);
		return latest;
	};
	const tool = () => toolNamed("agent");
	const callTool = (name: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: { details: AgentToolDetails }) => void) =>
		toolNamed(name).execute("call-1", params, signal, onUpdate, ctx);
	const call = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (update: { details: AgentToolDetails }) => void) =>
		callTool("agent", params, signal, onUpdate);
	const lastState = () => emitted.filter((entry) => entry.channel === "subagent:state").at(-1)?.data as HudState | undefined;
	const key = (data: string) => {
		for (const handler of [...inputHandlers]) {
			const result = handler(data);
			if (result?.consume) return true;
		}
		return false;
	};
	return {
		emit,
		tool,
		toolNamed,
		call,
		callTool,
		registrations,
		commands,
		notices,
		factory,
		ctx,
		ui,
		sent,
		appended,
		events,
		emitted,
		lastState,
		key,
		customCalls,
		inputHandlers,
		agentDir,
		sessionDir,
		cwd,
	};
}

/** A session whose run waits until the test releases it. */
function gated() {
	const gates: Array<() => void> = [];
	const factory = new FakeFactory(() => async (session) => {
		await new Promise<void>((resolve) => {
			gates.push(resolve);
			void session.waitForAbort().then(resolve);
		});
		if (session.isAbortRequested) {
			session.messages.push({ role: "assistant", content: [{ type: "text", text: "partial work" }], stopReason: "aborted" });
			return;
		}
		await session.turn({ text: `report for ${session.prompts.at(-1) ?? ""}` });
	});
	const release = async (index = 0) => {
		await flush();
		gates[index]?.();
		await flush(10);
	};
	return { factory, release, gates };
}

interface ViewLike {
	handleInput(data: string): void;
	dispose(): void;
}

interface ControlledCall {
	options: unknown;
	resolve(value: unknown): void;
	reject(error: unknown): void;
	/** Build the component the way pi does; its done() settles this call. */
	view(): ViewLike;
}

/** Replace ctx.ui.custom with one whose calls stay pending until the test settles them. */
function controlCustom(h: ReturnType<typeof harness>): ControlledCall[] {
	const calls: ControlledCall[] = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => text, getBgAnsi: () => "" };
	const keys: Record<string, string> = { "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r" };
	const keybindings = { matches: (data: string, id: string) => keys[id] === data };
	const tui = { requestRender: () => {}, terminal: { rows: 30 } };
	h.ctx.ui.custom = ((factory: (...args: unknown[]) => ViewLike, options: unknown) => {
		h.customCalls.push({ options });
		return new Promise((resolve, reject) => {
			calls.push({ options, resolve, reject, view: () => factory(tui, theme, keybindings, resolve) });
		});
	}) as unknown as typeof h.ctx.ui.custom;
	return calls;
}

/** The agent tool's card for a start result, drawn the way pi's tool row does: invalidate re-runs both renderers. */
function drawCard(h: ReturnType<typeof harness>, result: unknown) {
	const tool = h.tool() as unknown as Pick<ToolDefinition, "renderCall" | "renderResult">;
	const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	let invalidations = 0;
	let card: { render(width: number): readonly string[] } | undefined;
	const context = {
		state: {},
		toolCallId: "call-1",
		expanded: false,
		isError: false,
		lastComponent: undefined,
		invalidate: () => {
			invalidations += 1;
			draw();
		},
	} as never;
	const draw = () => {
		card = tool.renderCall?.({ description: "a", prompt: "A" } as never, plainTheme, context);
		tool.renderResult?.(result as never, { expanded: false, isPartial: false }, plainTheme, context);
	};
	draw();
	return { lines: () => card?.render(200) ?? [], invalidations: () => invalidations };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-index-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("pi-subagent extension: foreground (Phase 1)", () => {
	it("registers agent, agent_send and agent_stop; adds custom types at session_start", async () => {
		const h = harness();
		const first = h.tool();
		expect(first.name).toBe("agent");
		expect(first.executionMode).toBeUndefined();
		expect(first.renderShell).toBe("self");
		expect(first.promptSnippet).toBe("Delegate a self-contained task to a subagent with its own context window");
		expect(first.promptGuidelines).toHaveLength(7);
		expect(first.promptGuidelines?.at(-1)).toMatch(/^Use agent with background: true only when/);
		expect(Object.keys(first.parameters.properties)).toEqual(["description", "prompt", "agent_type", "model", "thinking", "background"]);
		expect(first.description).toContain("- explore: Read-only search.");
		expect(first.description).toContain("- general: Same tools as you.");
		expect(first.description).toContain("background: true");
		expect(h.toolNamed("agent_send").promptGuidelines).toEqual([
			"Use agent_send to continue a subagent that already holds the context you need, instead of starting a new one and re-explaining.",
		]);
		expect(h.toolNamed("agent_stop").promptGuidelines).toEqual(["Use agent_stop to stop a background subagent you no longer need."]);

		mkdirSync(join(h.agentDir, "agents"), { recursive: true });
		writeFileSync(join(h.agentDir, "agents", "tracer.md"), "---\ndescription: Traces endpoints.\ntools: read, grep\n---\nTrace it.");
		const before = h.registrations.length;
		await h.emit("session_start", { reason: "startup" });
		expect(h.registrations).toHaveLength(before + 1);
		expect(h.tool().description).toContain("- tracer: Traces endpoints.");

		// Same description on the next session_start: no re-registration.
		await h.emit("session_start", { reason: "reload" });
		expect(h.registrations).toHaveLength(before + 1);
	});

	it("runs a foreground agent and returns its report", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		const updates: AgentToolDetails[] = [];
		const result = await h.call({ description: "find auth", prompt: "Find the auth code.", agent_type: "Explore" }, undefined, (update) => updates.push(update.details));

		expect(result.isError).toBe(false);
		const text = result.content[0]?.text ?? "";
		expect(text).toMatch(/^<subagent-result agent-id="ag-1" type="explore" status="completed" turns="1" tool-calls="0" duration="\d+s">\ndone\n<\/subagent-result>$/);
		expect(result.details).toMatchObject({ agentId: "ag-1", type: "explore", status: "completed", model: "faux/faux-1", truncated: false });

		const childDir = join(h.sessionDir, "subagents", "parent-1");
		expect(readFileSync(join(childDir, "ag-1.result.md"), "utf8")).toBe("done");
		const spec = h.factory.specs[0];
		expect(spec).toMatchObject({
			agentId: "ag-1",
			description: "find auth",
			cwd: h.cwd,
			model: { provider: "faux", id: "faux-1" },
			thinking: "low",
			sessionDir: childDir,
			parentSessionFile: join(h.sessionDir, "parent-1.jsonl"),
		});
		expect(spec?.type.tools).toEqual(["read", "grep", "find", "ls", "web_search", "web_fetch"]);
		expect(h.factory.sessions[0]?.prompts).toEqual(["Find the auth code."]);
		expect(updates.some((details) => details.status === "running")).toBe(true);
		// Foreground agents never notify.
		await flush();
		expect(h.sent).toEqual([]);
	});

	it("gives general powershell instead of bash when the parent uses powershell", async () => {
		const h = harness({ activeTools: ["read", "powershell", "edit", "write"] });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "d", prompt: "p" });
		expect(h.factory.specs[0]?.type.tools).toEqual(["read", "powershell", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"]);
		expect(h.factory.specs[0]?.thinking).toBe("medium");
	});

	it("rejects unknown types and invalid model parameters", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await expect(h.call({ description: "d", prompt: "p", agent_type: "nope" })).rejects.toThrow(/Unknown agent type "nope". Available types: explore, general/);
		await expect(h.call({ description: "d", prompt: "p", model: "other/model" })).rejects.toThrow(/Invalid model parameter/);
		expect(h.factory.specs).toHaveLength(0);
	});

	it("returns failures as error results that keep details", async () => {
		const factory = new FakeFactory(() => (s) => s.turn({ text: "partial", stopReason: "error", errorMessage: "529 overloaded" }));
		const h = harness({ factory });
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "d", prompt: "p" });
		expect(result.isError).toBe(true);
		expect(result.details.status).toBe("failed");
		expect(result.content[0]?.text).toContain("reason: provider error: 529 overloaded\npartial report:\npartial");
		expect(result.content[0]?.text).toMatch(/Retry with a new agent call, or do the task yourself\.$/);
	});

	it("aborts the child when the parent is interrupted", async () => {
		const h = harness({ factory: new FakeFactory(() => blockUntilAborted) });
		await h.emit("session_start", { reason: "startup" });
		const controller = new AbortController();
		const pending = h.call({ description: "d", prompt: "p" }, controller.signal);
		await flush();
		controller.abort();
		const result = await pending;
		expect(result.details).toMatchObject({ status: "aborted", reason: "parent interrupted" });
		expect(result.content[0]?.text.split("\n").at(-1)).toBe("</subagent-result>");
	});

	it("aborts running children on session_shutdown", async () => {
		const h = harness({ factory: new FakeFactory(() => blockUntilAborted) });
		await h.emit("session_start", { reason: "startup" });
		const pending = h.call({ description: "d", prompt: "p" });
		await flush();
		await h.emit("session_shutdown", { reason: "quit" });
		const result = await pending;
		expect(result.details).toMatchObject({ status: "aborted", reason: "session ended" });
		expect(h.factory.sessions[0]?.disposed).toBe(true);
	});

	it("uses in-memory children and a temp result directory for an in-memory parent", async () => {
		const h = harness({ inMemory: true });
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "d", prompt: "p" });
		expect(h.factory.specs[0]?.sessionDir).toBeUndefined();
		expect(result.details.resultFile).toContain(join("pi-subagent", "parent-1"));
		expect(result.content[0]?.text).not.toContain("transcript:");
		expect(result.content[0]?.text).not.toContain("agent_send");
		rmSync(join(tmpdir(), "pi-subagent", "parent-1"), { recursive: true, force: true });
	});

	it("lists types and reloads them with /agents", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		const command = h.commands.get("agents");
		await command?.handler("types", h.ctx);
		expect(h.notices.at(-1)?.text).toContain(
			"- explore (builtin) tools: read, grep, find, ls, web_search, web_fetch · model: inherit · thinking: low · max_turns: 300 · context_limit: 70%",
		);

		mkdirSync(join(h.agentDir, "agents"), { recursive: true });
		writeFileSync(join(h.agentDir, "agents", "late.md"), "---\ndescription: Added later.\n---\n");
		writeFileSync(join(h.agentDir, "pi-subagent.json"), JSON.stringify({ types: { explore: { max_turns: 5 } } }));
		await expect(h.call({ description: "d", prompt: "p", agent_type: "late" })).rejects.toThrow(/\/agents reload/);
		await command?.handler("reload", h.ctx);
		expect(h.notices.at(-1)?.text).toContain("the next request will not hit the prompt cache");
		expect(h.tool().description).toContain("- late: Added later.");
		await h.call({ description: "d", prompt: "p", agent_type: "late" });
		await h.call({ description: "d", prompt: "p", agent_type: "explore" });
		expect(h.factory.specs.at(-1)?.type.maxTurns).toBe(5);
	});

	it("warns once about an invalid config file", async () => {
		const h = harness();
		mkdirSync(h.agentDir, { recursive: true });
		writeFileSync(join(h.agentDir, "pi-subagent.json"), "{ broken");
		await h.emit("session_start", { reason: "startup" });
		expect(h.notices).toEqual([expect.objectContaining({ level: "warning", text: expect.stringContaining("invalid JSON") })]);
	});

	it("continues agent numbering after result files from earlier runs", async () => {
		const h = harness();
		const childDir = join(h.sessionDir, "subagents", "parent-1");
		mkdirSync(childDir, { recursive: true });
		writeFileSync(join(childDir, "ag-3.result.md"), "old");
		writeFileSync(join(childDir, "ag-5.result.1.md"), "old");
		expect(nextAgentNumber(childDir)).toBe(6);
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "d", prompt: "p" });
		expect(result.details.agentId).toBe("ag-6");
		expect(existsSync(join(childDir, "ag-6.result.md"))).toBe(true);
	});
});

describe("background runs and notifications", () => {
	it("returns at once, then notifies through the batcher when the parent is idle", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "查找鉴权相关代码", prompt: "Find auth.", agent_type: "explore", background: true });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toBe(
			"Started subagent ag-1 (explore): 查找鉴权相关代码\nYou will be notified with a <subagent-notification> message when it finishes. Do not poll; continue with other work or end your turn.",
		);
		expect(result.details).toMatchObject({ agentId: "ag-1", background: true, status: "running" });
		expect(h.sent).toEqual([]);

		await g.release();
		expect(h.sent).toHaveLength(1);
		const [first] = h.sent;
		expect(first?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(first?.message.customType).toBe("subagent-notification");
		expect(first?.message.display).toBe(true);
		expect(first?.message.content).toMatch(/^<subagent-notification>\n<agent agent-id="ag-1" type="explore" status="completed" turns="1" tool-calls="0" duration="\d+s">\n<description>查找鉴权相关代码<\/description>\n<result>\nreport for Find auth\.\n<\/result>\n<\/agent>\n<\/subagent-notification>\n\nSubagent ag-1 "查找鉴权相关代码" completed\.$/);
		expect(first?.message.details.agents).toEqual([expect.objectContaining({ agentId: "ag-1", status: "completed" })]);
		// Persisted: queued, running, running again once the transcript exists, completed (with its result file).
		expect(h.appended.map((entry) => entry.status)).toEqual(["queued", "running", "running", "completed"]);
		expect(h.appended[1]).not.toHaveProperty("sessionFile");
		expect(h.appended[2]?.sessionFile).toBeTruthy();
		expect(h.appended.at(-1)?.resultFile).toBe(join(h.sessionDir, "subagents", "parent-1", "ag-1.result.md"));
		expect(h.appended.at(-1)).not.toHaveProperty("text");
	});

	it("reports a queue position when the concurrency limit is reached", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		mkdirSync(h.agentDir, { recursive: true });
		writeFileSync(join(h.agentDir, "pi-subagent.json"), JSON.stringify({ maxConcurrent: 1 }));
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "one", prompt: "1", background: true });
		const second = await h.call({ description: "two", prompt: "2", background: true });
		expect(second.content[0]?.text.split("\n")[0]).toBe("Queued subagent ag-2 (general, position 1): two");
		expect(second.details).toMatchObject({ status: "queued", queuePosition: 1 });
		await h.emit("session_shutdown", { reason: "quit" });
	});

	it("applies a /shizuku change to the running session and keeps the type overrides in the file", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		mkdirSync(h.agentDir, { recursive: true });
		const file = join(h.agentDir, "pi-subagent.json");
		writeFileSync(file, JSON.stringify({ maxConcurrent: 1, types: { explore: { max_turns: 5 } } }));
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "one", prompt: "1", background: true });
		await h.call({ description: "two", prompt: "2", background: true });
		await flush();
		expect(g.factory.specs).toHaveLength(1);

		const providers: SettingsProvider[] = [];
		h.events.emit(SETTINGS_CHANNEL, { protocol: SETTINGS_PROTOCOL, register: (p: SettingsProvider) => providers.push(p) });
		const provider = providers[0];
		if (!provider) throw new Error("no provider");
		expect(provider.items().find((item) => item.id === "maxConcurrent")).toMatchObject({ value: 1, default: 4 });
		expect(provider.items().find((item) => item.id === "types")).toMatchObject({ kind: "info", value: "1 override · edit pi-subagent.json" });

		expect(await provider.set("maxConcurrent", 0)).toMatchObject({ ok: false });
		expect(await provider.set("maxConcurrent", 2)).toEqual({ ok: true });
		await flush();
		expect(g.factory.specs).toHaveLength(2);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ maxConcurrent: 2, types: { explore: { max_turns: 5 } } });
		await h.emit("session_shutdown", { reason: "quit" });
		// The runtime that shut down no longer answers.
		providers.length = 0;
		h.events.emit(SETTINGS_CHANNEL, { protocol: SETTINGS_PROTOCOL, register: (p: SettingsProvider) => providers.push(p) });
		expect(providers).toEqual([]);
	});

	it("holds notifications while the parent is busy and drains them at the turn boundary", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.ui.idle = false;
		await h.call({ description: "a", prompt: "A", background: true });
		await h.call({ description: "b", prompt: "B", background: true });
		await g.release(0);
		await g.release(1);
		expect(h.sent).toEqual([]);

		const [boundary] = (await h.emit("turn_end", { entries: [{ type: "x" }], continue: false, outcome: "completed" })) as Array<{
			entries: Array<{ type: string; customType?: string; content?: string }>;
			continue: boolean;
		}>;
		expect(boundary?.continue).toBe(true);
		expect(boundary?.entries).toHaveLength(2);
		expect(boundary?.entries[1]).toMatchObject({ type: "custom_message", customType: "subagent-notification" });
		expect(boundary?.entries[1]?.content).toContain('Subagent ag-1 "a" completed.\nSubagent ag-2 "b" completed.');
		// Drained: nothing left for the next boundary.
		expect(await h.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" })).toEqual([undefined]);
	});

	it("records but does not start a turn after an Esc-aborted run", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.ui.idle = false;
		await h.call({ description: "a", prompt: "A", background: true });
		await g.release();
		// An aborted run's boundary is not drained.
		expect(await h.emit("turn_end", { entries: [], continue: false, outcome: "aborted" })).toEqual([undefined]);
		await h.emit("agent_settled", { aborted: true });
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
	});

	it("is not affected by the parent's Esc", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		const controller = new AbortController();
		await h.call({ description: "a", prompt: "A", background: true }, controller.signal);
		controller.abort();
		await g.release();
		expect(h.sent[0]?.message.details.agents[0]?.status).toBe("completed");
	});

	it("rejects background in print and json mode and leaves it out of the description", async () => {
		for (const mode of ["print", "json"] as const) {
			const h = harness({ mode });
			await h.emit("session_start", { reason: "startup" });
			expect(h.tool().description).not.toContain("background");
			expect(h.tool().promptGuidelines).toHaveLength(6);
			await expect(h.call({ description: "d", prompt: "p", background: true })).rejects.toThrow(/background is not available in print or json mode/);
			// The foreground still works.
			expect((await h.call({ description: "d", prompt: "p" })).details.status).toBe("completed");
		}
	});

	it("uses the type's background default", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		mkdirSync(join(h.agentDir, "agents"), { recursive: true });
		writeFileSync(join(h.agentDir, "agents", "bg.md"), "---\ndescription: Background by default.\nbackground: true\n---\n");
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "d", prompt: "p", agent_type: "bg" });
		expect(result.details.background).toBe(true);
		await h.emit("session_shutdown", { reason: "quit" });
	});

	it("session_shutdown sends no notification and publishes an empty HUD state", async () => {
		const h = harness({ factory: new FakeFactory(() => blockUntilAborted) });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		const appendedBefore = h.appended.length;
		await h.emit("session_shutdown", { reason: "quit" });
		await flush();
		expect(h.sent).toEqual([]);
		expect(h.lastState()).toEqual({ rows: [], above: 0, below: 0, focus: null, tokens: 0, cost: 0 });
		// Nothing touches the old session after shutdown.
		expect(h.appended).toHaveLength(appendedBefore);
	});

	it("shouldNotify follows docs/06 §5.2", () => {
		expect(shouldNotify({ background: false, status: "completed" })).toBe(false);
		expect(shouldNotify({ background: true, status: "completed" })).toBe(true);
		expect(shouldNotify({ background: true, status: "failed" })).toBe(true);
		expect(shouldNotify({ background: true, status: "max_turns" })).toBe(true);
		expect(shouldNotify({ background: true, status: "aborted", stoppedBy: "user", reason: "stopped by the user" })).toBe(true);
		expect(shouldNotify({ background: true, status: "aborted", stoppedBy: "parent", reason: "stopped by parent" })).toBe(false);
		expect(shouldNotify({ background: true, status: "aborted", reason: "session ended" })).toBe(false);
	});
});

describe("agent_stop", () => {
	it("stops a background run without notifying and returns the partial report", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		const result = await h.callTool("agent_stop", { agent_id: "ag-1" });
		const text = result.content[0]?.text ?? "";
		expect(text.split("\n")[0]).toMatch(/^Stopped subagent ag-1 \(a\) after \d+s\.$/);
		expect(text).toContain('status="aborted"');
		expect(text).toContain("reason: stopped by parent\npartial report:\npartial work");
		expect(text).not.toContain("The user stopped");
		await flush(10);
		expect(h.sent).toEqual([]);
		expect(h.appended.at(-1)).toMatchObject({ status: "aborted", reason: "stopped by parent", stoppedBy: "parent" });
	});

	it("removes a queued agent from the queue", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		mkdirSync(h.agentDir, { recursive: true });
		writeFileSync(join(h.agentDir, "pi-subagent.json"), JSON.stringify({ maxConcurrent: 1 }));
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await h.call({ description: "b", prompt: "B", background: true });
		const result = await h.callTool("agent_stop", { agent_id: "ag-2" });
		expect(result.content[0]?.text).toContain("reason: stopped by parent");
		expect(h.factory.specs.map((spec) => spec.agentId)).toEqual(["ag-1"]);
		await g.release();
		expect(h.sent.map((entry) => entry.message.details.agents.map((agent) => agent.agentId))).toEqual([["ag-1"]]);
	});

	it("redraws the stopped agent's background card as stopped (docs/07 §1.4)", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		const started = await h.call({ description: "a", prompt: "A", background: true });
		expect(started.details).toMatchObject({ background: true, run: 1 });
		const card = drawCard(h, started);
		await flush();
		expect(card.lines()).toEqual(["● Agent general · a · ag-1 running in background"]);

		await h.callTool("agent_stop", { agent_id: "ag-1" });
		expect(card.invalidations()).toBe(1);
		expect(card.lines()[0]).toMatch(/^■ Agent general · a · stopped after \d+s$/);
	});

	it("keeps a stopped run's card stopped after agent_send reopens the agent, also after resume", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		const started = await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		await h.callTool("agent_stop", { agent_id: "ag-1" });
		// Reopened in the foreground and completed before the start card is drawn at all.
		writeFileSync(h.factory.sessions[0]?.sessionFile ?? "", "{}\n");
		const pending = h.callTool("agent_send", { agent_id: "ag-1", message: "What about B?" });
		await g.release(1);
		expect((await pending).details).toMatchObject({ status: "completed" });
		expect(h.appended.at(-1)).toMatchObject({ agentId: "ag-1", runs: 2, status: "completed" });
		expect(drawCard(h, started).lines()[0]).toMatch(/^■ Agent general · a · stopped after \d+s$/);

		// Resume: a new process restores from the persisted entries, where the latest one is run 2.
		const resumed = harness({ entries: h.appended });
		await resumed.emit("session_start", { reason: "resume" });
		expect(drawCard(resumed, started).lines()[0]).toMatch(/^■ Agent general · a · stopped after \d+s$/);
	});

	it("returns a finished agent's state and rejects unknown ids", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "d", prompt: "p" });
		const result = await h.callTool("agent_stop", { agent_id: "ag-1" });
		expect(result.content[0]?.text.split("\n")[0]).toBe("ag-1 had already finished: completed.");
		await expect(h.callTool("agent_stop", { agent_id: "ag-9" })).rejects.toThrow("Unknown subagent ag-9. Known agents: ag-1.");
	});

	it("does not wait forever for a hung run", async () => {
		const factory = new FakeFactory(() => blockUntilAborted);
		const h = harness({ factory, stopWaitMs: 100 });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		(h.factory.sessions[0] as FakeSession).hangOnAbort = true;
		const result = await h.callTool("agent_stop", { agent_id: "ag-1" });
		expect(result.content[0]?.text).toContain('status="aborted"');
		await h.emit("session_shutdown", { reason: "quit" });
	});
});

describe("agent_send", () => {
	it("steers a running agent", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		const result = await h.callTool("agent_send", { agent_id: "ag-1", message: "Also check tests." });
		expect(result.content[0]?.text).toBe("Message queued for ag-1; it will be part of the report you receive when it finishes.");
		expect(h.factory.sessions[0]?.userSteers).toEqual(["Also check tests."]);
		await g.release();
	});

	it("appends to the task of a queued agent", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		mkdirSync(h.agentDir, { recursive: true });
		writeFileSync(join(h.agentDir, "pi-subagent.json"), JSON.stringify({ maxConcurrent: 1 }));
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await h.call({ description: "b", prompt: "B", background: true });
		await h.callTool("agent_send", { agent_id: "ag-2", message: "Only src/." });
		await g.release(0);
		expect(h.factory.sessions[1]?.prompts).toEqual(["B\n\nAdditional instruction from the parent:\nOnly src/."]);
		await g.release(1);
	});

	it("continues a finished agent from its transcript, in the foreground or the background", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await g.release(0);
		const transcript = h.factory.sessions[0]?.sessionFile ?? "";
		mkdirSync(join(h.sessionDir, "subagents", "parent-1"), { recursive: true });
		writeFileSync(transcript, "{}\n");

		const pending = h.callTool("agent_send", { agent_id: "ag-1", message: "What about B?" });
		await g.release(1);
		const reply = await pending;
		expect(h.factory.specs[1]).toMatchObject({ agentId: "ag-1", resumeFile: transcript });
		expect(reply.isError).toBe(false);
		expect(reply.content[0]?.text).toContain("report for What about B?");
		expect(reply.details).toMatchObject({ agentId: "ag-1", status: "completed" });
		// A foreground continuation does not notify; the first run's notification was the only one.
		expect(h.sent).toHaveLength(1);
		const resultDir = join(h.sessionDir, "subagents", "parent-1");
		expect(readFileSync(join(resultDir, "ag-1.result.md"), "utf8")).toBe("report for What about B?");
		expect(readFileSync(join(resultDir, "ag-1.result.1.md"), "utf8")).toBe("report for A");
		expect(h.appended.at(-1)).toMatchObject({ agentId: "ag-1", runs: 2, prompt: "What about B?", status: "completed" });

		const started = await h.callTool("agent_send", { agent_id: "ag-1", message: "And C?", background: true });
		expect(started.content[0]?.text.split("\n")[0]).toBe("Continuing subagent ag-1 (general): a");
		await g.release(2);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]?.message.content).toContain("report for And C?");
	});

	it("rejects unknown ids and agents whose transcript is gone", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await expect(h.callTool("agent_send", { agent_id: "ag-1", message: "m" })).rejects.toThrow("Unknown subagent ag-1. No subagents have been started in this session.");
		await h.call({ description: "d", prompt: "p" });
		await expect(h.callTool("agent_send", { agent_id: "ag-1", message: "m" })).rejects.toThrow(
			"ag-1 cannot be continued: its transcript is no longer available. Start a new agent.",
		);
	});

	it("rejects an agent whose context reached the limit, without the follow-up hint in its result", async () => {
		const factory = new FakeFactory(() => async (session) => {
			session.context = { tokens: 72_000, contextWindow: 100_000 };
			await session.turn({ text: "final report" });
		});
		const h = harness({ factory });
		await h.emit("session_start", { reason: "startup" });
		const result = await h.call({ description: "d", prompt: "p" });
		expect(result.content[0]?.text).not.toContain("agent_send");
		mkdirSync(join(h.sessionDir, "subagents", "parent-1"), { recursive: true });
		writeFileSync(factory.sessions[0]?.sessionFile ?? "", "{}\n");
		await expect(h.callTool("agent_send", { agent_id: "ag-1", message: "m" })).rejects.toThrow(
			"ag-1 cannot be continued: its context window is nearly full (72% used). Start a new agent.",
		);
		expect(factory.specs).toHaveLength(1);
	});
});

describe("persistence and restore", () => {
	function entry(overrides: Partial<AgentEntry>): AgentEntry {
		return {
			agentId: "ag-1",
			type: "explore",
			description: "old",
			prompt: "p",
			status: "completed",
			createdAt: 1,
			startedAt: 1,
			endedAt: 2,
			model: "faux/faux-1",
			background: true,
			runs: 1,
			notes: [],
			stats: { turns: 1, toolCalls: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
			totalUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
			...overrides,
		};
	}

	it("restores records, closes the ones a dead process left running, and continues ids", async () => {
		const h = harness({
			entries: [
				entry({ agentId: "ag-1", status: "running" }),
				entry({ agentId: "ag-1", status: "completed" }),
				entry({ agentId: "ag-7", status: "queued" }),
				entry({ agentId: "ag-4", status: "running", description: "was running" }),
			],
		});
		await h.emit("session_start", { reason: "resume" });
		// Corrections are persisted.
		expect(h.appended.map((e) => [e.agentId, e.status, e.reason])).toEqual([
			["ag-7", "aborted", "session ended"],
			["ag-4", "aborted", "session ended"],
		]);
		// Restored agents never notify.
		await flush();
		expect(h.sent).toEqual([]);
		const result = await h.call({ description: "d", prompt: "p" });
		expect(result.details.agentId).toBe("ag-8");
		await expect(h.callTool("agent_stop", { agent_id: "ag-4" })).resolves.toMatchObject({
			content: [{ text: expect.stringMatching(/^ag-4 had already finished: aborted\./) }],
		});
	});

	it("takes the larger of the result-file and entry numbering", async () => {
		const h = harness({ entries: [entry({ agentId: "ag-2" })] });
		const childDir = join(h.sessionDir, "subagents", "parent-1");
		mkdirSync(childDir, { recursive: true });
		writeFileSync(join(childDir, "ag-5.result.md"), "old");
		await h.emit("session_start", { reason: "resume" });
		expect((await h.call({ description: "d", prompt: "p" })).details.agentId).toBe("ag-6");
	});
});

describe("HUD protocol and keyboard focus", () => {
	it("publishes rows, answers requests and asks pi-hud to announce itself", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		expect(h.emitted.some((entry) => entry.channel === "subagent:hud:request")).toBe(true);
		expect(h.lastState()).toMatchObject({ rows: [], focus: null });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		expect(h.lastState()?.rows).toEqual([expect.objectContaining({ id: "ag-1", status: "running", turn: 1, type: "general" })]);
		const count = h.emitted.length;
		h.events.emit("subagent:state:request", undefined);
		expect(h.emitted.length).toBe(count + 2);
		expect(h.lastState()?.rows[0]?.id).toBe("ag-1");
		await g.release();
		expect(h.lastState()?.rows[0]).toMatchObject({ id: "ag-1", status: "completed" });
	});

	it("enters focus mode on ↓ only when pi-hud renders, the editor is empty and there are rows", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		expect(h.inputHandlers).toHaveLength(1);
		expect(h.key("\x1b[B")).toBe(false); // no rows, HUD not rendering
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		expect(h.key("\x1b[B")).toBe(false); // HUD not rendering
		h.events.emit("subagent:hud", { rendering: true });
		h.ui.editorText = "draft";
		expect(h.key("\x1b[B")).toBe(false);
		h.ui.editorText = "";
		expect(h.key("\x1b[B")).toBe(true);
		expect(h.lastState()?.focus).toEqual({ selectedId: "ag-1" });
		// Esc leaves focus mode and is swallowed, so it cannot interrupt the main agent.
		expect(h.key("\x1b")).toBe(true);
		expect(h.lastState()?.focus).toBeNull();
		// pi-hud turning off ends focus mode.
		expect(h.key("\x1b[B")).toBe(true);
		h.events.emit("subagent:hud", { rendering: false });
		expect(h.lastState()?.focus).toBeNull();
		expect(h.key("\x1b")).toBe(false);
		await g.release();
	});

	it("x stops the selected agent as a user stop, which notifies", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.events.emit("subagent:hud", { rendering: true });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		expect(h.key("\x1b[B")).toBe(true);
		// The first x only arms the row; the HUD hears about it.
		expect(h.key("x")).toBe(true);
		expect(h.lastState()?.focus).toEqual({ selectedId: "ag-1", armed: true });
		await flush(20);
		expect(h.sent).toHaveLength(0);
		expect(h.key("x")).toBe(true);
		expect(h.lastState()?.focus).toEqual({ selectedId: "ag-1" });
		await flush(20);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.content).toContain('Subagent ag-1 "a" was stopped by the user.');
	});

	it("Enter and subagent:open open overlays", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.events.emit("subagent:hud", { rendering: true });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		h.key("\x1b[B");
		expect(h.key("\r")).toBe(true);
		await flush();
		expect(h.customCalls).toHaveLength(1);
		expect(h.customCalls[0]?.options).toMatchObject({ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
		// The overlay closed (the fake resolves at once): back in focus mode with the same selection.
		expect(h.lastState()?.focus).toEqual({ selectedId: "ag-1" });
		h.key("\x1b");

		// While one of our overlays is open, ↓ belongs to it, never to focus mode.
		let closeOverlay: () => void = () => {};
		const custom = h.ctx.ui.custom;
		h.ctx.ui.custom = (_factory: unknown, opts: unknown) => {
			h.customCalls.push({ options: opts });
			return new Promise((resolve) => {
				closeOverlay = () => resolve(undefined);
			});
		};
		h.events.emit("subagent:open", { agentId: "ag-1" });
		expect(h.key("\x1b[B")).toBe(false);
		expect(h.key("\x1b")).toBe(false);
		closeOverlay();
		await flush();
		h.ctx.ui.custom = custom;
		h.customCalls.pop();

		h.events.emit("subagent:open", { agentId: "ag-1" });
		// While the detail is showing, the list cannot open.
		h.events.emit("subagent:open", {});
		await flush();
		// The "+N more" row opens the list in the editor slot: no overlay options.
		h.events.emit("subagent:open", {});
		await flush();
		expect(h.customCalls.map((entry) => (entry.options as { overlayOptions?: { width: string } } | undefined)?.overlayOptions?.width ?? "list")).toEqual([
			"90%",
			"90%",
			"list",
		]);
		await g.release();
	});

	it("/agents shows the list in the editor slot; Enter opens the detail on top while the list stays open", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.events.emit("subagent:hud", { rendering: true });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		const calls = controlCustom(h);

		let listClosed = false;
		void h.commands
			.get("agents")
			?.handler("", h.ctx)
			.then(() => (listClosed = true));
		expect(calls).toHaveLength(1);
		// Not an overlay: pi puts it in place of the editor, like its own selectors.
		expect(calls[0]?.options).toBeUndefined();
		const list = calls[0]!.view();
		// The list holds the keyboard: no focus mode.
		expect(h.key("\x1b[B")).toBe(false);

		list.handleInput("\r");
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1]?.options).toMatchObject({ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
		expect(listClosed).toBe(false);
		// One detail at a time; /agents again while the list is open is ignored.
		list.handleInput("\r");
		await h.commands.get("agents")?.handler("", h.ctx);
		expect(calls).toHaveLength(2);

		// Esc in the detail closes only the detail; the list is still there and can open it again.
		calls[1]!.resolve(undefined);
		await flush();
		expect(listClosed).toBe(false);
		expect(h.key("\x1b[B")).toBe(false);
		list.handleInput("\r");
		await flush();
		expect(calls).toHaveLength(3);
		calls[2]!.resolve(undefined);
		await flush();

		// Esc in the list closes it; the flags are reset, so focus mode and /agents work again.
		list.handleInput("\x1b");
		await flush();
		expect(listClosed).toBe(true);
		list.dispose();
		expect(h.key("\x1b[B")).toBe(true);
		expect(h.key("\x1b")).toBe(true);
		void h.commands.get("agents")?.handler("", h.ctx);
		expect(calls).toHaveLength(4);
		expect(calls[3]?.options).toBeUndefined();
		calls[3]!.resolve(undefined);
		await flush();
		await g.release();
	});

	it("HUD clicks while the list is open: an agent row opens its detail on top, +N more is ignored", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		const calls = controlCustom(h);

		h.events.emit("subagent:open", {});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.options).toBeUndefined();
		h.events.emit("subagent:open", {});
		expect(calls).toHaveLength(1);

		h.events.emit("subagent:open", { agentId: "ag-1" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.options).toMatchObject({ overlay: true });
		h.events.emit("subagent:open", { agentId: "ag-1" });
		h.events.emit("subagent:open", {});
		expect(calls).toHaveLength(2);
		calls[1]!.resolve(undefined);
		await flush();

		// The list is still open: another row click opens a detail again, "+N more" still does nothing.
		h.events.emit("subagent:open", {});
		expect(calls).toHaveLength(2);
		h.events.emit("subagent:open", { agentId: "ag-1" });
		expect(calls).toHaveLength(3);
		calls[2]!.resolve(undefined);
		calls[0]!.resolve(undefined);
		await flush();
		h.events.emit("subagent:open", {});
		expect(calls).toHaveLength(4);
		calls[3]!.resolve(undefined);
		await flush();
		await g.release();
	});

	it("resets the flags when custom() rejects and when the session closes with the list open", async () => {
		const g = gated();
		const h = harness({ factory: g.factory });
		await h.emit("session_start", { reason: "startup" });
		h.events.emit("subagent:hud", { rendering: true });
		await h.call({ description: "a", prompt: "A", background: true });
		await flush();
		let calls = controlCustom(h);

		// The list fails to show (e.g. the UI went away): the next /agents opens it again.
		void h.commands.get("agents")?.handler("", h.ctx);
		calls[0]!.reject(new Error("gone"));
		await flush();
		void h.commands.get("agents")?.handler("", h.ctx);
		expect(calls).toHaveLength(2);
		// The detail on top of it fails too: the list stays usable, and its own flag is cleared.
		const list = calls[1]!.view();
		list.handleInput("\r");
		calls[2]!.reject(new Error("gone"));
		await flush();
		list.handleInput("\r");
		expect(calls).toHaveLength(4);
		calls[3]!.resolve(undefined);
		await flush();

		// The session closes while the list is open: pi disposes the list without settling custom().
		await h.emit("session_shutdown", { reason: "quit" });
		list.handleInput("\r");
		expect(calls).toHaveLength(4);
		list.dispose();

		// The next session starts clean.
		await h.emit("session_start", { reason: "resume" });
		calls = controlCustom(h);
		h.events.emit("subagent:hud", { rendering: true });
		await h.call({ description: "b", prompt: "B", background: true });
		await flush();
		expect(h.key("\x1b[B")).toBe(true);
		expect(h.key("\x1b")).toBe(true);
		void h.commands.get("agents")?.handler("", h.ctx);
		expect(calls).toHaveLength(1);
		calls[0]!.resolve(undefined);
		await flush();
		await g.release(1);
	});

	it("/agents without arguments lists agents (text outside the TUI)", async () => {
		const h = harness({ mode: "rpc" });
		await h.emit("session_start", { reason: "startup" });
		await h.call({ description: "find auth", prompt: "p" });
		await h.commands.get("agents")?.handler("", { ...h.ctx, mode: "rpc" });
		expect(h.notices.at(-1)?.text).toMatch(/^ag-1 {2}completed {2}\d+s {2}general {2}find auth$/);
	});

	it("editorHasFocus duck-types the focused component", () => {
		expect(editorHasFocus(undefined)).toBe(true);
		expect(editorHasFocus({})).toBe(true);
		expect(editorHasFocus({ getFocusedComponent: () => ({ getText: () => "" }) })).toBe(true);
		expect(editorHasFocus({ getFocusedComponent: () => ({ render: () => [] }) })).toBe(false);
		expect(editorHasFocus({ getFocusedComponent: () => null })).toBe(false);
	});
});
