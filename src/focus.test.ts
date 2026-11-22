// Focus mode swallows Esc so it cannot interrupt the main agent; every exit condition of docs/07 §4.3 is
// tested here, because a stuck focus mode would make Esc useless.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOCUS_IDLE_MS, FocusController } from "./focus.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";
const DOWN_RELEASE = "\x1b[1;1:3B";

function setup() {
	const env = {
		hud: true,
		editorEmpty: true,
		editorFocused: true,
		ids: ["ag-1", "ag-2", "ag-3"],
		active: new Set(["ag-1", "ag-2"]),
		opened: [] as string[],
		stopped: [] as string[],
		changes: 0,
		confirm: true,
	};
	const focus = new FocusController({
		hudRendering: () => env.hud,
		editorEmpty: () => env.editorEmpty,
		editorFocused: () => env.editorFocused,
		agentIds: () => env.ids,
		open: (id) => env.opened.push(id),
		stop: (id) => env.stopped.push(id),
		canStop: (id) => env.active.has(id),
		confirmStop: () => env.confirm,
		onChange: () => env.changes++,
	});
	const enter = () => {
		expect(focus.handleInput(DOWN)).toEqual({ consume: true });
		expect(focus.selectedId).toBe("ag-1");
	};
	return { env, focus, enter };
}

