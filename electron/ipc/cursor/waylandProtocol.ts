import { parseWaylandOutputScale, type WaylandOutput } from "./waylandCoordinates";

/**
 * JSON-lines protocol spoken by `recordly-wayland-cursor` on stdout.
 *
 * The helper merges the KWin cursor stream and the evdev button stream into a
 * single ordered pipe, so the main process never has to reconcile two sources.
 */
export type WaylandHelperEvent =
	| { type: "move"; x: number; y: number; timestamp: number }
	| {
			type: "button";
			button: 1 | 2 | 3;
			pressed: boolean;
			x: number;
			y: number;
			timestamp: number;
	  }
	| { type: "output"; count: number; output: WaylandOutput }
	| { type: "status"; state: string; detail: Record<string, unknown> }
	| { type: "error"; message: string };

function toFiniteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** evdev BTN_LEFT/BTN_RIGHT/BTN_MIDDLE arrive as 1/2/3, matching uiohook. */
export function normalizeWaylandMouseButton(value: unknown): 1 | 2 | 3 {
	return value === 2 || value === 3 ? value : 1;
}

export function parseWaylandHelperLine(line: string): WaylandHelperEvent | null {
	const trimmed = line.trim();
	if (!trimmed || !trimmed.startsWith("{")) {
		return null;
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	switch (parsed.type) {
		case "move": {
			const x = toFiniteNumber(parsed.x, Number.NaN);
			const y = toFiniteNumber(parsed.y, Number.NaN);
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				return null;
			}
			return { type: "move", x, y, timestamp: toFiniteNumber(parsed.timestamp, Date.now()) };
		}

		case "button": {
			const x = toFiniteNumber(parsed.x, Number.NaN);
			const y = toFiniteNumber(parsed.y, Number.NaN);
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				return null;
			}
			return {
				type: "button",
				button: normalizeWaylandMouseButton(parsed.button),
				pressed: parsed.pressed === true,
				x,
				y,
				timestamp: toFiniteNumber(parsed.timestamp, Date.now()),
			};
		}

		case "output": {
			const width = toFiniteNumber(parsed.width, 0);
			const height = toFiniteNumber(parsed.height, 0);
			if (width <= 0 || height <= 0) {
				return null;
			}
			return {
				type: "output",
				count: Math.max(1, Math.round(toFiniteNumber(parsed.count, 1))),
				output: {
					index: Math.max(0, Math.round(toFiniteNumber(parsed.index, 0))),
					name: typeof parsed.name === "string" ? parsed.name : "",
					x: Math.round(toFiniteNumber(parsed.x, 0)),
					y: Math.round(toFiniteNumber(parsed.y, 0)),
					width: Math.round(width),
					height: Math.round(height),
					scale: parseWaylandOutputScale(parsed.scale),
				},
			};
		}

		case "status": {
			const { type: _type, state, ...detail } = parsed;
			return {
				type: "status",
				state: typeof state === "string" ? state : "unknown",
				detail: detail as Record<string, unknown>,
			};
		}

		case "error":
			return {
				type: "error",
				message:
					typeof parsed.message === "string" ? parsed.message : "unknown helper error",
			};

		default:
			return null;
	}
}

/**
 * Incremental line splitter for the helper's stdout.  Returns the parsed events
 * plus the trailing partial line to carry into the next chunk.
 */
export function consumeWaylandHelperChunk(
	buffer: string,
	chunk: string,
): { events: WaylandHelperEvent[]; buffer: string } {
	const lines = (buffer + chunk).split(/\r?\n/);
	const remainder = lines.pop() ?? "";
	const events: WaylandHelperEvent[] = [];

	for (const line of lines) {
		const event = parseWaylandHelperLine(line);
		if (event) {
			events.push(event);
		}
	}

	return { events, buffer: remainder };
}

/**
 * Merge `output` events into the known layout.  The helper emits one message
 * per output with the total count, so a shrinking layout (monitor unplugged)
 * has to drop the stale entries rather than keep them around.
 */
export function mergeWaylandOutputs(
	existing: WaylandOutput[],
	event: { count: number; output: WaylandOutput },
): WaylandOutput[] {
	const next = existing.filter(
		(output) => output.index !== event.output.index && output.index < event.count,
	);
	next.push(event.output);
	return next.sort((left, right) => left.index - right.index);
}

export type WaylandButtonCapture = "unknown" | "active" | "unavailable";

export function readButtonCaptureState(
	event: Extract<WaylandHelperEvent, { type: "status" }>,
): WaylandButtonCapture | null {
	if (event.state === "button-capture-unavailable") {
		return "unavailable";
	}

	if (event.state === "ready" || event.state === "pointer-devices-changed") {
		const devices = Number(event.detail.pointerDevices ?? 0);
		return Number.isFinite(devices) && devices > 0 ? "active" : "unavailable";
	}

	return null;
}
