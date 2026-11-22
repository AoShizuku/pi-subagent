// Two-step stop (docs/07 §4.4): the first x arms the selected agent, a second x on it stops it. Shared by
// the /agents list, the detail overlay and HUD focus mode, each with its own instance.
//
// The arm belongs to an agent id, never to a row index: the lists re-sort every second, and a second x must
// not land on whatever agent moved into the armed row. It is dropped as soon as that agent is no longer the
// selected, stoppable one.

export const ARMED_HINT = "press x again to stop · any other key cancels";

export class StopConfirm {
	private armed: string | undefined;

	/** `enabled` is read on every press, so turning the option off applies to the next x. */
	constructor(private readonly enabled: () => boolean) {}

	get armedId(): string | undefined {
		return this.armed;
	}

	isArmed(id: string | undefined): boolean {
		return id !== undefined && this.armed === id;
	}

	/** x on a stoppable agent. True: stop it now. False: it is armed and waits for the second x. */
	press(id: string): boolean {
		if (!this.enabled() || this.armed === id) {
			this.armed = undefined;
			return true;
		}
		this.armed = id;
		return false;
	}

	/** Disarm; true when something was armed. */
	cancel(): boolean {
		if (this.armed === undefined) return false;
		this.armed = undefined;
		return true;
	}

	/** Keep the arm only while `selectedId` is the armed agent and it can still be stopped. True when it disarmed. */
	keep(selectedId: string | undefined, stoppable: boolean): boolean {
		if (this.armed === undefined || (this.armed === selectedId && stoppable)) return false;
		this.armed = undefined;
		return true;
	}
}
