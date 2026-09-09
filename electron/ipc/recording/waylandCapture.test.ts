import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp"), getAppPath: vi.fn(() => "/tmp/app"), isPackaged: false },
}));
vi.mock("../ffmpeg/binary", () => ({ getFfmpegBinaryPath: () => "/usr/bin/ffmpeg" }));
vi.mock("../paths/binaries", () => ({
	getWaylandCaptureHelperPath: () => "/opt/recordly-wayland-capture",
}));

import { isWaylandCaptureActive, startWaylandCapture, stopWaylandCapture } from "./waylandCapture";

class FakeHelper extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn(), end: vi.fn() };
	kill = vi.fn();
	emitLine(object: unknown) {
		this.stdout.emit("data", Buffer.from(`${JSON.stringify(object)}\n`));
	}
}

function createHelper() {
	return new FakeHelper() as unknown as import("node:child_process").ChildProcessWithoutNullStreams &
		FakeHelper;
}

const quiet = { log: () => {}, warn: () => {} };

describe("startWaylandCapture", () => {
	beforeEach(async () => {
		await stopWaylandCapture({ timeoutMs: 10, warn: () => {} });
	});

	it("resolves only once the helper reports it is recording", async () => {
		const helper = createHelper();
		const pending = startWaylandCapture({
			outputPath: "/tmp/a.mp4",
			spawnHelper: () => helper,
			...quiet,
		});

		helper.emitLine({ type: "status", state: "negotiating" });
		expect(isWaylandCaptureActive()).toBe(false);

		helper.emitLine({
			type: "status",
			state: "recording",
			nodeId: 94,
			sourceType: 1,
			cursorMode: "hidden",
			restoreToken: "",
			output: "/tmp/a.mp4",
		});

		await expect(pending).resolves.toEqual({
			success: true,
			outputPath: "/tmp/a.mp4",
			nodeId: 94,
		});
		expect(isWaylandCaptureActive()).toBe(true);
	});

	it("asks the helper to hide the cursor and where to write", async () => {
		const helper = createHelper();
		const spawnHelper = vi.fn(() => helper);
		const pending = startWaylandCapture({
			outputPath: "/tmp/b.mp4",
			spawnHelper,
			...quiet,
		});
		helper.emitLine({
			type: "status",
			state: "recording",
			nodeId: 1,
			sourceType: 1,
			cursorMode: "hidden",
			restoreToken: "",
			output: "/tmp/b.mp4",
		});
		await pending;

		const args = spawnHelper.mock.calls[0][1] as string[];
		expect(args).toContain("--cursor-mode");
		expect(args[args.indexOf("--cursor-mode") + 1]).toBe("hidden");
		expect(args[args.indexOf("--output") + 1]).toBe("/tmp/b.mp4");
	});

	it("refuses a source that is not a monitor", async () => {
		const helper = createHelper();
		const pending = startWaylandCapture({
			outputPath: "/tmp/c.mp4",
			spawnHelper: () => helper,
			...quiet,
		});

		// A stale portal restore token can replay a window the user picked for
		// another app; recording it would capture something never chosen here.
		helper.emitLine({
			type: "status",
			state: "recording",
			nodeId: 7,
			sourceType: 2,
			cursorMode: "hidden",
			restoreToken: "tok",
			output: "/tmp/c.mp4",
		});

		const result = await pending;
		expect(result.success).toBe(false);
		expect(isWaylandCaptureActive()).toBe(false);
		expect(helper.kill).toHaveBeenCalled();
	});

	it("reports a cancelled portal dialog", async () => {
		const helper = createHelper();
		const pending = startWaylandCapture({
			outputPath: "/tmp/d.mp4",
			spawnHelper: () => helper,
			...quiet,
		});

		helper.emit("close", 5);
		const result = await pending;
		expect(result).toMatchObject({ success: false, cancelled: true });
		expect((result as { message: string }).message).toContain("cancelled");
	});

	it("explains a missing GStreamer instead of failing silently", async () => {
		const helper = createHelper();
		const pending = startWaylandCapture({
			outputPath: "/tmp/e.mp4",
			spawnHelper: () => helper,
			...quiet,
		});

		helper.emitLine({ type: "error", message: "gst-launch-1.0 is missing." });
		helper.emit("close", 7);

		const result = await pending;
		expect(result.success).toBe(false);
		expect((result as { message: string }).message).toContain("gst-launch");
	});

	it("reports a missing helper binary rather than throwing", async () => {
		const result = await startWaylandCapture({
			outputPath: "/tmp/f.mp4",
			helperPath: null,
			...quiet,
		});

		expect(result.success).toBe(false);
		expect((result as { message: string }).message).toContain("recordly-wayland-capture");
	});
});

describe("stopWaylandCapture", () => {
	it("asks the helper to finish so the encoder can close the file", async () => {
		const helper = createHelper();
		const pending = startWaylandCapture({
			outputPath: "/tmp/g.mp4",
			spawnHelper: () => helper,
			...quiet,
		});
		helper.emitLine({
			type: "status",
			state: "recording",
			nodeId: 2,
			sourceType: 1,
			cursorMode: "hidden",
			restoreToken: "",
			output: "/tmp/g.mp4",
		});
		await pending;

		const stopping = stopWaylandCapture({ warn: () => {} });
		expect(helper.stdin.write).toHaveBeenCalledWith("stop\n");
		helper.emit("close", 0);

		await expect(stopping).resolves.toEqual({ success: true, outputPath: "/tmp/g.mp4" });
		expect(isWaylandCaptureActive()).toBe(false);
	});

	it("is safe when nothing is running", async () => {
		await expect(stopWaylandCapture({ warn: () => {} })).resolves.toEqual({
			success: false,
			outputPath: null,
		});
	});
});
