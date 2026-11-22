// Settings exposed to the /shizuku panel (pi-shizuku-settings): the scalar fields of pi-subagent.json. The
// per-type overrides (`types`) stay a hand-edited table; the panel only shows how many there are.

import { CONFIG_FILE_NAME, DEFAULT_CONFIG, parseConfig, saveConfigPatch, type SubagentConfig } from "./config.js";
import type { SetResult, SettingApplies, SettingItem, SettingValue } from "./shizuku-settings.js";

type IntKey = "maxConcurrent" | "resultMaxChars" | "notifyMaxChars" | "notifyBatchMaxChars" | "retentionDays";
type Key = IntKey | "confirmStop" | "childExtensions";

interface IntEntry {
	key: IntKey;
	label: string;
	description: string;
	/** parseConfig's lower bound. */
	min: number;
	/** Upper bound of the panel's ←→ only; parseConfig has none. */
	max: number;
	step: number;
	applies: SettingApplies;
}

const INT_ENTRIES: readonly IntEntry[] = [
	{
		key: "maxConcurrent",
		label: "Max concurrent",
		description: "Agents running at the same time; further launches wait in the queue.",
		min: 1,
		max: 64,
		step: 1,
		applies: "live",
	},
	{
		key: "resultMaxChars",
		label: "Result max chars",
		description: "Longest agent result handed back to the parent; the full text goes to a file.",
		min: 1000,
		max: 1_000_000,
		step: 1000,
		applies: "live",
	},
	{
		key: "notifyMaxChars",
		label: "Notify max chars",
		description: "Longest result per agent in a background notification.",
		min: 1000,
		max: 1_000_000,
		step: 1000,
		applies: "live",
	},
	{
		key: "notifyBatchMaxChars",
		label: "Notify batch max chars",
		description: "Longest background notification, all agents in it together.",
		min: 1000,
		max: 1_000_000,
		step: 1000,
		applies: "live",
	},
	{
		key: "retentionDays",
		label: "Retention days",
		description: "Child sessions of other parent sessions older than this are deleted when a session starts.",
		min: 1,
		max: 3650,
		step: 1,
		applies: "new-session",
	},
];

export function settingsItems(config: SubagentConfig): SettingItem[] {
	const overrides = Object.keys(config.types).length;
	return [
		...INT_ENTRIES.map(
			(entry): SettingItem => ({
				id: entry.key,
				kind: "int",
				label: entry.label,
				description: entry.description,
				value: config[entry.key],
				default: DEFAULT_CONFIG[entry.key],
				min: entry.min,
				max: entry.max,
				step: entry.step,
				applies: entry.applies,
			}),
		),
		{
			id: "confirmStop",
			kind: "bool",
			label: "Confirm stop",
			description: "x stops an agent only when pressed twice on it: the /agents list, the detail overlay, HUD focus mode.",
			value: config.confirmStop,
			default: DEFAULT_CONFIG.confirmStop,
			applies: "live",
		},
		{
			id: "childExtensions",
			kind: "text",
			label: "Child extensions",
			description: "Extensions a child session may load: package names or paths, comma separated. Used by agents started afterwards.",
			value: config.childExtensions.join(", "),
			default: DEFAULT_CONFIG.childExtensions.join(", "),
			placeholder: "pi-dsweb, …",
			applies: "live",
		},
		{
			id: "types",
			kind: "info",
			label: "Type overrides",
			description: "Per-type model / thinking / max_turns / context_limit. Edit the file, then /agents reload.",
			value: `${overrides} override${overrides === 1 ? "" : "s"} · edit ${CONFIG_FILE_NAME}`,
		},
	];
}

function isKey(id: string): id is Key {
	return id === "confirmStop" || id === "childExtensions" || INT_ENTRIES.some((entry) => entry.key === id);
}

/**
 * Validate one value with parseConfig, save it into the file and hand the parsed field to `apply`, so the
 * running session uses it at once.
 */
export function setSetting(path: string, id: string, value: SettingValue, apply: (patch: Partial<SubagentConfig>) => void): SetResult {
	if (!isKey(id)) return { ok: false, error: `unknown setting ${id}` };
	let raw: unknown = value;
	if (id === "childExtensions") {
		if (typeof value !== "string") return { ok: false, error: "childExtensions must be text" };
		raw = value.split(",").map((entry) => entry.trim()).filter(Boolean);
	}
	const parsed = parseConfig({ [id]: raw });
	if (parsed.warnings.length > 0) return { ok: false, error: parsed.warnings.join("; ") };
	try {
		saveConfigPatch(path, { [id]: raw });
	} catch (error) {
		return { ok: false, error: `could not save ${path}: ${(error as Error).message}` };
	}
	apply({ [id]: parsed.config[id] });
	return { ok: true };
}
