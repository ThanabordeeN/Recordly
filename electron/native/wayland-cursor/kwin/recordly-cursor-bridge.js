/*
 * Recordly KWin cursor bridge.
 *
 * Loaded into KWin (Plasma/Wayland) by the recordly-wayland-cursor helper via
 * org.kde.kwin.Scripting.loadScript().  KWin is the only component on a native
 * Wayland session that knows the global pointer position, so this script
 * forwards it to the helper over the session bus.
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

publishOutputs();

// Prime the helper with the current position so telemetry has a value before
// the pointer is first moved.
if (workspace.cursorPos) {
	sendCursor(Math.round(workspace.cursorPos.x), Math.round(workspace.cursorPos.y));
}
