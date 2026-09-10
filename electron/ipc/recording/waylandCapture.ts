import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { getWaylandCaptureHelperPath } from "../paths/binaries";
import {
	consumeWaylandCaptureChunk,
	isAcceptableCaptureStart,
	WAYLAND_CAPTURE_EXIT_CODES,
	type WaylandCaptureCursorMode,
	type WaylandCaptureEvent,
	type WaylandCaptureStarted,
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
	| { success: true; outputPath: string; nodeId: number; startedAtMs: number }
	| { success: false; message: string; cancelled?: boolean };

export type WaylandCaptureHandle = {
	process: ChildProcessWithoutNullStreams;
	outputPath: string;
	failed?: boolean;
	pendingBoundary?: { state: "paused" | "resumed"; finish: (result: { success: boolean; timestamp?: number }) => void };
};

let activeCapture: WaylandCaptureHandle | null = null;

const describeExit = (code: number) =>
	WAYLAND_CAPTURE_EXIT_CODES[code] ?? `Capture helper exited with code ${code}.`;

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
	/** PulseAudio source for system audio, normally "@DEFAULT_MONITOR@". */
	systemAudioDevice?: string;
	/** PulseAudio source for the microphone, normally "default". */
	microphoneDevice?: string;
	onCaptureStarted?: (event: WaylandCaptureStarted) => void;
	spawnHelper?: (helperPath: string, args: string[]) => ChildProcessWithoutNullStreams | null;
	log?: (message: string) => void;
	warn?: (message: string) => void;
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
			getFfmpegBinaryPath(),
		];

		if (options.systemAudioDevice) {
			args.push("--system-audio", options.systemAudioDevice);
		}
		if (options.microphoneDevice) {
			args.push("--microphone", options.microphoneDevice);
		}

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

		const capture: WaylandCaptureHandle = { process: helper, outputPath: options.outputPath };
		activeCapture = capture;
		let startedAtMs: number | null = null;
		let settled = false;
		let buffer = "";
		let lastError = "";

		const settle = (result: WaylandCaptureStartResult) => {
			if (settled) {
				return;
			}
			settled = true;
			if (!result.success) {
				if (activeCapture === capture) activeCapture = null;
				capture.pendingBoundary?.finish({ success: false });
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
				if (activeCapture?.process === helper) activeCapture.failed = true;
				warn(`[WaylandCapture] ${event.message}`);
				capture.pendingBoundary?.finish({ success: false });
				settle({ success: false, message: event.message });
				return;
			}

			switch (event.state) {
				case "negotiating":
					log("[WaylandCapture] waiting for the desktop portal…");
					return;

				case "capture-started":
					if (settled || startedAtMs !== null) return;
					if (event.output !== options.outputPath) {
						settle({ success: false, message: "Capture helper returned a different output path." });
						return;
					}
					startedAtMs = event.startedAtMs;
					try { options.onCaptureStarted?.(event); }
					catch (error) { settle({ success: false, message: String(error) }); }
					return;

				case "paused":
				case "resumed":
					if (event.output === capture.outputPath && capture.pendingBoundary?.state === event.state) {
						capture.pendingBoundary.finish({ success: true, timestamp: event.timestamp });
					}
					return;

				case "recording": {
					if (settled) return;
					if (startedAtMs === null || event.protocolVersion !== 2 || event.startedAtMs !== startedAtMs || event.output !== options.outputPath) {
						settle({ success: false, message: "The Wayland helper did not provide a valid first-sample timeline. Rebuild the helper." });
						return;
					}
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

					log(
						`[WaylandCapture] recording node ${event.nodeId} with the cursor ${event.cursorMode}`,
					);
					settle({ success: true, outputPath: event.output, nodeId: event.nodeId, startedAtMs });
					return;
				}

				case "stopped":
					if (event.exitCode !== 0 && activeCapture?.process === helper) {
						activeCapture.failed = true;
					}
					if (!settled) {
						settle({
							success: false,
							message: lastError || describeExit(event.exitCode),
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
			if (!message) return;
			warn(`[WaylandCapture] helper: ${message}`);
			// The helper links GStreamer, so a machine without those libraries
			// cannot even start it: the loader kills it before its own dependency
			// check can report anything. Name the cause instead of an exit code.
			if (message.includes("error while loading shared libraries")) {
				lastError =
					"The cursor-free capture helper could not start because GStreamer is missing " +
					"on this system (install gstreamer1 and gstreamer1-plugins-base, or the " +
					"equivalent for your distribution).";
			}
		});

		helper.stdin?.on?.("error", () => {
			capture.failed = true;
			capture.pendingBoundary?.finish({ success: false });
			settle({ success: false, message: "The Wayland helper command pipe failed." });
		});
		helper.once("error", (error) => {
			capture.failed = true;
			capture.pendingBoundary?.finish({ success: false });
			settle({ success: false, message: `Wayland capture helper error: ${String(error)}` });
		});

		helper.once("close", (code) => {
			capture.pendingBoundary?.finish({ success: false });
			const exitCode = typeof code === "number" ? code : -1;
			if (activeCapture?.process === helper) {
				activeCapture = null;
			}
			settle({
				success: false,
				message: lastError || describeExit(exitCode),
				cancelled: exitCode === 5,
			});
		});
	});
}

/**
 * Suspends or resumes the frame source.
 *
 * The paused stretch produces no frames and therefore vanishes from the
 * finished video, which matches how a paused recording is expected to behave.
 */
export function setWaylandCapturePaused(paused: boolean): Promise<{ success: boolean; timestamp?: number }> {
	const capture = activeCapture;
	if (!capture || capture.failed || capture.pendingBoundary) return Promise.resolve({ success: false });
	return new Promise((resolve) => {
		const timeout = setTimeout(() => finish({ success: false }), 3000);
		const finish = (result: { success: boolean; timestamp?: number }) => {
			clearTimeout(timeout);
			capture.pendingBoundary = undefined;
			resolve(result);
		};
		capture.pendingBoundary = { state: paused ? "paused" : "resumed", finish };
		try { capture.process.stdin.write(paused ? "pause\n" : "resume\n"); }
		catch { finish({ success: false }); }
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
			if (activeCapture === capture) activeCapture = null;
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

		capture.process.once("close", (code) => {
			clearTimeout(timeout);
			finish(code === 0 && !capture.failed);
		});

		try {
			capture.process.stdin?.write("stop\n");
			capture.process.stdin?.end();
		} catch {
			// Use the helper's signal handler only if the command pipe failed.
			try {
				capture.process.kill("SIGTERM");
			} catch {
				// already gone; close/timeout determines the result
			}
		}
	});
}
