// pi-subagent: delegate a bounded task to a fresh in-process pi session with its own context window.
// Phase 1: foreground `agent`, /agents types, /agents reload. Phase 2: background runs and notifications,
// agent_send / agent_stop, persistence and restore, cleanup, the extension allowlist, the HUD rows (drawn by
// pi-hud), keyboard focus, the detail overlay and the /agents list (docs/08 §3).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BoundaryResult,
	type BoundaryState,
	type CustomMessageEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { DEFAULT_WINDOW_MS, NotificationBatcher } from "./batcher.js";
import { createChildSessionFactory } from "./child.js";
import { cleanupOldSessions, DAY_MS } from "./cleanup.js";
import { CONFIG_FILE_NAME, isThinkingLevel, loadConfig, type SubagentConfig, THINKING_LEVELS, type ThinkingLevel } from "./config.js";
import { setSetting, settingsItems } from "./settings.js";
import { exposeSettings } from "./shizuku-settings.js";
import { AgentDetailView, type DetailSource, isStoppable, OVERLAY_OPTIONS } from "./detail.js";
import { FocusController } from "./focus.js";
import {
	buildHudState,
	EMPTY_STATE,
	focusOrder,
	HUD_CHANNEL,
	HUD_REQUEST_CHANNEL,
	type HudState,
	nextExpiry,
	OPEN_CHANNEL,
	STATE_CHANNEL,
	STATE_REQUEST_CHANNEL,
} from "./hud-state.js";
import { AgentListView, describeAgents } from "./list.js";
import { type AgentEntry, AgentManager, type AgentRecord, ENTRY_TYPE, isActive, isTerminal, STOP_WAIT_MS, toEntry } from "./manager.js";
import { formatModel, type ModelCatalog, type ModelRef, resolveModel, resolveThinking } from "./models.js";
import { contextPercent, type ProgressSnapshot } from "./observer.js";
import {
	AGENT_SEND_DESCRIPTION,
	AGENT_SEND_GUIDELINE,
	AGENT_STOP_DESCRIPTION,
	AGENT_STOP_GUIDELINE,
	agentGuidelines,
	PARAM_DESCRIPTIONS,
	PROMPT_SNIPPET,
	toolDescription,
} from "./prompts.js";
import {
	agentCardRenderers,
	type AgentToolDetails,
	CardLink,
	callLabel,
	NOTIFICATION_PREVIEW_LINES,
	type NotificationDetails,
	notificationLines,
	renderStopCall,
	renderStopResult,
} from "./render.js";
import {
	durationOf,
	formatDuration,
	formatNotification,
	formatResult,
	formatStarted,
	isContinuable,
	type NotificationItem,
	writeResultFile,
} from "./result.js";
import { type ChildSessionFactory, type ChildSpec, SESSION_ENDED } from "./run.js";
import { type AgentType, builtinAgentsDir, effectiveTools, type LoadedTypes, loadAgentTypes, lookupType } from "./types.js";

export const TOOL_NAME = "agent";
export const SEND_TOOL_NAME = "agent_send";
export const STOP_TOOL_NAME = "agent_stop";
export const NOTIFICATION_TYPE = "subagent-notification";
/** A zero-height widget below the editor; its factory hands us the TUI for the editor-focus check. */
const FOCUS_WIDGET_KEY = "pi-subagent-focus";
const PROGRESS_THROTTLE_MS = 100;
const HEARTBEAT_MS = 1000;

const agentSchema = Type.Object({
	description: Type.String({ description: PARAM_DESCRIPTIONS.description }),
	prompt: Type.String({ description: PARAM_DESCRIPTIONS.prompt }),
	agent_type: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.agent_type })),
	model: Type.Optional(Type.String({ description: PARAM_DESCRIPTIONS.model })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: PARAM_DESCRIPTIONS.thinking })),
	background: Type.Optional(Type.Boolean({ description: PARAM_DESCRIPTIONS.background })),
});

const sendSchema = Type.Object({
	agent_id: Type.String({ description: PARAM_DESCRIPTIONS.agent_id }),
	message: Type.String({ description: PARAM_DESCRIPTIONS.message }),
	background: Type.Optional(Type.Boolean({ description: PARAM_DESCRIPTIONS.send_background })),
});

const stopSchema = Type.Object({
	agent_id: Type.String({ description: PARAM_DESCRIPTIONS.agent_id }),
});

export interface SubagentDeps {
	/** Child session factory for a session; tests substitute a fake. Default: real in-process pi sessions. */
	createFactory?: (ctx: ExtensionContext, agentDir: string, childExtensions: () => readonly string[]) => ChildSessionFactory;
	/** Default: getAgentDir(). */
	agentDir?: () => string;
	/** Default: the plugin's agents/ directory. */
	builtinDir?: string;
	/** Notification merge window (default 3 s). */
	windowMs?: number;
	/** How long agent_stop waits for a stopped run (default 5 s). */
	stopWaitMs?: number;
}

