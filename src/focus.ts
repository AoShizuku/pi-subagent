// Keyboard focus on the HUD's agent rows, driven by ctx.ui.onTerminalInput (docs/07 §4).
//
// Listeners registered with onTerminalInput see every key before the editor (pi-tui tui.ts:1095-1110) and
// keep seeing keys while an overlay or dialog has focus. Esc is the dangerous key: in focus mode it is
// swallowed so it cannot interrupt the main agent, so focus mode must never get stuck. Every exit
// condition in docs/07 §4.3 is implemented here and covered by focus.test.ts.

import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import { StopConfirm } from "./stop-confirm.js";

export const FOCUS_IDLE_MS = 30_000;

export interface FocusDeps {
	/** pi-hud announced that it renders the agent rows (subagent:hud). */
	hudRendering(): boolean;
	/** The main editor holds no text. */
	editorEmpty(): boolean;
	/** The main editor has keyboard focus (no dialog, selector or overlay took it). */
	editorFocused(): boolean;
	/** Agent ids in focus-mode order (hud-state focusOrder). */
	agentIds(): string[];
	/** Enter: open the detail overlay. The controller is suspended until resume(). */
	open(agentId: string): void;
	/** x: stop the agent (only called when canStop; with confirmStop, on the second x). */
	stop(agentId: string): void;
	canStop(agentId: string): boolean;
	/** x must be pressed twice (docs/07 §4.4); default true. */
	confirmStop?(): boolean;
	/** Focus state or selection changed: re-publish the HUD state. */
	onChange(): void;
	idleMs?: number;
}

export type InputResult = { consume: true } | undefined;

const CONSUME: InputResult = { consume: true };

/** Mouse reports never reach extensions in fullscreen (the alt-screen listener runs first), but be safe. */
function isMouseSequence(data: string): boolean {
	return data.startsWith("\x1b[<") || (data.startsWith("\x1b[M") && data.length >= 6);
}

export class FocusController {
	private selected: string | undefined;
	private lastIndex = 0;
	private suspended = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly confirm: StopConfirm;

	constructor(private readonly deps: FocusDeps) {
		this.confirm = new StopConfirm(() => deps.confirmStop?.() ?? true);
	}

	/** Selected agent id while in focus mode (also while suspended behind the detail overlay). */
	get selectedId(): string | undefined {
		return this.selected;
	}

	/** The selected agent got the first x and waits for the second (docs/07 §4.4). */
	get armed(): boolean {
		return this.confirm.isArmed(this.selected);
	}

	get active(): boolean {
		return this.selected !== undefined;
	}

	/** True while the detail overlay opened from focus mode is showing. */
	get isSuspended(): boolean {
		return this.suspended;
	}

	readonly handleInput = (data: string): InputResult => {
		if (this.disposed || this.suspended || isMouseSequence(data)) return undefined;
		if (!this.active) return this.handleUnfocused(data);

		// Exit conditions checked on every key (docs/07 §4.3): the key then goes to pi untouched.
		if (!this.deps.hudRendering() || !this.deps.editorFocused() || !this.deps.editorEmpty()) {
			this.exit();
			return undefined;
		}
		if (isKeyRelease(data)) return CONSUME;
		const ids = this.deps.agentIds();
		if (ids.length === 0) {
			this.exit();
			return undefined;
		}
		this.armTimer();
		const index = this.indexIn(ids);
		const isX = data === "x" || matchesKey(data, "x");

		// Armed: only x goes on to stop. ↑↓ cancel and still move (↑ on the first row still leaves); every other
		// key only cancels and is swallowed. Esc does not leave focus mode, Enter does not open the detail, and
		// typed text does not land in the editor: a key pressed to back out of the stop does only that.
		this.keepArm();
		if (this.armed && !isX) {
			this.disarm();
			if (!matchesKey(data, "up") && !matchesKey(data, "down")) return CONSUME;
		}

		if (matchesKey(data, "escape")) {
			this.exit();
			return CONSUME;
		}
		if (matchesKey(data, "up")) {
			if (index <= 0) this.exit();
			else this.select(ids, index - 1);
			return CONSUME;
		}
		if (matchesKey(data, "down")) {
			if (index < ids.length - 1) this.select(ids, index + 1);
			return CONSUME;
		}
		if (matchesKey(data, "enter")) {
			const id = ids[index];
			if (id) {
				this.suspended = true;
				this.clearTimer();
				this.deps.open(id);
			}
			return CONSUME;
		}
		if (isX) {
			const id = ids[index];
			if (id && this.deps.canStop(id)) {
				if (this.confirm.press(id)) this.deps.stop(id);
				this.deps.onChange();
			}
			return CONSUME;
		}
		// Anything else, typing included: leave focus mode and let the editor have the key.
		this.exit();
		return undefined;
	};

	/** The detail overlay opened from focus mode closed: back to focus mode with the same selection. */
	resume(): void {
		if (!this.suspended) return;
		this.suspended = false;
		if (this.disposed || !this.active) return;
		const ids = this.deps.agentIds();
		if (ids.length === 0 || !this.deps.hudRendering()) {
			this.exit();
			return;
		}
		this.select(ids, this.indexIn(ids));
		this.armTimer();
	}

	/**
	 * The set of agents changed. Exits when nothing is left; keeps the selected agent by id, or selects
	 * its neighbour when it disappeared.
	 */
	sync(): void {
		if (!this.active) return;
		const ids = this.deps.agentIds();
		if (ids.length === 0) {
			this.exit();
			return;
		}
		const index = ids.indexOf(this.selected ?? "");
		if (index !== -1) {
			this.lastIndex = index;
			// The armed agent may have ended on its own, or a stop may have been requested elsewhere.
			this.keepArm();
			return;
		}
		this.select(ids, Math.min(this.lastIndex, ids.length - 1));
	}

	/** pi-hud stopped (or started) rendering the rows. */
	setHudRendering(rendering: boolean): void {
		if (!rendering) this.exit();
	}

	exit(): void {
		this.clearTimer();
		this.suspended = false;
		this.confirm.cancel();
		if (this.selected === undefined) return;
		this.selected = undefined;
		this.deps.onChange();
	}

	/** session_shutdown. */
	dispose(): void {
		this.exit();
		this.disposed = true;
	}

	private handleUnfocused(data: string): InputResult {
		if (!matchesKey(data, "down") || isKeyRelease(data)) return undefined;
		if (!this.deps.hudRendering() || !this.deps.editorFocused() || !this.deps.editorEmpty()) return undefined;
		const ids = this.deps.agentIds();
		if (ids.length === 0) return undefined;
		this.select(ids, 0);
		this.armTimer();
		return CONSUME;
	}

	private indexIn(ids: readonly string[]): number {
		const index = ids.indexOf(this.selected ?? "");
		return index === -1 ? Math.min(this.lastIndex, ids.length - 1) : index;
	}

	private select(ids: readonly string[], index: number): void {
		const id = ids[index];
		if (id === undefined) return;
		this.lastIndex = index;
		if (this.selected === id) return;
		this.selected = id;
		this.confirm.cancel();
		this.deps.onChange();
	}

	/** Drop the arm unless the selected agent can still be stopped; re-publishes when it dropped. */
	private keepArm(): void {
		const id = this.selected;
		if (this.confirm.keep(id, id !== undefined && this.deps.canStop(id))) this.deps.onChange();
	}

	private disarm(): void {
		if (this.confirm.cancel()) this.deps.onChange();
	}

	private armTimer(): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.suspended) this.exit();
		}, this.deps.idleMs ?? FOCUS_IDLE_MS);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
