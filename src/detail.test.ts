import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";

import { AgentDetailView, contextLabel, type DetailSource, detailContent, openCommand, ScrollState } from "./detail.js";
import { AgentListView, describeAgents, listRowLimit } from "./list.js";
import type { AgentRecord } from "./manager.js";
import { emptyUsage } from "./observer.js";

/** The mock marks the background with a zero-width escape, the way the real theme does. */
const SELECTED_BG = "\x1b[41m";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => `${SELECTED_BG}${text}\x1b[0m`, getBgAnsi: (_color: string) => SELECTED_BG, inverse: (text: string) => text } as unknown as Theme;
const KEYS: Record<string, string> = { "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data } as unknown as KeybindingsManager;

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		agentId: "ag-4",
		type: "general",
		description: "迁移 import 路径",
		prompt: Array.from({ length: 10 }, (_, i) => `prompt line ${i + 1}`).join("\n"),
		status: "running",
		createdAt: 0,
		startedAt: 1000,
		model: "deepseek/deepseek-pro",
		maxTurns: 60,
		background: true,
		runs: 1,
		notes: [],
		stats: { turns: 8, toolCalls: 31, usage: emptyUsage() },
		totalUsage: { input: 80_000, output: 4000, cacheRead: 1_000_000, cacheWrite: 200, cost: 0.041 },
		notified: false,
		activity: [
			{ toolCallId: "1", name: "grep", line: "Grep (/lib\\/http/ in src)", startedAt: 1000, endedAt: 1300, isError: false },
			{ toolCallId: "2", name: "edit", line: "Edit (src/api/user.ts)", startedAt: 2000, endedAt: 2100, isError: true },
			{ toolCallId: "3", name: "bash", line: "Bash (npm run typecheck)", startedAt: 5000 },
		],
		...overrides,
	};
}

describe("detailContent", () => {
	it("shows stats, the first 8 prompt lines, activity and what the agent is writing", () => {
		const lines = detailContent(record(), theme, {
			width: 80,
			now: 19_000,
			fullPrompt: false,
			progress: { turns: 8, toolCalls: 31, activeTools: [], recentText: "first line\n类型检查通过后我会再确认", usage: emptyUsage(), contextLimited: false, lastEventAt: 0 },
		});
		expect(lines[0]).toBe("deepseek/deepseek-pro · turn 9/60 · 31 tools · 84.2K tok · $0.041");
		expect(lines).toContain("  prompt line 8");
		expect(lines).not.toContain("  prompt line 9");
		expect(lines).toContain("  … 2 more lines (e to expand)");
		expect(lines).toContain("  ✓ Grep (/lib\\/http/ in src) · 0s");
		expect(lines).toContain("  ✗ Edit (src/api/user.ts) · 0s");
		expect(lines).toContain("  ● Bash (npm run typecheck) · 14s");
		expect(lines.at(-1)).toBe("Writing: 类型检查通过后我会再确认");
	});

	it("shows the report, the reason and the open command once finished", () => {
		const lines = detailContent(record({ status: "failed", reason: "provider error: 529", endedAt: 9000, stats: { turns: 3, toolCalls: 2, usage: emptyUsage() } }), theme, {
			width: 80,
			now: 20_000,
			fullPrompt: true,
			report: "# Done\nAll good.",
			transcript: "C:/s/child.jsonl",
			renderMarkdown: (text) => text.split("\n").map((line) => `md:${line}`),
		});
		expect(lines[0]).toBe("deepseek/deepseek-pro · 3 turns · 2 tools · 84.2K tok · $0.041");
		expect(lines[1]).toBe("reason: provider error: 529");
		expect(lines).toContain("  prompt line 10");
		expect(lines).toContain("  md:# Done");
		expect(lines.slice(-2)).toEqual(["Transcript: C:/s/child.jsonl", `Open it in pi: ${openCommand("C:/s/child.jsonl")}`]);
		expect(openCommand("C:/s/child.jsonl")).toBe('pi --session "C:/s/child.jsonl"');
	});

	it("says when the activity of a restored agent is not available", () => {
		const lines = detailContent(record({ status: "completed", activity: undefined, endedAt: 2 }), theme, { width: 80, now: 3, fullPrompt: false, report: "" });
		expect(lines).toContain("  (not recorded in this pi process; open the transcript)");
		expect(lines).toContain("  (no final report)");
	});
});

