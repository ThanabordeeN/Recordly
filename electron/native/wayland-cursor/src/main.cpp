// Recordly Wayland cursor/input helper (KDE Plasma / KWin, native Wayland).
//
// On a native Wayland session no client can read the global pointer position,
// and Electron's screen.getCursorScreenPoint() only updates while the pointer
// is over one of our own surfaces.  KWin is the compositor, so it is the only
// authoritative source.  This helper:
//
//   1. owns the session-bus name org.recordly.WaylandCursorBridge,
//   2. asks KWin to load the bundled bridge script, which pushes every real
//      pointer motion (and the output layout) back over that bus,
//   3. reads mouse *button* events straight from evdev, because KWin scripting
//      exposes no button signal,
//   4. merges both streams and writes JSON lines to stdout.
//
// It is a single long-running process.  Nothing polls a command line, nothing
// requires root, and the KWin script is unloaded again on shutdown.
//
// Protocol (stdout, one JSON object per line):
//   {"type":"move","x":1240,"y":612,"timestamp":1788939516893}
//   {"type":"button","button":1,"pressed":true,"x":1240,"y":612,"timestamp":...}
//   {"type":"output","index":0,"count":1,"name":"eDP-1","x":0,"y":0,
//    "width":1646,"height":1029,"scale":1.75}
//   {"type":"status","state":"ready","pointerDevices":2,"deniedDevices":0}
//   {"type":"status","state":"button-capture-unavailable","reason":"permission-denied",...}
//   {"type":"error","message":"..."}

#include <dirent.h>
#include <fcntl.h>
#include <linux/input.h>
#include <poll.h>
#include <sys/inotify.h>
#include <signal.h>
#include <systemd/sd-bus.h>

#include "libinput_buttons.h"
#include <time.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr const char *kBusName = "org.recordly.WaylandCursorBridge";
constexpr const char *kObjectPath = "/Cursor";
constexpr const char *kInterface = "org.recordly.WaylandCursorBridge";
constexpr const char *kKWinPluginId = "recordly-cursor-bridge";

volatile sig_atomic_t g_stopRequested = 0;

struct CursorPoint {
	int x = 0;
	int y = 0;
	bool valid = false;
};

CursorPoint g_cursor;

void handleSignal(int) { g_stopRequested = 1; }

long long nowMs() {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL;
}

long long monotonicMs() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL;
}

/** Added to a CLOCK_MONOTONIC stamp to express it on the wall clock. */
long long monotonicToRealtimeOffsetMs() {
	static const long long offset = nowMs() - monotonicMs();
	return offset;
}

void emitLine(const std::string &line) {
	fputs(line.c_str(), stdout);
	fputc('\n', stdout);
	fflush(stdout);
}

std::string jsonEscape(const std::string &value) {
	std::string out;
	out.reserve(value.size() + 8);
	for (char c : value) {
		switch (c) {
			case '"': out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n"; break;
			case '\r': out += "\\r"; break;
			case '\t': out += "\\t"; break;
			default:
				if (static_cast<unsigned char>(c) < 0x20) {
					char buf[8];
					snprintf(buf, sizeof(buf), "\\u%04x", c);
					out += buf;
				} else {
					out += c;
				}
		}
	}
	return out;
}

void emitError(const std::string &message) {
	char buf[1024];
	snprintf(buf, sizeof(buf), "{\"type\":\"error\",\"message\":\"%s\",\"timestamp\":%lld}",
	         jsonEscape(message).c_str(), nowMs());
	emitLine(buf);
}

// ── evdev pointer button capture ─────────────────────────────────────────────

bool testBit(const unsigned long *bitmask, int bit) {
	constexpr int bitsPerLong = 8 * sizeof(unsigned long);
	return (bitmask[bit / bitsPerLong] >> (bit % bitsPerLong)) & 1UL;
}

