import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { type AgentEntry, AgentManager, type AgentRecord, isTerminal, toEntry } from "./manager.js";
import { emptyUsage } from "./observer.js";
import {
	agentCardRenderers,
	type AgentToolDetails,
	CardLink,
	type CardSource,
	type NotificationDetails,
	notificationLines,
	renderAgentCall,
	renderAgentResult,
	renderStopCall,
	renderStopResult,
	resultBody,
} from "./render.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
/** Keeps the color names, so a test can tell which token a run uses. */
const colorTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text } as unknown as Theme;

const args = { description: "find auth code", prompt: "Find the session check.\nLine 2", agent_type: "explore" };

function details(overrides: Partial<AgentToolDetails> = {}): AgentToolDetails {
	return {
		agentId: "ag-1",
		type: "explore",
		description: "find auth code",
		status: "completed",
		turns: 6,
		toolCalls: 14,
		durationMs: 72_000,
		usage: { ...emptyUsage(), input: 40_000, output: 8_100, cacheRead: 99_999, cost: 0.012 },
		model: "faux/faux-1",
		maxTurns: 30,
		truncated: false,
		...overrides,
	};
}

function card(result?: { text?: string; details?: AgentToolDetails; partial?: boolean; isError?: boolean }, expanded = false, outputPad?: number) {
	const context = { state: {}, expanded, isError: result?.isError ?? false, outputPad, lastComponent: undefined } as never;
	const component = renderAgentCall(args as never, theme, context);
	if (result) {
		renderAgentResult(
			{ content: [{ type: "text", text: result.text ?? "" }], details: result.details } as never,
			{ expanded, isPartial: result.partial ?? false },
			theme,
			context,
		);
	}
	return component.render(200);
}

