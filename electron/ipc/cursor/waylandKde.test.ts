import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { helperPath } = vi.hoisted(() => ({
	helperPath: { value: "/opt/recordly-wayland-cursor" },
}));

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
		getAppPath: vi.fn(() => "/tmp/app"),
		isPackaged: false,
	},
}));

vi.mock("../paths/binaries", () => ({
	getWaylandCursorHelperPath: vi.fn(() => helperPath.value),
	getWaylandCursorKWinScriptPath: vi.fn(() => "/tmp/app/kwin/recordly-cursor-bridge.js"),
}));

import {
	cursorBackend,
	latestWaylandCursorPoint,
	setCursorBackend,
	setCursorCaptureStartTimeMs,
	setIsCursorCaptureActive,
	setLatestWaylandCursorPoint,
	setWaylandOutputs,
	waylandButtonCapture,
	waylandCursorHelperProcess,
	waylandOutputs,
} from "../state";
import {
	applyWaylandHelperEvent,
	isWaylandCursorBackendActive,
	startWaylandCursorBackend,
	stopWaylandCursorBackend,
} from "./waylandKde";

class FakeHelperProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn(), end: vi.fn() };
	kill = vi.fn();
}

function createFakeHelper() {
	return new FakeHelperProcess() as unknown as import("node:child_process").ChildProcessWithoutNullStreams &
		FakeHelperProcess;
}

describe("isWaylandCursorBackendActive", () => {
	beforeEach(() => {
		setCursorBackend("linux-x11-uiohook");
	});

	it("tracks the resolved backend", () => {
		expect(isWaylandCursorBackendActive()).toBe(false);
		setCursorBackend("linux-kde-wayland");
		expect(isWaylandCursorBackendActive()).toBe(true);
		expect(cursorBackend).toBe("linux-kde-wayland");
	});
});

describe("applyWaylandHelperEvent", () => {
	beforeEach(() => {
		// Resets the once-per-session button-capture warning flag so each case
		// observes its own log output.
		stopWaylandCursorBackend();
		setCursorBackend("linux-kde-wayland");
		setWaylandOutputs([]);
		setLatestWaylandCursorPoint(null);
		setIsCursorCaptureActive(true);
		setCursorCaptureStartTimeMs(Date.now());
	});

	it("caches the latest KWin cursor point", () => {
		applyWaylandHelperEvent(
			{ type: "move", x: 1240, y: 612, timestamp: 42 },
			{ log: () => {}, warn: () => {} },
		);

		expect(latestWaylandCursorPoint).toEqual({ x: 1240, y: 612, updatedAt: 42 });
	});

	it("records the output layout", () => {
		applyWaylandHelperEvent(
			{
				type: "output",
				count: 1,
				output: {
					index: 0,
					name: "eDP-1",
					x: 0,
					y: 0,
					width: 1646,
					height: 1029,
					scale: 1.75,
				},
			},
			{ log: () => {}, warn: () => {} },
		);

		expect(waylandOutputs).toHaveLength(1);
		expect(waylandOutputs[0].name).toBe("eDP-1");
	});

	it("converts press and release into mouse-down and mouse-up", () => {
		const onMouseDown = vi.fn();
		const onMouseUp = vi.fn();

		applyWaylandHelperEvent(
			{ type: "button", button: 1, pressed: true, x: 100, y: 200, timestamp: 1 },
			{ onMouseDown, onMouseUp, log: () => {}, warn: () => {} },
		);
		applyWaylandHelperEvent(
			{ type: "button", button: 1, pressed: false, x: 100, y: 200, timestamp: 2 },
			{ onMouseDown, onMouseUp, log: () => {}, warn: () => {} },
		);

		expect(onMouseDown).toHaveBeenCalledWith(1, { x: 100, y: 200 });
		expect(onMouseUp).toHaveBeenCalledWith({ x: 100, y: 200 });
	});

	it("maps right and middle buttons through unchanged", () => {
		const onMouseDown = vi.fn();

		for (const button of [2, 3] as const) {
			applyWaylandHelperEvent(
				{ type: "button", button, pressed: true, x: 1, y: 2, timestamp: 1 },
				{ onMouseDown, log: () => {}, warn: () => {} },
			);
		}

		expect(onMouseDown.mock.calls.map((call) => call[0])).toEqual([2, 3]);
	});

	it("still updates the cursor cache but records nothing while capture is stopped", () => {
		setIsCursorCaptureActive(false);
		const onMouseDown = vi.fn();

		applyWaylandHelperEvent(
			{ type: "button", button: 1, pressed: true, x: 7, y: 8, timestamp: 3 },
			{ onMouseDown, log: () => {}, warn: () => {} },
		);

		expect(onMouseDown).not.toHaveBeenCalled();
		expect(latestWaylandCursorPoint).toEqual({ x: 7, y: 8, updatedAt: 3 });
	});

	it("reports an actionable message when /dev/input is not readable", () => {
		const warn = vi.fn();

		applyWaylandHelperEvent(
			{
				type: "status",
				state: "button-capture-unavailable",
				detail: { reason: "permission-denied", path: "/dev/input/event4" },
			},
			{ log: () => {}, warn },
		);

		expect(waylandButtonCapture).toBe("unavailable");
		const message = warn.mock.calls[0][0] as string;
		expect(message).toContain(
			"[CursorTelemetry] Mouse button capture unavailable: permission denied for /dev/input/event4",
		);
		expect(message).toContain("Auto Zoom click detection will be unavailable");
	});

	it("explains a missing libinput without blaming permissions", () => {
		const warn = vi.fn();

		applyWaylandHelperEvent(
			{
				type: "status",
				state: "button-capture-unavailable",
				detail: { reason: "libinput-unavailable" },
			},
			{ log: () => {}, warn },
		);

		expect(waylandButtonCapture).toBe("unavailable");
		expect(warn.mock.calls[0][0]).toContain("libinput.so.10 could not be loaded");
	});

	it("keeps cursor movement working when button capture is unavailable", () => {
		applyWaylandHelperEvent(
			{
				type: "status",
				state: "button-capture-unavailable",
				detail: { reason: "permission-denied", path: "/dev/input/event4" },
			},
			{ log: () => {}, warn: () => {} },
		);
		applyWaylandHelperEvent(
			{ type: "move", x: 5, y: 6, timestamp: 9 },
			{ log: () => {}, warn: () => {} },
		);

		expect(latestWaylandCursorPoint).toEqual({ x: 5, y: 6, updatedAt: 9 });
	});

	it("marks button capture active once a pointer device is open", () => {
		applyWaylandHelperEvent(
			{ type: "status", state: "ready", detail: { pointerDevices: 2 } },
			{ log: () => {}, warn: () => {} },
		);

		expect(waylandButtonCapture).toBe("active");
	});
});

