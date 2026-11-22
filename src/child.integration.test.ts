// Integration: real pi SDK sessions (resource loader, tool registry, session files, agent loop) driven by
// pi-ai's faux provider, so no real model or credential is involved. Everything lives in a temp agentDir.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChildAgentSession, createChildSessionFactory, type ChildFactoryOptions } from "./child.js";
import { createSubagentExtension } from "./index.js";
import { AgentManager } from "./manager.js";
import { TURN_BUDGET_MESSAGE_TYPE } from "./prompts.js";
import type { ChildSpec } from "./run.js";
import { builtinAgentsDir, effectiveTools, loadAgentTypes, type AgentType } from "./types.js";

let root: string;
let agentDir: string;
let cwd: string;
let parentSessionDir: string;
let factoryOptions: ChildFactoryOptions;
let faux: ReturnType<typeof fauxProvider>;
let types: Map<string, AgentType>;
const sessions: AgentSession[] = [];
const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-int-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	parentSessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-CONVENTION-MARKER: use tabs.");
	writeFileSync(join(cwd, "hello.txt"), "hi");
	// Keep pi away from the real ~/.pi and the network.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";

	// The "parent": a registry with a provider registered at runtime, like pi.registerProvider does.
	const parentRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const parentRegistry = new ModelRegistry(parentRuntime);
	faux = fauxProvider({ provider: "faux-sub", api: "faux-sub-api" });
	parentRegistry.registerProvider(faux.provider.id, {
		api: faux.api,
		baseUrl: faux.getModel().baseUrl,
		apiKey: "test-key",
		models: faux.models,
		streamSimple: faux.provider.streamSimple,
	});
	factoryOptions = { parentRegistry, agentDir };
	types = loadAgentTypes({ builtinDir: builtinAgentsDir(), userDir: join(agentDir, "agents"), projectDir: join(cwd, ".pi", "agents"), projectTrusted: false }).types;
});

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
	process.env.PI_OFFLINE = savedEnv.offline;
	if (savedEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	if (savedEnv.offline === undefined) delete process.env.PI_OFFLINE;
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function spec(typeName: string, overrides: Partial<ChildSpec> = {}): ChildSpec {
	const type = types.get(typeName);
	if (!type) throw new Error(`no type ${typeName}`);
	return {
		agentId: "ag-1",
		description: "integration",
		type,
		cwd,
		model: { provider: faux.provider.id, id: faux.getModel().id },
		thinking: "low",
		...overrides,
	};
}

async function build(childSpec: ChildSpec): Promise<AgentSession> {
	const session = await createChildAgentSession(childSpec, factoryOptions);
	sessions.push(session);
	return session;
}

describe("child session assembly (real SDK)", () => {
	it("activates exactly the type's tools under noExtensions", async () => {
		const explore = await build(spec("explore"));
		expect([...explore.getActiveToolNames()].sort()).toEqual(["find", "grep", "ls", "read"]);
		const general = await build(spec("general"));
		expect([...general.getActiveToolNames()].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		const type = types.get("general");
		if (!type) throw new Error("general missing");
		const windows = await build(spec("general", { type: { ...type, tools: effectiveTools(type, ["powershell"]) } }));
		expect([...windows.getActiveToolNames()].sort()).toEqual(["edit", "find", "grep", "ls", "powershell", "read", "write"]);
		const none = await build(spec("explore", { type: { ...(types.get("explore") as AgentType), tools: [] } }));
		expect(none.getActiveToolNames()).toEqual([]);
	});

	it("turns auto-compaction off for the child only", async () => {
		const session = await build(spec("explore"));
		expect(session.autoCompactionEnabled).toBe(false);
		// The override stays in memory: the settings on disk still say enabled.
		expect(SettingsManager.create(process.cwd(), agentDir).getCompactionEnabled()).toBe(true);
	});

	it("keeps pi's tools and rules sections and appends the contract and type body", async () => {
		const session = await build(spec("explore"));
		const prompt = session.systemPrompt;
		expect(prompt).toContain("You are a coding assistant running inside pi");
		expect(prompt).toMatch(/<tools>\n- read: /);
		expect(prompt).toContain("<rules>");
		expect(prompt).toContain("<subagent_contract>\nYou are a subagent.");
		expect(prompt).toContain('<agent_type name="explore">\nYou are a read-only search agent.');
		expect(prompt).toContain("PROJECT-CONVENTION-MARKER");
		expect(prompt).not.toMatch(/^- (bash|edit|write|agent):/m);
		// Order: tools/rules before the addendum, project context after it (system-prompt.ts:128-196).
		expect(prompt.indexOf("<rules>")).toBeLessThan(prompt.indexOf("<subagent_contract>"));
		expect(prompt.indexOf("<subagent_contract>")).toBeLessThan(prompt.indexOf("PROJECT-CONVENTION-MARKER"));
	});

	it("leaves out AGENTS.md when the type sets context_files: false", async () => {
		const type = { ...(types.get("explore") as AgentType), contextFiles: false };
		const session = await build(spec("explore", { type }));
		expect(session.systemPrompt).not.toContain("PROJECT-CONVENTION-MARKER");
	});

	it("uses the replayed runtime provider and the requested thinking level", async () => {
		const session = await build(spec("explore"));
		expect(session.model?.provider).toBe("faux-sub");
		// "low" requested; the faux model has no reasoning, so pi clamps it (sdk.ts:270-276).
		expect(session.thinkingLevel).toBe("off");
	});
});

describe("foreground run (real SDK, faux provider)", () => {
	it("runs to completion and writes the child session file under subagents/<parentId>/", async () => {
		const childDir = join(parentSessionDir, "subagents", "parent-1");
		const parentFile = join(parentSessionDir, "parent-1.jsonl");
		faux.setResponses([fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }), fauxAssistantMessage("The answer: hello.txt exists.")]);

		const manager = new AgentManager({ factory: createChildSessionFactory(factoryOptions), maxConcurrent: () => 4 });
		const record = manager.create({ type: "explore", description: "list files", prompt: "List the files.", model: "faux-sub/faux-1" });
		await manager.execute(record, {
			spec: spec("explore", { agentId: record.agentId, description: "list files", sessionDir: childDir, parentSessionFile: parentFile }),
			task: "List the files.",
		});

		expect(record).toMatchObject({ status: "completed", text: "The answer: hello.txt exists.", stats: { turns: 2, toolCalls: 1 } });
		expect(record.model).toBe("faux-sub/faux-1");
		const file = record.sessionFile;
		if (!file) throw new Error("no session file");
		expect(dirname(file)).toBe(childDir);
		expect(basename(file)).toMatch(/^.+_.+\.jsonl$/);
		const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines[0]).toMatchObject({ type: "session", cwd, parentSession: parentFile });
		expect(lines.some((entry) => entry.type === "session_info" && entry.name === "list files")).toBe(true);
		const userMessage = lines.find((entry) => entry.type === "message" && (entry.message as { role: string }).role === "user");
		expect(JSON.stringify(userMessage)).toContain("List the files.");

		// /resume lists only the top level of the session directory.
		const listed = await SessionManager.list(cwd, parentSessionDir);
		expect(listed.map((info) => info.path)).not.toContain(file);
	});

	it("stops at max_turns after delivering the turn-budget reminder", async () => {
		const seen: string[] = [];
		faux.setResponses(
			Array.from({ length: 6 }, (_, i) => (context: { messages: unknown[] }) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([{ type: "text", text: `step ${i}` }, fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
			}),
		);
		const type = { ...(types.get("explore") as AgentType), maxTurns: 3 };
		const manager = new AgentManager({ factory: createChildSessionFactory(factoryOptions), maxConcurrent: () => 4 });
		const record = manager.create({ type: "explore", description: "loop", prompt: "Loop.", model: "faux-sub/faux-1" });
		await manager.execute(record, { spec: spec("explore", { agentId: record.agentId, type, sessionDir: join(parentSessionDir, "subagents", "p") }), task: "Loop." });

		expect(record).toMatchObject({ status: "max_turns", reason: "ran out of turns (3)", text: "step 2" });
		expect(record.stats.turns).toBe(3);
		// Reminder after turn 1 (2 left), seen by the request for turn 2.
		// The custom message reaches the model as a user message.
		expect(seen[1]).toContain('{"role":"user","content":[{"type":"text","text":"You have 2 turns left. Stop exploring and write your final report now."}]');
		expect(seen[0]).not.toContain("turns left");
		expect(seen).toHaveLength(3);
		// In the transcript it stays a hidden custom message.
		const transcript = readFileSync(record.sessionFile ?? "", "utf8");
		expect(transcript).toContain(`"customType":"${TURN_BUDGET_MESSAGE_TYPE}"`);
	});

	it("reports a provider error as failed", async () => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request: bad schema" })]);
		const manager = new AgentManager({ factory: createChildSessionFactory(factoryOptions), maxConcurrent: () => 4 });
		const record = manager.create({ type: "explore", description: "err", prompt: "x", model: "faux-sub/faux-1" });
		await manager.execute(record, { spec: spec("explore", { agentId: record.agentId }), task: "x" });
		expect(record.status).toBe("failed");
		expect(record.reason).toContain("invalid request: bad schema");
	});

	it("runs the agent tool end to end through the extension with the real child factory", async () => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }), fauxAssistantMessage("hello.txt says hi.")]);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		let tool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { status: string; resultFile?: string; sessionFile?: string } }> } | undefined;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			registerTool: (definition: typeof tool & { name: string }) => {
				if (definition.name === "agent") tool = definition;
			},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			appendEntry: () => {},
			events: { emit: () => {}, on: () => () => {} },
			getActiveTools: () => ["read", "bash", "agent"],
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		const fauxModel = factoryOptions.parentRegistry.find(faux.provider.id, faux.getModel().id);
		const ctx = {
			cwd,
			mode: "print",
			hasUI: false,
			model: fauxModel,
			isProjectTrusted: () => false,
			ui: { notify: () => {} },
			modelRegistry: factoryOptions.parentRegistry,
			sessionManager: {
				getSessionDir: () => parentSessionDir,
				getSessionId: () => "parent-9",
				getSessionFile: () => join(parentSessionDir, "parent-9.jsonl"),
				getEntries: () => [],
			},
		};
		createSubagentExtension({ agentDir: () => agentDir })(pi);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const result = await tool?.execute("call-1", { description: "read hello", prompt: "What does hello.txt say?", agent_type: "explore" }, undefined, undefined, ctx);
		if (!result) throw new Error("no result");

		const childDir = join(parentSessionDir, "subagents", "parent-9");
		expect(result.details.status).toBe("completed");
		expect(result.content[0]?.text).toMatch(/^<subagent-result agent-id="ag-1" type="explore" status="completed" turns="2" tool-calls="1" duration="\d+s">\nhello\.txt says hi\.\n<\/subagent-result>\ntranscript: /);
		expect(result.details.resultFile).toBe(join(childDir, "ag-1.result.md"));
		expect(readFileSync(join(childDir, "ag-1.result.md"), "utf8")).toBe("hello.txt says hi.");
		expect(dirname(result.details.sessionFile ?? "")).toBe(childDir);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	});

	it("aborts a running child when the parent's signal fires", async () => {
		await abortedByParent();
	});
});