interface FocusableTui {
	getFocusedComponent(): unknown;
}

interface SessionState {
	ctx: ExtensionContext;
	config: SubagentConfig;
	configError?: string;
	configWarnings: string[];
	loaded: LoadedTypes;
	manager: AgentManager;
	batcher: NotificationBatcher<AgentRecord>;
	/** Child session files; undefined for an in-memory parent (children are in-memory too). */
	childDir?: string;
	resultDir: string;
	parentSessionFile?: string;
	/** print / json: pi exits after this run, so background runs are unavailable (docs/02 §12). */
	oneShot: boolean;
	/** Set at session_shutdown; nothing touches pi or ctx afterwards. */
	closed: boolean;
	focus?: FocusController;
	/** pi-hud draws the agent rows (subagent:hud). */
	hudRendering: boolean;
	/** The /agents list is in the editor slot (docs/07 §7). */
	listOpen: boolean;
	/** The detail overlay is showing, on its own or on top of the list (docs/07 §5). */
	detailOpen: boolean;
	/** The TUI from the focus widget's factory (a proxy that follows renderer switches). */
	tui?: object;
	lastState?: string;
	expiryTimer?: ReturnType<typeof setTimeout>;
	disposers: Array<() => void>;
}

interface LaunchOptions {
	background: boolean;
	verb: "Started" | "Continuing";
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<AgentToolDetails>;
}

type AgentParams = { description: string; prompt: string; agent_type?: string; model?: string; thinking?: ThinkingLevel; background?: boolean };

