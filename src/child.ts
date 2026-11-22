// Real child sessions: in-process pi SDK sessions (docs/02 §2-§6).

import { join } from "node:path";

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type LoadExtensionsResult,
	type ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { appendSystemPrompt } from "./prompts.js";
import type { ChildSession, ChildSessionFactory, ChildSpec } from "./run.js";
import { activeChildTools } from "./types.js";

/** Never available to a child, whatever its type lists (docs/02 §6). */
export const SELF_TOOLS = ["agent", "agent_send", "agent_stop", "ask_user_question"];

export interface ChildFactoryOptions {
	/** The parent's registry (ctx.modelRegistry), source of runtime-registered providers. */
	parentRegistry: ModelRegistry;
	/** Default: getAgentDir() (~/.pi/agent, or PI_CODING_AGENT_DIR). */
	agentDir?: string;
	/** Extensions a child may load (docs/02 §5.2); read on every create so /agents reload applies. */
	childExtensions?: () => readonly string[];
}

/** Never loaded into a child, whatever the allowlist says (docs/02 §5.2). */
export const DENIED_EXTENSIONS = ["pi-subagent", "pi-ask-user", "pi-autotitle", "pi-hud", "pi-bettertui", "pi-background-shell"];

interface ExtensionLike {
	path: string;
	resolvedPath: string;
	sourceInfo: { source: string; baseDir?: string };
	tools: Map<string, unknown>;
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function segments(ext: ExtensionLike): string[] {
	return [ext.path, ext.resolvedPath, ext.sourceInfo.baseDir ?? "", ext.sourceInfo.source].flatMap((text) => normalize(text).split(/[/:@]/));
}

/**
 * Does an allowlist entry name this extension? An entry is a package name (matched against the path segments
 * and the package source, e.g. `npm:pi-foo`) or a path (matched as a prefix of the extension's paths).
 */
export function extensionMatches(ext: ExtensionLike, entry: string): boolean {
	const wanted = normalize(entry.trim());
	if (!wanted) return false;
	if (/[/]/.test(wanted) && !wanted.startsWith("@")) {
		return [ext.path, ext.resolvedPath, ext.sourceInfo.baseDir ?? "", ext.sourceInfo.source].some((path) => {
			const candidate = normalize(path);
			return candidate === wanted || candidate.startsWith(`${wanted}/`);
		});
	}
	const source = normalize(ext.sourceInfo.source);
	if (source === wanted || source === `npm:${wanted}` || source.endsWith(`/${wanted}`)) return true;
	// Scoped names (@scope/name) compare as consecutive segments.
	const parts = wanted.split("/");
	const all = segments(ext);
	return all.some((_, index) => parts.every((part, offset) => all[index + offset] === part.replace(/^@/, "")));
}

/** Keep allowlisted extensions, minus the denied ones; also returns the tool names they register. */
export function filterExtensions<T extends ExtensionLike>(extensions: readonly T[], allowlist: readonly string[]): { kept: T[]; tools: string[] } {
	const kept = extensions.filter(
		(ext) => allowlist.some((entry) => extensionMatches(ext, entry)) && !DENIED_EXTENSIONS.some((name) => extensionMatches(ext, name)),
	);
	return { kept, tools: [...new Set(kept.flatMap((ext) => [...ext.tools.keys()]))] };
}

/**
 * Copy providers that extensions registered at runtime (pi.registerProvider) into the child's runtime;
 * they are not in models.json, so a fresh runtime would not know them (docs/02 §3).
 * ModelRegistry keeps its runtime private (model-registry.ts:49), so the parent runtime cannot be shared.
 */
export function replayProviders(parent: ModelRegistry, child: ModelRuntime): void {
	for (const id of parent.getRegisteredProviderIds()) {
		const native = parent.getRegisteredNativeProvider(id);
		if (native) {
			child.registerNativeProvider(native);
			continue;
		}
		const config = parent.getRegisteredProviderConfig(id);
		if (config) child.registerProvider(id, config);
	}
}

export function createChildSessionFactory(options: ChildFactoryOptions): ChildSessionFactory {
	return {
		async create(spec) {
			return wrapSession(await createChildAgentSession(spec, options));
		},
	};
}

export async function createChildAgentSession(spec: ChildSpec, options: ChildFactoryOptions): Promise<AgentSession> {
	const agentDir = options.agentDir ?? getAgentDir();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	replayProviders(options.parentRegistry, modelRuntime);

	const settingsManager = SettingsManager.create(spec.cwd, agentDir);
	const allowlist = options.childExtensions?.() ?? [];
	// Tools registered by allowlisted extensions; a tools allowlist would otherwise leave them inactive (sdk.ts:72-87).
	let extensionTools: string[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir,
		settingsManager,
		// Default: no extensions at all. With an allowlist, pi loads the configured extensions and the
		// override keeps only the allowed ones (resource-loader.ts:323, :628).
		noExtensions: allowlist.length === 0,
		...(allowlist.length > 0
			? {
					extensionsOverride: (base: LoadExtensionsResult): LoadExtensionsResult => {
						const { kept, tools } = filterExtensions(base.extensions, allowlist);
						extensionTools = tools;
						return { ...base, extensions: kept };
					},
				}
			: {}),
		noPromptTemplates: true,
		noThemes: true,
		noSkills: !spec.type.skills,
		noContextFiles: !spec.type.contextFiles,
		// Append only: a custom system prompt would drop pi's tools/rules sections (system-prompt.ts:152-169).
		appendSystemPrompt: appendSystemPrompt(spec.type),
	});
	await resourceLoader.reload();
	// The context limit ends a long run with a report instead (docs/02 §9). A compaction rewrites the context,
	// which costs a full uncached prefill, and summarizes away details of the task. The override lives in memory
	// only and is never saved; it must follow resourceLoader.reload(), which re-reads the settings files. Only a
	// settings write or /reload would drop it again, and a child session does neither.
	settingsManager.applyOverrides({ compaction: { enabled: false } });