describe("FocusController: entering", () => {
	it("enters on ↓ and selects the first row", () => {
		const { focus, env, enter } = setup();
		enter();
		expect(focus.active).toBe(true);
		expect(env.changes).toBe(1);
	});

	it("does not enter when the editor has text, the HUD is not rendering, there are no rows, or a dialog has focus", () => {
		const { focus, env } = setup();
		env.editorEmpty = false;
		expect(focus.handleInput(DOWN)).toBeUndefined();
		env.editorEmpty = true;
		env.hud = false;
		expect(focus.handleInput(DOWN)).toBeUndefined();
		env.hud = true;
		env.ids = [];
		expect(focus.handleInput(DOWN)).toBeUndefined();
		env.ids = ["ag-1"];
		env.editorFocused = false;
		expect(focus.handleInput(DOWN)).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("ignores other keys and release events while unfocused", () => {
		const { focus } = setup();
		expect(focus.handleInput(UP)).toBeUndefined();
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.handleInput("a")).toBeUndefined();
		expect(focus.handleInput(DOWN_RELEASE)).toBeUndefined();
		expect(focus.active).toBe(false);
	});
});

describe("FocusController: keys in focus mode", () => {
	it("↓ moves down and stops at the last row; ↑ moves up and leaves from the first row", () => {
		const { focus, enter } = setup();
		enter();
		expect(focus.handleInput(DOWN)).toEqual({ consume: true });
		expect(focus.handleInput(DOWN)).toEqual({ consume: true });
		expect(focus.selectedId).toBe("ag-3");
		expect(focus.handleInput(DOWN)).toEqual({ consume: true });
		expect(focus.selectedId).toBe("ag-3");
		focus.handleInput(UP);
		focus.handleInput(UP);
		expect(focus.selectedId).toBe("ag-1");
		expect(focus.handleInput(UP)).toEqual({ consume: true });
		expect(focus.active).toBe(false);
	});

	it("Esc leaves focus mode and is swallowed", () => {
		const { focus, enter } = setup();
		enter();
		expect(focus.handleInput(ESC)).toEqual({ consume: true });
		expect(focus.active).toBe(false);
		// The next Esc is pi's again (it interrupts the agent).
		expect(focus.handleInput(ESC)).toBeUndefined();
	});

	it("swallows key release events without moving (kitty protocol)", () => {
		const { focus, enter } = setup();
		enter();
		expect(focus.handleInput(DOWN_RELEASE)).toEqual({ consume: true });
		expect(focus.selectedId).toBe("ag-1");
	});

	it("Enter opens the selected agent and suspends until resume()", () => {
		const { focus, env, enter } = setup();
		enter();
		focus.handleInput(DOWN);
		expect(focus.handleInput(ENTER)).toEqual({ consume: true });
		expect(env.opened).toEqual(["ag-2"]);
		expect(focus.isSuspended).toBe(true);
		// While the overlay is open every key belongs to it, Esc included.
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.handleInput(DOWN)).toBeUndefined();
		focus.resume();
		expect(focus.isSuspended).toBe(false);
		expect(focus.selectedId).toBe("ag-2");
		expect(focus.handleInput(ESC)).toEqual({ consume: true });
	});

	it("x x stops a running or queued agent; x is swallowed either way", () => {
		const { focus, env, enter } = setup();
		enter();
		expect(focus.handleInput("x")).toEqual({ consume: true });
		expect(focus.armed).toBe(true);
		expect(env.stopped).toEqual([]);
		expect(focus.handleInput("x")).toEqual({ consume: true });
		expect(env.stopped).toEqual(["ag-1"]);
		expect(focus.armed).toBe(false);
		focus.handleInput(DOWN);
		focus.handleInput(DOWN);
		// ag-3 has ended: x does not arm it.
		expect(focus.handleInput("x")).toEqual({ consume: true });
		expect(focus.armed).toBe(false);
		expect(focus.active).toBe(true);
	});

	it("with confirmStop off, one x stops", () => {
		const { focus, env, enter } = setup();
		env.confirm = false;
		enter();
		focus.handleInput("x");
		expect(env.stopped).toEqual(["ag-1"]);
		expect(focus.armed).toBe(false);
	});

	it("armed: Esc, Enter and typed keys only cancel, are swallowed and keep focus mode", () => {
		const { focus, env, enter } = setup();
		enter();
		const changes = env.changes;
		focus.handleInput("x");
		expect(env.changes).toBe(changes + 1);
		expect(focus.handleInput(ESC)).toEqual({ consume: true });
		expect(focus.armed).toBe(false);
		expect(focus.active).toBe(true);
		expect(env.changes).toBe(changes + 2);
		focus.handleInput("x");
		expect(focus.handleInput(ENTER)).toEqual({ consume: true });
		expect(env.opened).toEqual([]);
		expect(focus.isSuspended).toBe(false);
		focus.handleInput("x");
		expect(focus.handleInput("h")).toEqual({ consume: true });
		expect(focus.active).toBe(true);
		expect(env.stopped).toEqual([]);
		// Not armed any more: the next x arms again rather than stopping.
		focus.handleInput("x");
		expect(env.stopped).toEqual([]);
	});

	it("armed: ↓ cancels and moves, ↑ on the first row cancels and leaves", () => {
		const { focus, env, enter } = setup();
		enter();
		focus.handleInput("x");
		focus.handleInput(DOWN);
		expect(focus.selectedId).toBe("ag-2");
		expect(focus.armed).toBe(false);
		focus.handleInput("x");
		expect(focus.armed).toBe(true);
		focus.handleInput(UP);
		focus.handleInput("x");
		expect(focus.handleInput(UP)).toEqual({ consume: true });
		expect(focus.active).toBe(false);
		expect(env.stopped).toEqual([]);
	});

	it("the arm is dropped when the agent ends on its own or focus mode exits", () => {
		vi.useFakeTimers();
		try {
			const { focus, env, enter } = setup();
			enter();
			focus.handleInput("x");
			env.active.delete("ag-1");
			focus.sync();
			expect(focus.armed).toBe(false);
			// A second x on the ended agent does nothing.
			focus.handleInput("x");
			expect(env.stopped).toEqual([]);
			focus.handleInput(DOWN);
			focus.handleInput("x");
			vi.advanceTimersByTime(FOCUS_IDLE_MS);
			expect(focus.active).toBe(false);
			enter();
			focus.handleInput(DOWN);
			expect(focus.armed).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("any other key leaves focus mode and is not swallowed, so typing starts at once", () => {
		const { focus, enter } = setup();
		enter();
		expect(focus.handleInput("h")).toBeUndefined();
		expect(focus.active).toBe(false);
		enter();
		expect(focus.handleInput("\x1b[200~pasted\x1b[201~")).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("ignores mouse reports", () => {
		const { focus, enter } = setup();
		enter();
		expect(focus.handleInput("\x1b[<0;10;5M")).toBeUndefined();
		expect(focus.active).toBe(true);
	});
});

describe("FocusController: exit conditions (docs/07 §4.3)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("exits when the rows drop to zero", () => {
		const { focus, env, enter } = setup();
		enter();
		env.ids = [];
		focus.sync();
		expect(focus.active).toBe(false);
	});

	it("exits on the next key when the rows are gone, without swallowing it", () => {
		const { focus, env, enter } = setup();
		enter();
		env.ids = [];
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("exits when pi-hud stops rendering", () => {
		const { focus, env, enter } = setup();
		enter();
		focus.setHudRendering(false);
		expect(focus.active).toBe(false);
		// Also caught on the next key if the announcement was missed.
		enter();
		env.hud = false;
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("exits on session_shutdown and stays inert afterwards", () => {
		const { focus, enter } = setup();
		enter();
		focus.dispose();
		expect(focus.active).toBe(false);
		expect(focus.handleInput(DOWN)).toBeUndefined();
		expect(focus.handleInput(ESC)).toBeUndefined();
	});

	it("exits without swallowing when the editor has text", () => {
		const { focus, env, enter } = setup();
		enter();
		env.editorEmpty = false;
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("exits without swallowing when a dialog or selector took the keyboard", () => {
		const { focus, env, enter } = setup();
		enter();
		env.editorFocused = false;
		expect(focus.handleInput(ESC)).toBeUndefined();
		expect(focus.active).toBe(false);
	});

	it("exits after 30 s without a key; every key restarts the timer", () => {
		const { focus, enter } = setup();
		enter();
		vi.advanceTimersByTime(FOCUS_IDLE_MS - 1000);
		focus.handleInput(DOWN);
		vi.advanceTimersByTime(FOCUS_IDLE_MS - 1000);
		expect(focus.active).toBe(true);
		vi.advanceTimersByTime(1000);
		expect(focus.active).toBe(false);
	});

	it("does not time out behind the detail overlay, and re-arms on resume", () => {
		const { focus, enter } = setup();
		enter();
		focus.handleInput(ENTER);
		vi.advanceTimersByTime(FOCUS_IDLE_MS * 3);
		expect(focus.active).toBe(true);
		focus.resume();
		vi.advanceTimersByTime(FOCUS_IDLE_MS);
		expect(focus.active).toBe(false);
	});

	it("resume() leaves focus mode when the rows or the HUD went away meanwhile", () => {
		const { focus, env, enter } = setup();
		enter();
		focus.handleInput(ENTER);
		env.ids = [];
		focus.resume();
		expect(focus.active).toBe(false);
	});

	it("selects the neighbour when the selected agent disappears", () => {
		const { focus, env, enter } = setup();
		enter();
		focus.handleInput(DOWN);
		focus.handleInput(DOWN);
		expect(focus.selectedId).toBe("ag-3");
		env.ids = ["ag-1", "ag-2"];
		focus.sync();
		expect(focus.selectedId).toBe("ag-2");
		env.ids = ["ag-2", "ag-1"];
		focus.sync();
		expect(focus.selectedId).toBe("ag-2");
	});
});
