/**
 * Decides when Recordly records through `recordly-wayland-capture` instead of
 * the browser path.
 *
 * The helper exists to keep the system cursor out of the frames, which the
 * portal will only do for a client that negotiates its own ScreenCast session.
 * It records video only: the bundled ffmpeg has no PulseAudio input, so audio
 * still has to come from the renderer, and until that is muxed in this path is
 * limited to recordings with no audio.
 */

export type WaylandCaptureDecision =
	| { use: true }
	| { use: false; reason: WaylandCaptureSkipReason; message: string };

export type WaylandCaptureSkipReason =
	| "not-kde-wayland"
	| "disabled"
	| "helper-missing"
	| "audio-requested"
	| "window-source";

export type WaylandCaptureDecisionInput = {
	/** Resolved cursor backend; the capture path shares the KDE Wayland gate. */
	cursorBackend: string;
	/** Whether the user opted in. Off by default: the browser path still works. */
	enabled: boolean;
	isHelperAvailable: boolean;
	capturesSystemAudio: boolean;
	capturesMicrophone: boolean;
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

	if (input.capturesSystemAudio || input.capturesMicrophone) {
		return {
			use: false,
			reason: "audio-requested",
			message:
				"Cursor-free capture records video only for now, so a recording with audio uses " +
				"the browser path instead.",
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
