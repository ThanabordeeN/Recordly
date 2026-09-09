import { describe, expect, it } from "vitest";
import {
	consumeWaylandHelperChunk,
	mergeWaylandOutputs,
	normalizeWaylandMouseButton,
	parseWaylandHelperLine,
	readButtonCaptureState,
} from "./waylandProtocol";

describe("normalizeWaylandMouseButton", () => {
	it("maps evdev BTN_LEFT/RIGHT/MIDDLE to Recordly's 1/2/3", () => {
		expect(normalizeWaylandMouseButton(1)).toBe(1);
		expect(normalizeWaylandMouseButton(2)).toBe(2);
		expect(normalizeWaylandMouseButton(3)).toBe(3);
	});

	it("defaults unknown buttons to left", () => {
		expect(normalizeWaylandMouseButton(9)).toBe(1);
		expect(normalizeWaylandMouseButton(undefined)).toBe(1);
		expect(normalizeWaylandMouseButton("2")).toBe(1);
	});
});

describe("parseWaylandHelperLine", () => {
	it("parses a move line", () => {
		expect(
			parseWaylandHelperLine('{"type":"move","x":1240,"y":612,"timestamp":1788939516893}'),
		).toEqual({ type: "move", x: 1240, y: 612, timestamp: 1788939516893 });
	});

	it("parses button press and release", () => {
		expect(
			parseWaylandHelperLine(
				'{"type":"button","button":1,"pressed":true,"x":10,"y":20,"timestamp":5}',
			),
		).toEqual({ type: "button", button: 1, pressed: true, x: 10, y: 20, timestamp: 5 });

		expect(
			parseWaylandHelperLine(
				'{"type":"button","button":2,"pressed":false,"x":10,"y":20,"timestamp":6}',
			),
		).toEqual({ type: "button", button: 2, pressed: false, x: 10, y: 20, timestamp: 6 });
	});

	it("parses an output line including a fractional scale", () => {
		const event = parseWaylandHelperLine(
			'{"type":"output","index":0,"count":1,"name":"eDP-1","x":0,"y":0,"width":1646,"height":1029,"scale":1.75}',
		);

		expect(event).toEqual({
			type: "output",
			count: 1,
			output: { index: 0, name: "eDP-1", x: 0, y: 0, width: 1646, height: 1029, scale: 1.75 },
		});
	});

	it("parses status and error lines", () => {
		expect(
			parseWaylandHelperLine('{"type":"status","state":"ready","pointerDevices":3}'),
		).toEqual({ type: "status", state: "ready", detail: { pointerDevices: 3 } });

		expect(parseWaylandHelperLine('{"type":"error","message":"nope"}')).toEqual({
			type: "error",
			message: "nope",
		});
	});

	it("rejects junk, partial lines, and unknown types", () => {
		expect(parseWaylandHelperLine("")).toBeNull();
		expect(parseWaylandHelperLine("not json")).toBeNull();
		expect(parseWaylandHelperLine('{"type":"move","x":12')).toBeNull();
		expect(parseWaylandHelperLine('{"type":"move","y":3}')).toBeNull();
		expect(parseWaylandHelperLine('{"type":"whatever"}')).toBeNull();
		expect(
			parseWaylandHelperLine('{"type":"output","index":0,"count":1,"width":0,"height":0}'),
		).toBeNull();
	});
});

describe("consumeWaylandHelperChunk", () => {
	it("keeps a partial trailing line for the next chunk", () => {
		const first = consumeWaylandHelperChunk(
			"",
			'{"type":"move","x":1,"y":2,"timestamp":3}\n{"type":"move","x":4,',
		);

		expect(first.events).toHaveLength(1);
		expect(first.buffer).toBe('{"type":"move","x":4,');

		const second = consumeWaylandHelperChunk(first.buffer, '"y":5,"timestamp":6}\n');
		expect(second.events).toEqual([{ type: "move", x: 4, y: 5, timestamp: 6 }]);
		expect(second.buffer).toBe("");
	});

	it("skips unparseable lines without losing the rest", () => {
		const result = consumeWaylandHelperChunk(
			"",
			'garbage\n{"type":"move","x":1,"y":2,"timestamp":3}\n',
		);

		expect(result.events).toHaveLength(1);
	});
});

describe("mergeWaylandOutputs", () => {
	const first = { index: 0, name: "eDP-1", x: 0, y: 0, width: 1646, height: 1029, scale: 1.75 };
	const second = { index: 1, name: "DP-1", x: 1646, y: 0, width: 1920, height: 1080, scale: 1 };

	it("accumulates the outputs of one layout announcement", () => {
		let outputs = mergeWaylandOutputs([], { count: 2, output: first });
		outputs = mergeWaylandOutputs(outputs, { count: 2, output: second });

		expect(outputs.map((output) => output.name)).toEqual(["eDP-1", "DP-1"]);
	});

	it("replaces an output in place when its geometry changes", () => {
		const outputs = mergeWaylandOutputs([first], {
			count: 1,
			output: { ...first, width: 1920, height: 1080, scale: 1 },
		});

		expect(outputs).toHaveLength(1);
		expect(outputs[0].width).toBe(1920);
	});

	it("drops stale outputs when a monitor is unplugged", () => {
		const outputs = mergeWaylandOutputs([first, second], { count: 1, output: first });

		expect(outputs).toHaveLength(1);
		expect(outputs[0].name).toBe("eDP-1");
	});
});

describe("readButtonCaptureState", () => {
	it("reports active capture when pointer devices were opened", () => {
		expect(
			readButtonCaptureState({
				type: "status",
				state: "ready",
				detail: { pointerDevices: 2 },
			}),
		).toBe("active");
	});

	it("reports unavailable capture when evdev was denied", () => {
		expect(
			readButtonCaptureState({
				type: "status",
				state: "button-capture-unavailable",
				detail: { reason: "permission-denied", path: "/dev/input/event3" },
			}),
		).toBe("unavailable");

		expect(
			readButtonCaptureState({
				type: "status",
				state: "ready",
				detail: { pointerDevices: 0 },
			}),
		).toBe("unavailable");
	});

	it("picks up a hot-plugged mouse", () => {
		expect(
			readButtonCaptureState({
				type: "status",
				state: "pointer-devices-changed",
				detail: { pointerDevices: 1 },
			}),
		).toBe("active");
	});

	it("ignores unrelated status lines", () => {
		expect(
			readButtonCaptureState({ type: "status", state: "whatever", detail: {} }),
		).toBeNull();
	});
});