interface ToolResultLike {
	content: Array<{ text: string }>;
	details?: { status: string; agentId: string; sessionFile?: string; background?: boolean };
	isError?: boolean;
}

/** The extension with the real child factory, a fake parent pi and ctx (rpc mode: background allowed, no TUI). */
async function extensionHarness() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<ToolResultLike> }>();
	const sent: Array<{ message: { content: string; customType: string }; options: { triggerTurn?: boolean } }> = [];
	const appended: Array<{ status: string; agentId: string }> = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerTool: (definition: { name: string; execute: (...args: unknown[]) => Promise<ToolResultLike> }) => tools.set(definition.name, definition),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		getActiveTools: () => ["read", "bash", "agent"],
		getThinkingLevel: () => "off",
		appendEntry: (_type: string, data: { status: string; agentId: string }) => appended.push({ ...data }),
		sendMessage: (message: { content: string; customType: string }, options: { triggerTurn?: boolean }) => sent.push({ message, options }),
		events: { emit: () => {}, on: () => () => {} },
	} as unknown as ExtensionAPI;
	const fauxModel = factoryOptions.parentRegistry.find(faux.provider.id, faux.getModel().id);
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: false,
		model: fauxModel,
		isIdle: () => true,
		isProjectTrusted: () => false,
		ui: { notify: () => {} },
		modelRegistry: factoryOptions.parentRegistry,
		sessionManager: {
			getSessionDir: () => parentSessionDir,
			getSessionId: () => "parent-bg",
			getSessionFile: () => join(parentSessionDir, "parent-bg.jsonl"),
			getEntries: () => [],
		},
	};
	createSubagentExtension({ agentDir: () => agentDir, windowMs: 50, stopWaitMs: 3000 })(pi);
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	const call = async (name: string, params: Record<string, unknown>): Promise<ToolResultLike> => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		return tool.execute("call-1", params, undefined, undefined, ctx);
	};
	const shutdown = () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	return { call, sent, appended, shutdown };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A faux response that waits until the request is aborted (like a real provider stream). */
