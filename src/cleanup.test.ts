import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupOldSessions, DAY_MS } from "./cleanup.js";

let root: string;
const RETENTION = 14 * DAY_MS;

function file(parent: string, name: string, ageMs: number): string {
	const dir = join(root, parent);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, "x");
	const time = new Date(Date.now() - ageMs);
	utimesSync(path, time, time);
	utimesSync(dir, time, time);
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-subagent-cleanup-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cleanupOldSessions", () => {
	it("removes whole directories whose newest file is past retention, keeps the rest", async () => {
		file("old", "child.jsonl", RETENTION + 60_000);
		file("old", "ag-1.result.md", RETENTION + 120_000);
		file("mixed", "child.jsonl", RETENTION + 60_000);
		file("mixed", "ag-2.result.md", 60_000);
		file("current", "child.jsonl", RETENTION + 60_000);

		expect(await cleanupOldSessions(root, "current", RETENTION)).toBe(1);
		expect(existsSync(join(root, "old"))).toBe(false);
		expect(existsSync(join(root, "mixed"))).toBe(true);
		expect(existsSync(join(root, "current"))).toBe(true);
	});

	it("ignores a missing root and stray files", async () => {
		expect(await cleanupOldSessions(join(root, "missing"), "x", RETENTION)).toBe(0);
		writeFileSync(join(root, "stray.txt"), "x");
		expect(await cleanupOldSessions(root, "x", RETENTION)).toBe(0);
		expect(existsSync(join(root, "stray.txt"))).toBe(true);
	});
});
