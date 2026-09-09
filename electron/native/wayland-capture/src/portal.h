// xdg-desktop-portal ScreenCast negotiation.
//
// Recordly's existing Wayland capture goes through Chromium's getDisplayMedia,
// which always asks the portal for an *embedded* cursor and exposes no way to
// change that: `cursor` is absent from getSupportedConstraints(), Electron's
// display-media callback takes only video/audio/enableLocalEcho, and Chromium
// ships no switch for it. The portal itself is perfectly capable -- KDE reports
// AvailableCursorModes = 7 (hidden | embedded | metadata) -- so the only way to
// record without the system cursor baked into the frames is to negotiate the
// session ourselves.

#pragma once

#include <string>

/** Portal source types, as advertised by AvailableSourceTypes. */
enum class PortalSourceType : unsigned {
	Monitor = 1,
	Window = 2,
	Virtual = 4,
};

enum class PortalCursorMode {
	Hidden = 1,
	Embedded = 2,
	Metadata = 4,
};

struct PortalSession {
	std::string sessionHandle;
	unsigned nodeId = 0;
	/** What the portal actually handed us, which is not always what we asked for. */
	unsigned sourceType = 0;
	int pipewireFd = -1;
	unsigned width = 0;
	unsigned height = 0;
	std::string restoreToken;
	bool valid = false;
};

struct PortalError {
	std::string message;
	/** Portal response code: 0 ok, 1 user cancelled, 2 ended some other way. */
	unsigned response = 0;
	/** Set when a restore token produced a source we did not ask for. */
	bool restoreTokenMismatch = false;
};

/**
 * Runs CreateSession -> SelectSources -> Start -> OpenPipeWireRemote.
 *
 * `Start` shows the compositor's screen picker, so this blocks until the user
 * chooses (or cancels). A `restoreToken` from an earlier session lets the
 * portal skip that dialog.
 *
 * The returned stream is checked against `sourceType`: a restore token records
 * whatever the previous session selected, so a stale one can silently hand back
 * a *window* -- someone's camera preview, say -- when a monitor was requested.
 * That mismatch is reported as an error rather than recorded.
 */
bool portalOpenScreenCast(PortalCursorMode cursorMode, PortalSourceType sourceType,
                          const std::string &restoreToken, PortalSession *out,
                          PortalError *error);

/** Closes the session so the compositor stops streaming. */
void portalCloseScreenCast(PortalSession *session);
