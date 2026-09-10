import { describe, expect, it } from "vitest";
import {
	consumeWaylandCaptureChunk,
	isAcceptableCaptureStart,
	parseWaylandCaptureLine,
} from "./waylandCaptureProtocol";

describe("parseWaylandCaptureLine", () => {
	it("preserves the native first-sample epoch and pause boundary", () => {
		expect(parseWaylandCaptureLine(JSON.stringify({ type: "status", state: "capture-started", protocolVersion: 2, startedAtMs: 1000, timestamp: 1020, output: "/tmp/a.mp4" }))).toEqual({ type: "status", state: "capture-started", protocolVersion: 2, startedAtMs: 1000, timestamp: 1020, output: "/tmp/a.mp4" });
		expect(parseWaylandCaptureLine(JSON.stringify({ type: "status", state: "paused", protocolVersion: 2, timestamp: 2000, mediaTimeUs: 1000000, output: "/tmp/a.mp4" }))).toMatchObject({ state: "paused", timestamp: 2000, mediaTimeUs: 1000000 });
	});

	it.each([null, -1, "1000"])("rejects an invalid first-sample epoch: %s", (startedAtMs) => {
		expect(parseWaylandCaptureLine(JSON.stringify({ type: "status", state: "capture-started", protocolVersion: 2, startedAtMs, timestamp: 1020, output: "/tmp/a.mp4" }))).toBeNull();
	});

	it("parses the recording announcement", () => {
		expect(
			parseWaylandCaptureLine(
				'{"type":"status","state":"recording","nodeId":94,"width":1646,"height":1029,' +
					'"sourceType":1,"cursorMode":"hidden","output":"/tmp/a.mp4"}',
			),
		).toEqual({
			type: "status",
			state: "recording",
			nodeId: 94,
			sourceType: 1,
			cursorMode: "hidden",
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
