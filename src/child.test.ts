import { describe, expect, it } from "vitest";

import { extensionMatches, filterExtensions } from "./child.js";

function ext(path: string, source: string, tools: string[] = [], baseDir?: string) {
	return { path, resolvedPath: path, sourceInfo: { source, baseDir }, tools: new Map(tools.map((name) => [name, {}])) };
}

const installed = [
	ext("C:\\Users\\me\\.pi\\agent\\npm\\node_modules\\pi-web\\src\\index.ts", "npm:pi-web", ["web_search", "web_fetch"]),
	ext("D:/work/demo-app/plugins/pi-hud/src/index.ts", "D:/work/demo-app/plugins/pi-hud", [], "D:/work/demo-app/plugins/pi-hud"),
	ext("D:/work/demo-app/plugins/pi-subagent/src/index.ts", "D:/work/demo-app/plugins/pi-subagent", ["agent", "agent_send"]),
	ext("/home/me/exts/lint/index.ts", "/home/me/exts/lint", ["lint"]),
	ext("/x/node_modules/@acme/pi-tools/dist/index.js", "npm:@acme/pi-tools", ["acme"]),
];

describe("child extension allowlist (docs/02 §5.2)", () => {
	it("matches package names, scoped names and path prefixes", () => {
		expect(extensionMatches(installed[0]!, "pi-web")).toBe(true);
		expect(extensionMatches(installed[0]!, "pi-we")).toBe(false);
		expect(extensionMatches(installed[3]!, "/home/me/exts/lint")).toBe(true);
		expect(extensionMatches(installed[3]!, "/home/me/exts")).toBe(true);
		expect(extensionMatches(installed[3]!, "/home/me/ex")).toBe(false);
		expect(extensionMatches(installed[4]!, "@acme/pi-tools")).toBe(true);
		expect(extensionMatches(installed[4]!, "pi-tools")).toBe(true);
		expect(extensionMatches(installed[0]!, "  ")).toBe(false);
	});

	it("keeps only allowlisted extensions, never the denied ones, and lists their tools", () => {
		const { kept, tools } = filterExtensions(installed, ["pi-web", "pi-hud", "pi-subagent", "D:/work/demo-app/plugins", "@acme/pi-tools"]);
		expect(kept.map((e) => e.sourceInfo.source)).toEqual(["npm:pi-web", "npm:@acme/pi-tools"]);
		expect(tools).toEqual(["web_search", "web_fetch", "acme"]);
		expect(filterExtensions(installed, []).kept).toEqual([]);
	});
});
