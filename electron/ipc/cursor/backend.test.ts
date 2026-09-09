import { describe, expect, it } from "vitest";
import {
	detectLinuxCompositor,
	formatCursorBackendStartupLogs,
	getLinuxSessionType,
	isKdePlasmaSession,
	normalizeBuildVariant,
	resolveCursorBackend,
} from "./backend";

const KDE_WAYLAND_ENV: NodeJS.ProcessEnv = {
	XDG_SESSION_TYPE: "wayland",
	XDG_CURRENT_DESKTOP: "KDE",
	DESKTOP_SESSION: "plasma",
	KDE_FULL_SESSION: "true",
	WAYLAND_DISPLAY: "wayland-0",
};

const KDE_X11_ENV: NodeJS.ProcessEnv = {
	XDG_SESSION_TYPE: "x11",
	XDG_CURRENT_DESKTOP: "KDE",
	DESKTOP_SESSION: "plasma",
	KDE_FULL_SESSION: "true",
	DISPLAY: ":0",
};

describe("getLinuxSessionType", () => {
	it("trusts XDG_SESSION_TYPE first", () => {
		expect(getLinuxSessionType({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
		expect(getLinuxSessionType({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe(
			"x11",
		);
	});

	it("falls back to the display sockets", () => {
		expect(getLinuxSessionType({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
		expect(getLinuxSessionType({ DISPLAY: ":0" })).toBe("x11");
		expect(getLinuxSessionType({})).toBe("unknown");
	});
});

describe("isKdePlasmaSession", () => {
	it("recognises the ways Plasma advertises itself", () => {
		expect(isKdePlasmaSession({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(true);
		expect(isKdePlasmaSession({ XDG_CURRENT_DESKTOP: "KDE:plasma" })).toBe(true);
		expect(isKdePlasmaSession({ KDE_FULL_SESSION: "true" })).toBe(true);
		expect(isKdePlasmaSession({ KDE_SESSION_VERSION: "6" })).toBe(true);
		expect(isKdePlasmaSession({ DESKTOP_SESSION: "plasmawayland" })).toBe(true);
	});

	it("does not claim GNOME or wlroots sessions", () => {
		expect(isKdePlasmaSession({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(false);
		expect(isKdePlasmaSession({ XDG_CURRENT_DESKTOP: "sway" })).toBe(false);
		expect(isKdePlasmaSession({})).toBe(false);
	});
});

describe("detectLinuxCompositor", () => {
	it("reports KDE/KWin on a Plasma session", () => {
		expect(detectLinuxCompositor(KDE_WAYLAND_ENV)).toBe("kde-kwin");
	});

	it("reports a non-KDE Wayland compositor as other", () => {
		expect(
			detectLinuxCompositor({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" }),
		).toBe("other");
	});

	it("reports nothing for a plain X11 session", () => {
		expect(detectLinuxCompositor({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBeNull();
	});
});

describe("resolveCursorBackend", () => {
	it("keeps macOS and Windows on their native monitors", () => {
		expect(resolveCursorBackend({ platform: "darwin", env: {} }).backend).toBe("macos-native");
		expect(resolveCursorBackend({ platform: "win32", env: {} }).backend).toBe("windows-native");
	});

	it("selects the KDE Wayland backend when the helper is bundled", () => {
		const resolution = resolveCursorBackend({
			platform: "linux",
			env: KDE_WAYLAND_ENV,
			isWaylandHelperAvailable: true,
		});

		expect(resolution.backend).toBe("linux-kde-wayland");
		expect(resolution.compositor).toBe("kde-kwin");
		expect(resolution.sessionType).toBe("wayland");
		expect(resolution.fatal).toBeUndefined();
	});

	it("stays on uiohook in the normal build when the helper is missing", () => {
		const resolution = resolveCursorBackend({
			platform: "linux",
			env: KDE_WAYLAND_ENV,
			isWaylandHelperAvailable: false,
		});

		expect(resolution.backend).toBe("linux-x11-uiohook");
		expect(resolution.reason).toContain("does not ship the Wayland cursor helper");
	});

	it("keeps X11 sessions on uiohook", () => {
		expect(
			resolveCursorBackend({
				platform: "linux",
				env: KDE_X11_ENV,
				isWaylandHelperAvailable: true,
			}).backend,
		).toBe("linux-x11-uiohook");
	});

	it("does not claim GNOME or wlroots Wayland sessions in V1", () => {
		for (const desktop of ["GNOME", "sway", "Hyprland"]) {
			const resolution = resolveCursorBackend({
				platform: "linux",
				env: { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: desktop },
				isWaylandHelperAvailable: true,
			});

			expect(resolution.backend).toBe("linux-x11-uiohook");
			expect(resolution.compositor).toBe("other");
		}
	});

	it("uses the KDE backend in the dedicated build even without the helper flag", () => {
		const resolution = resolveCursorBackend({
			platform: "linux",
			env: KDE_WAYLAND_ENV,
			buildVariant: "linux-kde-wayland",
			isWaylandHelperAvailable: false,
		});

		expect(resolution.backend).toBe("linux-kde-wayland");
		expect(resolution.fatal).toBeUndefined();
	});

	it("fails loudly instead of falling back when the Wayland build runs on X11", () => {
		const resolution = resolveCursorBackend({
			platform: "linux",
			env: KDE_X11_ENV,
			buildVariant: "linux-kde-wayland",
		});

		expect(resolution.backend).toBe("linux-kde-wayland");
		expect(resolution.fatal?.code).toBe("x11-session-in-wayland-build");
		expect(resolution.fatal?.message).toContain("native Wayland session");
	});

	it("honours the RECORDLY_CURSOR_BACKEND override in the normal build", () => {
		expect(
			resolveCursorBackend({
				platform: "linux",
				env: { ...KDE_X11_ENV, RECORDLY_CURSOR_BACKEND: "linux-kde-wayland" },
			}).backend,
		).toBe("linux-kde-wayland");

		expect(
			resolveCursorBackend({
				platform: "linux",
				env: { ...KDE_WAYLAND_ENV, RECORDLY_CURSOR_BACKEND: "linux-x11-uiohook" },
				isWaylandHelperAvailable: true,
			}).backend,
		).toBe("linux-x11-uiohook");
	});

	it("ignores an unknown override value", () => {
		expect(
			resolveCursorBackend({
				platform: "linux",
				env: { ...KDE_WAYLAND_ENV, RECORDLY_CURSOR_BACKEND: "nonsense" },
				isWaylandHelperAvailable: true,
			}).backend,
		).toBe("linux-kde-wayland");
	});
});

describe("normalizeBuildVariant", () => {
	it("only accepts the known variant", () => {
		expect(normalizeBuildVariant("linux-kde-wayland")).toBe("linux-kde-wayland");
		expect(normalizeBuildVariant("default")).toBe("default");
		expect(normalizeBuildVariant(undefined)).toBe("default");
		expect(normalizeBuildVariant(42)).toBe("default");
	});
});

describe("formatCursorBackendStartupLogs", () => {
	it("emits the documented startup lines", () => {
		const lines = formatCursorBackendStartupLogs(
			resolveCursorBackend({
				platform: "linux",
				env: KDE_WAYLAND_ENV,
				isWaylandHelperAvailable: true,
			}),
		);

		expect(lines[0]).toBe("[Wayland] compositor: KDE/KWin");
		expect(lines[1]).toBe("[CursorTelemetry] backend: linux-kde-wayland");
	});
});