describe("agent tool card", () => {
	it("shows one header line before the result", () => {
		expect(card()).toEqual(["● Agent explore · find auth code"]);
	});

	it("shows a single queued line", () => {
		expect(card({ details: details({ status: "queued", queuePosition: 2 }), partial: true })).toEqual(["● Agent explore · find auth code · queued (2)"]);
	});

	it("shows exactly three lines while running", () => {
		const progress = {
			turns: 2,
			toolCalls: 6,
			activeTools: [
				{ toolCallId: "a", name: "grep", line: "Grep (/authenticate/ in src)", startedAt: 0 },
				{ toolCallId: "b", name: "read", line: "Read (src/auth/session.ts:40-120)", startedAt: 0 },
			],
			recentText: "",
			usage: { ...emptyUsage(), input: 18_000, output: 200 },
			contextLimited: false,
			lastEventAt: 0,
		};
		expect(card({ details: details({ status: "running", durationMs: 23_000, progress }), partial: true })).toEqual([
			"● Agent explore · find auth code · 23s",
			"  ├ Grep (/authenticate/ in src) · Read (src/auth/session.ts:40-120)",
			"  └ 6 tools · turn 3 · 18.2K tok",
		]);
		const idle = card({ details: details({ status: "running", durationMs: 1000, progress: { ...progress, activeTools: [], recentText: "first\nNow checking the" } }), partial: true });
		expect(idle).toHaveLength(3);
		expect(idle[1]).toBe("  ├ Now checking the");
	});

	it("collapses a finished run to one line per status", () => {
		expect(card({ details: details() })).toEqual(["✓ Agent explore · find auth code · 14 tools · 48.1K tok · 1m12s ▸"]);
		expect(card({ details: details({ status: "failed", reason: "provider error: 529 overloaded", durationMs: 14_000 }), isError: true })).toEqual([
			"✗ Agent explore · find auth code · failed: provider error: 529 overloaded · 14s ▸",
		]);
		expect(card({ details: details({ status: "aborted", durationMs: 9000 }) })[0]).toBe("■ Agent explore · find auth code · stopped · 9s ▸");
		expect(card({ details: details({ status: "max_turns", durationMs: 362_000 }) })[0]).toBe("↻ Agent explore · find auth code · out of turns (30) · 6m02s ▸");
	});

	it("expands to metadata, the prompt, the report and the transcript", () => {
		const text = '<subagent-result agent-id="ag-1">\nThe answer.\n</subagent-result>\ntranscript: /s/c.jsonl';
		const lines = card({ text, details: details({ sessionFile: "/s/c.jsonl" }) }, true);
		expect(lines[0]).toMatch(/▾$/);
		expect(lines.slice(1)).toEqual([
			"  ag-1 · faux/faux-1 · 6 turns · $0.012",
			"  ┌ prompt",
			"  │ Find the session check.",
			"  │ Line 2",
			"  ├ report",
			"  │ The answer.",
			"  └ transcript: /s/c.jsonl",
		]);
	});

	it("keeps the icon in the gutter's column 0 whatever pi's outputPad is", () => {
		expect(card(undefined, false, 1)).toEqual(["● Agent explore · find auth code"]);
		expect(card({ details: details() }, false, 1)).toEqual(["✓ Agent explore · find auth code · 14 tools · 48.1K tok · 1m12s ▸"]);
		const text = '<subagent-result agent-id="ag-1">\nThe answer.\n</subagent-result>';
		const lines = card({ text, details: details() }, true, 2);
		expect(lines[0]!.startsWith("✓ Agent")).toBe(true);
		expect(lines).toContain("  │ The answer.");
	});

	it("shows a thrown error on the header line", () => {
		expect(card({ text: 'Unknown agent type "x". Available types: explore', isError: true })).toEqual([
			'✗ Agent explore · find auth code · Unknown agent type "x". Available types: explore',
		]);
	});

	it("draws a thrown error whose details pi stored as {} instead of crashing", () => {
		// pi records a thrown tool error as `details: {}`; reading a status from it once killed the process.
		const context = { state: {}, expanded: false, isError: true, lastComponent: undefined } as never;
		const component = renderAgentCall({ agent_id: "ag-8", message: "Continue." } as never, colorTheme, context);
		const text = "ag-8 cannot be continued: its transcript is no longer available. Start a new agent.";
		renderAgentResult({ content: [{ type: "text", text }], details: {} } as never, { expanded: false, isPartial: false }, colorTheme, context);
		const line = component.render(300)[0] ?? "";
		expect(line.startsWith("<error>✗</error> ")).toBe(true);
		expect(line).toContain(`<error>${text}</error>`);
		expect(line).not.toContain("undefined");
	});

	it("extracts the report body from the result text", () => {
		expect(resultBody({ content: [{ type: "text", text: '<subagent-result a="1">\nline 1\nline 2\n</subagent-result>\nnote: x' }] })).toBe("line 1\nline 2");
	});

	it("draws a background start as one line (docs/07 §1.4)", () => {
		expect(card({ details: details({ agentId: "ag-2", status: "running", background: true }) })).toEqual([
			"● Agent explore · find auth code · ag-2 running in background",
		]);
		expect(card({ details: details({ agentId: "ag-3", status: "queued", queuePosition: 2, background: true }) })).toEqual([
			"● Agent explore · find auth code · ag-3 queued in background (2)",
		]);
	});

	it("draws running in accent and stopped in warning", () => {
		const context = { state: {}, expanded: false, isError: false, lastComponent: undefined } as never;
		const component = renderAgentCall(args as never, colorTheme, context);
		expect(component.render(200)[0]?.startsWith("<accent>●</accent> ")).toBe(true);
		renderAgentResult({ content: [], details: details({ status: "aborted" }) } as never, { expanded: false, isPartial: false }, colorTheme, context);
		expect(component.render(200)[0]?.startsWith("<warning>■</warning> ")).toBe(true);
	});

	it("draws an agent_send call and a message queued for a running agent", () => {
		const context = { state: {}, expanded: false, isError: false, lastComponent: undefined } as never;
		const component = renderAgentCall({ agent_id: "ag-1", message: "Also check tests.\nMore." } as never, theme, context);
		expect(component.render(200)).toEqual(["● Agent ag-1 ← Also check tests. · follow-up"]);
		renderAgentResult({ content: [{ type: "text", text: "Message queued for ag-1; it will be part of the report." }] } as never, { expanded: false, isPartial: false }, theme, context);
		expect(component.render(200)).toEqual(["● Agent ag-1 ← Also check tests. · follow-up · Message queued for ag-1; it will be part of the report."]);
	});
});

