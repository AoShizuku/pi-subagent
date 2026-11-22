// Model and thinking-level resolution for a child session (docs/02 §3).

import type { ThinkingLevel } from "./config.js";

export interface ModelRef {
	provider: string;
	id: string;
}

/** The parent's model catalogue, narrowed to what resolution needs (backed by ctx.modelRegistry). */
export interface ModelCatalog {
	find(provider: string, id: string): ModelRef | undefined;
	/** Models whose provider has credentials. */
	available(): readonly ModelRef[];
	hasAuth(model: ModelRef): boolean;
}

export interface ModelRequest {
	/** `model` call parameter: errors are reported to the caller. */
	param?: string;
	/** Model from the plugin config or the type file: falls back to the parent model with a note. */
	configured?: string;
	parent?: ModelRef;
}

export interface ModelResolution {
	/** Undefined only when there is no parent model either; pi then picks its default. */
	model?: ModelRef;
	notes: string[];
}

export function formatModel(model: ModelRef | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(default)";
}

type Lookup = { ok: true; model: ModelRef } | { ok: false; error: string };

/** Accepts `provider/id` or a bare id that matches exactly one available model. */
export function lookupModel(spec: string, catalog: ModelCatalog): Lookup {
	const text = spec.trim();
	const slash = text.indexOf("/");
	if (slash > 0) {
		const found = catalog.find(text.slice(0, slash), text.slice(slash + 1));
		if (found) {
			return catalog.hasAuth(found)
				? { ok: true, model: found }
				: { ok: false, error: `model ${formatModel(found)} has no credentials configured` };
		}
	}
	// Bare id; ids may themselves contain "/" (for example OpenRouter's), so also try the whole text.
	const matches = catalog.available().filter((model) => model.id === text);
	if (matches.length === 1 && matches[0]) return { ok: true, model: matches[0] };
	if (matches.length > 1) {
		return { ok: false, error: `model id "${text}" is ambiguous; use one of: ${matches.map(formatModel).join(", ")}` };
	}
	return { ok: false, error: `model "${text}" not found among models with credentials` };
}

/** Resolution order: call parameter > config / type file > parent model. Throws only for the call parameter. */
export function resolveModel(request: ModelRequest, catalog: ModelCatalog): ModelResolution {
	if (request.param?.trim()) {
		const found = lookupModel(request.param, catalog);
		if (!found.ok) throw new Error(`Invalid model parameter: ${found.error}. Omit model to use the default.`);
		return { model: found.model, notes: [] };
	}
	if (request.configured?.trim()) {
		const found = lookupModel(request.configured, catalog);
		if (found.ok) return { model: found.model, notes: [] };
		return {
			model: request.parent,
			notes: [`model ${request.configured.trim()} unavailable (${found.error}), used ${formatModel(request.parent)}`],
		};
	}
	return { model: request.parent, notes: [] };
}

/** Resolution order: call parameter > config / type file > parent. pi clamps it to the model (sdk.ts:270-276). */
export function resolveThinking(param: ThinkingLevel | undefined, configured: ThinkingLevel | undefined, parent: ThinkingLevel | undefined): ThinkingLevel | undefined {
	return param ?? configured ?? parent;
}
