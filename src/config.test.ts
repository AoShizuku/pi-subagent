import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, loadConfig, parseConfig } from "./config.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
	it("uses defaults when the file does not exist", () => {
		const loaded = loadConfig(join(dir, "missing.json"));
		expect(loaded).toEqual({ config: { ...DEFAULT_CONFIG, types: {}, childExtensions: ["pi-dsweb"] }, warnings: [] });
	});

	it("falls back to defaults and reports an error for invalid JSON", () => {
		const path = join(dir, "pi-subagent.json");
		writeFileSync(path, "{ not json");
		const loaded = loadConfig(path);
		expect(loaded.config.maxConcurrent).toBe(4);
		expect(loaded.error).toContain("invalid JSON");
	});

	it("reads values and type overrides, ignoring invalid fields with warnings", () => {
		const path = join(dir, "pi-subagent.json");
		writeFileSync(
			path,
			JSON.stringify({
				maxConcurrent: 2,
				resultMaxChars: 5000,
				types: { Explore: { model: "a/b", thinking: "bad", max_turns: 10, context_limit: 80 }, plan: { context_limit: 5 } },
			}),
		);
		const loaded = loadConfig(path);
		expect(loaded.config).toEqual({
			...DEFAULT_CONFIG,
			maxConcurrent: 2,
			resultMaxChars: 5000,
			types: { explore: { model: "a/b", maxTurns: 10, contextLimit: 80 }, plan: {} },
		});
		expect(loaded.warnings).toEqual([expect.stringContaining("types.Explore.thinking"), "types.plan.context_limit must be an integer from 10 to 95"]);
	});

	it("reads the Phase 2 fields", () => {
		const loaded = parseConfig({ notifyMaxChars: 2000, notifyBatchMaxChars: 6000, retentionDays: 3, childExtensions: [" pi-foo ", "", "/x/ext"] });
		expect(loaded.config).toMatchObject({ notifyMaxChars: 2000, notifyBatchMaxChars: 6000, retentionDays: 3, childExtensions: ["pi-foo", "/x/ext"] });
		expect(loaded.warnings).toEqual([]);
		const bad = parseConfig({ retentionDays: 0, childExtensions: "pi-foo" });
		expect(bad.config).toMatchObject({ retentionDays: 14, childExtensions: ["pi-dsweb"] });
		expect(bad.warnings).toHaveLength(2);
	});

	it("confirmStop defaults to on and takes only a boolean", () => {
		expect(parseConfig({}).config.confirmStop).toBe(true);
		expect(parseConfig({ confirmStop: false }).config.confirmStop).toBe(false);
		const bad = parseConfig({ confirmStop: "no" });
		expect(bad.config.confirmStop).toBe(true);
		expect(bad.warnings).toEqual([expect.stringContaining("confirmStop")]);
	});

	it("rejects out-of-range numbers", () => {
		const loaded = parseConfig({ maxConcurrent: 0, resultMaxChars: "big" });
		expect(loaded.config.maxConcurrent).toBe(4);
		expect(loaded.config.resultMaxChars).toBe(20_000);
		expect(loaded.warnings).toHaveLength(2);
	});
});