export function createSubagentExtension(deps: SubagentDeps = {}): (pi: ExtensionAPI) => void {
	const builtinDir = deps.builtinDir ?? builtinAgentsDir();
	const agentDirOf = deps.agentDir ?? getAgentDir;
	const stopWaitMs = deps.stopWaitMs ?? STOP_WAIT_MS;

	return function piSubagent(pi: ExtensionAPI): void {
		let state: SessionState | undefined;
		let registeredKey: string | undefined;
		// Background cards look up their agent in the current session's manager (docs/07 §1.4).
		const cardLink = new CardLink();
		const cardRenderers = agentCardRenderers(cardLink);

		const registerAgentTool = (description: string, guidelines: string[]): void => {
			const key = `${description}\n\n${guidelines.join("\n")}`;
			if (key === registeredKey) return;
			registeredKey = key;
			pi.registerTool<typeof agentSchema, AgentToolDetails>({
				name: TOOL_NAME,
				label: "Agent",
				description,
				promptSnippet: PROMPT_SNIPPET,
				promptGuidelines: guidelines,
				parameters: agentSchema,
				// No executionMode: one "sequential" tool would serialize the whole batch (agent-loop.ts:525-533).
				renderShell: "self",
				execute: (_toolCallId, params, signal, onUpdate, ctx) =>
					runAgentTool(
						requireState(state),
						pi,
						// StringEnum's static type does not narrow across typebox copies; the schema already validated it.
						{ ...params, thinking: isThinkingLevel(params.thinking) ? params.thinking : undefined },
						signal,
						onUpdate,
						ctx,
					),
				renderCall: cardRenderers.renderCall,
				renderResult: cardRenderers.renderResult,
			});
		};

		const registerDescription = (current: Pick<SessionState, "loaded" | "oneShot">): void => {
			const options = { background: !current.oneShot };
			registerAgentTool(toolDescription(current.loaded.types.values(), options), agentGuidelines(options));
		};

		const loadTypes = (ctx: ExtensionContext, config: SubagentConfig): LoadedTypes => {
			const agentDir = agentDirOf();
			return loadAgentTypes(
				{
					builtinDir,
					userDir: join(agentDir, "agents"),
					projectDir: join(ctx.cwd, ".pi", "agents"),
					projectTrusted: ctx.isProjectTrusted(),
				},
				config,
			);
		};

		const loadSettings = (ctx: ExtensionContext): Pick<SessionState, "config" | "configError" | "configWarnings" | "loaded"> => {
			const loadedConfig = loadConfig(join(agentDirOf(), CONFIG_FILE_NAME));
			return {
				config: loadedConfig.config,
				configError: loadedConfig.error,
				configWarnings: loadedConfig.warnings,
				loaded: loadTypes(ctx, loadedConfig.config),
			};
		};

		// Registered at load with the built-in types so the tools exist before session_start; the description
		// is rebuilt once per session_start, never mid-session (docs/04 §6).
		registerDescription({ loaded: loadAgentTypes({ builtinDir, userDir: "", projectDir: "", projectTrusted: false }), oneShot: false });

		pi.registerTool<typeof sendSchema, AgentToolDetails>({
			name: SEND_TOOL_NAME,
			label: "Agent Send",
			description: AGENT_SEND_DESCRIPTION,
			promptSnippet: "Send a follow-up to a subagent by its agent id; a finished one resumes with its full context",
			promptGuidelines: [AGENT_SEND_GUIDELINE],
			parameters: sendSchema,
			renderShell: "self",
			execute: (_toolCallId, params, signal, onUpdate, ctx) => runSendTool(requireState(state), pi, params, signal, onUpdate, ctx),
			renderCall: cardRenderers.renderCall,
			renderResult: cardRenderers.renderResult,
		});

		pi.registerTool({
			name: STOP_TOOL_NAME,
			label: "Agent Stop",
			description: AGENT_STOP_DESCRIPTION,
			promptSnippet: "Stop a running or queued subagent by its agent id",
			promptGuidelines: [AGENT_STOP_GUIDELINE],
			parameters: stopSchema,
			execute: (_toolCallId, params) => runStopTool(requireState(state), params.agent_id, stopWaitMs),
			renderShell: "self",
			renderCall: renderStopCall,
			renderResult: renderStopResult,
		});

		pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, options, theme) => {
			// Markers sit in the gutter's column 0 (pi-shizuku README.md), not at pi's outputPad.
			return new Text(notificationLines(message.details, options.expanded, theme).join("\n"), 0, 0);
		});

		// Busy parent: drain everything that finished during this turn into one message (docs/06 §5.3).
		pi.on("turn_end", (event) => drainAtBoundary(state, event));
		pi.on("agent_before_settle", (event) => drainAtBoundary(state, event));
		// Agents that finished after the last boundary. An aborted run is not restarted: the notification is
		// recorded and the model sees it with the next prompt.
		pi.on("agent_settled", (event) => drainSettled(pi, state, event.aborted));

		pi.on("session_start", (_event, ctx) => {
			const settings = loadSettings(ctx);
			const sessionManager = ctx.sessionManager;
			const parentId = sessionManager.getSessionId();
			const parentSessionFile = sessionManager.getSessionFile();
			const subagentsRoot = parentSessionFile ? join(sessionManager.getSessionDir(), "subagents") : undefined;
			const childDir = subagentsRoot ? join(subagentsRoot, parentId) : undefined;
			const tmpRoot = join(tmpdir(), "pi-subagent");
			const resultDir = childDir ?? join(tmpRoot, parentId);
			const childExtensions = (): readonly string[] => current.config.childExtensions;
			const factory =
				deps.createFactory?.(ctx, agentDirOf(), childExtensions) ??
				createChildSessionFactory({ parentRegistry: ctx.modelRegistry, agentDir: agentDirOf(), childExtensions });

			const current: SessionState = {
				...settings,
				ctx,
				childDir,
				resultDir,
				parentSessionFile,
				oneShot: ctx.mode === "print" || ctx.mode === "json",
				closed: false,
				hudRendering: false,
				listOpen: false,
				detailOpen: false,
				disposers: [],
				manager: new AgentManager({
					factory,
					maxConcurrent: () => current.config.maxConcurrent,
					firstId: nextAgentNumber(resultDir),
					persist: (record) => {
						if (!current.closed) pi.appendEntry(ENTRY_TYPE, toEntry(record));
					},
					onFinished: (record) => finalize(current, record),
				}),
				batcher: new NotificationBatcher<AgentRecord>({
					isIdle: () => ctx.isIdle(),
					hasRunning: () => current.manager.list().some((record) => record.background && isActive(record.status)),
					deliverIdle: (batch) => deliver(pi, current, batch, true),
					windowMs: deps.windowMs ?? DEFAULT_WINDOW_MS,
				}),
			};
			state = current;

			// Restore (docs/06 §8): records from this session's entries; the ones a dead process left running are closed.
			const entries: AgentEntry[] = [];
			for (const entry of sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === ENTRY_TYPE) entries.push(entry.data as AgentEntry);
			}
			for (const record of current.manager.restore(entries)) pi.appendEntry(ENTRY_TYPE, toEntry(record));
			// After restore, so cards drawn before session_start (resume, /reload) redraw to their record's state.
			cardLink.attach(current.manager);

			registerDescription(current);
			notifyProblems(ctx, current);

			const maxAge = current.config.retentionDays * DAY_MS;
			if (subagentsRoot) void cleanupOldSessions(subagentsRoot, parentId, maxAge);
			void cleanupOldSessions(tmpRoot, parentId, maxAge);

			setupHud(pi, current);
		});

		pi.on("session_shutdown", async () => {
			const current = state;
			state = undefined;
			if (!current) return;
			current.closed = true;
			// pi disposes an open list or detail with the session UI without settling its custom() promise, so
			// the finally blocks in openList / openDetail may never run; this state is dead either way.
			current.listOpen = false;
			current.detailOpen = false;
			current.batcher.dispose();
			current.focus?.dispose();
			if (current.expiryTimer) clearTimeout(current.expiryTimer);
			for (const dispose of current.disposers.splice(0)) {
				try {
					dispose();
				} catch {
					// Best effort while pi tears the session down.
				}
			}
			pi.events.emit(STATE_CHANNEL, EMPTY_STATE);
			// The link stays attached through shutdown, so cards of agents it aborts redraw as stopped.
			await current.manager.shutdown();
			cardLink.detach(current.manager);
		});

		// The /shizuku panel (pi-shizuku-settings) edits the scalar fields of pi-subagent.json; a change goes
		// into the running session's config at once. Type overrides stay with /agents reload.
		exposeSettings(pi, {
			id: "pi-subagent",
			title: "pi-subagent",
			description: "Delegate bounded tasks to fresh in-process sessions",
			file: join(agentDirOf(), CONFIG_FILE_NAME),
			items: () => settingsItems(state?.config ?? loadConfig(join(agentDirOf(), CONFIG_FILE_NAME)).config),
			set: (id, value) =>
				setSetting(join(agentDirOf(), CONFIG_FILE_NAME), id, value, (patch) => {
					const current = state;
					if (!current) return;
					current.config = { ...current.config, ...patch };
					// A higher limit can start queued agents now.
					if (patch.maxConcurrent !== undefined) current.manager.pump();
				}),
		});

		pi.registerCommand("agents", {
			description: "Subagents: /agents lists this session's agents, /agents types lists types, /agents reload re-reads type files and config",
			getArgumentCompletions: (prefix) =>
				["types", "reload"].filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name })),
			handler: async (args, ctx) => {
				const current = state;
				if (!current) return;
				const command = args.trim().toLowerCase();
				if (command === "") {
					if (ctx.mode !== "tui" || !ctx.hasUI) {
						ctx.ui.notify(describeAgents(current.manager.list()), "info");
						return;
					}
					await openList(current);
					return;
				}
				if (command === "types") {
					ctx.ui.notify(describeTypes(current), "info");
					return;
				}
				if (command === "reload") {
					Object.assign(current, loadSettings(ctx));
					const before = registeredKey;
					registerDescription(current);
					current.manager.pump();
					const changed = registeredKey !== before;
					ctx.ui.notify(
						`Reloaded ${current.loaded.types.size} agent types.${
							changed
								? " The agent tool description changed; the next request will not hit the prompt cache."
								: " The agent tool description is unchanged."
						}`,
						"info",
					);
					notifyProblems(ctx, current);
					return;
				}
				ctx.ui.notify("Usage: /agents | /agents types | /agents reload", "info");
			},
		});
	};
}