describe("startWaylandCursorBackend / stopWaylandCursorBackend", () => {
	beforeEach(() => {
		setCursorBackend("linux-kde-wayland");
		helperPath.value = "/opt/recordly-wayland-cursor";
		stopWaylandCursorBackend();
	});

	it("spawns the helper with the KWin script path", () => {
		const helper = createFakeHelper();
		const spawnHelper = vi.fn(() => helper);

		expect(startWaylandCursorBackend({ spawnHelper, log: () => {}, warn: () => {} })).toBe(
			true,
		);
		expect(spawnHelper).toHaveBeenCalledWith("/opt/recordly-wayland-cursor", [
			"--kwin-script",
			"/tmp/app/kwin/recordly-cursor-bridge.js",
		]);
		expect(waylandCursorHelperProcess).toBe(helper);
	});

	it("feeds stdout through the parser into cursor state", () => {
		const helper = createFakeHelper();
		startWaylandCursorBackend({
			spawnHelper: () => helper,
			log: () => {},
			warn: () => {},
		});

		helper.stdout.emit(
			"data",
			Buffer.from(
				'{"type":"output","index":0,"count":1,"name":"eDP-1","x":0,"y":0,"width":1646,"height":1029,"scale":1.75}\n' +
					'{"type":"move","x":800,"y":500,"timestamp":11}\n{"type":"move","x":80',
			),
		);

		expect(waylandOutputs).toHaveLength(1);
		expect(latestWaylandCursorPoint).toEqual({ x: 800, y: 500, updatedAt: 11 });

		helper.stdout.emit("data", Buffer.from('1,"y":501,"timestamp":12}\n'));
		expect(latestWaylandCursorPoint).toEqual({ x: 801, y: 501, updatedAt: 12 });
	});

	it("asks the helper to stop and then terminates it, clearing all state", () => {
		const helper = createFakeHelper();
		startWaylandCursorBackend({ spawnHelper: () => helper, log: () => {}, warn: () => {} });
		helper.stdout.emit("data", Buffer.from('{"type":"move","x":1,"y":2,"timestamp":3}\n'));

		stopWaylandCursorBackend();

		expect(helper.stdin.write).toHaveBeenCalledWith("stop\n");
		expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
		expect(waylandCursorHelperProcess).toBeNull();
		expect(latestWaylandCursorPoint).toBeNull();
		expect(waylandOutputs).toEqual([]);
	});

	it("is safe to stop when nothing is running", () => {
		expect(() => stopWaylandCursorBackend()).not.toThrow();
		expect(waylandCursorHelperProcess).toBeNull();
	});

	it("clears state when the helper exits on its own", () => {
		const helper = createFakeHelper();
		const warn = vi.fn();
		startWaylandCursorBackend({ spawnHelper: () => helper, log: () => {}, warn });

		helper.emit("close", 4);

		expect(waylandCursorHelperProcess).toBeNull();
		expect(warn.mock.calls.at(-1)?.[0]).toContain(
			"KWin refused to load the Recordly cursor bridge script",
		);
	});

	it("reports a missing helper binary instead of throwing", () => {
		helperPath.value = null as unknown as string;
		const warn = vi.fn();

		expect(startWaylandCursorBackend({ log: () => {}, warn })).toBe(false);
		expect(warn.mock.calls[0][0]).toContain("recordly-wayland-cursor helper is missing");
		expect(waylandCursorHelperProcess).toBeNull();
	});

	it("survives a spawn failure", () => {
		const warn = vi.fn();

		expect(
			startWaylandCursorBackend({
				spawnHelper: () => {
					throw new Error("ENOENT");
				},
				log: () => {},
				warn,
			}),
		).toBe(false);
		expect(warn.mock.calls[0][0]).toContain("Failed to spawn the Wayland cursor helper");
	});
});
