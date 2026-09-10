/*
 * Recordly KWin cursor bridge.
 *
 * Loaded into KWin (Plasma/Wayland) by the recordly-wayland-cursor helper via
 * org.kde.kwin.Scripting.loadScript().  KWin is the only component on a native
 * Wayland session that knows the global pointer position, so this script
 * forwards it to the helper over the session bus. KWin also owns placement of
 * the native-Wayland HUD window, which this script anchors at bottom-center.
 *
 * Nothing here polls: `workspace.cursorPosChanged` fires on real pointer
 * motion, and a small leading-edge throttle keeps a 1000 Hz gaming mouse from
 * flooding the bus.  Recordly samples telemetry at 30 Hz, so ~125 Hz is
 * already about 4x oversampled.
 */

var SERVICE = "org.recordly.WaylandCursorBridge";
var OBJECT = "/Cursor";
var IFACE = "org.recordly.WaylandCursorBridge";

// Minimum spacing between bus messages, in milliseconds (~125 Hz).
var THROTTLE_MS = 8;

// KWin owns placement of native-Wayland top-level windows. Keep the bounded
// Electron HUD at the bottom-center of the window's work area; Electron's
// setBounds(x, y) cannot do this on Wayland.
var HUD_CAPTION = "Recordly HUD";
var hudPlacementInProgress = false;

var lastSentMs = 0;
var lastSentX = null;
var lastSentY = null;

function sendCursor(x, y) {
	lastSentMs = new Date().getTime();
	lastSentX = x;
	lastSentY = y;
	// Integral JS numbers marshal to D-Bus "i" through KWin's QJSEngine bridge.
	callDBus(SERVICE, OBJECT, IFACE, "Move", x, y);
}

function onCursorPosChanged() {
	var pos = workspace.cursorPos;
	if (!pos) {
		return;
	}

	var x = Math.round(pos.x);
	var y = Math.round(pos.y);
	if (x === lastSentX && y === lastSentY) {
		return;
	}

	if (new Date().getTime() - lastSentMs < THROTTLE_MS) {
		return;
	}

	sendCursor(x, y);
}

function publishOutputs() {
	var screens = workspace.screens || [];
	var count = screens.length;
	var index = 0;
	var output = null;
	// KWin 6 exposes Output.geometry as a logical-pixel QRect.
	var geometry = null;

	for (index = 0; index < count; index++) {
		output = screens[index];
		geometry = output.geometry;
		if (!geometry) {
			continue;
		}

		// Scale travels as a string so a fractional value (1.5, 1.75, ...)
		// cannot be silently truncated by integer marshalling.
		callDBus(
			SERVICE,
			OBJECT,
			IFACE,
			"Output",
			index,
			count,
			String(output.name || ""),
			Math.round(geometry.x),
			Math.round(geometry.y),
			Math.round(geometry.width),
			Math.round(geometry.height),
			String(output.devicePixelRatio || output.scale || 1),
		);
	}
}

workspace.cursorPosChanged.connect(onCursorPosChanged);

if (workspace.screensChanged) {
	workspace.screensChanged.connect(publishOutputs);
}
if (workspace.virtualScreenGeometryChanged) {
	workspace.virtualScreenGeometryChanged.connect(publishOutputs);
}

function isHudWindow(window) {
	return window && window.caption === HUD_CAPTION;
}

function placeHudWindow(window) {
	if (
		!isHudWindow(window) ||
		window.deleted ||
		window.move ||
		hudPlacementInProgress
	) {
		return;
	}

	var area = workspace.clientArea(KWin.WorkArea, window);
	var frame = window.frameGeometry;
	var target = {
		x: Math.round(area.x + (area.width - frame.width) / 2),
		y: Math.round(area.y + area.height - frame.height),
		width: frame.width,
		height: frame.height
	};

	if (frame.x === target.x && frame.y === target.y) {
		return;
	}

	hudPlacementInProgress = true;
	window.frameGeometry = target;
	hudPlacementInProgress = false;
}

function watchHudWindow(window) {
	if (!isHudWindow(window)) {
		return;
	}

	placeHudWindow(window);
	window.frameGeometryChanged.connect(function () {
		placeHudWindow(window);
	});
}

workspace.windowAdded.connect(watchHudWindow);
if (workspace.stackingOrder) {
	workspace.stackingOrder.forEach(watchHudWindow);
}

publishOutputs();

// Prime the helper with the current position so telemetry has a value before
// the pointer is first moved.
if (workspace.cursorPos) {
	sendCursor(Math.round(workspace.cursorPos.x), Math.round(workspace.cursorPos.y));
}
