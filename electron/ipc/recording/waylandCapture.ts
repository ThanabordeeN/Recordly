import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getWaylandCaptureHelperPath } from "../paths/binaries";
import {
	consumeWaylandCaptureChunk,
	describeWaylandCaptureExit,
	isAcceptableCaptureStart,
	type WaylandCaptureCursorMode,
	type WaylandCaptureEvent,
} from "./waylandCaptureProtocol";

/**
 * Lifetime of the `recordly-wayland-capture` helper.
 *
 * The helper records the screen through its own xdg-desktop-portal session so
 * it can ask for `cursor_mode=hidden`. Chromium's getDisplayMedia always asks
 * for an embedded cursor and offers no way to change it, which is why a
 * recording made through the browser path has the system cursor burned into
 * every frame on top of the cursor Recordly draws from telemetry.
 */

export type WaylandCaptureStartResult =
	| { success: true; outputPath: string; nodeId: number }
	| { success: false; message: string; cancelled?: boolean };

export type WaylandCaptureHandle = {
	process: ChildProcessWithoutNullStreams;
	outputPath: string;
};

let activeCapture: WaylandCaptureHandle | null = null;

export function getActiveWaylandCapture() {
	return activeCapture;
}

export function isWaylandCaptureActive() {
	return activeCapture !== null;
}

/**
 * Starts the helper and resolves once it reports that it is recording.
 *
 * Resolving early would race the portal picker: the helper only knows what it
 * is capturing after the user has chosen a screen.
 */
export function startWaylandCapture(options: {
	outputPath: string;
	cursorMode?: WaylandCaptureCursorMode;
	frameRate?: number;
	spawnHelper?: (helperPath: string, args: string[]) => ChildProcessWithoutNullStreams | null;
	log?: (message: string) => void;
	warn?: (message: string) => void;
	ffmpegPath?: string;
	helperPath?: string | null;
}): Promise<WaylandCaptureStartResult> {
	const log = options.log ?? console.log;
	const warn = options.warn ?? console.warn;

	return new Promise<WaylandCaptureStartResult>((resolve) => {
		if (activeCapture) {
			resolve({ success: false, message: "A Wayland capture is already running." });
			return;
		}

		const helperPath =
			options.helperPath === undefined ? getWaylandCaptureHelperPath() : options.helperPath;
		if (!helperPath) {
			resolve({
				success: false,
				message:
					"recordly-wayland-capture is missing from this build, so the system cursor " +
					"cannot be excluded from the recording.",
			});
			return;
		}

		const args = [
			"--output",
			options.outputPath,
			"--cursor-mode",
			options.cursorMode ?? "hidden",
			"--fps",
			String(options.frameRate ?? 60),
			"--ffmpeg",
			options.ffmpegPath ?? getFfmpegBinaryPath(),
		];

		let helper: ChildProcessWithoutNullStreams | null = null;
		try {
			helper = options.spawnHelper
				? options.spawnHelper(helperPath, args)
				: (spawn(helperPath, args, {
						stdio: ["pipe", "pipe", "pipe"],
					}) as ChildProcessWithoutNullStreams);
		} catch (error) {
			resolve({
				success: false,
				message: `Failed to start the Wayland capture helper: ${String(error)}`,
			});
			return;
		}

		if (!helper) {
			resolve({ success: false, message: "Failed to start the Wayland capture helper." });
			return;
		}

		let settled = false;
		let buffer = "";
		let lastError = "";

		const settle = (result: WaylandCaptureStartResult) => {
			if (settled) {
				return;
			}
			settled = true;
			if (!result.success) {
				activeCapture = null;
				try {
					helper?.kill("SIGTERM");
				} catch {
					// already gone
				}
			}
			resolve(result);
		};

		const applyEvent = (event: WaylandCaptureEvent) => {
			if (event.type === "error") {
				lastError = event.message;
				warn(`[WaylandCapture] ${event.message}`);
				return;
			}

			switch (event.state) {
				case "negotiating":
					log("[WaylandCapture] waiting for the desktop portal…");
					return;

				case "restore-token-rejected":
					warn(
						`[WaylandCapture] Ignoring a saved screen selection: ${event.reason}. ` +
							"Asking again so the recording captures what you pick now.",
					);
					return;

				case "recording": {
					if (!isAcceptableCaptureStart(event)) {
						// Belt and braces: the helper refuses this too, but an
						// older helper must never be allowed to record a window
						// when a monitor was requested.
						settle({
							success: false,
							message:
								"The desktop portal returned a source that is not a monitor; " +
								"the recording was stopped before it began.",
						});
						return;
					}

					activeCapture = {
						process: helper as ChildProcessWithoutNullStreams,
						outputPath: event.output,
					};
					log(
						`[WaylandCapture] recording node ${event.nodeId} with the cursor ${event.cursorMode}`,
					);
					settle({ success: true, outputPath: event.output, nodeId: event.nodeId });
					return;
				}

				case "stopped":
					if (!settled) {
						settle({
							success: false,
							message: lastError || describeWaylandCaptureExit(event.exitCode),
						});
					}
					return;
			}
		};

		helper.stdout?.on("data", (chunk: Buffer) => {
			const parsed = consumeWaylandCaptureChunk(buffer, chunk.toString());
			buffer = parsed.buffer;
			for (const event of parsed.events) {
				applyEvent(event);
			}
		});

		helper.stderr?.on("data", (chunk: Buffer) => {
			const message = chunk.toString().trim();
			if (message) {
				warn(`[WaylandCapture] helper: ${message}`);
			}
		});

		helper.once("error", (error) => {
			settle({ success: false, message: `Wayland capture helper error: ${String(error)}` });
		});

		helper.once("close", (code) => {
			const exitCode = typeof code === "number" ? code : -1;
			if (activeCapture?.process === helper) {
				activeCapture = null;
			}
			settle({
				success: false,
				message: lastError || describeWaylandCaptureExit(exitCode),
				cancelled: exitCode === 5,
			});
		});
	});
}

/**
 * Asks the helper to finish and waits for the encoder to close the file.
 *
 * Killing it outright would leave an mp4 without its moov atom, so the helper is
 * given a chance to shut the pipeline down in order.
 */
export function stopWaylandCapture(options?: {
	timeoutMs?: number;
	warn?: (message: string) => void;
}): Promise<{ success: boolean; outputPath: string | null }> {
	const warn = options?.warn ?? console.warn;
	const capture = activeCapture;
	activeCapture = null;

	if (!capture) {
		return Promise.resolve({ success: false, outputPath: null });
	}

	return new Promise((resolve) => {
		let done = false;
		const finish = (success: boolean) => {
			if (done) {
				return;
			}
			done = true;
			resolve({ success, outputPath: capture.outputPath });
		};

		const timeout = setTimeout(() => {
			warn("[WaylandCapture] helper did not exit in time; terminating it.");
			try {
				capture.process.kill("SIGKILL");
			} catch {
				// already gone
			}
			finish(false);
		}, options?.timeoutMs ?? 20000);

		capture.process.once("close", () => {
			clearTimeout(timeout);
			finish(true);
		});

		try {
			capture.process.stdin?.write("stop\n");
			capture.process.stdin?.end();
		} catch {
			// pipe already closed
		}
		try {
			capture.process.kill("SIGTERM");
		} catch {
			// already gone
		}
	});
}