constexpr int kBitmaskLongs(int max) { return (max + (8 * sizeof(unsigned long)) - 1) / (8 * sizeof(unsigned long)); }

// A device qualifies only when it carries pointer axes *and* the three mouse
// buttons we forward.  Anything that also reports alphabetic keys is skipped so
// this helper never has a keyboard file descriptor open at all.
bool isPointerButtonDevice(int fd, std::string *nameOut) {
	unsigned long evBits[kBitmaskLongs(EV_MAX + 1)] = {0};
	if (ioctl(fd, EVIOCGBIT(0, sizeof(evBits)), evBits) < 0) {
		return false;
	}
	if (!testBit(evBits, EV_KEY)) {
		return false;
	}

	unsigned long keyBits[kBitmaskLongs(KEY_MAX + 1)] = {0};
	if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keyBits)), keyBits) < 0) {
		return false;
	}
	if (!testBit(keyBits, BTN_LEFT)) {
		return false;
	}

	// Reject anything that looks like a keyboard (a real mouse has no letters).
	for (int key = KEY_Q; key <= KEY_P; key++) {
		if (testBit(keyBits, key)) {
			return false;
		}
	}

	bool hasRelativeAxes = false;
	if (testBit(evBits, EV_REL)) {
		unsigned long relBits[kBitmaskLongs(REL_MAX + 1)] = {0};
		if (ioctl(fd, EVIOCGBIT(EV_REL, sizeof(relBits)), relBits) >= 0) {
			hasRelativeAxes = testBit(relBits, REL_X) && testBit(relBits, REL_Y);
		}
	}

	bool hasAbsoluteAxes = false;
	if (!hasRelativeAxes && testBit(evBits, EV_ABS)) {
		unsigned long absBits[kBitmaskLongs(ABS_MAX + 1)] = {0};
		if (ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(absBits)), absBits) >= 0) {
			hasAbsoluteAxes = testBit(absBits, ABS_X) && testBit(absBits, ABS_Y);
		}
	}

	if (!hasRelativeAxes && !hasAbsoluteAxes) {
		return false;
	}

	char name[256] = {0};
	if (ioctl(fd, EVIOCGNAME(sizeof(name) - 1), name) >= 0 && nameOut) {
		*nameOut = name;
	}
	return true;
}

// KDE stores per-device touchpad settings in kcminputrc under a section keyed
// by vendor, product, and device name.  Honouring it keeps the helper's idea of
// a "click" identical to the compositor's: if the user turned tap-to-click off,
// a tap must not become a click here either.
struct KdeTouchpadConfig {
	bool tapToClick = true;   // KDE enables tapping by default on touchpads.
	bool lmrTapButtonMap = false;
	int clickMethod = -1;     // -1: leave libinput's own default alone.
};

std::string kcminputrcPath() {
	if (const char *configHome = getenv("XDG_CONFIG_HOME"); configHome && *configHome) {
		return std::string(configHome) + "/kcminputrc";
	}
	const char *home = getenv("HOME");
	return home ? std::string(home) + "/.config/kcminputrc" : std::string();
}

std::string trimmed(const std::string &value) {
	const size_t first = value.find_first_not_of(" \t\r\n");
	if (first == std::string::npos) {
		return "";
	}
	const size_t last = value.find_last_not_of(" \t\r\n");
	return value.substr(first, last - first + 1);
}

