#include "portal.h"

#include <systemd/sd-bus.h>
#include <fcntl.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

namespace {

constexpr const char *kPortalBus = "org.freedesktop.portal.Desktop";
constexpr const char *kPortalPath = "/org/freedesktop/portal/desktop";
constexpr const char *kScreenCast = "org.freedesktop.portal.ScreenCast";
constexpr const char *kRequestIface = "org.freedesktop.portal.Request";
constexpr const char *kSessionIface = "org.freedesktop.portal.Session";

/** Collected from the portal's Request::Response signal. */
struct ResponseState {
	bool received = false;
	unsigned response = 0;
	std::string sessionHandle;
	std::string restoreToken;
	unsigned nodeId = 0;
	unsigned width = 0;
	unsigned height = 0;
	unsigned sourceType = 0;
	bool hasStream = false;
};

void readStreamProperties(sd_bus_message *message, ResponseState *state) {
	// a{sv} of stream properties. "source_type" is the one that matters for
	// safety: it says whether we were handed a monitor, a window, or a virtual
	// source, regardless of what SelectSources asked for.
	if (sd_bus_message_enter_container(message, 'a', "{sv}") < 0) {
		return;
	}

	while (sd_bus_message_enter_container(message, 'e', "sv") > 0) {
		const char *key = nullptr;
		sd_bus_message_read(message, "s", &key);
		if (key && strcmp(key, "size") == 0 &&
		    sd_bus_message_enter_container(message, 'v', "(ii)") >= 0) {
			int width = 0;
			int height = 0;
			if (sd_bus_message_read(message, "(ii)", &width, &height) >= 0 && width > 0 &&
			    height > 0) {
				state->width = static_cast<unsigned>(width);
				state->height = static_cast<unsigned>(height);
			}
			sd_bus_message_exit_container(message);
		} else if (key && strcmp(key, "source_type") == 0 &&
		           sd_bus_message_enter_container(message, 'v', "u") >= 0) {
			unsigned sourceType = 0;
			if (sd_bus_message_read(message, "u", &sourceType) >= 0) {
				state->sourceType = sourceType;
			}
			sd_bus_message_exit_container(message);
		} else {
			sd_bus_message_skip(message, "v");
		}
		sd_bus_message_exit_container(message);
	}

	sd_bus_message_exit_container(message);
}

int onPortalResponse(sd_bus_message *message, void *userdata, sd_bus_error * /*error*/) {
	auto *state = static_cast<ResponseState *>(userdata);

	unsigned response = 0;
	if (sd_bus_message_read(message, "u", &response) < 0) {
		return 0;
	}
	state->response = response;
	state->received = true;

	if (sd_bus_message_enter_container(message, 'a', "{sv}") < 0) {
		return 1;
	}

	while (sd_bus_message_enter_container(message, 'e', "sv") > 0) {
		const char *key = nullptr;
		sd_bus_message_read(message, "s", &key);
		const std::string name = key ? key : "";

		if (name == "session_handle") {
			const char *value = nullptr;
			// Portal implementations disagree on whether this is "o" or "s".
			if (sd_bus_message_enter_container(message, 'v', "o") >= 0) {
				sd_bus_message_read(message, "o", &value);
				sd_bus_message_exit_container(message);
			} else if (sd_bus_message_enter_container(message, 'v', "s") >= 0) {
				sd_bus_message_read(message, "s", &value);
				sd_bus_message_exit_container(message);
			}
			if (value) {
				state->sessionHandle = value;
			}
		} else if (name == "restore_token") {
			const char *value = nullptr;
			if (sd_bus_message_enter_container(message, 'v', "s") >= 0) {
				sd_bus_message_read(message, "s", &value);
				sd_bus_message_exit_container(message);
			}
			if (value) {
				state->restoreToken = value;
			}
		} else if (name == "streams") {
			sd_bus_message_enter_container(message, 'v', "a(ua{sv})");
			sd_bus_message_enter_container(message, 'a', "(ua{sv})");
			while (sd_bus_message_enter_container(message, 'r', "ua{sv}") > 0) {
				unsigned nodeId = 0;
				sd_bus_message_read(message, "u", &nodeId);
				// Only the first stream is used: SelectSources asks for one.
				if (!state->hasStream) {
					state->nodeId = nodeId;
					state->hasStream = true;
					readStreamProperties(message, state);
				} else {
					sd_bus_message_skip(message, "a{sv}");
				}
				sd_bus_message_exit_container(message);
			}
			sd_bus_message_exit_container(message);
			sd_bus_message_exit_container(message);
		} else {
			sd_bus_message_skip(message, "v");
		}

		sd_bus_message_exit_container(message);
	}

	sd_bus_message_exit_container(message);
	return 1;
}

/**
 * The portal replies asynchronously on a Request object whose path is derived
 * from our unique bus name, so the match has to be installed before the call.
 */
std::string requestPathFor(const std::string &senderToken, const char *handleToken) {
	return std::string(kPortalPath) + "/request/" + senderToken + "/" + handleToken;
}

std::string senderTokenFor(sd_bus *bus) {
	const char *unique = nullptr;
	if (sd_bus_get_unique_name(bus, &unique) < 0 || !unique || !*unique) {
		return "";
	}

	std::string token = unique[0] == ':' ? unique + 1 : unique;
	for (char &c : token) {
		if (c == '.') {
			c = '_';
		}
	}
	return token;
}

/** Pumps the bus until the matching Response signal lands, or we give up. */
bool waitForResponse(sd_bus *bus, ResponseState *state, int timeoutSeconds) {
	// The Start dialog waits on a human, so the caller passes a long timeout.
	const int pollIntervalMs = 100;
	const int iterations = (timeoutSeconds * 1000) / pollIntervalMs;

	for (int i = 0; i < iterations && !state->received; i++) {
		const int processed = sd_bus_process(bus, nullptr);
		if (processed < 0) {
			return false;
		}
		if (processed > 0) {
			continue;
		}
		sd_bus_wait(bus, static_cast<uint64_t>(pollIntervalMs) * 1000);
	}

	return state->received;
}

}  // namespace