function slowResponse(ms = 8000) {
	return async (_context: unknown, options?: { signal?: AbortSignal }) => {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		return fauxAssistantMessage("too late");
	};
}

describe("Phase 2 through the extension (real SDK, faux provider)", () => {
	it("runs a background agent and notifies through the batcher", async () => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }), fauxAssistantMessage("Background answer: hello.txt.")]);
		const h = await extensionHarness();
		const started = await h.call("agent", { description: "list in background", prompt: "List the files.", agent_type: "explore", background: true });
		expect(started.content[0]?.text).toMatch(/^Started subagent ag-1 \(explore\): list in background\n/);
		expect(h.sent).toEqual([]);

		await waitFor(() => h.sent.length > 0);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(h.sent[0]?.message.customType).toBe("subagent-notification");
		const content = h.sent[0]?.message.content ?? "";
		expect(content).toMatch(/^<subagent-notification>\n<agent agent-id="ag-1" type="explore" status="completed" turns="2" tool-calls="1" duration="\d+s">/);
		expect(content).toContain("<result>\nBackground answer: hello.txt.\n</result>");
		expect(content).toContain('Subagent ag-1 "list in background" completed.');
		expect(h.appended.map((entry) => entry.status)).toEqual(["queued", "running", "running", "completed"]);
		await h.shutdown();
	});

	it("continues a finished agent with agent_send by reopening its session file", async () => {
		const seen: string[] = [];
		faux.setResponses([
			fauxAssistantMessage("The codename is BLUE-HERON."),
			(context: { messages: unknown[] }) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("You told me BLUE-HERON earlier.");
			},
		]);
		const h = await extensionHarness();
		const first = await h.call("agent", { description: "remember", prompt: "Remember the codename BLUE-HERON.", agent_type: "explore" });
		expect(first.details?.status).toBe("completed");
		expect(first.content[0]?.text).toContain('Use agent_send with agent_id "ag-1" to ask this subagent a follow-up; it keeps its context.');
		const transcript = first.details?.sessionFile ?? "";
		expect(transcript).not.toBe("");

		const reply = await h.call("agent_send", { agent_id: "ag-1", message: "What was the codename?" });
		expect(reply.isError).toBe(false);
		expect(reply.content[0]?.text).toMatch(/^<subagent-result agent-id="ag-1" type="explore" status="completed" turns="1" /);
		expect(reply.content[0]?.text).toContain("You told me BLUE-HERON earlier.");
		// Same transcript, and the resumed child saw the whole first conversation.
		expect(reply.details?.sessionFile).toBe(transcript);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain("Remember the codename BLUE-HERON.");
		expect(seen[0]).toContain("The codename is BLUE-HERON.");
		expect(seen[0]).toContain("What was the codename?");
		const lines = readFileSync(transcript, "utf8").trim().split("\n");
		expect(lines.filter((line) => line.includes('"type":"session"'))).toHaveLength(1);
		expect(lines.filter((line) => line.includes('"role":"user"'))).toHaveLength(2);
		const childDir = join(parentSessionDir, "subagents", "parent-bg");
		expect(readFileSync(join(childDir, "ag-1.result.md"), "utf8")).toBe("You told me BLUE-HERON earlier.");
		expect(readFileSync(join(childDir, "ag-1.result.1.md"), "utf8")).toBe("The codename is BLUE-HERON.");
		await h.shutdown();
	});

	it("stops a background agent with agent_stop and does not notify", async () => {
		faux.setResponses([slowResponse()]);
		const h = await extensionHarness();
		await h.call("agent", { description: "slow", prompt: "Take your time.", agent_type: "explore", background: true });
		await waitFor(() => h.appended.some((entry) => entry.status === "running"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		const startedAt = Date.now();
		const stopped = await h.call("agent_stop", { agent_id: "ag-1" });
		expect(Date.now() - startedAt).toBeLessThan(3000);
		expect(stopped.content[0]?.text).toMatch(/^Stopped subagent ag-1 \(slow\) after \d+s\.\n<subagent-result agent-id="ag-1" type="explore" status="aborted"/);
		expect(stopped.content[0]?.text).toContain("reason: stopped by parent");
		// Give a late notification every chance to appear.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.sent).toEqual([]);
		expect(h.appended.at(-1)).toMatchObject({ agentId: "ag-1", status: "aborted" });
		await h.shutdown();
	});
});

/** Phase 1 case, kept as a function so the Phase 2 helpers above stay next to their tests. */
async function abortedByParent(): Promise<void> {
	{
		// A slow response that, like a real provider, gives up when the request's signal aborts.
		faux.setResponses([
			async (_context, options) => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5000);
					options?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				return fauxAssistantMessage("too late");
			},
		]);
		const manager = new AgentManager({ factory: createChildSessionFactory(factoryOptions), maxConcurrent: () => 4 });
		const record = manager.create({ type: "explore", description: "slow", prompt: "x", model: "faux-sub/faux-1" });
		const controller = new AbortController();
		const done = manager.execute(record, { spec: spec("explore", { agentId: record.agentId }), task: "x", signal: controller.signal, onStart: () => setTimeout(() => controller.abort(), 300) });
		const startedAt = Date.now();
		await done;
		expect(record).toMatchObject({ status: "aborted", reason: "parent interrupted" });
		expect(Date.now() - startedAt).toBeLessThan(4500);
	}
}