describe("background card following the agent's record (docs/07 §1.4)", () => {
	const START = 1_000_000;

	function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
		return {
			agentId: "ag-2",
			type: "explore",
			description: "find auth code",
			prompt: "Find the session check.",
			status: "running",
			createdAt: START,
			startedAt: START,
			model: "faux/faux-1",
			background: true,
			runs: 1,
			notes: [],
			stats: { turns: 2, toolCalls: 4, usage: { ...emptyUsage(), input: 4000, output: 400 } },
			totalUsage: emptyUsage(),
			notified: false,
			...overrides,
		};
	}

	/** A stand-in for AgentManager: set() changes a record, keeps a run's outcome when it ends, and announces it. */
	class FakeSource implements CardSource {
		readonly records = new Map<string, AgentRecord>();
		readonly outcomes = new Map<string, AgentRecord>();
		readonly listeners = new Set<(record: AgentRecord) => void>();
		get(agentId: string) {
			return this.records.get(agentId);
		}
		runOutcome(agentId: string, run: number) {
			return this.outcomes.get(`${agentId}#${run}`);
		}
		subscribe(listener: (record: AgentRecord) => void) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		set(next: AgentRecord) {
			this.records.set(next.agentId, next);
			if (isTerminal(next.status)) this.outcomes.set(`${next.agentId}#${next.runs}`, { ...next });
			for (const listener of [...this.listeners]) listener(next);
		}
	}

	/** A background card on a row: invalidate re-runs both renderers the way pi's tool row does. */
	function row(link: CardLink, options: { expanded?: boolean; run?: number; queued?: boolean; t?: Theme } = {}) {
		const renderers = agentCardRenderers(link);
		const t = options.t ?? theme;
		let invalidations = 0;
		const start = details({ agentId: "ag-2", status: options.queued ? "queued" : "running", background: true, run: options.run ?? 1, durationMs: 0 });
		const context = {
			state: {},
			toolCallId: "tc-1",
			expanded: options.expanded ?? false,
			isError: false,
			lastComponent: undefined,
			invalidate: () => {
				invalidations += 1;
				draw();
			},
		} as never;
		let component: { render(width: number): string[] } | undefined;
		const draw = () => {
			component = renderers.renderCall(args as never, t, context);
			renderers.renderResult(
				{ content: [{ type: "text", text: "Started subagent ag-2 (explore): find auth code" }], details: start } as never,
				{ expanded: options.expanded ?? false, isPartial: false },
				t,
				context,
			);
		};
		draw();
		return { lines: () => component?.render(200) ?? [], invalidations: () => invalidations };
	}

	it("switches from running to completed, redrawing once when the record ends", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		source.set(record());
		const card = row(link);
		expect(card.lines()).toEqual(["● Agent explore · find auth code · ag-2 running in background"]);

		// Progress does not redraw the card.
		source.set(record({ stats: { turns: 3, toolCalls: 5, usage: emptyUsage() } }));
		expect(card.invalidations()).toBe(0);

		source.set(record({ status: "completed", endedAt: START + 8000, text: "The answer." }));
		expect(card.invalidations()).toBe(1);
		expect(card.lines()).toEqual(["✓ Agent explore · find auth code · 4 tools · 4.4K tok · 8s ▸"]);
		// Further announcements of the ended record do not redraw again.
		source.set(record({ status: "completed", endedAt: START + 8000, text: "The answer." }));
		expect(card.invalidations()).toBe(1);
	});

	it("expands a completed background card like a foreground one, with the report from the record", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		source.set(record({ status: "completed", endedAt: START + 8000, text: "The answer.", sessionFile: "/s/c.jsonl" }));
		expect(row(link, { expanded: true }).lines()).toEqual([
			"✓ Agent explore · find auth code · 4 tools · 4.4K tok · 8s ▾",
			"  ag-2 · faux/faux-1 · 2 turns",
			"  ┌ prompt",
			"  │ Find the session check.",
			"  │ Line 2",
			"  ├ report",
			"  │ The answer.",
			"  └ transcript: /s/c.jsonl",
		]);
	});

	it("shows a failure and a stop on one line", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		source.set(record());
		const card = row(link);
		source.set(record({ status: "failed", reason: "529 overloaded", endedAt: START + 14_000 }));
		expect(card.lines()).toEqual(["✗ Agent explore · find auth code · failed · 529 overloaded · 14s"]);

		const stopped = new FakeSource();
		const link2 = new CardLink();
		link2.attach(stopped);
		stopped.set(record());
		const colored = row(link2, { t: colorTheme });
		stopped.set(record({ status: "aborted", reason: "stopped by parent", stoppedBy: "parent", endedAt: START + 2000 }));
		expect(colored.invalidations()).toBe(1);
		const line = colored.lines()[0] ?? "";
		expect(line.startsWith("<warning>■</warning> ")).toBe(true);
		expect(line.replace(/<\/?[a-zA-Z]+>/g, "")).toBe("■ Agent explore · find auth code · stopped after 2s");
	});

	it("keeps the queued line while the record waits", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		source.set(record({ status: "queued", startedAt: undefined }));
		expect(row(link, { queued: true }).lines()).toEqual(["● Agent explore · find auth code · ag-2 queued in background"]);
	});

	it("draws the start line dim as a whole when the record is gone", () => {
		const link = new CardLink();
		link.attach(new FakeSource());
		expect(row(link, { t: colorTheme }).lines()).toEqual(["<dim>● Agent explore · find auth code · ag-2 running in background</dim>"]);
	});

	it("redraws a card drawn before session_start once the restored manager is attached (resume)", () => {
		const link = new CardLink();
		const card = row(link, { t: colorTheme });
		expect(card.lines()[0]?.startsWith("<dim>")).toBe(true);
		const source = new FakeSource();
		source.records.set("ag-2", record({ status: "aborted", reason: "session ended", endedAt: START + 99_000 }));
		link.attach(source);
		expect(card.invalidations()).toBe(1);
		expect(card.lines()[0]?.replace(/<\/?[a-zA-Z]+>/g, "")).toBe("■ Agent explore · find auth code · stopped · session ended");
	});

	it("keeps its run's outcome when agent_send reopens the agent before the card is drawn again", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		source.set(record());
		const card = row(link);
		// Run 1 ends and run 2 starts and ends without the card's lines being drawn in between.
		source.set(record({ status: "completed", endedAt: START + 8000 }));
		source.set(record({ status: "running", runs: 2, startedAt: START + 20_000 }));
		source.set(record({ status: "failed", runs: 2, reason: "529 overloaded", startedAt: START + 20_000, endedAt: START + 30_000 }));
		expect(card.lines()).toEqual(["✓ Agent explore · find auth code · 4 tools · 4.4K tok · 8s ▸"]);
		expect(row(link, { run: 2 }).lines()).toEqual(["✗ Agent explore · find auth code · failed · 529 overloaded · 10s"]);
	});

	it("finds each run's outcome after restore, also for a later agent_send run (resume)", () => {
		const entry = (overrides: Partial<AgentRecord>): AgentEntry => toEntry(record(overrides));
		// The real sequence: background start, agent_stop, agent_send reopens it in the foreground, completed.
		const entries = [
			entry({ status: "queued", startedAt: undefined }),
			entry({ status: "running" }),
			entry({ status: "aborted", reason: "stopped by parent", stoppedBy: "parent", endedAt: START + 13_000 }),
			entry({ status: "queued", runs: 2, background: false, startedAt: undefined }),
			entry({ status: "running", runs: 2, background: false, startedAt: START + 60_000 }),
			entry({ status: "completed", runs: 2, background: false, startedAt: START + 60_000, endedAt: START + 68_000 }),
			// A run the old process left running: restore closes it as "session ended".
			entry({ agentId: "ag-3", status: "running" }),
		];
		const manager = new AgentManager({ factory: {} as never, maxConcurrent: () => 1, now: () => START + 99_000 });
		manager.restore(entries);
		const link = new CardLink();
		link.attach(manager);
		const strip = (line: string | undefined) => line?.replace(/<\/?[a-zA-Z]+>/g, "");

		const first = row(link, { t: colorTheme }).lines()[0];
		expect(first?.startsWith("<warning>■</warning> ")).toBe(true);
		expect(strip(first)).toBe("■ Agent explore · find auth code · stopped after 13s");
		expect(manager.runOutcome("ag-2", 2)).toMatchObject({ status: "completed", runs: 2 });
		expect(manager.runOutcome("ag-3", 1)).toMatchObject({ status: "aborted", reason: "session ended" });
	});

	it("stops listening when the manager is detached", () => {
		const source = new FakeSource();
		const link = new CardLink();
		link.attach(source);
		expect(source.listeners.size).toBe(1);
		link.detach(new FakeSource());
		expect(source.listeners.size).toBe(1);
		link.detach(source);
		expect(source.listeners.size).toBe(0);
	});
});

