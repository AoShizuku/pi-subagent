// Plugin configuration: ~/.pi/agent/pi-subagent.json (global only; docs/04 §5).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Per-type overrides; priority is call parameter > this > type file > parent session (docs/02 §3). */
export interface TypeOverride {
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	contextLimit?: number;
}

export interface SubagentConfig {
	/** Keyed by lower-case type name. */
	types: Record<string, TypeOverride>;
	maxConcurrent: number;
	resultMaxChars: number;
	/** Per agent in a background notification (docs/05 §3.2). */
	notifyMaxChars: number;
	/** Whole notification batch (docs/05 §3.2). */
	notifyBatchMaxChars: number;
	/** Child session directories of other parent sessions older than this are deleted (docs/06 §8). */
	retentionDays: number;
	/** Extensions a child session may load: package names or paths (docs/02 §5.2). */
	childExtensions: string[];
	/** x stops an agent only when pressed twice on it: the /agents list, the detail overlay, HUD focus mode (docs/07 §4.4). */
	confirmStop: boolean;
}

export const DEFAULT_CONFIG: SubagentConfig = {
	types: {},
	maxConcurrent: 4,
	resultMaxChars: 20_000,
	notifyMaxChars: 8000,
	notifyBatchMaxChars: 24_000,
	retentionDays: 14,
	// pi-dsweb gives the built-in types web_search / web_fetch (agents/*.md); harmless when it is not installed.
	childExtensions: ["pi-dsweb"],
	confirmStop: true,
};

export const CONFIG_FILE_NAME = "pi-subagent.json";

export interface LoadedConfig {
	config: SubagentConfig;
	/** Set when the file exists but could not be read or parsed; defaults are used then. */
	error?: string;
	/** Fields that were present but invalid and therefore ignored. */
	warnings: string[];
}

export function defaultConfig(): SubagentConfig {
	return { ...DEFAULT_CONFIG, types: {}, childExtensions: [...DEFAULT_CONFIG.childExtensions] };
}

export function loadConfig(path: string): LoadedConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig(), warnings: [] };
		return { config: defaultConfig(), error: `cannot read ${path}: ${(error as Error).message}`, warnings: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { config: defaultConfig(), error: `invalid JSON in ${path}: ${(error as Error).message}`, warnings: [] };
	}
	if (!isObject(parsed)) return { config: defaultConfig(), error: `${path} must contain a JSON object`, warnings: [] };
	return parseConfig(parsed);
}

export function parseConfig(input: Record<string, unknown>): LoadedConfig {
	const config = defaultConfig();
	const warnings: string[] = [];

	const positiveInt = (key: "maxConcurrent" | "resultMaxChars" | "notifyMaxChars" | "notifyBatchMaxChars" | "retentionDays", min: number): void => {
		const value = input[key];
		if (value === undefined) return;
		if (typeof value === "number" && Number.isInteger(value) && value >= min) config[key] = value;
		else warnings.push(`${key} must be an integer >= ${min}; using ${config[key]}`);
	};
	positiveInt("maxConcurrent", 1);
	positiveInt("resultMaxChars", 1000);
	positiveInt("notifyMaxChars", 1000);
	positiveInt("notifyBatchMaxChars", 1000);
	positiveInt("retentionDays", 1);

	if (input.childExtensions !== undefined) {
		const value = input.childExtensions;
		if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
			config.childExtensions = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
		} else {
			warnings.push("childExtensions must be a list of package names or paths");
		}
	}

	if (input.confirmStop !== undefined) {
		if (typeof input.confirmStop === "boolean") config.confirmStop = input.confirmStop;
		else warnings.push(`confirmStop must be true or false; using ${config.confirmStop}`);
	}

	if (input.types !== undefined) {
		if (!isObject(input.types)) {
			warnings.push("types must be an object");
		} else {
			for (const [name, value] of Object.entries(input.types)) {
				if (!isObject(value)) {
					warnings.push(`types.${name} must be an object`);
					continue;
				}
				const override: TypeOverride = {};
				if (value.model !== undefined) {
					if (typeof value.model === "string" && value.model.trim()) override.model = value.model.trim();
					else warnings.push(`types.${name}.model must be a non-empty string`);
				}
				if (value.thinking !== undefined) {
					if (isThinkingLevel(value.thinking)) override.thinking = value.thinking;
					else warnings.push(`types.${name}.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
				}
				if (value.max_turns !== undefined) {
					if (isMaxTurns(value.max_turns)) override.maxTurns = value.max_turns;
					else warnings.push(`types.${name}.max_turns must be an integer >= 2`);
				}
				if (value.context_limit !== undefined) {
					if (isContextLimit(value.context_limit)) override.contextLimit = value.context_limit;
					else warnings.push(`types.${name}.context_limit must be an integer from ${CONTEXT_LIMIT_MIN} to ${CONTEXT_LIMIT_MAX}`);
				}
				config.types[name.toLowerCase()] = override;
			}
		}
	}
	return { config, warnings };
}

export function isMaxTurns(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 2;
}

/** Bounds of context_limit: below 10% a run could not do anything; above 95% the report may not fit. */
export const CONTEXT_LIMIT_MIN = 10;
export const CONTEXT_LIMIT_MAX = 95;

export function isContextLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= CONTEXT_LIMIT_MIN && value <= CONTEXT_LIMIT_MAX;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write `patch` (raw JSON fields) into the file and keep every other field (types, unknown keys) as it is. A
 * missing file is created. Throws when the file exists but is not a JSON object (it is left alone) or cannot be written.
 */
export function saveConfigPatch(path: string, patch: Record<string, unknown>): void {
	let current: Record<string, unknown> = {};
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (raw !== undefined) {
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed)) throw new Error("the file must contain a JSON object");
		current = parsed;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}
`, "utf8");
}
