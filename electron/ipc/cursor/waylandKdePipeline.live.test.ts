import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Live end-to-end check of the KDE Wayland telemetry pipeline: real helper,
 * real KWin, real evdev, through the real sampler and interaction recorder,
 * out to the sample array that becomes `<recording>.cursor.json`.
 *
 * Skipped unless RECORDLY_LIVE_WAYLAND_TEST=1, so `npm test` never needs a
 * compositor.  On a KDE Wayland machine:
 *
 *   RECORDLY_LIVE_WAYLAND_TEST=1 npx vitest --run \
 *     electron/ipc/cursor/waylandKdePipeline.live.test.ts
 *
 * Move the mouse continuously and click while it collects.
 */
const isEnabled = process.env.RECORDLY_LIVE_WAYLAND_TEST === "1";
const COLLECT_MS = Number(process.env.RECORDLY_LIVE_WAYLAND_TEST_MS ?? 12000);

const projectRoot = path.resolve(__dirname, "..", "..", "..");

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp"), getAppPath: vi.fn(() => "/tmp/app"), isPackaged: false },
}));

// Only the display list is mocked; everything else is the real implementation.
// The KDE backend never calls getCursorScreenPoint, which is the whole point.
vi.mock("../utils", () => ({
	getTelemetryPathForVideo: vi.fn(() => "/tmp/live.cursor.json"),
	getScreen: vi.fn(() => ({
		getCursorScreenPoint: () => {
			throw new Error("the KDE Wayland backend must not read Electron's cursor point");
		},
		getPrimaryDisplay: () => ({
			id: 1,
			scaleFactor: 1,
			bounds: { x: 0, y: 0, width: 1, height: 1 },
		}),
		getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }),
		getAllDisplays: () => [],
	})),
}));

vi.mock("../paths/binaries", () => ({
	getWaylandCursorHelperPath: () => {
		const candidates = [
			path.join(projectRoot, "electron/native/bin/linux-x64/recordly-wayland-cursor"),
			path.join(projectRoot, "electron/native/wayland-cursor/build/recordly-wayland-cursor"),
		];
		return candidates.find((candidate) => existsSync(candidate)) ?? null;
	},
	getWaylandCursorKWinScriptPath: () =>
		path.join(projectRoot, "electron/native/wayland-cursor/kwin/recordly-cursor-bridge.js"),
}));

import {
	activeCursorSamples,
	setActiveCursorSamples,
	setCursorBackend,
	setCursorCaptureStartTimeMs,
	setIsCursorCaptureActive,
	setLastLeftClick,
} from "../state";
import {
	resetCursorCaptureClock,
	sampleCursorPoint,
	startCursorSampling,
	stopCursorCapture,
} from "./telemetry";
import { startWaylandCursorBackend, stopWaylandCursorBackend } from "./waylandKde";

describe.skipIf(!isEnabled)("live KDE Wayland telemetry pipeline", () => {
	it(
		"produces continuously changing cursor samples plus paired click and mouseup events",
		async () => {
			setCursorBackend("linux-kde-wayland");
			setActiveCursorSamples([]);
			setLastLeftClick(null);
			setCursorCaptureStartTimeMs(Date.now());
			resetCursorCaptureClock();
			setIsCursorCaptureActive(true);

			expect(startWaylandCursorBackend()).toBe(true);
			// Give KWin a moment to load the bridge and prime a position.
			await new Promise((resolve) => setTimeout(resolve, 1500));

			sampleCursorPoint();
			startCursorSampling();

			console.log(`[live] collecting for ${COLLECT_MS}ms — move the mouse and click now.`);
			await new Promise((resolve) => setTimeout(resolve, COLLECT_MS));

			stopCursorCapture();
			setIsCursorCaptureActive(false);
			const samples = [...activeCursorSamples];
			stopWaylandCursorBackend();

			const byType = samples.reduce<Record<string, number>>((counts, sample) => {
				const key = sample.interactionType ?? "none";
				counts[key] = (counts[key] ?? 0) + 1;
				return counts;
			}, {});
			const uniquePositions = new Set(samples.map((sample) => `${sample.cx},${sample.cy}`));

			console.log(
				JSON.stringify(
					{
						total: samples.length,
						unique_positions: uniquePositions.size,
						interactions: byType,
						first: samples[0],
						last: samples.at(-1),
					},
					null,
					2,
				),
			);

			expect(samples.length).toBeGreaterThan(50);
			expect(uniquePositions.size).toBeGreaterThan(50);
			for (const sample of samples) {
				expect(sample.cx).toBeGreaterThanOrEqual(0);
				expect(sample.cx).toBeLessThanOrEqual(1);
				expect(sample.cy).toBeGreaterThanOrEqual(0);
				expect(sample.cy).toBeLessThanOrEqual(1);
			}

			const clicks =
				(byType.click ?? 0) +
				(byType["double-click"] ?? 0) +
				(byType["right-click"] ?? 0) +
				(byType["middle-click"] ?? 0);
			expect(clicks).toBe(byType.mouseup ?? 0);
		},
		COLLECT_MS + 20000,
	);
});