KdeTouchpadConfig readKdeTouchpadConfig(uint32_t vendor, uint32_t product, const char *name) {
	KdeTouchpadConfig config;

	const std::string path = kcminputrcPath();
	if (path.empty()) {
		return config;
	}

	FILE *file = fopen(path.c_str(), "r");
	if (!file) {
		return config;
	}

	char header[512];
	snprintf(header, sizeof(header), "[Libinput][%u][%u][%s]", vendor, product,
	         name ? name : "");

	char line[1024];
	bool inSection = false;
	while (fgets(line, sizeof(line), file)) {
		const std::string entry = trimmed(line);
		if (entry.empty()) {
			continue;
		}

		if (entry.front() == '[') {
			if (inSection) {
				break;  // next section: we are done
			}
			inSection = entry == header;
			continue;
		}

		if (!inSection) {
			continue;
		}

		const size_t separator = entry.find('=');
		if (separator == std::string::npos) {
			continue;
		}
		const std::string key = trimmed(entry.substr(0, separator));
		const std::string value = trimmed(entry.substr(separator + 1));

		if (key == "TapToClick") {
			config.tapToClick = value == "true" || value == "1";
		} else if (key == "LmrTapButtonMap") {
			config.lmrTapButtonMap = value == "true" || value == "1";
		} else if (key == "ClickMethod") {
			config.clickMethod = atoi(value.c_str());
		}
	}

	fclose(file);
	return config;
}

// ── Pointer button capture (libinput) ────────────────────────────────────────

LibinputApi g_libinput;

struct ButtonCapture {
	struct libinput *context = nullptr;
	int fd = -1;
	std::vector<std::string> devicePaths;
	int deniedCount = 0;
	std::string firstDeniedPath;
};

ButtonCapture g_buttons;

// libinput opens the device nodes through these callbacks.  It never takes an
// exclusive grab, so the compositor keeps receiving the same input.
int libinputOpenRestricted(const char *path, int flags, void * /*userdata*/) {
	const int fd = open(path, flags | O_CLOEXEC);
	if (fd < 0) {
		if (errno == EACCES || errno == EPERM) {
			g_buttons.deniedCount++;
			if (g_buttons.firstDeniedPath.empty()) {
				g_buttons.firstDeniedPath = path;
			}
		}
		return -errno;
	}
	return fd;
}

void libinputCloseRestricted(int fd, void * /*userdata*/) { close(fd); }

const RecordlyLibinputInterface kLibinputInterface = {
	libinputOpenRestricted,
	libinputCloseRestricted,
};

void configureLibinputDevice(struct libinput_device *device) {
	if (!device) {
		return;
	}

	const uint32_t vendor = g_libinput.device_get_id_vendor(device);
	const uint32_t product = g_libinput.device_get_id_product(device);
	const char *name = g_libinput.device_get_name(device);
	const KdeTouchpadConfig config = readKdeTouchpadConfig(vendor, product, name);

	// Tapping is off by default in libinput but on by default in Plasma, and a
	// tap emits no kernel button event at all -- this is the whole reason the
	// helper reads through libinput instead of evdev.
	if (g_libinput.device_config_tap_get_finger_count(device) > 0) {
		g_libinput.device_config_tap_set_enabled(
			device, config.tapToClick ? RECORDLY_LI_CONFIG_TAP_ENABLED
			                          : RECORDLY_LI_CONFIG_TAP_DISABLED);
		g_libinput.device_config_tap_set_button_map(
			device, config.lmrTapButtonMap ? RECORDLY_LI_CONFIG_TAP_MAP_LMR
			                               : RECORDLY_LI_CONFIG_TAP_MAP_LRM);
	}

	// KDE stores ClickMethod using libinput's own bitmask values.
	if (config.clickMethod > 0 &&
	    (g_libinput.device_config_click_get_methods(device) &
	     static_cast<uint32_t>(config.clickMethod)) != 0) {
		g_libinput.device_config_click_set_method(device, config.clickMethod);
	}
}