describe("ScrollState", () => {
	it("follows the end until the user scrolls up, and again after scrolling back down", () => {
		const scroll = new ScrollState(true);
		expect(scroll.layout(30, 10)).toBe(20);
		expect(scroll.layout(35, 10)).toBe(25);
		scroll.scrollBy(-3);
		expect(scroll.following).toBe(false);
		expect(scroll.layout(40, 10)).toBe(22);
		scroll.page(1);
		expect(scroll.layout(40, 10)).toBe(30);
		scroll.scrollBy(1);
		expect(scroll.following).toBe(true);
		expect(scroll.layout(50, 10)).toBe(40);
		scroll.toStart();
		expect(scroll.layout(50, 10)).toBe(0);
		scroll.toEnd();
		expect(scroll.layout(60, 10)).toBe(50);
	});

	it("starts at the top for a finished agent", () => {
		const scroll = new ScrollState(false);
		expect(scroll.layout(30, 10)).toBe(0);
	});
});

describe("AgentDetailView", () => {
	const views: AgentDetailView[] = [];
	afterEach(() => {
		for (const view of views.splice(0)) view.dispose();
	});

	function view(rec: AgentRecord, rows = 30, confirm = true) {
		const stopped: string[] = [];
		let closed = 0;
		let renders = 0;
		const source: DetailSource = {
			get: (id) => (id === rec.agentId ? rec : undefined),
			progress: () => undefined,
			subscribe: () => () => {},
			stop: (id) => stopped.push(id),
			report: () => "the report",
			transcript: () => "C:/s/child.jsonl",
			confirmStop: () => confirm,
		};
		const host = { requestRender: () => renders++, terminal: { rows } };
		const v = new AgentDetailView(host, theme, keybindings, source, rec.agentId, () => closed++);
		views.push(v);
		return { v, stopped, closed: () => closed, renders: () => renders };
	}

	it("draws a framed box no wider than the overlay and as tall as 80% of the terminal, whatever the content", () => {
		const { v } = view(record());
		const lines = v.render(70);
		// Short content still fills 80% of 30 rows: a centred box that grew with each activity line would jump.
		expect(lines).toHaveLength(24);
		const { v: tall } = view(record({ prompt: Array.from({ length: 60 }, (_, i) => `p${i}`).join("\n") }));
		tall.handleInput("e");
		expect(tall.render(70)).toHaveLength(24);
		// The status keeps a dash before the corner, as the /provider and /sessions boxes do.
		expect(lines[0]).toMatch(/^╭─ ag-4 · general · 迁移 import 路径 ─+ ● running · \S+ ─╮$/);
		expect(lines.at(-1)).toMatch(/^╰─+╯$/);
		expect(lines.at(-2)).toContain("e prompt · x stop · esc close");
		for (const line of lines) expect(visibleWidth(line)).toBe(70);
	});

	it("shows the context fill left of the duration once the child reports one", () => {
		const { v } = view(record({ context: { tokens: 84_200, window: 200_000 } }));
		const lines = v.render(70);
		expect(lines[0]).toMatch(/ ● running · ctx 42% · \S+ ─╮$/);
		expect(visibleWidth(lines[0] ?? "")).toBe(70);
	});

	it("colours the context fill like pi-hud: dim, warning from 70%, error from 85%", () => {
		const colored = { fg: (color: string, text: string) => `<${color}>${text}` } as unknown as Theme;
		expect(contextLabel({}, colored)).toBeUndefined();
		expect(contextLabel({ context: { tokens: 69_000, window: 100_000 } }, colored)).toBe("<dim>ctx 69%");
		expect(contextLabel({ context: { tokens: 70_000, window: 100_000 } }, colored)).toBe("<warning>ctx 70%");
		expect(contextLabel({ context: { tokens: 85_000, window: 100_000 } }, colored)).toBe("<error>ctx 85%");
		expect(contextLabel({ context: { tokens: 300_000, window: 100_000 } }, colored)).toBe("<error>ctx 100%");
	});

	it("x x stops a running agent, e expands the prompt, esc closes", () => {
		const { v, stopped, closed } = view(record());
		v.handleInput("x");
		expect(stopped).toEqual([]);
		v.handleInput("x");
		expect(stopped).toEqual(["ag-4"]);
		expect(v.render(70).join("\n")).toContain("stopping ag-4");
		v.handleInput("e");
		expect(v.render(70).join("\n")).toContain("prompt line 10");
		v.handleInput("\x1b");
		expect(closed()).toBe(1);
	});

	it("the first x swaps the key line for the prompt; Esc then only cancels, without closing", () => {
		const { v, stopped, closed } = view(record());
		v.handleInput("x");
		expect(v.render(70).at(-2)).toContain("press x again to stop · any other key cancels");
		v.handleInput("\x1b");
		expect(closed()).toBe(0);
		expect(v.render(70).at(-2)).toContain("e prompt · x stop · esc close");
		// e while armed only cancels too: the prompt stays collapsed.
		v.handleInput("x");
		v.handleInput("e");
		expect(v.render(70).join("\n")).not.toContain("prompt line 10");
		// A scroll key cancels and still scrolls; so does the wheel.
		v.handleInput("x");
		v.handleInput("\x1b[A");
		v.handleInput("x");
		v.handleMouse({ type: "wheel", wheelDelta: 1 } as never);
		expect(v.render(70).at(-2)).not.toContain("press x again");
		expect(stopped).toEqual([]);
	});

	it("with confirmStop off, one x stops", () => {
		const { v, stopped } = view(record(), 30, false);
		v.handleInput("x");
		expect(stopped).toEqual(["ag-4"]);
	});

	it("an agent already being stopped says stopping and ignores x", () => {
		const { v, stopped } = view(record({ stoppedBy: "user" }));
		const lines = v.render(70);
		expect(lines[0]).toContain("● stopping");
		expect(lines.at(-2)).not.toContain("x stop");
		v.handleInput("x");
		v.handleInput("x");
		expect(stopped).toEqual([]);
	});

	it("the arm is dropped when the agent ends on its own", () => {
		const rec = record();
		const { v, stopped } = view(rec);
		v.handleInput("x");
		rec.status = "completed";
		rec.endedAt = 5000;
		expect(v.render(70).at(-2)).not.toContain("press x again");
		v.handleInput("x");
		expect(stopped).toEqual([]);
	});

	it("scrolls with the wheel and ignores other mouse events", () => {
		const long = record({ status: "completed", endedAt: 2000, prompt: Array.from({ length: 60 }, (_, i) => `p${i}`).join("\n") });
		const { v } = view(long, 20);
		v.handleInput("e");
		const first = v.render(70)[1];
		expect(v.handleMouse({ type: "wheel", wheelDelta: 3 } as never)).toEqual({ handled: true });
		expect(v.render(70)[1]).not.toBe(first);
		expect(v.handleMouse({ type: "click", button: "left" } as never)).toBeUndefined();
	});
});

