// One-line summary of a child tool call, e.g. `Read (src/auth.ts:40-120)` (docs/07 §1.2, §8).
// Mirrors pi-bettertui's tool rows (pi-bettertui src/tool-summary.ts callDetail).

import { isAbsolute, relative } from "node:path";

const LABELS: Record<string, string> = {
	read: "Read",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
};

const SHELL_MAX = 40;
const DETAIL_MAX = 60;

export function toolLabel(name: string): string {
	return LABELS[name] ?? name;
}

export function toolLine(name: string, args: unknown, cwd?: string): string {
	const detail = toolDetail(name, isRecord(args) ? args : {}, cwd);
	return detail ? `${toolLabel(name)} (${detail})` : toolLabel(name);
}

export function toolDetail(name: string, args: Record<string, unknown>, cwd?: string): string {
	const path = displayPath(str(args.file_path ?? args.path), cwd);
	switch (name) {
		case "read": {
			const offset = num(args.offset);
			const limit = num(args.limit);
			if (offset === undefined) return path;
			return `${path}:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}`;
		}
		case "edit":
		case "write":
			return path;
		case "bash":
		case "powershell":
			return clip(oneLine(str(args.command)), SHELL_MAX);
		case "grep": {
			const pattern = str(args.pattern);
			return pattern ? clip(`/${pattern}/${path ? ` in ${path}` : ""}`, DETAIL_MAX) : path;
		}
		case "find": {
			const pattern = str(args.pattern);
			return clip(pattern && path ? `${pattern} in ${path}` : pattern || path, DETAIL_MAX);
		}
		case "ls":
			return path || ".";
		default:
			return "";
	}
}

function displayPath(path: string, cwd: string | undefined): string {
	if (!path || !cwd || !isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : path;
}

function oneLine(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	const head = (lines[0] ?? "").trim();
	return lines.length > 1 ? `${head} …` : head;
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