describe("agent_stop row", () => {
	function stop(result?: { text: string; isError?: boolean }, t: Theme = theme) {
		const context = { state: {}, expanded: false, isError: result?.isError ?? false, outputPad: 1, lastComponent: undefined } as never;
		const component = renderStopCall({ agent_id: "ag-1" } as never, t, context);
		if (result) {
			renderStopResult({ content: [{ type: "text", text: result.text }] } as never, { expanded: false, isPartial: false }, t, context);
		}
		return component.render(200);
	}

	it("draws one bash-style line with the outcome as summary", () => {
		expect(stop()).toEqual(["● Agent Stop (ag-1)"]);
		expect(stop({ text: "Stopped subagent ag-1 (find auth) after 12s.\n<subagent-result>…" })).toEqual([
			"● Agent Stop (ag-1) · Stopped subagent ag-1 (find auth) after 12s.",
		]);
		expect(stop({ text: "Unknown agent ag-1.", isError: true })).toEqual(["× Agent Stop (ag-1) · Unknown agent ag-1."]);
	});

	it("is dim as a whole after a successful stop; a failed stop keeps the error ×", () => {
		expect(stop({ text: "Stopped subagent ag-1 (find auth) after 12s." }, colorTheme)).toEqual([
			"<dim>● Agent Stop (ag-1) · Stopped subagent ag-1 (find auth) after 12s.</dim>",
		]);
		const failed = stop({ text: "Unknown agent ag-1.", isError: true }, colorTheme)[0] ?? "";
		expect(failed.startsWith("<error>×</error> ")).toBe(true);
		expect(failed).not.toContain("success");
	});
});