// Adds every pointer device not already registered.  Called at startup and
// again whenever inotify reports a new /dev/input node, so a mouse plugged in
// mid-recording still produces click telemetry.
void addPointerDevices(ButtonCapture &capture) {
	capture.deniedCount = 0;
	capture.firstDeniedPath.clear();

	DIR *dir = opendir("/dev/input");
	if (!dir) {
		capture.deniedCount = 1;
		capture.firstDeniedPath = "/dev/input";
		return;
	}

	std::vector<std::string> candidates;
	while (struct dirent *entry = readdir(dir)) {
		if (strncmp(entry->d_name, "event", 5) != 0) {
			continue;
		}
		candidates.push_back(std::string("/dev/input/") + entry->d_name);
	}
	closedir(dir);

	for (const std::string &path : candidates) {
		bool alreadyAdded = false;
		for (const std::string &existing : capture.devicePaths) {
			if (existing == path) {
				alreadyAdded = true;
				break;
			}
		}
		if (alreadyAdded) {
			continue;
		}

		// Screen out keyboards before libinput ever sees them, so this process
		// never holds a file descriptor that could carry typed input.
		int probeFd = open(path.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
		if (probeFd < 0) {
			if (errno == EACCES || errno == EPERM) {
				capture.deniedCount++;
				if (capture.firstDeniedPath.empty()) {
					capture.firstDeniedPath = path;
				}
			}
			continue;
		}
		const bool isPointer = isPointerButtonDevice(probeFd, nullptr);
		close(probeFd);
		if (!isPointer) {
			continue;
		}

		struct libinput_device *device = g_libinput.path_add_device(capture.context, path.c_str());
		if (!device) {
			continue;
		}

		configureLibinputDevice(device);
		capture.devicePaths.push_back(path);
	}
}

bool startButtonCapture(ButtonCapture &capture) {
	if (!g_libinput.load()) {
		return false;
	}

	capture.context = g_libinput.path_create_context(&kLibinputInterface, nullptr);
	if (!capture.context) {
		return false;
	}

	addPointerDevices(capture);
	capture.fd = g_libinput.get_fd(capture.context);
	return true;
}

void stopButtonCapture(ButtonCapture &capture) {
	if (capture.context) {
		g_libinput.unref(capture.context);
		capture.context = nullptr;
	}
	capture.fd = -1;
	capture.devicePaths.clear();
	g_libinput.unload();
}

int mouseButtonFromCode(uint32_t code) {
	switch (code) {
		case BTN_LEFT: return 1;
		case BTN_RIGHT: return 2;
		case BTN_MIDDLE: return 3;
		default: return 0;
	}
}

void emitButton(int button, bool pressed, long long timestamp) {
	char buf[256];
	snprintf(buf, sizeof(buf),
	         "{\"type\":\"button\",\"button\":%d,\"pressed\":%s,\"x\":%d,\"y\":%d,"
	         "\"timestamp\":%lld}",
	         button, pressed ? "true" : "false", g_cursor.x, g_cursor.y, timestamp);
	emitLine(buf);
}

void drainButtonEvents(ButtonCapture &capture) {
	if (!capture.context || g_libinput.dispatch(capture.context) < 0) {
		return;
	}

	while (struct libinput_event *event = g_libinput.get_event(capture.context)) {
		// Only pointer buttons leave this loop.  Motion, scroll, gesture, and
		// every key event are destroyed without being inspected or logged.
		if (g_libinput.event_get_type(event) == RECORDLY_LI_EVENT_POINTER_BUTTON) {
			struct libinput_event_pointer *pointerEvent =
				g_libinput.event_get_pointer_event(event);
			const int button =
				mouseButtonFromCode(g_libinput.event_pointer_get_button(pointerEvent));
			if (button != 0) {
				const bool pressed = g_libinput.event_pointer_get_button_state(pointerEvent) ==
				                     RECORDLY_LI_BUTTON_STATE_PRESSED;
				// libinput stamps events on CLOCK_MONOTONIC while telemetry is
				// keyed on wall clock, so shift by the measured offset instead
				// of assuming the event was handled the instant it arrived.
				const long long monotonicMs = static_cast<long long>(
					g_libinput.event_pointer_get_time_usec(pointerEvent) / 1000ULL);
				const long long timestamp =
					monotonicMs > 0 ? monotonicMs + monotonicToRealtimeOffsetMs() : nowMs();
				emitButton(button, pressed, timestamp);
			}
		}

		g_libinput.event_destroy(event);
	}
}

// ── D-Bus surface consumed by the KWin script ────────────────────────────────

int onBusMessage(sd_bus_message *message, void * /*userdata*/, sd_bus_error * /*error*/) {
	const char *member = sd_bus_message_get_member(message);
	if (!member) {
		return 0;
	}

	if (strcmp(member, "Move") == 0) {
		int x = 0;
		int y = 0;
		if (sd_bus_message_read(message, "ii", &x, &y) < 0) {
			return 0;
		}

		g_cursor.x = x;
		g_cursor.y = y;
		g_cursor.valid = true;

		char buf[192];
		snprintf(buf, sizeof(buf), "{\"type\":\"move\",\"x\":%d,\"y\":%d,\"timestamp\":%lld}", x, y,
		         nowMs());
		emitLine(buf);
		sd_bus_reply_method_return(message, NULL);
		return 1;
	}

	if (strcmp(member, "Output") == 0) {
		int index = 0;
		int count = 0;
		const char *name = "";
		int x = 0;
		int y = 0;
		int width = 0;
		int height = 0;
		const char *scale = "1";
		if (sd_bus_message_read(message, "iisiiiis", &index, &count, &name, &x, &y, &width, &height,
		                        &scale) < 0) {
			return 0;
		}

		char buf[512];
		snprintf(buf, sizeof(buf),
		         "{\"type\":\"output\",\"index\":%d,\"count\":%d,\"name\":\"%s\",\"x\":%d,"
		         "\"y\":%d,\"width\":%d,\"height\":%d,\"scale\":%s}",
		         index, count, jsonEscape(name).c_str(), x, y, width, height,
		         (scale && *scale) ? scale : "1");
		emitLine(buf);
		sd_bus_reply_method_return(message, NULL);
		return 1;
	}

	return 0;
}

bool callKWinScripting(sd_bus *bus, const char *method, const char *signature, const char *arg1,
                       const char *arg2, std::string *errorOut) {
	sd_bus_error error = SD_BUS_ERROR_NULL;
	sd_bus_message *reply = NULL;
	int r;

	if (signature == NULL) {
		r = sd_bus_call_method(bus, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", method,
		                       &error, &reply, NULL);
	} else if (arg2 == NULL) {
		r = sd_bus_call_method(bus, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", method,
		                       &error, &reply, signature, arg1);
	} else {
		r = sd_bus_call_method(bus, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", method,
		                       &error, &reply, signature, arg1, arg2);
	}

	if (r < 0 && errorOut) {
		*errorOut = error.message ? error.message : strerror(-r);
	}

	sd_bus_error_free(&error);
	if (reply) {
		sd_bus_message_unref(reply);
	}
	return r >= 0;
}

}  // namespace

