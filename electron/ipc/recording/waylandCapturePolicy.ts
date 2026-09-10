/**
 * Decides when Recordly records through `recordly-wayland-capture` instead of
 * the browser path.
 *
 * The helper exists to keep the system cursor out of the frames, which the
 * portal will only do for a client that negotiates its own ScreenCast session.
 * It records the screen and its audio itself. The browser path remains only
 * for sessions where this backend is not applicable or when the user disables
 * cursor-free capture; an applicable cursor-free failure is fatal so a visible
 * system cursor is never recorded silently.
 */

export type WaylandCaptureDecision =
	| { use: true }
	| {
			use: false;
			reason: WaylandCaptureSkipReason;
			message: string;
			/** Whether falling back would violate the requested cursor-free recording. */
			fatal: boolean;
	  };

export type WaylandCaptureSkipReason =
	| "not-kde-wayland"
	| "disabled"
	| "helper-missing"
	| "specific-microphone"
	| "window-source";

export type WaylandCaptureDecisionInput = {
	/** Resolved cursor backend; the capture path shares the KDE Wayland gate. */
	cursorBackend: string;
	/** Whether the user enabled cursor-free capture for this recording. */
	enabled: boolean;
	isHelperAvailable: boolean;
	capturesSystemAudio: boolean;
	capturesMicrophone: boolean;
	/**
	 * Whether the user picked a specific microphone rather than the system
	 * default. The helper captures through PulseAudio, whose source names do not
	 * map to the browser device ids Recordly selects with. If the source cannot
	 * be resolved, fail instead of recording the wrong microphone silently.
	 */
	usesNonDefaultMicrophone?: boolean;
	/** Source id, e.g. "screen:linux-portal" or "window:123". */
	sourceId?: string | null;
};

export function decideWaylandCapture(input: WaylandCaptureDecisionInput): WaylandCaptureDecision {
	if (input.cursorBackend !== "linux-kde-wayland") {
		return {
			use: false,
			reason: "not-kde-wayland",
			message: "Cursor-free capture is only available on a KDE Wayland session.",
			fatal: false,
		};
	}

	if (!input.enabled) {
		return {
			use: false,
			reason: "disabled",
			message: "Cursor-free capture is turned off.",
			fatal: false,
		};
	}

	if (!input.isHelperAvailable) {
		return {
			use: false,
			reason: "helper-missing",
			message:
				"recordly-wayland-capture is not present in this build, so the system cursor cannot " +
				"be excluded from this recording.",
			fatal: true,
		};
	}

	if (input.capturesMicrophone && input.usesNonDefaultMicrophone) {
		return {
			use: false,
			reason: "specific-microphone",
			message:
				"The selected microphone could not be mapped to a PulseAudio source, so the " +
				"cursor-free recording cannot start without risking the wrong microphone.",
			fatal: true,
		};
	}

	// Only whole monitors: the portal is asked for a monitor and both the helper
	// and the main process refuse anything else.
	if (input.sourceId?.startsWith("window:")) {
		return {
			use: false,
			reason: "window-source",
			message: "Cursor-free capture records a whole monitor, not a single window.",
			fatal: true,
		};
	}

	return { use: true };
}
