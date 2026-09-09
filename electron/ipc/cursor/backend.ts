import { isLikelyLinuxWaylandSession } from "../register/sourceMapping";

/**
 * Which implementation supplies global cursor position and mouse-button
 * telemetry for the current session.
 *
 * `linux-kde-wayland` is the dedicated KDE Plasma / KWin native-Wayland path:
 * cursor position comes from KWin over the session bus and button events come
 * from evdev.  It never touches uiohook or `screen.getCursorScreenPoint()`,
 * both of which report stale coordinates under KWin.
 */
export type CursorBackend =
	| "macos-native"
	| "windows-native"
	| "linux-x11-uiohook"
	| "linux-kde-wayland";

/**
 * Which artifact is running.  The dedicated Wayland AppImage stamps
 * `recordlyBuildVariant` into its packaged package.json; the normal
 * cross-platform builds carry nothing and stay on their existing behavior.
 */
export type RecordlyBuildVariant = "default" | "linux-kde-wayland";

export type LinuxSessionType = "wayland" | "x11" | "unknown";

export type LinuxCompositor = "kde-kwin" | "other" | null;

export type CursorBackendResolution = {
	backend: CursorBackend;
	sessionType: LinuxSessionType;
	compositor: LinuxCompositor;
	/** Human-readable explanation, logged at startup. */
	reason: string;
	/**
	 * Set when the dedicated Wayland build cannot run at all. The caller shows
	 * this to the user and exits instead of quietly degrading to uiohook.
	 */
	fatal?: {
		code: "x11-session-in-wayland-build" | "non-linux-wayland-build";
		message: string;
	};
};

export function normalizeBuildVariant(value: unknown): RecordlyBuildVariant {
	return value === "linux-kde-wayland" ? "linux-kde-wayland" : "default";
}

export function getLinuxSessionType(env: NodeJS.ProcessEnv): LinuxSessionType {
	const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase();
	if (sessionType === "wayland") {
		return "wayland";
	}
	if (sessionType === "x11") {
		return "x11";
	}
	if (env.WAYLAND_DISPLAY) {
		return "wayland";
	}
	if (env.DISPLAY) {
		return "x11";
	}

	return "unknown";
}

/**
 * KDE sets several of these; Plasma 6 on Fedora exports XDG_CURRENT_DESKTOP
 * and KDE_FULL_SESSION, while some launchers only set DESKTOP_SESSION.
 */
export function isKdePlasmaSession(env: NodeJS.ProcessEnv): boolean {
	const currentDesktops = (env.XDG_CURRENT_DESKTOP ?? "")
		.split(":")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
	if (currentDesktops.includes("kde") || currentDesktops.includes("plasma")) {
		return true;
	}

	if (env.KDE_FULL_SESSION?.trim().toLowerCase() === "true") {
		return true;
	}

	if (env.KDE_SESSION_VERSION?.trim()) {
		return true;
	}

	const desktopSession = env.DESKTOP_SESSION?.trim().toLowerCase() ?? "";
	return desktopSession.includes("plasma") || desktopSession.includes("kde");
}

export function detectLinuxCompositor(env: NodeJS.ProcessEnv): LinuxCompositor {
	if (isKdePlasmaSession(env)) {
		return "kde-kwin";
	}

	return getLinuxSessionType(env) === "wayland" ? "other" : null;
}

function normalizeBackendOverride(value: string | undefined): CursorBackend | null {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "linux-kde-wayland" ||
		normalized === "linux-x11-uiohook" ||
		normalized === "macos-native" ||
		normalized === "windows-native"
	) {
		return normalized;
	}

	return null;
}

/**
 * Decide which cursor telemetry backend to use.
 *
 * The dedicated Wayland build never falls back to uiohook: if it is launched
 * under X11 the caller is expected to surface `fatal` and quit. The normal
 * cross-platform build opts into the KDE backend only when the session really
 * is KDE Wayland *and* the helper shipped with the artifact, so existing Linux
 * X11 users keep the uiohook path they have today.
 */
