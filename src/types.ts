// Agent type discovery: built-in, user and project markdown files with YAML frontmatter (docs/04).

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import {
	CONTEXT_LIMIT_MAX,
	CONTEXT_LIMIT_MIN,
	isContextLimit,
	isMaxTurns,
	isThinkingLevel,
	type SubagentConfig,
	type ThinkingLevel,
} from "./config.js";

/** pi's built-in tools (pi/packages/coding-agent/src/core/tools/index.ts:95). Types may only pick from these. */
export const BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_TYPE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** A safeguard against runaway loops; the context limit is what normally ends a long run (docs/02 §9). */
export const DEFAULT_MAX_TURNS = 300;
/** Percent of the context window at which the subagent is told to write its report (docs/02 §9). */
export const DEFAULT_CONTEXT_LIMIT = 70;
export const DEFAULT_TYPE = "general";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type TypeSource = "builtin" | "user" | "project";

export interface AgentType {
	/** Lower-case name; lookups are case-insensitive. */
	name: string;
	description: string;
	tools: string[];
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns: number;
	/** Percent of the context window that starts the wrap-up. */
	contextLimit: number;
	contextFiles: boolean;
	skills: boolean;
	/** Default for the `background` call parameter (docs/04 §2). */
	background: boolean;
	/** Role text appended to the child's system prompt (may be empty). */
	body: string;
	source: TypeSource;
	path: string;
}

export interface TypeDirs {
	builtinDir: string;
	userDir: string;
	/** `<cwd>/.pi/agents`; read only when the project is trusted. */
	projectDir: string;
	projectTrusted: boolean;
}

export interface LoadedTypes {
	types: Map<string, AgentType>;
	warnings: string[];
	/** Project type files skipped because the project is not trusted. */
	skippedProject: number;
}

export function builtinAgentsDir(): string {
	return fileURLToPath(new URL("../agents/", import.meta.url));
}

/** Load all layers (built-in < user < project) and apply the config overrides. */
export function loadAgentTypes(dirs: TypeDirs, config?: SubagentConfig): LoadedTypes {
	const types = new Map<string, AgentType>();
	const warnings: string[] = [];
	let skippedProject = 0;

	const layers: Array<[TypeSource, string]> = [
		["builtin", dirs.builtinDir],
		["user", dirs.userDir],
	];
	if (dirs.projectTrusted) layers.push(["project", dirs.projectDir]);
	else skippedProject = listMarkdown(dirs.projectDir).length;

	for (const [source, dir] of layers) {
		for (const path of listMarkdown(dir)) {
			const result = parseTypeFile(path, source);
			for (const warning of result.warnings) warnings.push(`${path}: ${warning}`);
			if (result.kind === "skip") continue;
			if (result.kind === "disable") {
				types.delete(result.name);
				continue;
			}
			types.set(result.type.name, result.type);
		}
	}

	if (config) {
		for (const [name, override] of Object.entries(config.types)) {
			const type = types.get(name);
			if (!type) {
				warnings.push(`pi-subagent.json: types.${name} does not match any loaded agent type`);
				continue;
			}
			types.set(name, {
				...type,
				model: override.model ?? type.model,
				thinking: override.thinking ?? type.thinking,
				maxTurns: override.maxTurns ?? type.maxTurns,
				contextLimit: override.contextLimit ?? type.contextLimit,
			});
		}
	}

	return { types, warnings, skippedProject };
}

export function lookupType(types: ReadonlyMap<string, AgentType>, name: string | undefined): AgentType | undefined {
	return types.get((name?.trim() || DEFAULT_TYPE).toLowerCase());
}

type ParseResult =
	| { kind: "type"; type: AgentType; warnings: string[] }
	| { kind: "disable"; name: string; warnings: string[] }
	| { kind: "skip"; warnings: string[] };

export function parseTypeFile(path: string, source: TypeSource): ParseResult {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "skip", warnings: [`cannot read file (${(error as Error).message}); skipped`] };
	}
	return parseTypeContent(content, path, source);
}