describe("/agents list", () => {
	it("describes agents in focus order for modes without a TUI", () => {
		const text = describeAgents(
			[record({ agentId: "ag-1", status: "completed", endedAt: 61_000, description: "done one" }), record({ agentId: "ag-2", status: "queued", startedAt: undefined })],
			100_000,
		);
		expect(text).toBe("ag-2  queued  general  迁移 import 路径\nag-1  completed  1m00s  general  done one");
		expect(describeAgents([])).toBe("No subagents in this session.");
	});

	function listView(records: AgentRecord[], rows = 30, listTheme: Theme = theme) {
		const stopped: string[] = [];
		const opened: string[] = [];
		let closed = 0;
		const list = new AgentListView(
			{ requestRender: () => {}, terminal: { rows } },
			listTheme,
			keybindings,
			{ list: () => records, stop: (id) => stopped.push(id), open: (id) => opened.push(id) },
			() => closed++,
		);
		return { list, stopped, opened, closed: () => closed };
	}

	/** Marks colors and surfaces by name, to tell the armed row from the plain selection. */
	const marking = {
		...theme,
		fg: (color: string, text: string) => (color === "error" || color === "accent" ? `<${color}>${text}` : text),
		bg: (color: string, text: string) => `[${color}]${text}`,
		getBgAnsi: (color: string) => `[${color}]`,
	} as unknown as Theme;

	it("selects, stops and opens agents without closing; esc closes", () => {
		const records = [record({ agentId: "ag-1" }), record({ agentId: "ag-2", status: "completed", endedAt: 5 })];
		const { list, stopped, opened, closed } = listView(records);
		// The title and the counts sit on the top edge.
		expect(list.render(100)[0]).toMatch(/^─ Subagents ─+ 1 active, 2 total ─$/);
		expect(list.render(100)[2]).toMatch(/^\x1b\[41m▎ ag-1 +running/);
		list.handleInput("x");
		list.handleInput("x");
		list.handleInput("\x1b[B");
		list.handleInput("x");
		expect(stopped).toEqual(["ag-1"]);
		list.handleInput("\r");
		expect(opened).toEqual(["ag-2"]);
		// The list stays open under the detail, with the same selection.
		expect(closed()).toBe(0);
		expect(list.render(100)[3]).toMatch(/^\x1b\[41m▎ ag-2 +completed/);
		list.handleInput("q");
		expect(closed()).toBe(1);
		// Closed: Enter no longer opens anything, and a second close is a no-op.
		list.handleInput("\r");
		list.handleInput("\x1b");
		expect(opened).toEqual(["ag-2"]);
		expect(closed()).toBe(1);
		list.dispose();
	});

	it("the first x arms the row: error bar, error surface and the prompt in place of the key line", () => {
		const records = [record({ agentId: "ag-1" }), record({ agentId: "ag-2" })];
		const { list, stopped } = listView(records, 30, marking);
		expect(list.render(100)[2]).toMatch(/^\[selectedBg\]<accent>▎ /);
		list.handleInput("x");
		const lines = list.render(100);
		expect(lines[2]).toMatch(/^\[toolErrorBg\]<error>▎ /);
		expect(lines.at(-1)).toBe("<error>press x again to stop · any other key cancels");
		expect(stopped).toEqual([]);
		list.handleInput("x");
		expect(stopped).toEqual(["ag-1"]);
		expect(list.render(100)[2]).toMatch(/^\[selectedBg\]<accent>▎ /);
	});

	it("armed: ↓ cancels and moves; Esc, Enter and q only cancel", () => {
		const records = [record({ agentId: "ag-1" }), record({ agentId: "ag-2" })];
		const { list, stopped, opened, closed } = listView(records);
		list.handleInput("x");
		list.handleInput("\x1b[B");
		expect(list.render(100)[3]).toMatch(/▎ ag-2/);
		// The arm stayed with ag-1: x on ag-2 arms ag-2 instead of stopping anything.
		list.handleInput("x");
		expect(stopped).toEqual([]);
		for (const key of ["\x1b", "\r", "q"]) {
			list.handleInput(key);
			list.handleInput("x");
		}
		expect(closed()).toBe(0);
		expect(opened).toEqual([]);
		expect(stopped).toEqual([]);
		list.handleInput("x");
		expect(stopped).toEqual(["ag-2"]);
		list.dispose();
	});

	it("keeps the arm on the agent, not the row, and drops it when that agent ends", () => {
		const first = record({ agentId: "ag-1", startedAt: 1000 });
		const second = record({ agentId: "ag-2", startedAt: 2000 });
		const records = [first, second];
		const { list, stopped } = listView(records);
		list.handleInput("\x1b[B");
		list.handleInput("x");
		// ag-1 ends on its own and sorts below: ag-2 moves to the top row but stays selected and armed.
		first.status = "completed";
		first.endedAt = 3000;
		expect(list.render(100).at(-1)).toContain("press x again");
		list.handleInput("x");
		expect(stopped).toEqual(["ag-2"]);
		// Now the armed agent itself ends: the prompt goes away and x no longer stops it.
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[A");
		list.handleInput("x");
		second.status = "completed";
		second.endedAt = 4000;
		expect(list.render(100).at(-1)).toContain("x stop");
		list.dispose();
	});

	it("an agent being stopped shows stopping and x does not arm it", () => {
		const { list, stopped } = listView([record({ agentId: "ag-1", stoppedBy: "user" })]);
		expect(list.render(100)[2]).toMatch(/▎ ag-1 +stopping/);
		list.handleInput("x");
		list.handleInput("x");
		expect(stopped).toEqual([]);
		expect(list.render(100).at(-1)).toContain("x stop · esc close");
		list.dispose();
	});

	it("marks the selected row with a bar and the selection surface, and the surface fills the line", () => {
		const records = [record({ agentId: "ag-1" }), record({ agentId: "ag-2", status: "completed", endedAt: 5 })];
		const { list } = listView(records);
		const row = list.render(100)[2] ?? "";
		expect(row.startsWith(`${SELECTED_BG}▎ ag-1`)).toBe(true);
		expect(visibleWidth(row)).toBe(100);
		// The other rows stay on the terminal background.
		expect(list.render(100)[3]).not.toContain(SELECTED_BG);
		list.dispose();
	});

	it("caps the visible rows for the bottom slot and shows how many are hidden", () => {
		expect(listRowLimit(10)).toBe(4);
		expect(listRowLimit(5)).toBe(3);
		expect(listRowLimit(24)).toBe(9);
		expect(listRowLimit(60)).toBe(10);
		const records = Array.from({ length: 20 }, (_, i) => record({ agentId: `ag-${i + 1}`, status: "completed", endedAt: 5 + i }));
		const { list } = listView(records, 24);
		const lines = list.render(100);
		const agentRows = lines.filter((line) => /ag-\d+/.test(line));
		expect(agentRows).toHaveLength(9);
		expect(lines).toContain("  ↓ 11 more");
		expect(lines.some((line) => /^ {2}↑ \d+ more$/.test(line))).toBe(false);
		// Header, blank, 9 rows, "↓ 11 more", blank, hints.
		expect(lines).toHaveLength(14);
		for (let i = 0; i < 10; i++) list.handleInput("\x1b[B");
		const scrolled = list.render(100);
		expect(scrolled.filter((line) => /ag-\d+/.test(line))).toHaveLength(9);
		expect(scrolled).toContain("  ↑ 6 more");
		expect(scrolled).toContain("  ↓ 5 more");
		list.dispose();
	});
});