int main(int argc, char **argv) {
	setvbuf(stdout, NULL, _IOLBF, 0);

	std::string kwinScriptPath;
	bool enableButtonCapture = true;
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--kwin-script") == 0 && i + 1 < argc) {
			kwinScriptPath = argv[++i];
		} else if (strcmp(argv[i], "--no-buttons") == 0 ||
		           strcmp(argv[i], "--no-evdev") == 0) {
			enableButtonCapture = false;
		}
	}

	if (kwinScriptPath.empty()) {
		emitError("missing --kwin-script <path>");
		return 2;
	}
	if (access(kwinScriptPath.c_str(), R_OK) != 0) {
		emitError("KWin bridge script is not readable: " + kwinScriptPath);
		return 2;
	}

	struct sigaction action = {};
	action.sa_handler = handleSignal;
	sigaction(SIGINT, &action, NULL);
	sigaction(SIGTERM, &action, NULL);
	sigaction(SIGHUP, &action, NULL);
	signal(SIGPIPE, SIG_IGN);

	sd_bus *bus = NULL;
	int r = sd_bus_open_user(&bus);
	if (r < 0) {
		emitError(std::string("cannot connect to the session bus: ") + strerror(-r));
		return 3;
	}

	sd_bus_slot *slot = NULL;
	r = sd_bus_add_object(bus, &slot, kObjectPath, onBusMessage, NULL);
	if (r < 0) {
		emitError(std::string("cannot export ") + kObjectPath + ": " + strerror(-r));
		sd_bus_flush_close_unref(bus);
		return 3;
	}

	// Wait for a predecessor instead of replacing it. The KWin script, not this
	// name, is the real singleton: a departing helper unloads the script *before*
	// releasing the name (see the teardown below), so taking the name by force
	// would load the script only to have the outgoing instance unload it again.
	// Recordly restarts this helper to switch button capture on for a recording,
	// so the handoff happens on every recording, not only after a crash.
	// A crashed owner is gone from the bus already and never reaches this wait.
	for (int waitedMs = 0;; waitedMs += 50) {  // 3 s predecessor shutdown budget
		r = sd_bus_request_name(bus, kBusName, 0);
		if (r >= 0 || r != -EEXIST || waitedMs >= 3000) break;
		usleep(50 * 1000);
	}
	if (r < 0) {
		emitError(r == -EEXIST
		              ? std::string("another Recordly cursor helper still owns ") + kBusName
		              : std::string("cannot own ") + kBusName + ": " + strerror(-r));
		sd_bus_slot_unref(slot);
		sd_bus_flush_close_unref(bus);
		return 3;
	}

	std::string kwinError;
	if (!callKWinScripting(bus, "loadScript", "ss", kwinScriptPath.c_str(), kKWinPluginId,
	                       &kwinError)) {
		emitError("KWin rejected the cursor bridge script: " + kwinError);
		sd_bus_release_name(bus, kBusName);
		sd_bus_slot_unref(slot);
		sd_bus_flush_close_unref(bus);
		return 4;
	}
	if (!callKWinScripting(bus, "start", NULL, NULL, NULL, &kwinError)) {
		emitError("KWin refused to start the cursor bridge script: " + kwinError);
		callKWinScripting(bus, "unloadScript", "s", kKWinPluginId, NULL, NULL);
		sd_bus_release_name(bus, kBusName);
		sd_bus_slot_unref(slot);
		sd_bus_flush_close_unref(bus);
		return 4;
	}

	bool buttonCaptureStarted = false;
	int inotifyFd = -1;
	if (enableButtonCapture) {
		buttonCaptureStarted = startButtonCapture(g_buttons);
		inotifyFd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
		if (inotifyFd >= 0 &&
		    inotify_add_watch(inotifyFd, "/dev/input", IN_CREATE | IN_ATTRIB) < 0) {
			close(inotifyFd);
			inotifyFd = -1;
		}
	}

	{
		char buf[256];
		snprintf(buf, sizeof(buf),
		         "{\"type\":\"status\",\"state\":\"ready\",\"pointerDevices\":%zu,"
		         "\"deniedDevices\":%d,\"timestamp\":%lld}",
		         g_buttons.devicePaths.size(), g_buttons.deniedCount, nowMs());
		emitLine(buf);
	}

	if (enableButtonCapture && g_buttons.devicePaths.empty()) {
		const char *reason = !buttonCaptureStarted ? "libinput-unavailable"
		                     : g_buttons.deniedCount > 0 ? "permission-denied"
		                                                 : "no-pointer-device";
		char buf[512];
		snprintf(buf, sizeof(buf),
		         "{\"type\":\"status\",\"state\":\"button-capture-unavailable\",\"reason\":\"%s\","
		         "\"path\":\"%s\",\"timestamp\":%lld}",
		         reason,
		         jsonEscape(g_buttons.firstDeniedPath.empty() ? "/dev/input/event*"
		                                                      : g_buttons.firstDeniedPath)
		             .c_str(),
		         nowMs());
		emitLine(buf);
	}

	std::vector<struct pollfd> pollfds;
	while (!g_stopRequested) {
		r = sd_bus_process(bus, NULL);
		if (r < 0) {
			emitError(std::string("session bus failure: ") + strerror(-r));
			break;
		}
		if (r > 0) {
			continue;
		}

		uint64_t busTimeoutUsec = 0;
		sd_bus_get_timeout(bus, &busTimeoutUsec);
		int timeoutMs = 1000;
		if (busTimeoutUsec != UINT64_MAX) {
			// sd_bus reports an absolute CLOCK_MONOTONIC deadline; a short
			// ceiling keeps shutdown responsive without busy-waiting.
			timeoutMs = 200;
		}

		pollfds.clear();
		const int busEvents = sd_bus_get_events(bus);
		struct pollfd busPoll = {};
		busPoll.fd = sd_bus_get_fd(bus);
		busPoll.events = static_cast<short>(busEvents > 0 ? busEvents : POLLIN);
		pollfds.push_back(busPoll);

		struct pollfd stdinPoll = {};
		stdinPoll.fd = STDIN_FILENO;
		stdinPoll.events = POLLIN;
		pollfds.push_back(stdinPoll);

		struct pollfd inotifyPoll = {};
		inotifyPoll.fd = inotifyFd;
		inotifyPoll.events = inotifyFd >= 0 ? POLLIN : 0;
		pollfds.push_back(inotifyPoll);

		// libinput multiplexes every device onto a single descriptor.
		struct pollfd buttonPoll = {};
		buttonPoll.fd = g_buttons.fd;
		buttonPoll.events = g_buttons.fd >= 0 ? POLLIN : 0;
		pollfds.push_back(buttonPoll);

		int ready = poll(pollfds.data(), pollfds.size(), timeoutMs);
		if (ready < 0) {
			if (errno == EINTR) {
				continue;
			}
			emitError(std::string("poll failed: ") + strerror(errno));
			break;
		}

		// stdin closing means Recordly exited: shut down instead of lingering.
		if (pollfds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
			char stdinBuffer[128];
			ssize_t bytes = read(STDIN_FILENO, stdinBuffer, sizeof(stdinBuffer));
			if (bytes <= 0 || memmem(stdinBuffer, static_cast<size_t>(bytes), "stop", 4) != NULL) {
				break;
			}
		}

		if (g_buttons.fd >= 0 && (pollfds[3].revents & POLLIN)) {
			drainButtonEvents(g_buttons);
		}

		if (inotifyFd >= 0 && (pollfds[2].revents & POLLIN)) {
			char inotifyBuffer[4096];
			while (read(inotifyFd, inotifyBuffer, sizeof(inotifyBuffer)) > 0) {
				// Contents are irrelevant; any change means rescan.
			}
			const size_t before = g_buttons.devicePaths.size();
			if (buttonCaptureStarted) {
				addPointerDevices(g_buttons);
			}
			if (g_buttons.devicePaths.size() != before) {
				char buf[192];
				snprintf(buf, sizeof(buf),
				         "{\"type\":\"status\",\"state\":\"pointer-devices-changed\","
				         "\"pointerDevices\":%zu,\"timestamp\":%lld}",
				         g_buttons.devicePaths.size(), nowMs());
				emitLine(buf);
			}
		}
	}

	callKWinScripting(bus, "unloadScript", "s", kKWinPluginId, NULL, NULL);
	if (inotifyFd >= 0) {
		close(inotifyFd);
	}
	stopButtonCapture(g_buttons);
	sd_bus_release_name(bus, kBusName);
	sd_bus_slot_unref(slot);
	sd_bus_flush_close_unref(bus);
	return 0;
}