export function parseTypeContent(content: string, path: string, source: TypeSource): ParseResult {
	const warnings: string[] = [];
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
	} catch (error) {
		return { kind: "skip", warnings: [`invalid frontmatter (${(error as Error).message}); skipped`] };
	}

	const rawName = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name : basename(path, ".md");
	const name = rawName.trim().toLowerCase();
	if (!NAME_PATTERN.test(name)) {
		return { kind: "skip", warnings: [`invalid name "${rawName}" (allowed: [a-z0-9][a-z0-9_-]*); skipped`] };
	}

	const enabled = optionalBoolean(frontmatter, "enabled", warnings);
	if (enabled === false) return { kind: "disable", name, warnings };

	const description = typeof frontmatter.description === "string" ? frontmatter.description.replace(/\s+/g, " ").trim() : "";
	if (!description) return { kind: "skip", warnings: [...warnings, "missing description; skipped"] };

	let tools = DEFAULT_TYPE_TOOLS;
	if (frontmatter.tools !== undefined) {
		const parsed = parseTools(frontmatter.tools);
		if (typeof parsed === "string") return { kind: "skip", warnings: [...warnings, `${parsed}; skipped`] };
		tools = parsed;
	}

	let model: string | undefined;
	if (frontmatter.model !== undefined) {
		if (typeof frontmatter.model === "string" && frontmatter.model.trim()) model = frontmatter.model.trim();
		else warnings.push("model must be a non-empty string; ignored");
	}

	let thinking: ThinkingLevel | undefined;
	if (frontmatter.thinking !== undefined) {
		if (isThinkingLevel(frontmatter.thinking)) thinking = frontmatter.thinking;
		else warnings.push(`invalid thinking "${String(frontmatter.thinking)}"; ignored`);
	}

	let maxTurns = DEFAULT_MAX_TURNS;
	if (frontmatter.max_turns !== undefined) {
		if (isMaxTurns(frontmatter.max_turns)) maxTurns = frontmatter.max_turns;
		else warnings.push(`max_turns must be an integer >= 2; using ${DEFAULT_MAX_TURNS}`);
	}

	let contextLimit = DEFAULT_CONTEXT_LIMIT;
	if (frontmatter.context_limit !== undefined) {
		if (isContextLimit(frontmatter.context_limit)) contextLimit = frontmatter.context_limit;
		else warnings.push(`context_limit must be an integer from ${CONTEXT_LIMIT_MIN} to ${CONTEXT_LIMIT_MAX}; using ${DEFAULT_CONTEXT_LIMIT}`);
	}

	const type: AgentType = {
		name,
		description,
		tools,
		model,
		thinking,
		maxTurns,
		contextLimit,
		contextFiles: optionalBoolean(frontmatter, "context_files", warnings) ?? true,
		skills: optionalBoolean(frontmatter, "skills", warnings) ?? false,
		background: optionalBoolean(frontmatter, "background", warnings) ?? false,
		body: body.trim(),
		source,
		path,
	};
	return { kind: "type", type, warnings };
}

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Comma-separated string or YAML list; "none" means no tools. Names other than pi's built-in tools are
 * extension tools: they become active only when an extension in `childExtensions` registers them
 * (docs/04 §4), so listing one never loads code by itself.
 */
function parseTools(value: unknown): string[] | string {
	let entries: string[];
	if (typeof value === "string") entries = value.split(",");
	else if (Array.isArray(value) && value.every((item) => typeof item === "string")) entries = value as string[];
	else return "tools must be a comma-separated string or a list";
	const names = entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	if (names.length === 1 && names[0] === "none") return [];
	const invalid = names.filter((name) => !TOOL_NAME.test(name));
	if (invalid.length > 0) return `invalid tool names: ${invalid.join(", ")}`;
	return [...new Set(names)];
}

/** Tools a child actually gets: built-ins, plus extension tools that an allowlisted extension registered. */
export function activeChildTools(typeTools: readonly string[], extensionTools: readonly string[]): string[] {
	return typeTools.filter((name) => (BUILTIN_TOOLS as readonly string[]).includes(name) || extensionTools.includes(name));
}

function optionalBoolean(frontmatter: Record<string, unknown>, key: string, warnings: string[]): boolean | undefined {
	const value = frontmatter[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`${key} must be true or false; ignored`);
	return undefined;
}

function listMarkdown(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Windows: `general` follows the parent's shell. When the parent has `powershell` active, the built-in
 * `general` gets `powershell` in place of `bash` (docs/04 §3.2).
 */
export function effectiveTools(type: AgentType, parentActiveTools: readonly string[]): string[] {
	if (type.name !== "general" || type.source !== "builtin" || !parentActiveTools.includes("powershell")) return type.tools;
	return [...new Set(type.tools.map((tool) => (tool === "bash" ? "powershell" : tool)))];
}
