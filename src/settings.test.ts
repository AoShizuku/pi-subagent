import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultConfig, loadConfig, type SubagentConfig } from "./config.js";
import { setSetting, settingsItems } from "./settings.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-settings-"));
	dirs.push(dir);
	return join(dir, "pi-subagent.json");
}

describe("settings items", () => {
	it("reflect the current config", () => {
		const config = { ...defaultConfig(), maxConcurrent: 2, childExtensions: ["pi-dsweb", "pi-ask-user"] };
		const items = settingsItems(config);
		expect(items.find((item) => item.id === "maxConcurrent")).toMatchObject({ kind: "int", value: 2, default: 4, min: 1 });
		expect(items.find((item) => item.id === "retentionDays")).toMatchObject({ applies: "new-session" });
		expect(items.find((item) => item.id === "childExtensions")).toMatchObject({
			kind: "text",
			value: "pi-dsweb, pi-ask-user",
			default: "pi-dsweb",
		});
		expect(items.find((item) => item.id === "types")).toMatchObject({ kind: "info", value: "0 overrides · edit pi-subagent.json" });
	});
});

describe("setSetting", () => {
	it("saves a valid value, keeps the rest of the file and applies the parsed field", () => {
		const path = tempFile();
		writeFileSync(path, JSON.stringify({ types: { explore: { model: "x/y" } }, retentionDays: 3 }));
		let patch: Partial<SubagentConfig> | undefined;
		expect(setSetting(path, "childExtensions", " pi-dsweb , ,guard ", (p) => (patch = p))).toEqual({ ok: true });
		expect(patch).toEqual({ childExtensions: ["pi-dsweb", "guard"] });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			types: { explore: { model: "x/y" } },
			retentionDays: 3,
			childExtensions: ["pi-dsweb", "guard"],
		});
		expect(setSetting(path, "confirmStop", false, () => {})).toEqual({ ok: true });
		expect(loadConfig(path).config).toMatchObject({ confirmStop: false, retentionDays: 3, types: { explore: { model: "x/y" } } });
	});

	it("rejects invalid values and unknown or read-only ids without writing", () => {
		const path = tempFile();
		const apply = () => {
			throw new Error("must not apply");
		};
		expect(setSetting(path, "resultMaxChars", 999, apply)).toMatchObject({ ok: false });
		expect(setSetting(path, "maxConcurrent", 1.5, apply)).toMatchObject({ ok: false });
		expect(setSetting(path, "confirmStop", "yes", apply)).toMatchObject({ ok: false });
		expect(setSetting(path, "types", "x", apply)).toMatchObject({ ok: false });
		expect(setSetting(path, "nope", 1, apply)).toMatchObject({ ok: false });
		expect(() => readFileSync(path)).toThrow();
	});

	it("leaves a broken file alone", () => {
		const path = tempFile();
		writeFileSync(path, "{ broken");
		expect(setSetting(path, "maxConcurrent", 2, () => {})).toMatchObject({ ok: false });
		expect(readFileSync(path, "utf8")).toBe("{ broken");
	});

	it("resets to the default", () => {
		const path = tempFile();
		writeFileSync(path, JSON.stringify({ notifyMaxChars: 2000 }));
		const item = settingsItems(loadConfig(path).config).find((entry) => entry.id === "notifyMaxChars");
		if (!item || item.kind !== "int") throw new Error("missing item");
		setSetting(path, "notifyMaxChars", item.default, () => {});
		expect(loadConfig(path).config.notifyMaxChars).toBe(8000);
	});
});
