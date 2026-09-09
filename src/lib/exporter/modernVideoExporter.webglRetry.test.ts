import { describe, expect, it, vi } from "vitest";
import { ModernVideoExporter } from "./modernVideoExporter";

type RetryProbe = {
	shouldRetryWithWebglRenderer: (error: unknown) => boolean;
	renderBackend: "webgpu" | "webgl" | null;
	encoderError: unknown;
	cancelled: boolean;
};

function createExporter(overrides: Record<string, unknown> = {}): RetryProbe {
	vi.stubGlobal("window", {
		electronAPI: {
			nativeStaticLayoutExport: vi.fn(),
			nativeStaticLayoutExportCancel: vi.fn(),
		},
	});

	return new ModernVideoExporter({
		videoUrl: "file:///recording.mp4",
		width: 1920,
		height: 1080,
		frameRate: 30,
		bitrate: 8_000_000,
		wallpaper: "#101010",
		padding: 0,
		borderRadius: 0,
		backgroundBlur: 0,
		shadowIntensity: 0,
		showShadow: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		...overrides,
	} as never) as unknown as RetryProbe;
}

describe("shouldRetryWithWebglRenderer", () => {
	it("retries once when a WebGPU render fails mid-export", () => {
		// The real-world case: Pixi initialises fine on WebGPU, then throws
		// "Cannot read properties of undefined (reading '_resourceType')"
		// while building a bind group.
		const exporter = createExporter();
		exporter.renderBackend = "webgpu";

		expect(
			exporter.shouldRetryWithWebglRenderer(
				new TypeError("Cannot read properties of undefined (reading '_resourceType')"),
			),
		).toBe(true);
	});

	it("does not retry when WebGL was already the renderer", () => {
		const exporter = createExporter();
		exporter.renderBackend = "webgl";

		expect(exporter.shouldRetryWithWebglRenderer(new Error("boom"))).toBe(false);
	});

	it("does not retry before a renderer has been chosen", () => {
		const exporter = createExporter();
		exporter.renderBackend = null;

		expect(exporter.shouldRetryWithWebglRenderer(new Error("boom"))).toBe(false);
	});

	it("respects an explicitly pinned render backend", () => {
		const exporter = createExporter({ preferredRenderBackend: "webgpu" });
		exporter.renderBackend = "webgpu";

		expect(exporter.shouldRetryWithWebglRenderer(new Error("boom"))).toBe(false);
	});

	it("does not retry an encoder failure, which fails the same way on either renderer", () => {
		const exporter = createExporter();
		exporter.renderBackend = "webgpu";
		exporter.encoderError = new Error("H.264 Annex B encoding is not supported at 2160x1350.");

		expect(exporter.shouldRetryWithWebglRenderer(new Error("boom"))).toBe(false);
	});

	it("does not retry a cancelled export", () => {
		const exporter = createExporter();
		exporter.renderBackend = "webgpu";
		exporter.cancelled = true;

		expect(exporter.shouldRetryWithWebglRenderer(new Error("boom"))).toBe(false);
	});
});