export default createSubagentExtension();

function requireState(state: SessionState | undefined): SessionState {
	if (!state) throw new Error("pi-subagent is not ready: no active session");
	return state;
}

// ---------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------

async function runAgentTool(
	state: SessionState,
	pi: ExtensionAPI,
	params: AgentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<AgentToolDetails>> {
	// 1. Type and model; errors are thrown so the model sees them and corrects the call.
	const type = lookupType(state.loaded.types, params.agent_type);
	if (!type) {
		const known = [...state.loaded.types.keys()].join(", ");
		throw new Error(
			`Unknown agent type "${params.agent_type}". Available types: ${known}. Type files added after the session started are loaded with /agents reload.`,
		);
	}
	if (params.background === true && state.oneShot) throw oneShotError();
	// A type's background default does not apply in one-shot modes; the run falls back to the foreground.
	const background = params.background ?? (type.background && !state.oneShot);
	const parentModel = parentModelOf(ctx);
	const resolution = resolveModel({ param: params.model, configured: type.model, parent: parentModel }, catalogOf(ctx.modelRegistry));
	const thinking = resolveThinking(params.thinking, type.thinking, ctx.thinkingLevel ?? pi.getThinkingLevel());

	// 2. Snapshot the parent now, not when the agent leaves the queue (docs/02 §2).
	const description = callLabel(params);
	const record = state.manager.create({
		type: type.name,
		description,
		prompt: params.prompt,
		model: formatModel(resolution.model),
		background,
		maxTurns: type.maxTurns,
	});
	record.notes.push(...resolution.notes);
	const spec = childSpec(state, pi, ctx, record, type, resolution.model, thinking);
	return launch(state, record, type, spec, params.prompt, { background, verb: "Started", signal, onUpdate });
}

async function runSendTool(
	state: SessionState,
	pi: ExtensionAPI,
	params: { agent_id: string; message: string; background?: boolean },
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<AgentToolDetails>> {
	const agentId = params.agent_id.trim();
	const record = state.manager.get(agentId);
	if (!record) throw unknownAgent(state, agentId);
	const message = params.message;

	if (!isTerminal(record.status)) {
		const sent = await state.manager.send(agentId, message);
		if (sent.kind !== "finished") {
			return {
				content: [{ type: "text", text: `Message queued for ${agentId}; it will be part of the report you receive when it finishes.` }],
				details: undefined as unknown as AgentToolDetails,
			};
		}
	}

	// Finished: reopen the transcript and run again (docs/06 §6).
	if (record.contextLimited) {
		const fill = record.context ? ` (${contextPercent(record.context)}% used)` : "";
		throw new Error(`${agentId} cannot be continued: its context window is nearly full${fill}. Start a new agent.`);
	}
	const transcript = existingFile(record.sessionFile);
	if (!transcript) throw new Error(`${agentId} cannot be continued: its transcript is no longer available. Start a new agent.`);
	if (params.background === true && state.oneShot) throw oneShotError();
	const background = params.background ?? false;
	const type = lookupType(state.loaded.types, record.type);
	if (!type) throw new Error(`${agentId} cannot be continued: its agent type "${record.type}" is no longer loaded. Start a new agent.`);
	// Type and model resolve as they would now; a changed type file applies.
	const resolution = resolveModel({ configured: type.model, parent: parentModelOf(ctx) }, catalogOf(ctx.modelRegistry));
	const thinking = resolveThinking(undefined, type.thinking, ctx.thinkingLevel ?? pi.getThinkingLevel());
	state.manager.reopen(agentId, { prompt: message, model: formatModel(resolution.model), background, maxTurns: type.maxTurns });
	record.notes.push(...resolution.notes);
	const spec = { ...childSpec(state, pi, ctx, record, type, resolution.model, thinking), resumeFile: transcript };
	return launch(state, record, type, spec, message, { background, verb: "Continuing", signal, onUpdate });
}

async function runStopTool(state: SessionState, rawId: string, waitMs: number): Promise<AgentToolResult<undefined>> {
	const agentId = rawId.trim();
	const before = state.manager.get(agentId);
	if (!before) throw unknownAgent(state, agentId);
	const wasActive = isActive(before.status);
	const record = (await state.manager.stop(agentId, "parent", waitMs)) ?? before;
	const formatted = formatResult(record, {
		maxChars: state.config.resultMaxChars,
		resultFile: record.resultFile,
		transcript: existingFile(record.sessionFile),
	});
	const first = wasActive
		? `Stopped subagent ${agentId} (${record.description}) after ${formatDuration(durationOf(record))}.`
		: `${agentId} had already finished: ${record.status}.`;
	return { content: [{ type: "text", text: `${first}\n${formatted.text}` }], details: undefined };
}

/** Queue and run; the foreground waits with progress, the background returns at once (docs/06 §4). */
async function launch(
	state: SessionState,
	record: AgentRecord,
	type: AgentType,
	spec: ChildSpec,
	task: string,
	options: LaunchOptions,
): Promise<AgentToolResult<AgentToolDetails>> {
	if (options.background) {
		// Not tied to the tool call's signal: Esc on the parent does not stop background agents (docs/06 §4.2).
		void state.manager.execute(record, { spec, task }).catch(() => {});
		const position = state.manager.position(record.agentId);
		const details = detailsOf(record, type, { truncated: false, queuePosition: position || undefined });
		// execute() took a slot synchronously unless it queued; the status flips to running a tick later.
		if (position === 0 && details.status === "queued") details.status = "running";
		return {
			content: [{ type: "text", text: formatStarted(record, position, options.verb) }],
			details: { ...details, background: true, run: record.runs },
		};
	}

	const progress = progressReporter(record, type, options.onUpdate, () => state.manager.position(record.agentId));
	try {
		await state.manager.execute(record, {
			spec,
			task,
			signal: options.signal,
			onQueued: () => progress.emit(),
			onStart: () => progress.start(),
			onProgress: (snapshot) => progress.schedule(snapshot),
		});
	} finally {
		progress.stop();
	}

	// The result file was written when the run finished (finalize).
	const transcript = existingFile(record.sessionFile);
	const formatted = formatResult(record, { maxChars: state.config.resultMaxChars, resultFile: record.resultFile, transcript });
	return {
		content: [{ type: "text", text: formatted.text }],
		details: detailsOf(record, type, { truncated: formatted.truncated, sessionFile: transcript }),
		// Failed, aborted and out-of-turns runs are errors the model must notice; details stay for the card.
		isError: record.status !== "completed",
	};
}

function childSpec(
	state: SessionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	record: AgentRecord,
	type: AgentType,
	model: ModelRef | undefined,
	thinking: ThinkingLevel | undefined,
): ChildSpec {
	return {
		agentId: record.agentId,
		description: record.description,
		type: { ...type, tools: effectiveTools(type, pi.getActiveTools()) },
		cwd: ctx.cwd,
		model,
		thinking,
		sessionDir: state.childDir,
		parentSessionFile: state.parentSessionFile,
	};
}

function oneShotError(): Error {
	return new Error(
		"background is not available in print or json mode: pi exits when this run ends, so the notification could never arrive. Run the agent in the foreground.",
	);
}

function unknownAgent(state: SessionState, agentId: string): Error {
	const known = state.manager.list().map((record) => record.agentId);
	return new Error(`Unknown subagent ${agentId}.${known.length > 0 ? ` Known agents: ${known.join(", ")}.` : " No subagents have been started in this session."}`);
}

function parentModelOf(ctx: ExtensionContext): ModelRef | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function existingFile(path: string | undefined): string | undefined {
	return path && existsSync(path) ? path : undefined;
}


// ---------------------------------------------------------------------------------------------------------
// Finishing and notifications (docs/06 §5)
// ---------------------------------------------------------------------------------------------------------

/** A run reached its terminal state: write the result file, then notify if this ending calls for it. */
function finalize(state: SessionState, record: AgentRecord): void {
	if (state.closed) {
		record.notified = true;
		return;
	}
	try {
		record.resultFile = writeResultFile(state.resultDir, record.agentId, record.text ?? "");
	} catch (error) {
		record.notes.push(`could not write the result file: ${(error as Error).message}`);
	}
	if (shouldNotify(record)) state.batcher.enqueue(record);
	else record.notified = true;
}

/** docs/06 §5.2: background runs only; not when the model stopped it itself or the session is ending. */
export function shouldNotify(record: Pick<AgentRecord, "background" | "status" | "stoppedBy" | "reason">): boolean {
	if (!record.background) return false;
	if (record.status === "aborted" && (record.stoppedBy === "parent" || record.reason === SESSION_ENDED)) return false;
	return true;
}

function notificationMessage(state: SessionState, batch: readonly AgentRecord[]): {
	customType: string;
	content: string;
	display: boolean;
	details: NotificationDetails;
} {
	const items: NotificationItem[] = batch.map((record) => ({ record, continuable: isContinuable(record, existingFile(record.sessionFile)) }));
	return {
		customType: NOTIFICATION_TYPE,
		content: formatNotification(items, { perAgent: state.config.notifyMaxChars, batch: state.config.notifyBatchMaxChars }),
		display: true,
		details: {
			agents: batch.map((record) => ({
				agentId: record.agentId,
				type: record.type,
				description: record.description,
				status: record.status,
				reason: record.reason,
				toolCalls: record.stats.toolCalls,
				durationMs: durationOf(record),
				resultFile: record.resultFile,
				preview: (record.text ?? "").split(/\r?\n/).slice(0, NOTIFICATION_PREVIEW_LINES),
			})),
		},
	};
}

function deliver(pi: ExtensionAPI, state: SessionState, batch: AgentRecord[], triggerTurn: boolean): void {
	if (state.closed || batch.length === 0) return;
	for (const record of batch) record.notified = true;
	pi.sendMessage(notificationMessage(state, batch), { triggerTurn, deliverAs: "steer" });
}

function drainAtBoundary(state: SessionState | undefined, event: BoundaryState): BoundaryResult | undefined {
	if (!state || state.closed || event.outcome !== "completed" || state.batcher.size === 0) return undefined;
	const batch = state.batcher.take();
	for (const record of batch) record.notified = true;
	const draft: CustomMessageEntryDraft = { type: "custom_message", ...notificationMessage(state, batch) };
	return { entries: [...event.entries, draft], continue: true };
}

function drainSettled(pi: ExtensionAPI, state: SessionState | undefined, aborted: boolean): void {
	if (!state || state.closed || state.batcher.size === 0) return;
	deliver(pi, state, state.batcher.take(), !aborted);
}

// ---------------------------------------------------------------------------------------------------------
// HUD rows, keyboard focus, the /agents list (bottom slot) and the detail overlay (docs/07 §3-§7)
// ---------------------------------------------------------------------------------------------------------

function setupHud(pi: ExtensionAPI, state: SessionState): void {
	const { ctx, manager } = state;

	const emitState = (force = false): void => {
		if (state.closed) return;
		const now = Date.now();
		const parent = parentModelOf(ctx);
		const hud: HudState = buildHudState(manager.list(), {
			now,
			parentModel: parent ? formatModel(parent) : undefined,
			focusId: state.focus?.active ? state.focus.selectedId : undefined,
			focusArmed: state.focus?.armed === true,
		});
		const json = JSON.stringify(hud);
		if (force || json !== state.lastState) {
			state.lastState = json;
			pi.events.emit(STATE_CHANNEL, hud);
		}
		// Finished rows leave the HUD 60 s after they end; refresh then.
		if (state.expiryTimer) clearTimeout(state.expiryTimer);
		state.expiryTimer = undefined;
		const expiry = nextExpiry(manager.list(), now);
		if (expiry !== undefined) {
			state.expiryTimer = setTimeout(() => emitState(), expiry - now + 50);
			state.expiryTimer.unref?.();
		}
	};

	state.disposers.push(
		manager.subscribe(() => {
			state.focus?.sync();
			emitState();
		}),
	);
	state.disposers.push(pi.events.on(STATE_REQUEST_CHANNEL, () => emitState(true)));
	state.disposers.push(
		pi.events.on(HUD_CHANNEL, (data) => {
			state.hudRendering = (data as { rendering?: unknown } | undefined)?.rendering === true;
			state.focus?.setHudRendering(state.hudRendering);
		}),
	);
	state.disposers.push(
		pi.events.on(OPEN_CHANNEL, (data) => {
			const agentId = (data as { agentId?: unknown } | undefined)?.agentId;
			state.focus?.exit();
			// An agent row opens its detail, also on top of an open list; "+N more" opens the list unless it is open.
			if (typeof agentId === "string" && manager.get(agentId)) void openDetail(state, agentId, "mouse");
			else void openList(state);
		}),
	);

	if (ctx.mode === "tui" && ctx.hasUI) {
		// The widget renders nothing (zero lines below the editor); its factory gives us the TUI, whose focused
		// component tells whether the editor or a dialog/selector has the keyboard.
		ctx.ui.setWidget(
			FOCUS_WIDGET_KEY,
			(tui) => {
				state.tui = tui;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);
		state.disposers.push(() => ctx.ui.setWidget(FOCUS_WIDGET_KEY, undefined));

		const focus = new FocusController({
			hudRendering: () => state.hudRendering,
			editorEmpty: () => ctx.ui.getEditorText() === "",
			// Our own list and overlay first: they hold the keyboard even when the TUI reference is missing.
			editorFocused: () => !state.listOpen && !state.detailOpen && editorHasFocus(state.tui),
			agentIds: () => focusOrder(manager.list()).map((record) => record.agentId),
			open: (agentId) => void openDetail(state, agentId, "focus"),
			stop: (agentId) => void manager.stop(agentId, "user"),
			canStop: (agentId) => {
				const record = manager.get(agentId);
				return record !== undefined && isStoppable(record);
			},
			confirmStop: () => state.config.confirmStop,
			onChange: () => emitState(),
		});
		state.focus = focus;
		state.disposers.push(ctx.ui.onTerminalInput(focus.handleInput));
	}

	// pi-hud may have announced itself before this session existed; ask again.
	pi.events.emit(HUD_REQUEST_CHANNEL, undefined);
	emitState(true);
}

/**
 * The editor (pi's or a custom one) has a getText method; selectors, dialogs and overlays do not. Without a
 * TUI reference (not captured yet) fall back to the editor-empty check alone.
 */
export function editorHasFocus(tui: object | undefined): boolean {
	// getFocusedComponent is on pi-tui's TuiBase (tui.ts:623) but not in its public TUI interface.
	const getFocused = (tui as Partial<FocusableTui> | undefined)?.getFocusedComponent;
	if (!tui || typeof getFocused !== "function") return true;
	const focused = getFocused.call(tui) as { getText?: unknown } | null | undefined;
	return typeof focused?.getText === "function";
}

function detailSource(state: SessionState): DetailSource {
	const { manager } = state;
	return {
		get: (agentId) => manager.get(agentId),
		progress: (agentId) => manager.progress(agentId),
		subscribe: (listener) => manager.subscribe(listener),
		stop: (agentId) => void manager.stop(agentId, "user"),
		report: (record) => {
			const file = existingFile(record.resultFile);
			if (file) {
				try {
					return readFileSync(file, "utf8");
				} catch {
					// Fall back to the in-memory text.
				}
			}
			return record.text ?? "";
		},
		transcript: (record) => existingFile(record.sessionFile),
		confirmStop: () => state.config.confirmStop,
	};
}

/**
 * Open the detail overlay: long content, so an overlay with a bounded height that scrolls itself. It may sit
 * on top of the /agents list; pi gives the keyboard back to the list when the overlay closes. From focus
 * mode, closing it returns to focus mode (docs/07 §5-§6). One detail at a time: further requests are ignored.
 */
async function openDetail(state: SessionState, agentId: string, origin: "focus" | "mouse" | "list"): Promise<void> {
	const { ctx } = state;
	if (state.closed || state.detailOpen || ctx.mode !== "tui" || !ctx.hasUI) {
		if (origin === "focus") state.focus?.resume();
		return;
	}
	state.detailOpen = true;
	try {
		const source = detailSource(state);
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => new AgentDetailView(tui, theme, keybindings, source, agentId, () => done()), {
			overlay: true,
			overlayOptions: { ...OVERLAY_OPTIONS },
		});
	} catch {
		// The UI went away (session switch); nothing to restore.
	} finally {
		state.detailOpen = false;
		if (origin === "focus") state.focus?.resume();
	}
}

/**
 * The /agents list; also the target of the HUD's "+N more" row. A short selection list, so it goes in the
 * editor slot at the bottom like pi's own selectors (no overlay) and the transcript stays visible. Enter opens
 * the detail overlay on top while the list stays open underneath, keeping its selection (docs/07 §7).
 * Ignored while the list or a detail is already showing.
 */
async function openList(state: SessionState): Promise<void> {
	const { ctx, manager } = state;
	if (state.closed || state.listOpen || state.detailOpen || ctx.mode !== "tui" || !ctx.hasUI) return;
	state.listOpen = true;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) =>
				new AgentListView(
					tui,
					theme,
					keybindings,
					{
						list: () => manager.list(),
						stop: (agentId) => void manager.stop(agentId, "user"),
						open: (agentId) => void openDetail(state, agentId, "list"),
						confirmStop: () => state.config.confirmStop,
					},
					() => done(),
				),
		);
	} catch {
		// The UI went away (session switch) or the list could not be shown; nothing to restore.
	} finally {
		state.listOpen = false;
	}
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

