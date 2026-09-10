import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Wayland capture encoder arguments", () => {
	it("does not buffer and truncate live inputs with FFmpeg shortest mode", () => {
		const source = fs.readFileSync(
			path.resolve(process.cwd(), "electron/native/wayland-capture/src/capture_runner.cpp"),
			"utf8",
		);

		// Structural guard for an independently reproduced live-pipeline failure:
		// a 20 s capture ended at ~11 s with -shortest, but at ~20 s without it.
		// Everything else about the pipeline is covered end to end by
		// tests/generated_capture_test.py, which decodes the real output.
		expect(source).not.toContain('"-shortest"');
	});
});