describe("notification message", () => {
	const agents: NotificationDetails["agents"] = [
		{ agentId: "ag-2", type: "explore", description: "查找鉴权相关代码", status: "completed", toolCalls: 11, durationMs: 48_000, resultFile: "/r/ag-2.result.md", preview: ["line 1", "line 2"] },
		{ agentId: "ag-3", type: "general", description: "检查迁移脚本", status: "failed", reason: "529 overloaded", toolCalls: 2, durationMs: 14_000, preview: [] },
	];

	it("draws one line per agent", () => {
		expect(notificationLines({ agents }, false, theme)).toEqual([
			"● ag-2 explore 查找鉴权相关代码 completed · 11 tools · 48s",
			"● ag-3 general 检查迁移脚本 failed · 529 overloaded · 14s",
		]);
	});

	it("colors a stopped agent warning, not error (design_style.md §3)", () => {
		const stopped: NotificationDetails["agents"] = [
			{ agentId: "ag-4", type: "general", description: "迁移", status: "aborted", toolCalls: 1, durationMs: 3_000, preview: [] },
		];
		const line = notificationLines({ agents: stopped }, false, colorTheme)[0]!;
		expect(line).toContain("<warning>●</warning>");
		expect(line).toContain("<warning>stopped</warning>");
		expect(line).not.toContain("<error>");
	});

	it("adds the report preview and the result file when expanded", () => {
		expect(notificationLines({ agents: agents.slice(0, 1) }, true, theme)).toEqual([
			"● ag-2 explore 查找鉴权相关代码 completed · 11 tools · 48s",
			"  │ line 1",
			"  │ line 2",
			"  └ /r/ag-2.result.md",
		]);
	});
});