function detailsOf(
	record: AgentRecord,
	type: AgentType,
	extra: { truncated: boolean; sessionFile?: string; progress?: ProgressSnapshot; queuePosition?: number },
): AgentToolDetails {
	const stats = extra.progress ?? record.stats;
	return {
		agentId: record.agentId,
		type: record.type,
		description: record.description,
		status: record.status,
		reason: record.reason,
		turns: stats.turns,
		toolCalls: stats.toolCalls,
		durationMs: durationOf(record),
		usage: { ...stats.usage },
		model: record.model,
		maxTurns: type.maxTurns,
		sessionFile: extra.sessionFile,
		resultFile: record.resultFile,
		truncated: extra.truncated,
		progress: extra.progress,
		queuePosition: extra.queuePosition,
	};
}

/** Throttled onUpdate (at most every 100 ms) plus a 1 s heartbeat so the elapsed time keeps moving. */
function progressReporter(
	record: AgentRecord,
	type: AgentType,
	onUpdate: AgentToolUpdateCallback<AgentToolDetails> | undefined,
	position: () => number,
) {
	let latest: ProgressSnapshot | undefined;
	let lastEmit = 0;
	let pending: NodeJS.Timeout | undefined;
	let heartbeat: NodeJS.Timeout | undefined;

	const emit = (): void => {
		if (!onUpdate) return;
		lastEmit = Date.now();
		const queuePosition = record.status === "queued" ? position() : undefined;
		const text = record.status === "queued" ? `${record.agentId} queued (${queuePosition})` : `${record.agentId} running`;
		onUpdate({ content: [{ type: "text", text }], details: detailsOf(record, type, { truncated: false, progress: latest, queuePosition }) });
	};

	return {
		emit,
		start(): void {
			emit();
			if (onUpdate) heartbeat = setInterval(emit, HEARTBEAT_MS);
		},
		schedule(snapshot: ProgressSnapshot): void {
			latest = snapshot;
			if (!onUpdate || pending) return;
			pending = setTimeout(
				() => {
					pending = undefined;
					emit();
				},
				Math.max(0, PROGRESS_THROTTLE_MS - (Date.now() - lastEmit)),
			);
		},
		stop(): void {
			if (pending) clearTimeout(pending);
			if (heartbeat) clearInterval(heartbeat);
			pending = undefined;
			heartbeat = undefined;
		},
	};
}

