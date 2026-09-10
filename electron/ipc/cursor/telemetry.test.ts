import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_TELEMETRY_VERSION } from "../constants";

const { writeFile, rm } = vi.hoisted(() => ({
	writeFile: vi.fn(),
	rm: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	default: {
		writeFile,
		rm,
	},
}));

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
	},
}));

vi.mock("../utils", () => ({
	getTelemetryPathForVideo: vi.fn(() => "/tmp/recording.cursor.json"),
	getScreen: vi.fn(() => ({
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		getPrimaryDisplay: () => ({ scaleFactor: 1 }),
		getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 } }),
		getAllDisplays: () => [],
	})),
}));

import {
	activeCursorSamples,
	setActiveCursorSamples,
	setCursorBackend,
	setCursorCaptureStartTimeMs,
	setLatestWaylandCursorPoint,
	setWaylandOutputs,
} from "../state";
import {
	getCursorCaptureElapsedMs,
	normalizeCursorTelemetrySamples,
	pauseCursorCapture,
	pauseCursorCaptureAtBoundary,
	pushCursorSample,
	resetCursorCaptureClock,
	resumeCursorCapture,
	sampleCursorPoint,
	writeCursorTelemetry,
} from "./telemetry";

describe("cursor telemetry pause clock", () => {
	beforeEach(() => {
		writeFile.mockReset();
		rm.mockReset();
		setCursorCaptureStartTimeMs(1_000);
		setActiveCursorSamples([]);
		resetCursorCaptureClock();
	});

	it("subtracts paused time from elapsed cursor timestamps", () => {
		expect(getCursorCaptureElapsedMs(1_120)).toBe(120);

		pauseCursorCapture(1_200);
		expect(getCursorCaptureElapsedMs(1_450)).toBe(200);

		resumeCursorCapture(1_700);
		expect(getCursorCaptureElapsedMs(1_900)).toBe(400);
	});

	it("ignores duplicate pause or resume transitions", () => {
		pauseCursorCapture(1_150);
		pauseCursorCapture(1_250);
		resumeCursorCapture(1_500);
		resumeCursorCapture(1_650);

		expect(getCursorCaptureElapsedMs(1_900)).toBe(550);
	});

	it("drops cursor samples captured after the renderer pause boundary", () => {
		pushCursorSample(0.1, 0.1, 120, "move");
		pushCursorSample(0.2, 0.2, 205, "move");
		pushCursorSample(0.3, 0.3, 260, "move");

		pauseCursorCaptureAtBoundary(1_200);

		expect(getCursorCaptureElapsedMs(1_500)).toBe(200);
		expect(activeCursorSamples.map((sample) => sample.timeMs)).toEqual([120]);

		resumeCursorCapture(1_700);
		expect(getCursorCaptureElapsedMs(1_900)).toBe(400);
	});

	it("normalizes cursor telemetry samples before persisting them", async () => {
		const samples = normalizeCursorTelemetrySamples([
			{ timeMs: 30, cx: 2, cy: -1, interactionType: "click", cursorType: "pointer" },
			{ timeMs: -10, cx: Number.NaN, cy: 0.2, interactionType: "drag", cursorType: "ibeam" },
			{ timeMs: 10, cx: 0.25, cy: 0.75, interactionType: "move", cursorType: "text" },
		]);

		expect(samples).toEqual([
			{ timeMs: 0, cx: 0.5, cy: 0.2, interactionType: undefined, cursorType: undefined },
			{ timeMs: 10, cx: 0.25, cy: 0.75, interactionType: "move", cursorType: "text" },
			{ timeMs: 30, cx: 1, cy: 0, interactionType: "click", cursorType: "pointer" },
		]);

		await writeCursorTelemetry("/tmp/recording.mp4", samples);

		expect(writeFile).toHaveBeenCalledWith(
			"/tmp/recording.cursor.json",
			JSON.stringify(
				{
					version: CURSOR_TELEMETRY_VERSION,
					samples,
				},
				null,
				2,
			),
			"utf-8",
		);
		expect(rm).not.toHaveBeenCalled();
	});

	it("removes the sidecar when saving an empty cursor telemetry payload", async () => {
		await writeCursorTelemetry("/tmp/recording.mp4", []);

		expect(rm).toHaveBeenCalledWith("/tmp/recording.cursor.json", { force: true });
		expect(writeFile).not.toHaveBeenCalled();
	});
});

describe("KDE Wayland cursor sampling", () => {
	beforeEach(() => {
		setActiveCursorSamples([]);
		setCursorCaptureStartTimeMs(Date.now());
		setLatestWaylandCursorPoint(null);
		setWaylandOutputs([{ name: "DP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1 }]);
		setCursorBackend("linux-kde-wayland");
	});

	// KWin needs ~200 ms to report a position while the bridge helper is handed
	// over. Recording the screen-centre placeholder pinned the drawn cursor to
	// the middle of the screen at the start of every recording.
	it("records nothing until KWin reports a real position", () => {
		sampleCursorPoint();
		sampleCursorPoint();
		expect(activeCursorSamples).toHaveLength(0);

		// Off-centre on purpose: the placeholder this replaces is (0.5, 0.5).
		setLatestWaylandCursorPoint({ x: 480, y: 270, updatedAt: Date.now() });
		sampleCursorPoint();
		expect(activeCursorSamples).toHaveLength(1);
		expect(activeCursorSamples[0].cx).toBeCloseTo(0.25, 5);
	});
});
