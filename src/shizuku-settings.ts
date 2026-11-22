// pi-shizuku-settings protocol, version 1 (pi-shizuku-settings/DESIGN.md §3).
//
// This file is copied verbatim into every plugin that exposes settings, as `src/shizuku-settings.ts`. The
// plugins stay independent packages: none of them depends on pi-shizuku-settings, and they work the same when
// it is not installed. Edit the copy in pi-shizuku-settings first, then copy it over; do not rewrite it per plugin.
//
// How it works: the /shizuku panel emits SETTINGS_CHANNEL on pi.events with a CollectRequest. pi's event bus
// calls listeners synchronously, so every plugin that called exposeSettings() hands its provider over before
// emit() returns. The provider is a live object: the panel reads items() on every render and calls set() to
// change a value. Validation, saving and applying stay in the plugin.

/** pi.events channel the panel emits to collect providers. */
export const SETTINGS_CHANNEL = "shizuku-settings:collect";
/** Bumped on an incompatible change; a provider for another version is ignored by the panel. */
export const SETTINGS_PROTOCOL = 1;

/**
 * When a change takes effect.
 * live: right away. reload: after /reload. new-session: from the next session (/new, resume). restart: after pi restarts.
 */
export type SettingApplies = "live" | "reload" | "new-session" | "restart";

interface SettingBase {
	/** Unique inside the provider; dotted paths are fine (`thinking.lines`). */
	id: string;
	/** Short English label (design_style.md §9). */
	label: string;
	/** One or two sentences, shown under the list for the selected row. */
	description?: string;
	/** Default: live. */
	applies?: SettingApplies;
	/** Set when something outside the file decides the value (an environment variable); the panel shows it read-only with this text. */
	locked?: string;
}

export type SettingItem =
	| (SettingBase & { kind: "bool"; value: boolean; default: boolean })
	| (SettingBase & { kind: "enum"; value: string; default: string; values: readonly string[] })
	| (SettingBase & { kind: "int"; value: number; default: number; min: number; max: number; step?: number })
	/** Free text; the empty string means "not set" when the default is empty. */
	| (SettingBase & { kind: "text"; value: string; default: string; placeholder?: string })
	/** Read-only fact (a key is configured, where a file lives). */
	| (SettingBase & { kind: "info"; value: string })
	/** Opens another panel: the settings panel closes and puts `command` in the editor. */
	| (SettingBase & { kind: "command"; command: string });

export type SettingValue = boolean | number | string;

export type SetResult = { ok: true; message?: string } | { ok: false; error: string };

export interface SettingsProvider {
	/** Plugin name without the npm scope, e.g. `pi-bettertui`. Unique; a later registration with the same id replaces the earlier one. */
	id: string;
	/** Shown in the plugin list; usually the package name. */
	title: string;
	/** One line, shown next to the title. */
	description?: string;
	/** Where the values are saved, shown on the panel's top edge. */
	file?: string;
	/** Current items, read on every render. */
	items(): readonly SettingItem[];
	/** Validate, save and apply one value. The panel resets a value by passing the item's default. */
	set(id: string, value: SettingValue): SetResult | Promise<SetResult>;
}

export interface CollectRequest {
	protocol: number;
	register(provider: SettingsProvider): void;
}

export function isCollectRequest(data: unknown): data is CollectRequest {
	if (typeof data !== "object" || data === null) return false;
	const request = data as Partial<CollectRequest>;
	return request.protocol === SETTINGS_PROTOCOL && typeof request.register === "function";
}

interface SettingsHost {
	events: { on(channel: string, handler: (data: unknown) => void): () => void };
	on(event: "session_shutdown", handler: () => void): void;
}

/**
 * Answer the panel's collect requests with `provider` until this extension runtime shuts down. pi builds a new
 * runtime on /reload, /new and resume, and that runtime calls this again, so the panel never sees a stale one.
 */
export function exposeSettings(pi: SettingsHost, provider: SettingsProvider): () => void {
	const off = pi.events.on(SETTINGS_CHANNEL, (data) => {
		if (isCollectRequest(data)) data.register(provider);
	});
	pi.on("session_shutdown", () => off());
	return off;
}