export function resolveCursorBackend({
	platform,
	env,
	buildVariant = "default",
	isWaylandHelperAvailable = false,
}: {
	platform: NodeJS.Platform | string;
	env: NodeJS.ProcessEnv;
	buildVariant?: RecordlyBuildVariant;
	isWaylandHelperAvailable?: boolean;
}): CursorBackendResolution {
	if (platform === "darwin") {
		return {
			backend: "macos-native",
			sessionType: "unknown",
			compositor: null,
			reason: "macOS uses the native cursor monitor.",
		};
	}

	if (platform === "win32") {
		return {
			backend: "windows-native",
			sessionType: "unknown",
			compositor: null,
			reason: "Windows uses the native cursor monitor.",
		};
	}

	if (platform !== "linux") {
		return {
			backend: "linux-x11-uiohook",
			sessionType: "unknown",
			compositor: null,
			reason: `Unsupported platform "${String(platform)}"; using the portable hook.`,
		};
	}

	const sessionType = getLinuxSessionType(env);
	const compositor = detectLinuxCompositor(env);
	const isWayland = sessionType === "wayland" || isLikelyLinuxWaylandSession(env);

	if (buildVariant === "linux-kde-wayland") {
		if (!isWayland) {
			return {
				backend: "linux-kde-wayland",
				sessionType,
				compositor,
				reason: "Dedicated KDE Wayland build launched outside a Wayland session.",
				fatal: {
					code: "x11-session-in-wayland-build",
					message:
						"This is the Recordly KDE Wayland build and it requires a native Wayland session. " +
						`The current session reports XDG_SESSION_TYPE="${env.XDG_SESSION_TYPE ?? ""}". ` +
						"Log into the Plasma (Wayland) session, or install the standard Recordly Linux build for X11.",
				},
			};
		}

		return {
			backend: "linux-kde-wayland",
			sessionType,
			compositor,
			reason:
				compositor === "kde-kwin"
					? "Dedicated KDE Wayland build on a KDE/KWin session."
					: "Dedicated KDE Wayland build; compositor did not identify as KDE but Wayland was detected.",
		};
	}

	const override = normalizeBackendOverride(env.RECORDLY_CURSOR_BACKEND);
	if (override) {
		return {
			backend: override,
			sessionType,
			compositor,
			reason: `RECORDLY_CURSOR_BACKEND override set to "${override}".`,
		};
	}

	if (isWayland && compositor === "kde-kwin" && isWaylandHelperAvailable) {
		return {
			backend: "linux-kde-wayland",
			sessionType,
			compositor,
			reason: "KDE/KWin Wayland session detected and the cursor helper is bundled.",
		};
	}

	if (isWayland && compositor === "kde-kwin") {
		return {
			backend: "linux-x11-uiohook",
			sessionType,
			compositor,
			reason:
				"KDE/KWin Wayland session detected but this build does not ship the Wayland cursor helper. " +
				"Cursor telemetry will be degraded; install the Recordly KDE Wayland build for accurate Auto Zoom.",
		};
	}

	return {
		backend: "linux-x11-uiohook",
		sessionType,
		compositor,
		reason: isWayland
			? "Wayland session without KDE/KWin; the dedicated backend targets KDE only in V1."
			: "X11 session.",
	};
}

export function formatCursorBackendStartupLogs(resolution: CursorBackendResolution): string[] {
	const lines: string[] = [];

	if (resolution.compositor) {
		lines.push(
			`[Wayland] compositor: ${resolution.compositor === "kde-kwin" ? "KDE/KWin" : "unknown"}`,
		);
	}

	lines.push(`[CursorTelemetry] backend: ${resolution.backend}`);
	lines.push(`[CursorTelemetry] ${resolution.reason}`);

	return lines;
}
