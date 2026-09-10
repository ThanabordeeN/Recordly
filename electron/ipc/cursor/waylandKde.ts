import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { getWaylandCursorHelperPath, getWaylandCursorKWinScriptPath } from "../paths/binaries";
import {
	cursorBackend,
	isCursorCaptureActive,
	setLatestWaylandCursorPoint,
	setWaylandButtonCapture,
	setWaylandCursorHelperBuffer,
	setWaylandCursorHelperProcess,
	setWaylandOutputs,
	waylandCursorHelperBuffer,
	waylandCursorHelperProcess,
	waylandOutputs,
} from "../state";
import { recordCursorMouseDown, recordCursorMouseUp } from "./interaction";
import { isCursorCapturePaused } from "./telemetry";
import {
	consumeWaylandHelperChunk,
	mergeWaylandOutputs,
	readButtonCaptureState,
	type WaylandHelperEvent,
} from "./waylandProtocol";

/**
 * Runtime for the `linux-kde-wayland` cursor backend.
 *
 * Owns the lifetime of the `recordly-wayland-cursor` helper. The helper can be
 * started at application startup in placement-only mode (without opening input
 * devices), then restarted with button capture when recording begins. It loads
 * and unloads the KWin bridge script itself.
 */

export const WAYLAND_HELPER_EXIT_CODES: Record<number, string> = {
	2: "The KWin bridge script was missing or unreadable.",
	3: "Could not reach the D-Bus session bus.",
	4: "KWin refused to load the Recordly cursor bridge script.",
};

let hasLoggedButtonCaptureWarning = false;

export function isWaylandCursorBackendActive() {
	return cursorBackend === "linux-kde-wayland";
}

/**
 * Apply one helper event to cursor state.  Exported separately from the process
 * plumbing so the whole event path is unit-testable without spawning anything.
 */
export function applyWaylandHelperEvent(
	event: WaylandHelperEvent,
	options?: {
		onMouseDown?: (button: 1 | 2 | 3, point: { x: number; y: number }) => void;
		onMouseUp?: (point: { x: number; y: number }) => void;
		log?: (message: string) => void;
		warn?: (message: string) => void;
	},
) {
	const log = options?.log ?? console.log;
	const warn = options?.warn ?? console.warn;

	switch (event.type) {
		case "move":
			setLatestWaylandCursorPoint({ x: event.x, y: event.y, updatedAt: event.timestamp });
			return;

		case "output": {
			const merged = mergeWaylandOutputs(waylandOutputs, event);
			setWaylandOutputs(merged);
			log(
				`[Wayland] output ${event.output.index + 1}/${event.count}: ${event.output.name || "unnamed"} ` +
					`${event.output.width}x${event.output.height} @ ${event.output.x},${event.output.y} scale ${event.output.scale}`,
			);
			return;
		}

		case "button": {
			// The cursor position that came with the button event is the one
			// KWin last reported *before* the press, which is exactly what the
			// click happened at.  Using it avoids any ordering race with the
			// move stream.
			setLatestWaylandCursorPoint({ x: event.x, y: event.y, updatedAt: event.timestamp });

			if (!isCursorCaptureActive || isCursorCapturePaused()) {
				return;
			}

			const point = { x: event.x, y: event.y };
			if (event.pressed) {
				(options?.onMouseDown ?? recordCursorMouseDown)(event.button, point);
			} else {
				(options?.onMouseUp ?? recordCursorMouseUp)(point);
			}
			return;
		}

		case "status": {
			const buttonCapture = readButtonCaptureState(event);
			if (buttonCapture) {
				setWaylandButtonCapture(buttonCapture);
			}

			if (event.state === "ready") {
				log(
					`[CursorTelemetry] Wayland helper ready (pointer devices: ${
						event.detail.pointerDevices ?? 0
					}).`,
				);
			}

			if (buttonCapture === "unavailable" && !hasLoggedButtonCaptureWarning) {
				hasLoggedButtonCaptureWarning = true;
				const reason = String(event.detail.reason ?? "no-pointer-device");
				const path = String(event.detail.path ?? "/dev/input/event*");
				const suffix =
					"Auto Zoom click detection will be unavailable; cursor movement telemetry still works.";
				warn(
					reason === "permission-denied"
						? `[CursorTelemetry] Mouse button capture unavailable: permission denied for ${path}\n` +
								"Auto Zoom click detection will be unavailable. Add your user to the 'input' group " +
								"(see docs/linux-kde-wayland.md) and log back in."
						: reason === "libinput-unavailable"
							? `[CursorTelemetry] Mouse button capture unavailable: libinput.so.10 could not be loaded.\n${suffix}`
							: `[CursorTelemetry] Mouse button capture unavailable: no pointer device found under ${path}\n${suffix}`,
				);
			}
			return;
		}

		case "error":
			warn(`[CursorTelemetry] Wayland helper error: ${event.message}`);
			return;
	}
}

