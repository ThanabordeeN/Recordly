import { describe, expect, it } from "vitest";
import { decideWaylandCapture, type WaylandCaptureDecisionInput } from "./waylandCapturePolicy";

const base: WaylandCaptureDecisionInput = {
	cursorBackend: "linux-kde-wayland",
	enabled: true,
	isHelperAvailable: true,
	capturesSystemAudio: false,
	capturesMicrophone: false,
	sourceId: "screen:linux-portal",
};

describe("decideWaylandCapture", () => {
	it("records a silent monitor capture through the helper", () => {
		expect(decideWaylandCapture(base)).toEqual({ use: true });
	});

	it("stays on the browser path on any other session", () => {
		for (const backend of ["linux-x11-uiohook", "macos-native", "windows-native"]) {
			const decision = decideWaylandCapture({ ...base, cursorBackend: backend });
			expect(decision).toMatchObject({ use: false, reason: "not-kde-wayland" });
		}
	});

	it("is off unless the user opts in", () => {
		expect(decideWaylandCapture({ ...base, enabled: false })).toMatchObject({
			use: false,
			reason: "disabled",
		});
	});

	it("explains a missing helper rather than failing the recording", () => {
		const decision = decideWaylandCapture({ ...base, isHelperAvailable: false });
		expect(decision).toMatchObject({ use: false, reason: "helper-missing" });
		expect((decision as { message: string }).message).toContain("browser path");
	});

	it("records audio itself, so audio alone does not force a fallback", () => {
		expect(decideWaylandCapture({ ...base, capturesSystemAudio: true })).toEqual({ use: true });
		expect(decideWaylandCapture({ ...base, capturesMicrophone: true })).toEqual({ use: true });
	});

	it("defers when a specific microphone was chosen", () => {
		// PulseAudio source names do not map to the browser device ids Recordly
		// selects with, so recording the default mic instead would be silently
		// capturing the wrong input.
		expect(
			decideWaylandCapture({
				...base,
				capturesMicrophone: true,
				usesNonDefaultMicrophone: true,
			}),
		).toMatchObject({ use: false, reason: "specific-microphone" });
	});

	it("refuses a window source", () => {
		expect(decideWaylandCapture({ ...base, sourceId: "window:42" })).toMatchObject({
			use: false,
			reason: "window-source",
		});
	});

	it("accepts a screen source id that is not the portal sentinel", () => {
		expect(decideWaylandCapture({ ...base, sourceId: "screen:0:0" })).toEqual({ use: true });
		expect(decideWaylandCapture({ ...base, sourceId: null })).toEqual({ use: true });
	});
});
