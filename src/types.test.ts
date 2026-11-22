import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";
import { testType } from "./test-helpers.js";
import { activeChildTools, builtinAgentsDir, effectiveTools, loadAgentTypes, lookupType, type TypeDirs } from "./types.js";

let root: string;
let dirs: TypeDirs;

function write(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), content);
}

function typeFile(fields: Record<string, string>, body = "Body text."): string {
	return `---\n${Object.entries(fields)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n")}\n---\n\n${body}\n`;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-types-"));
	dirs = {
		builtinDir: builtinAgentsDir(),
		userDir: join(root, "user"),
		projectDir: join(root, "project", ".pi", "agents"),
		projectTrusted: true,
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loadAgentTypes", () => {
	it("loads the built-in explore and general types", () => {
		const { types, warnings } = loadAgentTypes(dirs);
		expect(warnings).toEqual([]);
		expect([...types.keys()]).toEqual(["explore", "general"]);
		const explore = types.get("explore");
		expect(explore).toMatchObject({
			tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"],
			thinking: "low",
			maxTurns: 300,
			contextLimit: 70,
			source: "builtin",
			contextFiles: true,
			skills: false,
		});
		expect(explore?.body).toContain("You are a read-only search agent.");
		expect(types.get("general")).toMatchObject({
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"],
			thinking: undefined,
			maxTurns: 300,
			contextLimit: 70,
		});
	});

	it("lets user types override built-ins and project types override user types, case-insensitively", () => {
		write(dirs.userDir, "Explore.md", typeFile({ name: "EXPLORE", description: "user explore", tools: "read" }));
		write(dirs.userDir, "tracer.md", typeFile({ description: "user tracer" }));
		write(dirs.projectDir, "tracer.md", typeFile({ name: "Tracer", description: "project tracer", tools: "read, grep" }));
		const { types } = loadAgentTypes(dirs);
		expect(types.get("explore")).toMatchObject({ description: "user explore", tools: ["read"], source: "user", maxTurns: 300 });
		expect(types.get("tracer")).toMatchObject({ description: "project tracer", tools: ["read", "grep"], source: "project" });
		expect(lookupType(types, "TRACER")?.source).toBe("project");
		expect(lookupType(types, undefined)?.name).toBe("general");
	});

	it("skips files without a description and warns", () => {
		write(dirs.userDir, "nodesc.md", typeFile({ name: "nodesc" }));
		const { types, warnings } = loadAgentTypes(dirs);
		expect(types.has("nodesc")).toBe(false);
		expect(warnings).toEqual([expect.stringContaining("missing description")]);
	});

	it("accepts extension tool names and rejects malformed ones", () => {
		write(dirs.userDir, "web.md", typeFile({ description: "web", tools: "read, web_search" }));
		write(dirs.userDir, "bad-tools.md", typeFile({ description: "bad", tools: "read, web search" }));
		const { types, warnings } = loadAgentTypes(dirs);
		expect(types.get("web")?.tools).toEqual(["read", "web_search"]);
		expect(types.has("bad-tools")).toBe(false);
		expect(warnings.join("\n")).toContain("invalid tool names: web search");
	});

	it("activates extension tools only when an allowlisted extension registered them", () => {
		const listed = ["read", "grep", "web_search", "web_fetch"];
		expect(activeChildTools(listed, [])).toEqual(["read", "grep"]);
		expect(activeChildTools(listed, ["web_search", "web_fetch", "other_tool"])).toEqual(listed);
		expect(activeChildTools([], ["web_search"])).toEqual([]);
	});

	it("rejects invalid names", () => {
		write(dirs.userDir, "bad.md", typeFile({ name: "bad name!", description: "x" }));
		const { types, warnings } = loadAgentTypes(dirs);
		expect(types.size).toBe(2);
		expect(warnings[0]).toContain("invalid name");
	});

	it("skips project types when the project is not trusted and counts them", () => {
		write(dirs.projectDir, "a.md", typeFile({ description: "a" }));
		write(dirs.projectDir, "b.md", typeFile({ description: "b" }));
		const { types, skippedProject } = loadAgentTypes({ ...dirs, projectTrusted: false });
		expect(types.has("a")).toBe(false);
		expect(skippedProject).toBe(2);
	});

	it("disables a lower-priority type with enabled: false", () => {
		write(dirs.userDir, "explore.md", "---\nenabled: false\n---\n");
		const { types } = loadAgentTypes(dirs);
		expect(types.has("explore")).toBe(false);
		expect(types.has("general")).toBe(true);
	});

	it("ignores invalid thinking, max_turns and context_limit with warnings, and parses list tools and none", () => {
		write(dirs.userDir, "a.md", typeFile({ description: "a", thinking: "huge", max_turns: "1", context_limit: "99", tools: "none" }));
		write(
			dirs.userDir,
			"b.md",
			"---\ndescription: b\ntools:\n  - read\n  - LS\ncontext_files: false\nskills: true\nbackground: true\ncontext_limit: 50\n---\n",
		);
		const { types, warnings } = loadAgentTypes(dirs);
		expect(types.get("a")).toMatchObject({ thinking: undefined, maxTurns: 300, contextLimit: 70, tools: [], background: false });
		expect(types.get("b")).toMatchObject({ tools: ["read", "ls"], contextFiles: false, skills: true, background: true, contextLimit: 50, body: "" });
		expect(warnings).toHaveLength(3);
		expect(warnings).toContainEqual(expect.stringContaining("context_limit must be an integer from 10 to 95; using 70"));
	});

	it("applies config overrides and warns about unknown names", () => {
		const { config } = parseConfig({
			types: { Explore: { model: "deepseek/flash", thinking: "high", max_turns: 12, context_limit: 60 }, ghost: { model: "x/y" } },
		});
		const { types, warnings } = loadAgentTypes(dirs, config);
		expect(types.get("explore")).toMatchObject({ model: "deepseek/flash", thinking: "high", maxTurns: 12, contextLimit: 60, source: "builtin" });
		expect(warnings).toEqual([expect.stringContaining("types.ghost")]);
	});
});

describe("effectiveTools", () => {
	it("swaps bash for powershell in the built-in general type when the parent uses powershell", () => {
		const general = testType({ tools: ["read", "bash", "edit"] });
		expect(effectiveTools(general, ["read", "powershell"])).toEqual(["read", "powershell", "edit"]);
		expect(effectiveTools(general, ["read", "bash"])).toEqual(["read", "bash", "edit"]);
		expect(effectiveTools({ ...general, source: "user" }, ["powershell"])).toEqual(["read", "bash", "edit"]);
		expect(effectiveTools({ ...general, name: "other" }, ["powershell"])).toEqual(["read", "bash", "edit"]);
	});
});