function handleHelperStdout(chunk: Buffer) {
	const { events, buffer } = consumeWaylandHelperChunk(
		waylandCursorHelperBuffer,
		chunk.toString(),
	);
	setWaylandCursorHelperBuffer(buffer);

	for (const event of events) {
		applyWaylandHelperEvent(event);
	}
}

export function stopWaylandCursorBackend() {
	const process_ = waylandCursorHelperProcess;
	setWaylandCursorHelperProcess(null);
	setWaylandCursorHelperBuffer("");
	setWaylandOutputs([]);
	setLatestWaylandCursorPoint(null);
	setWaylandButtonCapture("unknown");
	hasLoggedButtonCaptureWarning = false;

	if (!process_) {
		return;
	}

	// The helper unloads its KWin script on a clean shutdown, so ask nicely
	// first; SIGTERM is the backstop if it is already wedged.
	try {
		process_.stdin?.write("stop\n");
		process_.stdin?.end();
	} catch {
		// ignore: the pipe may already be closed
	}

	try {
		process_.kill("SIGTERM");
	} catch {
		// ignore: the process may already be gone
	}
}

export function startWaylandCursorBackend(options?: {
	spawnHelper?: (helperPath: string, args: string[]) => ChildProcessWithoutNullStreams | null;
	enableButtons?: boolean;
	log?: (message: string) => void;
	warn?: (message: string) => void;
}): boolean {
	stopWaylandCursorBackend();

	const log = options?.log ?? console.log;
	const warn = options?.warn ?? console.warn;

	const helperPath = getWaylandCursorHelperPath();
	if (!helperPath) {
		warn(
			"[CursorTelemetry] recordly-wayland-cursor helper is missing from this build. " +
				"Cursor telemetry and Auto Zoom click detection are unavailable on KDE Wayland.",
		);
		return false;
	}

	const args = ["--kwin-script", getWaylandCursorKWinScriptPath()];
	if (options?.enableButtons === false) {
		args.push("--no-buttons");
	}

	let helper: ChildProcessWithoutNullStreams | null = null;
	try {
		helper = options?.spawnHelper
			? options.spawnHelper(helperPath, args)
			: (spawn(helperPath, args, {
					stdio: ["pipe", "pipe", "pipe"],
				}) as ChildProcessWithoutNullStreams);
	} catch (error) {
		warn(`[CursorTelemetry] Failed to spawn the Wayland cursor helper: ${String(error)}`);
		return false;
	}

	if (!helper) {
		return false;
	}

	setWaylandCursorHelperProcess(helper);
	setWaylandCursorHelperBuffer("");

	helper.stdout?.on("data", handleHelperStdout);
	helper.stderr?.on("data", (chunk: Buffer) => {
		const message = chunk.toString().trim();
		if (message) {
			warn(`[CursorTelemetry] wayland helper: ${message}`);
		}
	});

	helper.once("error", (error) => {
		warn(`[CursorTelemetry] Wayland cursor helper process error: ${String(error)}`);
		if (waylandCursorHelperProcess === helper) {
			stopWaylandCursorBackend();
		}
	});

	helper.once("close", (code) => {
		if (typeof code === "number" && code !== 0) {
			warn(
				`[CursorTelemetry] Wayland cursor helper exited with code ${code}. ` +
					(WAYLAND_HELPER_EXIT_CODES[code] ?? "Cursor telemetry is unavailable."),
			);
		}
		if (waylandCursorHelperProcess === helper) {
			stopWaylandCursorBackend();
		}
	});

	log(`[CursorTelemetry] backend: linux-kde-wayland (helper: ${helperPath})`);
	return true;
}
