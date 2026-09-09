/**
 * Decides when Recordly records through `recordly-wayland-capture` instead of
 * the browser path.
 *
 * The helper exists to keep the system cursor out of the frames, which the
 * portal will only do for a client that negotiates its own ScreenCast session.
 * It records the screen and its audio itself, so the only things that send a
 * recording back to the browser path are a session it does not support, a
 * source that is not a monitor, or a build without the helper.
 */

export type WaylandCaptureDecision =
	| { use: true }
	| { use: false; reason: WaylandCaptureSkipReason; message: string };

export type WaylandCaptureSkipReason =
	| "not-kde-wayland"
	| "disabled"
	| "helper-missing"
	| "specific-microphone"
	| "window-source";

export type WaylandCaptureDecisionInput = {
	/** Resolved cursor backend; the capture path shares the KDE Wayland gate. */
	cursorBackend: string;
	/** Whether the user opted in. Off by default: the browser path still works. */
	enabled: boolean;
	isHelperAvailable: boolean;
	capturesSystemAudio: boolean;
	capturesMicrophone: boolean;
	/**
	 * Whether the user picked a specific microphone rather than the system
	 * default. The helper captures through PulseAudio, whose source names do not
	 * map to the browser device ids Recordly selects with, so honouring the
	 * choice is not possible yet and recording the wrong microphone silently
	 * would be worse than using the browser path.
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
		};
	}

	if (!input.enabled) {
		return {
			use: false,
			reason: "disabled",
			message: "Cursor-free capture is turned off.",
		};
	}

	if (!input.isHelperAvailable) {
		return {
			use: false,
			reason: "helper-missing",
			message:
				"recordly-wayland-capture is not present in this build; recording through the " +
				"browser path, which includes the system cursor in the video.",
		};
	}

	if (input.capturesMicrophone && input.usesNonDefaultMicrophone) {
		return {
			use: false,
			reason: "specific-microphone",
			message:
				"Cursor-free capture can only record the system default microphone, so this " +
				"recording uses the browser path instead.",
		};
	}

	// Only whole monitors: the portal is asked for a monitor and both the helper
	// and the main process refuse anything else.
	if (input.sourceId?.startsWith("window:")) {
		return {
			use: false,
			reason: "window-source",
			message: "Cursor-free capture records a whole monitor, not a single window.",
		};
	}

	return { use: true };
}
