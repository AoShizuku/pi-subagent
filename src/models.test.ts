import { describe, expect, it } from "vitest";

import { lookupModel, type ModelCatalog, type ModelRef, resolveModel, resolveThinking } from "./models.js";

const MODELS: Array<ModelRef & { auth: boolean }> = [
	{ provider: "anthropic", id: "claude-haiku", auth: true },
	{ provider: "deepseek", id: "flash", auth: true },
	{ provider: "other", id: "flash", auth: true },
	{ provider: "openrouter", id: "meta/llama", auth: true },
	{ provider: "nokey", id: "model-x", auth: false },
];

const catalog: ModelCatalog = {
	find: (provider, id) => MODELS.find((model) => model.provider === provider && model.id === id),
	available: () => MODELS.filter((model) => model.auth),
	hasAuth: (model) => MODELS.some((entry) => entry.provider === model.provider && entry.id === model.id && entry.auth),
};

const parent: ModelRef = { provider: "anthropic", id: "claude-haiku" };

describe("lookupModel", () => {
	it("accepts provider/id", () => {
		expect(lookupModel("deepseek/flash", catalog)).toMatchObject({ ok: true, model: { provider: "deepseek", id: "flash" } });
	});

	it("accepts a bare id that matches exactly one available model", () => {
		expect(lookupModel("claude-haiku", catalog)).toMatchObject({ ok: true, model: { provider: "anthropic" } });
		expect(lookupModel("meta/llama", catalog)).toMatchObject({ ok: true, model: { provider: "openrouter", id: "meta/llama" } });
	});

	it("reports an ambiguous bare id with the candidates", () => {
		const result = lookupModel("flash", catalog);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("deepseek/flash, other/flash");
	});

	it("reports models without credentials", () => {
		const result = lookupModel("nokey/model-x", catalog);
		expect(!result.ok && result.error).toContain("no credentials");
	});
});

describe("resolveModel", () => {
	it("uses the call parameter first", () => {
		expect(resolveModel({ param: "deepseek/flash", configured: "other/flash", parent }, catalog)).toEqual({
			model: { provider: "deepseek", id: "flash", auth: true },
			notes: [],
		});
	});

	it("throws when the call parameter is unavailable", () => {
		expect(() => resolveModel({ param: "nope/none", parent }, catalog)).toThrow(/Invalid model parameter/);
		expect(() => resolveModel({ param: "flash", parent }, catalog)).toThrow(/ambiguous/);
	});

	it("uses the configured model, falling back to the parent with a note when unavailable", () => {
		expect(resolveModel({ configured: "other/flash", parent }, catalog).model).toMatchObject({ provider: "other" });
		const fallback = resolveModel({ configured: "nokey/model-x", parent }, catalog);
		expect(fallback.model).toBe(parent);
		expect(fallback.notes).toEqual([expect.stringMatching(/^model nokey\/model-x unavailable \(.*\), used anthropic\/claude-haiku$/)]);
	});

	it("inherits the parent model by default", () => {
		expect(resolveModel({ parent }, catalog)).toEqual({ model: parent, notes: [] });
	});
});

describe("resolveThinking", () => {
	it("prefers parameter, then configured, then parent", () => {
		expect(resolveThinking("high", "low", "medium")).toBe("high");
		expect(resolveThinking(undefined, "low", "medium")).toBe("low");
		expect(resolveThinking(undefined, undefined, "medium")).toBe("medium");
	});
});
