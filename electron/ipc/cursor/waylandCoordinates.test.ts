import { describe, expect, it } from "vitest";
import {
	type DisplayLike,
	findWaylandOutputForPoint,
	matchWaylandOutputForDisplay,
	normalizePointInRect,
	normalizeWaylandCursorPoint,
	parseWaylandOutputScale,
	type WaylandOutput,
} from "./waylandCoordinates";

function output(
	index: number,
	name: string,
	x: number,
	y: number,
	width: number,
	height: number,
	scale = 1,
): WaylandOutput {
	return { index, name, x, y, width, height, scale };
}

function display(
	id: number,
	x: number,
	y: number,
	width: number,
	height: number,
	scaleFactor = 1,
	label?: string,
): DisplayLike {
	return { id, label, bounds: { x, y, width, height }, scaleFactor };
}

describe("normalizePointInRect", () => {
	it("maps 1920x1080 @ 100% linearly", () => {
		const rect = { x: 0, y: 0, width: 1920, height: 1080 };
		expect(normalizePointInRect({ x: 0, y: 0 }, rect)).toEqual({ cx: 0, cy: 0 });
		expect(normalizePointInRect({ x: 960, y: 540 }, rect)).toEqual({ cx: 0.5, cy: 0.5 });
		expect(normalizePointInRect({ x: 1920, y: 1080 }, rect)).toEqual({ cx: 1, cy: 1 });
	});

	it("clamps points outside the rect", () => {
		const rect = { x: 0, y: 0, width: 1920, height: 1080 };
		expect(normalizePointInRect({ x: -400, y: 5000 }, rect)).toEqual({ cx: 0, cy: 1 });
	});

	it("survives a degenerate rect instead of dividing by zero", () => {
		const result = normalizePointInRect({ x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 });
		expect(Number.isFinite(result.cx)).toBe(true);
		expect(Number.isFinite(result.cy)).toBe(true);
	});
});

describe("scaling", () => {
	// KWin's logical geometry already has scale divided out, so normalization
	// must never touch the scale factor again.  These are the cases that the
	// old `point / primarySf` code got wrong.
	it("2560x1440 @ 125% -> 2048x1152 logical", () => {
		const outputs = [output(0, "DP-1", 0, 0, 2048, 1152, 1.25)];
		const result = normalizeWaylandCursorPoint({
			point: { x: 1024, y: 576 },
			outputs,
			display: display(1, 0, 0, 2048, 1152, 1.25),
		});

		expect(result.cx).toBeCloseTo(0.5, 10);
		expect(result.cy).toBeCloseTo(0.5, 10);
	});

	it("3840x2160 @ 150% -> 2560x1440 logical", () => {
		const outputs = [output(0, "DP-2", 0, 0, 2560, 1440, 1.5)];
		const result = normalizeWaylandCursorPoint({
			point: { x: 640, y: 1080 },
			outputs,
			display: display(1, 0, 0, 2560, 1440, 1.5),
		});

		expect(result.cx).toBeCloseTo(0.25, 10);
		expect(result.cy).toBeCloseTo(0.75, 10);
	});

	it("2880x1800 @ 175% fractional scaling, with Chromium's noisy scaleFactor", () => {
		// Real values measured on Fedora 44 / Plasma 6.7: KWin reports the
		// output as 1646x1029, Electron reports scaleFactor 1.7496962547302246.
		const outputs = [output(0, "eDP-1", 0, 0, 1646, 1029, 1.75)];
		const result = normalizeWaylandCursorPoint({
			point: { x: 823, y: 514.5 },
			outputs,
			display: display(66, 0, 0, 1646, 1029, 1.7496962547302246, "Built-in Screen"),
		});

		expect(result.cx).toBeCloseTo(0.5, 10);
		expect(result.cy).toBeCloseTo(0.5, 10);
	});
});

describe("matchWaylandOutputForDisplay", () => {
	it("matches the single output without needing a display", () => {
		const outputs = [output(0, "eDP-1", 0, 0, 1646, 1029, 1.75)];
		expect(matchWaylandOutputForDisplay({ outputs, display: null })).toBe(outputs[0]);
	});

	it("matches identical rects on a side-by-side layout", () => {
		const outputs = [
			output(0, "eDP-1", 0, 0, 1920, 1080),
			output(1, "DP-1", 1920, 0, 2560, 1440),
		];
		const displays = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 2560, 1440)];

		expect(matchWaylandOutputForDisplay({ outputs, display: displays[1], displays })).toBe(
			outputs[1],
		);
	});

	it("matches a monitor placed left of primary (negative X)", () => {
		const outputs = [
			output(0, "DP-1", -1920, 0, 1920, 1080),
			output(1, "eDP-1", 0, 0, 1646, 1029, 1.75),
		];
		const displays = [display(1, -1920, 0, 1920, 1080), display(2, 0, 0, 1646, 1029)];

		expect(matchWaylandOutputForDisplay({ outputs, display: displays[0], displays })).toBe(
			outputs[0],
		);
	});

	it("matches a monitor placed above primary (negative Y)", () => {
		const outputs = [
			output(0, "HDMI-1", 0, -1080, 1920, 1080),
			output(1, "eDP-1", 0, 0, 1920, 1080),
		];
		const displays = [display(1, 0, -1080, 1920, 1080), display(2, 0, 0, 1920, 1080)];

		expect(matchWaylandOutputForDisplay({ outputs, display: displays[0], displays })).toBe(
			outputs[0],
		);
	});

	it("tolerates rounding differences via overlap", () => {
		const outputs = [
			output(0, "eDP-1", 0, 0, 1646, 1029, 1.75),
			output(1, "DP-1", 1646, 0, 1920, 1080),
		];
		const displays = [display(1, 0, 0, 1645, 1028), display(2, 1646, 0, 1920, 1080)];

		expect(matchWaylandOutputForDisplay({ outputs, display: displays[0], displays })).toBe(
			outputs[0],
		);
	});

	it("falls back to the output name when geometries disagree entirely", () => {
		const outputs = [
			output(0, "eDP-1", 0, 0, 1646, 1029),
			output(1, "DP-1", 1646, 0, 1920, 1080),
		];

		expect(
			matchWaylandOutputForDisplay({
				outputs,
				display: display(9, 9000, 9000, 800, 600, 1, "DP-1"),
			}),
		).toBe(outputs[1]);
	});

	it("falls back to layout order when nothing else matches", () => {
		const outputs = [output(0, "A", 0, 0, 1920, 1080), output(1, "B", 1920, 0, 1920, 1080)];
		// Electron reports a completely disjoint coordinate space here, so
		// neither the exact-rect nor the overlap rule can fire.
		const displays = [display(1, 10000, 0, 100, 100), display(2, 10500, 0, 100, 100)];

		expect(matchWaylandOutputForDisplay({ outputs, display: displays[1], displays })).toBe(
			outputs[1],
		);
	});

	it("returns null when there is nothing to match against", () => {
		expect(
			matchWaylandOutputForDisplay({ outputs: [], display: display(1, 0, 0, 10, 10) }),
		).toBeNull();
	});
});

