import { describe, expect, it } from "vitest";
import { readBuildVariant, resolveStartupCursorBackend } from "./cursorBackendStartup";

const WAYLAND_MANIFEST = JSON.stringify({ recordlyBuildVariant: "linux-kde-wayland" });
const DEFAULT_MANIFEST = JSON.stringify({ name: "recordly" });

describe("readBuildVariant", () => {
	it("returns the normal build when the app is not packaged", () => {
		expect(readBuildVariant({ resourcesPath: undefined, env: {} })).toBe("default");
	});

	it("reads the variant stamped into the packaged marker file", () => {
		expect(
			readBuildVariant({
				resourcesPath: "/app/resources",
				env: {},
				readFile: () => WAYLAND_MANIFEST,
			}),
		).toBe("linux-kde-wayland");
	});

	it("defaults to the normal build for a plain manifest", () => {
		expect(
			readBuildVariant({
				resourcesPath: "/app/resources",
				env: {},
				readFile: () => DEFAULT_MANIFEST,
			}),
		).toBe("default");
	});

	it("defaults to the normal build when the marker cannot be read", () => {
		expect(
			readBuildVariant({
				resourcesPath: "/app/resources",
				env: {},
				readFile: () => {
					throw new Error("ENOENT");
				},
			}),
		).toBe("default");
	});

	it("lets RECORDLY_BUILD_VARIANT force the Wayland path in a source checkout", () => {
		expect(
			readBuildVariant({
				resourcesPath: "/app/resources",
				env: { RECORDLY_BUILD_VARIANT: "linux-kde-wayland" },
				readFile: () => DEFAULT_MANIFEST,
			}),
		).toBe("linux-kde-wayland");
	});
});

describe("resolveStartupCursorBackend", () => {
	it("selects the KDE Wayland backend for the dedicated artifact", () => {
		const resolution = resolveStartupCursorBackend({
			resourcesPath: "/app/resources",
			platform: "linux",
			env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" },
			isWaylandHelperAvailable: true,
			readFile: () => WAYLAND_MANIFEST,
		});

		expect(resolution.backend).toBe("linux-kde-wayland");
		expect(resolution.fatal).toBeUndefined();
	});

	it("returns a fatal result when the Wayland artifact is launched on X11", () => {
		const resolution = resolveStartupCursorBackend({
			resourcesPath: "/app/resources",
			platform: "linux",
			env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "KDE" },
			isWaylandHelperAvailable: true,
			readFile: () => WAYLAND_MANIFEST,
		});

		expect(resolution.fatal?.code).toBe("x11-session-in-wayland-build");
	});

	it("leaves the normal Linux artifact on uiohook", () => {
		const resolution = resolveStartupCursorBackend({
			resourcesPath: "/app/resources",
			platform: "linux",
			env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
			isWaylandHelperAvailable: true,
			readFile: () => DEFAULT_MANIFEST,
		});

		expect(resolution.backend).toBe("linux-x11-uiohook");
		expect(resolution.fatal).toBeUndefined();
	});
});