bool portalOpenScreenCast(PortalCursorMode cursorMode, PortalSourceType sourceType,
                          const std::string &restoreToken, PortalSession *out,
                          PortalError *error) {
	auto fail = [&](const std::string &message, unsigned response, bool mismatch = false) {
		if (error) {
			error->message = message;
			error->response = response;
			error->restoreTokenMismatch = mismatch;
		}
		return false;
	};

	sd_bus *bus = nullptr;
	if (sd_bus_open_user(&bus) < 0) {
		return fail("cannot connect to the session bus", 0);
	}

	const std::string sender = senderTokenFor(bus);
	if (sender.empty()) {
		sd_bus_flush_close_unref(bus);
		return fail("cannot resolve our own bus name", 0);
	}

	sd_bus_error busError = SD_BUS_ERROR_NULL;
	sd_bus_message *reply = nullptr;
	sd_bus_message *call = nullptr;

	auto cleanup = [&]() {
		sd_bus_error_free(&busError);
		if (call) {
			sd_bus_message_unref(call);
			call = nullptr;
		}
		if (reply) {
			sd_bus_message_unref(reply);
			reply = nullptr;
		}
	};

	// ── CreateSession ────────────────────────────────────────────────────────
	ResponseState createState;
	std::string path = requestPathFor(sender, "recordly0");
	sd_bus_match_signal(bus, nullptr, kPortalBus, path.c_str(), kRequestIface, "Response",
	                    onPortalResponse, &createState);

	sd_bus_message_new_method_call(bus, &call, kPortalBus, kPortalPath, kScreenCast,
	                               "CreateSession");
	sd_bus_message_open_container(call, 'a', "{sv}");
	sd_bus_message_append(call, "{sv}", "handle_token", "s", "recordly0");
	sd_bus_message_append(call, "{sv}", "session_handle_token", "s", "recordlysession0");
	sd_bus_message_close_container(call);
	if (sd_bus_call(bus, call, 0, &busError, &reply) < 0) {
		const std::string message = busError.message ? busError.message : "CreateSession failed";
		cleanup();
		sd_bus_flush_close_unref(bus);
		return fail(message, 0);
	}
	cleanup();

	if (!waitForResponse(bus, &createState, 30) || createState.response != 0 ||
	    createState.sessionHandle.empty()) {
		sd_bus_flush_close_unref(bus);
		return fail("portal refused to create a screencast session", createState.response);
	}

	// ── SelectSources ────────────────────────────────────────────────────────
	ResponseState selectState;
	path = requestPathFor(sender, "recordly1");
	sd_bus_match_signal(bus, nullptr, kPortalBus, path.c_str(), kRequestIface, "Response",
	                    onPortalResponse, &selectState);

	sd_bus_message_new_method_call(bus, &call, kPortalBus, kPortalPath, kScreenCast,
	                               "SelectSources");
	sd_bus_message_append(call, "o", createState.sessionHandle.c_str());
	sd_bus_message_open_container(call, 'a', "{sv}");
	sd_bus_message_append(call, "{sv}", "handle_token", "s", "recordly1");
	sd_bus_message_append(call, "{sv}", "types", "u", static_cast<unsigned>(sourceType));
	sd_bus_message_append(call, "{sv}", "multiple", "b", 0);
	sd_bus_message_append(call, "{sv}", "cursor_mode", "u", static_cast<unsigned>(cursorMode));
	// persist_mode 2 asks the portal for a token so a later recording can skip
	// the picker entirely.
	sd_bus_message_append(call, "{sv}", "persist_mode", "u", 2u);
	if (!restoreToken.empty()) {
		sd_bus_message_append(call, "{sv}", "restore_token", "s", restoreToken.c_str());
	}
	sd_bus_message_close_container(call);
	if (sd_bus_call(bus, call, 0, &busError, &reply) < 0) {
		const std::string message = busError.message ? busError.message : "SelectSources failed";
		cleanup();
		sd_bus_flush_close_unref(bus);
		return fail(message, 0);
	}
	cleanup();

	if (!waitForResponse(bus, &selectState, 30) || selectState.response != 0) {
		sd_bus_flush_close_unref(bus);
		return fail("portal rejected the requested capture sources", selectState.response);
	}

	// ── Start (shows the picker unless a restore token was accepted) ─────────
	ResponseState startState;
	path = requestPathFor(sender, "recordly2");
	sd_bus_match_signal(bus, nullptr, kPortalBus, path.c_str(), kRequestIface, "Response",
	                    onPortalResponse, &startState);

	sd_bus_message_new_method_call(bus, &call, kPortalBus, kPortalPath, kScreenCast, "Start");
	sd_bus_message_append(call, "o", createState.sessionHandle.c_str());
	sd_bus_message_append(call, "s", "");
	sd_bus_message_open_container(call, 'a', "{sv}");
	sd_bus_message_append(call, "{sv}", "handle_token", "s", "recordly2");
	sd_bus_message_close_container(call);
	if (sd_bus_call(bus, call, 0, &busError, &reply) < 0) {
		const std::string message = busError.message ? busError.message : "Start failed";
		cleanup();
		sd_bus_flush_close_unref(bus);
		return fail(message, 0);
	}
	cleanup();

	// Five minutes: the user has to pick a screen in the portal dialog.
	if (!waitForResponse(bus, &startState, 300)) {
		sd_bus_flush_close_unref(bus);
		return fail("timed out waiting for the screen picker", 0);
	}
	if (startState.response != 0) {
		sd_bus_flush_close_unref(bus);
		return fail(startState.response == 1 ? "screen sharing was cancelled"
		                                     : "the portal ended the session",
		            startState.response);
	}
	if (!startState.hasStream) {
		sd_bus_flush_close_unref(bus);
		return fail("the portal returned no capture stream", startState.response);
	}

	// A restore token replays whatever the earlier session picked, so it can
	// hand back a window when a monitor was requested. Recording that would
	// capture something the user never chose for this recording; refuse it and
	// let the caller ask again without the token.
	if (startState.sourceType != 0 &&
	    startState.sourceType != static_cast<unsigned>(sourceType)) {
		const char *got = startState.sourceType == 2   ? "a window"
		                  : startState.sourceType == 4 ? "a virtual source"
		                                               : "an unexpected source";
		// Close the session so the compositor stops streaming immediately.
		sd_bus_call_method(bus, kPortalBus, createState.sessionHandle.c_str(), kSessionIface,
		                   "Close", nullptr, nullptr, nullptr);
		sd_bus_flush_close_unref(bus);
		return fail(std::string("the portal returned ") + got + " instead of the requested source",
		            startState.response, !restoreToken.empty());
	}

	// ── OpenPipeWireRemote ───────────────────────────────────────────────────
	sd_bus_message_new_method_call(bus, &call, kPortalBus, kPortalPath, kScreenCast,
	                               "OpenPipeWireRemote");
	sd_bus_message_append(call, "o", createState.sessionHandle.c_str());
	sd_bus_message_open_container(call, 'a', "{sv}");
	sd_bus_message_close_container(call);
	if (sd_bus_call(bus, call, 0, &busError, &reply) < 0) {
		const std::string message =
			busError.message ? busError.message : "OpenPipeWireRemote failed";
		cleanup();
		sd_bus_flush_close_unref(bus);
		return fail(message, 0);
	}

	int pipewireFd = -1;
	if (sd_bus_message_read(reply, "h", &pipewireFd) < 0 || pipewireFd < 0) {
		cleanup();
		sd_bus_flush_close_unref(bus);
		return fail("the portal returned no PipeWire descriptor", 0);
	}
	// sd-bus owns the descriptor for as long as the message lives, so take our
	// own copy before the reply is released.
	// F_DUPFD_CLOEXEC so the descriptor cannot leak into unrelated children.
	pipewireFd = fcntl(pipewireFd, F_DUPFD_CLOEXEC, 0);
	cleanup();

	out->sessionHandle = createState.sessionHandle;
	out->nodeId = startState.nodeId;
	out->sourceType = startState.sourceType;
	out->pipewireFd = pipewireFd;
	out->width = startState.width;
	out->height = startState.height;
	out->restoreToken = startState.restoreToken;
	out->valid = true;

	// The session outlives this bus connection: the portal keeps it open until
	// Session.Close, and the PipeWire node stays valid meanwhile.
	sd_bus_flush_close_unref(bus);
	return true;
}

void portalCloseScreenCast(PortalSession *session) {
	if (!session || !session->valid) {
		return;
	}

	sd_bus *bus = nullptr;
	if (sd_bus_open_user(&bus) >= 0) {
		sd_bus_call_method(bus, kPortalBus, session->sessionHandle.c_str(), kSessionIface, "Close",
		                   nullptr, nullptr, nullptr);
		sd_bus_flush_close_unref(bus);
	}

	if (session->pipewireFd >= 0) {
		close(session->pipewireFd);
		session->pipewireFd = -1;
	}
	session->valid = false;
}
