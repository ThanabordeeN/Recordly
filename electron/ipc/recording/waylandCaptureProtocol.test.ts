import { describe, expect, it } from "vitest";
import {
	consumeWaylandCaptureChunk,
	describeWaylandCaptureExit,
	isAcceptableCaptureStart,
	parseWaylandCaptureLine,
} from "./waylandCaptureProtocol";

describe("parseWaylandCaptureLine", () => {
	it("parses the recording announcement", () => {
		expect(
			parseWaylandCaptureLine(
				'{"type":"status","state":"recording","nodeId":94,"width":1646,"height":1029,' +
					'"sourceType":1,"cursorMode":"hidden","restoreToken":"tok","output":"/tmp/a.mp4"}',
			),
		).toEqual({
			type: "status",
			state: "recording",
			nodeId: 94,
			sourceType: 1,
			cursorMode: "hidden",
			restoreToken: "tok",
			output: "/tmp/a.mp4",
		});
	});

	it("parses negotiating, stopped and error lines", () => {
		expect(parseWaylandCaptureLine('{"type":"status","state":"negotiating"}')).toEqual({
			type: "status",
			state: "negotiating",
		});

		expect(
			parseWaylandCaptureLine(
				'{"type":"status","state":"stopped","exitCode":0,"output":"/tmp/a.mp4"}',
			),
		).toEqual({ type: "status", state: "stopped", exitCode: 0, output: "/tmp/a.mp4" });

		expect(parseWaylandCaptureLine('{"type":"error","message":"nope"}')).toEqual({
			type: "error",
			message: "nope",
		});
	});

	it("surfaces a rejected restore token", () => {
		expect(
			parseWaylandCaptureLine(
				'{"type":"status","state":"restore-token-rejected","reason":"returned a window"}',
			),
		).toEqual({
			type: "status",
			state: "restore-token-rejected",
			reason: "returned a window",
		});
	});

	it("defaults an unknown cursor mode to hidden", () => {
		const event = parseWaylandCaptureLine(
			'{"type":"status","state":"recording","nodeId":1,"sourceType":1,"cursorMode":"weird"}',
		);
		expect(event).toMatchObject({ cursorMode: "hidden" });
	});

	it("rejects junk, partial lines and unknown states", () => {
		expect(parseWaylandCaptureLine("")).toBeNull();
		expect(parseWaylandCaptureLine("not json")).toBeNull();
		expect(parseWaylandCaptureLine('{"type":"status","state":"recor')).toBeNull();
		expect(parseWaylandCaptureLine('{"type":"status","state":"whatever"}')).toBeNull();
		expect(parseWaylandCaptureLine('{"type":"other"}')).toBeNull();
	});
});

describe("consumeWaylandCaptureChunk", () => {
	it("carries a partial trailing line into the next chunk", () => {
		const first = consumeWaylandCaptureChunk(
			"",
			'{"type":"status","state":"negotiating"}\n{"type":"error","mess',
		);
		expect(first.events).toHaveLength(1);

		const second = consumeWaylandCaptureChunk(first.buffer, 'age":"boom"}\n');
		expect(second.events).toEqual([{ type: "error", message: "boom" }]);
	});
});

describe("isAcceptableCaptureStart", () => {
	const base = {
		type: "status",
		state: "recording",
		nodeId: 1,
		cursorMode: "hidden",
		restoreToken: "",
		output: "/tmp/a.mp4",
	} as const;

	it("accepts a monitor capture", () => {
		expect(isAcceptableCaptureStart({ ...base, sourceType: 1 })).toBe(true);
	});

	it("refuses a window or virtual source", () => {
		// A restore token can replay a source the user picked for another app;
		// recording it would capture something never chosen for this recording.
		expect(isAcceptableCaptureStart({ ...base, sourceType: 2 })).toBe(false);
		expect(isAcceptableCaptureStart({ ...base, sourceType: 4 })).toBe(false);
		expect(isAcceptableCaptureStart({ ...base, sourceType: 0 })).toBe(false);
	});
});

describe("describeWaylandCaptureExit", () => {
	it("explains the documented exit codes", () => {
		expect(describeWaylandCaptureExit(0)).toContain("finished");
		expect(describeWaylandCaptureExit(5)).toContain("cancelled");
		expect(describeWaylandCaptureExit(7)).toContain("pipewiresrc");
		expect(describeWaylandCaptureExit(99)).toContain("99");
	});
});
