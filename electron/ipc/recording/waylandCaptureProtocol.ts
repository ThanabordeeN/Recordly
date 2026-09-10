/**
 * JSON-lines protocol spoken by `recordly-wayland-capture` on stdout.
 *
 * The helper negotiates its own xdg-desktop-portal ScreenCast session so it can
 * ask for `cursor_mode=hidden`, which Chromium's getDisplayMedia cannot express
 * (see electron/native/wayland-capture/src/main.cpp for the evidence).
 */
export type WaylandCaptureStarted = {
	type: "status";
	state: "capture-started";
	protocolVersion: 2;
	startedAtMs: number;
	timestamp: number;
	output: string;
};

export type WaylandCaptureBoundary = {
	type: "status";
	state: "paused" | "resumed";
	timestamp: number;
	mediaTimeUs: number;
	output: string;
};

export type WaylandCaptureEvent =
	| WaylandCaptureStarted
	| WaylandCaptureBoundary
	| { type: "status"; state: "negotiating" }
	| {
			type: "status";
			state: "recording";
			protocolVersion?: 2;
			startedAtMs?: number;
			timestamp?: number;
			nodeId: number;
			sourceType: number;
			cursorMode: WaylandCaptureCursorMode;
			output: string;
	  }
	| { type: "status"; state: "stopped"; exitCode: number; output: string; stoppedAtMs?: number; durationMs?: number }
	| { type: "error"; message: string };

export type WaylandCaptureCursorMode = "hidden" | "embedded" | "metadata";

/** Portal source types; only a monitor is ever requested. */
export const PORTAL_SOURCE_TYPE_MONITOR = 1;

export const WAYLAND_CAPTURE_EXIT_CODES: Record<number, string> = {
	2: "The helper was started without an output path.",
	3: "The capture pipeline could not be started.",
	4: "The desktop portal refused to start a screen capture session.",
	5: "Screen sharing was cancelled.",
	6: "The encoder exited with an error.",
	7: "GStreamer with the pipewiresrc element is required for cursor-free capture.",
};

function toFiniteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function validTime(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeCursorMode(value: unknown): WaylandCaptureCursorMode {
	return value === "embedded" || value === "metadata" ? value : "hidden";
}

export function parseWaylandCaptureLine(line: string): WaylandCaptureEvent | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	if (parsed.type === "error") {
		return {
			type: "error",
			message: typeof parsed.message === "string" ? parsed.message : "unknown capture error",
		};
	}

	if (parsed.type !== "status") {
		return null;
	}

	switch (parsed.state) {
		case "negotiating":
			return { type: "status", state: "negotiating" };

		case "capture-started":
			if (parsed.protocolVersion !== 2 || !validTime(parsed.startedAtMs) || !validTime(parsed.timestamp) || parsed.startedAtMs > parsed.timestamp || typeof parsed.output !== "string" || !parsed.output) return null;
			return { type: "status", state: "capture-started", protocolVersion: 2, startedAtMs: parsed.startedAtMs, timestamp: parsed.timestamp, output: parsed.output };

		case "paused":
		case "resumed":
			if (parsed.protocolVersion !== 2 || !validTime(parsed.timestamp) || !validTime(parsed.mediaTimeUs) || typeof parsed.output !== "string") return null;
			return { type: "status", state: parsed.state, timestamp: parsed.timestamp, mediaTimeUs: parsed.mediaTimeUs, output: parsed.output };

		case "recording":
			return {
				...(parsed.protocolVersion === 2 && validTime(parsed.startedAtMs) && validTime(parsed.timestamp) && parsed.startedAtMs <= parsed.timestamp
					? { protocolVersion: 2 as const, startedAtMs: parsed.startedAtMs, timestamp: parsed.timestamp } : {}),
				type: "status",
				state: "recording",
				nodeId: Math.max(0, Math.round(toFiniteNumber(parsed.nodeId, 0))),
				sourceType: Math.max(0, Math.round(toFiniteNumber(parsed.sourceType, 0))),
				cursorMode: normalizeCursorMode(parsed.cursorMode),
				output: typeof parsed.output === "string" ? parsed.output : "",
			};

		case "stopped":
			return {
				...(validTime(parsed.stoppedAtMs) && validTime(parsed.durationMs) ? { stoppedAtMs: parsed.stoppedAtMs, durationMs: parsed.durationMs } : {}),
				type: "status",
				state: "stopped",
				exitCode: Math.round(toFiniteNumber(parsed.exitCode, -1)),
				output: typeof parsed.output === "string" ? parsed.output : "",
			};

		default:
			return null;
	}
}

/** Incremental line splitter for the helper's stdout. */
export function consumeWaylandCaptureChunk(
	buffer: string,
	chunk: string,
): { events: WaylandCaptureEvent[]; buffer: string } {
	const lines = (buffer + chunk).split(/\r?\n/);
	const remainder = lines.pop() ?? "";
	const events: WaylandCaptureEvent[] = [];

	for (const line of lines) {
		const event = parseWaylandCaptureLine(line);
		if (event) {
			events.push(event);
		}
	}

	return { events, buffer: remainder };
}

/**
 * Whether a `recording` event describes a capture Recordly is willing to keep.
 *
 * The helper already refuses a source type it did not ask for, but the decision
 * is repeated here so a helper from an older build cannot quietly hand back a
 * window -- someone's camera preview, say -- when a monitor was requested.
 */
export function isAcceptableCaptureStart(
	event: Extract<WaylandCaptureEvent, { state: "recording" }>,
): boolean {
	return event.sourceType === PORTAL_SOURCE_TYPE_MONITOR;
}
