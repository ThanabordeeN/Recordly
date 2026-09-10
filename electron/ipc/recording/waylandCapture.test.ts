import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp"), getAppPath: vi.fn(() => "/tmp/app"), isPackaged: false } }));
vi.mock("../ffmpeg/binary", () => ({ getFfmpegBinaryPath: () => "/usr/bin/ffmpeg" }));
vi.mock("../paths/binaries", () => ({ getWaylandCaptureHelperPath: () => "/opt/recordly-wayland-capture" }));
import { startWaylandCapture, stopWaylandCapture, setWaylandCapturePaused } from "./waylandCapture";

class FakeHelper extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn(), end: vi.fn() };
	kill = vi.fn();
	emitLine(object: unknown) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(object)}\n`)); }
}
const createHelper = () => new FakeHelper() as unknown as import("node:child_process").ChildProcessWithoutNullStreams & FakeHelper;
const quiet = { log: () => {}, warn: () => {} };
const first = { type: "status", state: "capture-started", protocolVersion: 2, startedAtMs: 1000, timestamp: 1020, output: "/tmp/a.mp4" };
const recording = { ...first, state: "recording", timestamp: 1800, nodeId: 94, sourceType: 1, cursorMode: "hidden" };
function begin(helper: ReturnType<typeof createHelper>, extra = {}) {
	return startWaylandCapture({ outputPath: "/tmp/a.mp4", spawnHelper: () => helper, ...quiet, ...extra });
}
async function ready(helper: ReturnType<typeof createHelper>) {
	const pending = begin(helper);
	helper.emitLine(first); helper.emitLine(recording);
	expect((await pending).success).toBe(true);
}
beforeEach(async () => { await stopWaylandCapture({ timeoutMs: 1, warn: () => {} }); });

describe("Wayland first-sample lifecycle", () => {
	it("starts companions on the first sample but resolves startup only after encoding", async () => {
		const helper = createHelper(); const onCaptureStarted = vi.fn();
		const pending = begin(helper, { onCaptureStarted });
		const resolved = vi.fn(); void pending.then(resolved);
		helper.emitLine(first);
		expect(onCaptureStarted).toHaveBeenCalledExactlyOnceWith(first);
		await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
		helper.emitLine(recording);
		await expect(pending).resolves.toEqual({ success: true, outputPath: "/tmp/a.mp4", nodeId: 94, startedAtMs: 1000 });
		helper.emitLine(first); helper.emitLine(recording);
		expect(onCaptureStarted).toHaveBeenCalledTimes(1);
	});
	it("rejects a legacy recording event without a first-sample epoch", async () => {
		const helper = createHelper(); const pending = begin(helper);
		helper.emitLine({ type: "status", state: "recording", nodeId: 1, sourceType: 1, output: "/tmp/a.mp4" });
		expect((await pending).success).toBe(false);
	});
	it("rejects a foreign output and does not start companions", async () => {
		const helper = createHelper(); const onCaptureStarted = vi.fn(); const pending = begin(helper, { onCaptureStarted });
		helper.emitLine({ ...first, output: "/tmp/foreign.mp4" });
		expect((await pending).success).toBe(false); expect(onCaptureStarted).not.toHaveBeenCalled();
	});
	it("reserves the helper while negotiating", async () => {
		const helper = createHelper(); const pending = begin(helper);
		expect((await begin(createHelper())).success).toBe(false);
		helper.emit("close", 5); await pending;
	});
	it("asks for hidden cursor and the requested output", async () => {
		const helper = createHelper(); const spawnHelper = vi.fn(() => helper);
		const pending = startWaylandCapture({ outputPath: "/tmp/a.mp4", spawnHelper, ...quiet });
		helper.emitLine(first); helper.emitLine(recording); await pending;
		const args = spawnHelper.mock.calls[0][1] as string[];
		expect(args[args.indexOf("--cursor-mode") + 1]).toBe("hidden");
		expect(args[args.indexOf("--output") + 1]).toBe("/tmp/a.mp4");
	});
	it("refuses nonmonitor sources", async () => {
		const helper = createHelper(); const pending = begin(helper);
		helper.emitLine(first); helper.emitLine({ ...recording, sourceType: 2 });
		expect((await pending).success).toBe(false); expect(helper.kill).toHaveBeenCalled();
	});
	it("reports portal cancellation", async () => {
		const helper = createHelper(); const pending = begin(helper); helper.emit("close", 5);
		await expect(pending).resolves.toMatchObject({ success: false, cancelled: true });
	});
	it("reports startup failure after a first sample", async () => {
		const helper = createHelper(); const pending = begin(helper); helper.emitLine(first);
		helper.emitLine({ type: "error", message: "encoder failed" });
		await expect(pending).resolves.toMatchObject({ success: false, message: "encoder failed" });
	});
	it("reports a missing binary", async () => {
		await expect(startWaylandCapture({ outputPath: "/tmp/a.mp4", helperPath: null, ...quiet })).resolves.toMatchObject({ success: false });
	});
});

describe("Wayland pause and stop", () => {
	it("waits for the native pause acknowledgment", async () => {
		const helper = createHelper(); await ready(helper);
		const pending = setWaylandCapturePaused(true); const resolved = vi.fn(); void Promise.resolve(pending).then(resolved);
		await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
		helper.emitLine({ type: "status", state: "paused", protocolVersion: 2, timestamp: 2000, mediaTimeUs: 1000000, output: "/tmp/a.mp4" });
		await expect(pending).resolves.toEqual({ success: true, timestamp: 2000 });
	});
	it("sends stop without simultaneously terminating the helper", async () => {
		const helper = createHelper(); await ready(helper);
		const pending = stopWaylandCapture({ warn: () => {} });
		expect(helper.stdin.write).toHaveBeenCalledWith("stop\n"); expect(helper.kill).not.toHaveBeenCalled();
		helper.emit("close", 0);
		await expect(pending).resolves.toEqual({ success: true, outputPath: "/tmp/a.mp4" });
	});
	it.each([6, null])("does not accept unsuccessful exit %s", async (code) => {
		const helper = createHelper(); await ready(helper);
		const pending = stopWaylandCapture({ warn: () => {} }); helper.emit("close", code);
		await expect(pending).resolves.toMatchObject({ success: false });
	});
	it("retains runtime errors even if the helper exits zero", async () => {
		const helper = createHelper(); await ready(helper);
		helper.emitLine({ type: "error", message: "source failed" });
		const pending = stopWaylandCapture({ warn: () => {} }); helper.emit("close", 0);
		await expect(pending).resolves.toMatchObject({ success: false });
	});
	it("is safe when nothing is running", async () => {
		await expect(stopWaylandCapture(quiet)).resolves.toEqual({ success: false, outputPath: null });
	});
});