describe("findWaylandOutputForPoint", () => {
	const outputs = [
		output(0, "DP-1", -1920, -200, 1920, 1080),
		output(1, "eDP-1", 0, 0, 1646, 1029, 1.75),
	];

	it("finds the output containing the point", () => {
		expect(findWaylandOutputForPoint(outputs, { x: -1000, y: 100 })).toBe(outputs[0]);
		expect(findWaylandOutputForPoint(outputs, { x: 800, y: 500 })).toBe(outputs[1]);
	});

	it("falls back to the nearest output for a point in dead space", () => {
		expect(findWaylandOutputForPoint(outputs, { x: 5000, y: 500 })).toBe(outputs[1]);
	});

	it("returns null with no outputs", () => {
		expect(findWaylandOutputForPoint([], { x: 0, y: 0 })).toBeNull();
	});
});

describe("normalizeWaylandCursorPoint", () => {
	it("normalizes against the captured monitor on a multi-monitor desk", () => {
		const outputs = [
			output(0, "DP-1", -2560, 0, 2560, 1440, 1.5),
			output(1, "eDP-1", 0, 0, 1920, 1080),
		];
		const displays = [display(1, -2560, 0, 2560, 1440), display(2, 0, 0, 1920, 1080)];

		// Cursor sits at the centre of the left-hand monitor.
		const result = normalizeWaylandCursorPoint({
			point: { x: -1280, y: 720 },
			outputs,
			display: displays[0],
			displays,
		});

		expect(result.output?.name).toBe("DP-1");
		expect(result.cx).toBeCloseTo(0.5, 10);
		expect(result.cy).toBeCloseTo(0.5, 10);
	});

	it("clamps to the captured monitor when the cursor is on another one", () => {
		const outputs = [
			output(0, "eDP-1", 0, 0, 1920, 1080),
			output(1, "DP-1", 1920, 0, 1920, 1080),
		];
		const displays = [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 1920, 1080)];

		const result = normalizeWaylandCursorPoint({
			point: { x: 2880, y: 540 },
			outputs,
			display: displays[0],
			displays,
		});

		expect(result.cx).toBe(1);
		expect(result.cy).toBeCloseTo(0.5, 10);
	});

	it("uses the cursor's own output when the captured display cannot be matched", () => {
		const outputs = [
			output(0, "eDP-1", 0, 0, 1920, 1080),
			output(1, "DP-1", 1920, 0, 1920, 1080),
		];

		const result = normalizeWaylandCursorPoint({
			point: { x: 2880, y: 270 },
			outputs,
			display: null,
		});

		expect(result.output?.name).toBe("DP-1");
		expect(result.cx).toBeCloseTo(0.5, 10);
		expect(result.cy).toBeCloseTo(0.25, 10);
	});

	it("falls back to the Electron display rect before the layout arrives", () => {
		const result = normalizeWaylandCursorPoint({
			point: { x: 480, y: 270 },
			outputs: [],
			display: display(1, 0, 0, 1920, 1080),
		});

		expect(result.output).toBeNull();
		expect(result.cx).toBeCloseTo(0.25, 10);
		expect(result.cy).toBeCloseTo(0.25, 10);
	});

	it("returns the screen centre when nothing is known at all", () => {
		expect(normalizeWaylandCursorPoint({ point: { x: 1, y: 2 }, outputs: [] })).toEqual({
			cx: 0.5,
			cy: 0.5,
			output: null,
		});
	});
});

describe("parseWaylandOutputScale", () => {
	it("parses the string the helper sends", () => {
		expect(parseWaylandOutputScale("1.75")).toBe(1.75);
		expect(parseWaylandOutputScale(2)).toBe(2);
	});

	it("defaults to 1 for junk", () => {
		expect(parseWaylandOutputScale("nope")).toBe(1);
		expect(parseWaylandOutputScale(0)).toBe(1);
		expect(parseWaylandOutputScale(undefined)).toBe(1);
	});
});