function catalogOf(registry: ModelRegistry): ModelCatalog {
	type RegistryModel = Parameters<ModelRegistry["hasConfiguredAuth"]>[0];
	return {
		find: (provider, id) => registry.find(provider, id),
		available: () => registry.getAvailable(),
		hasAuth: (model) => registry.hasConfiguredAuth(model as RegistryModel),
	};
}

/** Continue numbering after result files left by earlier runs of this parent session (e.g. before /reload). */
export function nextAgentNumber(resultDir: string): number {
	let max = 0;
	try {
		for (const name of readdirSync(resultDir)) {
			const match = /^ag-(\d+)\.result(?:\.\d+)?\.md$/.exec(name);
			if (match) max = Math.max(max, Number(match[1]));
		}
	} catch {
		// No directory yet.
	}
	return max + 1;
}

function notifyProblems(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;
	if (state.configError) ctx.ui.notify(`pi-subagent: ${state.configError}; using defaults`, "warning");
	const warnings = [...state.configWarnings.map((warning) => `pi-subagent.json: ${warning}`), ...state.loaded.warnings];
	if (warnings.length > 0) {
		ctx.ui.notify(`pi-subagent: ${warnings.length} agent type warning(s); see /agents types\n${warnings.join("\n")}`, "warning");
	}
}

export function describeTypes(state: Pick<SessionState, "loaded" | "configError" | "configWarnings">): string {
	const lines = ["Agent types:"];
	for (const type of state.loaded.types.values()) {
		const parts = [
			`tools: ${type.tools.length > 0 ? type.tools.join(", ") : "none"}`,
			`model: ${type.model ?? "inherit"}`,
			`thinking: ${type.thinking ?? "inherit"}`,
			`max_turns: ${type.maxTurns}`,
			`context_limit: ${type.contextLimit}%`,
		];
		if (type.background) parts.push("background");
		lines.push(`- ${type.name} (${type.source}) ${parts.join(" · ")}`);
		lines.push(`  ${type.description}`);
	}
	if (state.loaded.skippedProject > 0) {
		lines.push(`Skipped ${state.loaded.skippedProject} project type file(s): the project is not trusted.`);
	}
	const warnings = [
		...(state.configError ? [`pi-subagent.json: ${state.configError}`] : []),
		...state.configWarnings.map((warning) => `pi-subagent.json: ${warning}`),
		...state.loaded.warnings,
	];
	if (warnings.length > 0) lines.push("Warnings:", ...warnings.map((warning) => `- ${warning}`));
	return lines.join("\n");
}