	// agent_send to a finished agent reopens its transcript; the session restores the full history (docs/06 §6).
	const sessionManager = spec.resumeFile
		? SessionManager.open(spec.resumeFile, spec.sessionDir, spec.cwd)
		: spec.sessionDir
			? SessionManager.create(spec.cwd, spec.sessionDir, { parentSession: spec.parentSessionFile })
			: SessionManager.inMemory(spec.cwd, { parentSession: spec.parentSessionFile });

	// Prefer the child runtime's model object; fall back to the parent's (e.g. a virtual model, which cannot be replayed).
	const model = spec.model
		? (modelRuntime.getModel(spec.model.provider, spec.model.id) ?? options.parentRegistry.find(spec.model.provider, spec.model.id))
		: undefined;

	const { session } = await createAgentSession({
		cwd: spec.cwd,
		agentDir,
		modelRuntime,
		model,
		thinkingLevel: spec.thinking,
		// Only tools the type lists; an extension tool also needs its extension in the allowlist (docs/04 §4).
		tools: activeChildTools(spec.type.tools, extensionTools),
		excludeTools: SELF_TOOLS,
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	try {
		// Usually no extensions are loaded; binding keeps the same lifecycle as other SDK sessions.
		await session.bindExtensions({ mode: "print" });
		if (!spec.resumeFile) session.setSessionName(spec.description);
	} catch (error) {
		session.dispose();
		throw error;
	}
	return session;
}

export function wrapSession(session: AgentSession): ChildSession {
	let disposed = false;
	return {
		get sessionFile() {
			return session.sessionFile;
		},
		get model() {
			const model = session.model;
			return model ? `${model.provider}/${model.id}` : undefined;
		},
		get messages() {
			return session.messages;
		},
		contextUsage: () => session.getContextUsage(),
		subscribe: (listener) => session.subscribe(listener),
		prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
		abort: () => session.abort(),
		steer: (customType, content) => {
			void session.sendCustomMessage({ customType, content, display: false }, { deliverAs: "steer" }).catch(() => {});
		},
		steerUser: async (text) => {
			await session.steer(text);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			session.dispose();
		},
	};
}
