// Recordly Wayland screen capture helper (KDE Plasma / KWin, native Wayland).
//
// Exists for one reason: to record without the system cursor burned into the
// frames. Chromium's getDisplayMedia always asks xdg-desktop-portal for an
// *embedded* cursor and offers no way to change it -- `cursor` is not in
// getSupportedConstraints(), Electron's display-media callback carries only
// video/audio/enableLocalEcho, and no Chromium switch controls it. The portal
// itself supports hiding the cursor (KDE advertises AvailableCursorModes = 7),
// so this helper negotiates its own ScreenCast session with cursor_mode=hidden
// and Recordly draws its own cursor from telemetry instead.
//
// Frames travel: portal -> PipeWire -> GStreamer -> Y4M -> ffmpeg -> file.
// GStreamer only moves pixels; encoding uses the ffmpeg Recordly already
// bundles, so no GStreamer encoder plugins are required. Y4M is self-describing,
// so the frame size never has to be guessed or passed along.
//
// Protocol (stdout, one JSON object per line):
//   {"type":"status","state":"negotiating"}
//   {"type":"status","state":"recording","nodeId":215,"width":2880,"height":1800,
//    "restoreToken":"...","cursorMode":"hidden"}
//   {"type":"status","state":"stopped","exitCode":0,"output":"/path/file.mp4"}
//   {"type":"error","message":"..."}

#include <fcntl.h>
#include <poll.h>
#include <sys/prctl.h>
#include <signal.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "portal.h"

namespace {

volatile sig_atomic_t g_stopRequested = 0;

void handleSignal(int) { g_stopRequested = 1; }

long long nowMs() {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL;
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
	emitLine("{\"type\":\"error\",\"message\":\"" + jsonEscape(message) +
	         "\",\"timestamp\":" + std::to_string(nowMs()) + "}");
}

/** Spawns a child with the given stdin/stdout, plus one extra inherited fd. */
pid_t spawnChild(const std::vector<std::string> &argv, int stdinFd, int stdoutFd,
                 int inheritFd, int inheritAs) {
	std::vector<char *> raw;
	raw.reserve(argv.size() + 1);
	for (const std::string &argument : argv) {
		raw.push_back(const_cast<char *>(argument.c_str()));
	}
	raw.push_back(nullptr);

	const pid_t pid = fork();
	if (pid != 0) {
		return pid;
	}

	if (stdinFd >= 0 && stdinFd != STDIN_FILENO) {
		dup2(stdinFd, STDIN_FILENO);
	}
	if (stdoutFd >= 0 && stdoutFd != STDOUT_FILENO) {
		dup2(stdoutFd, STDOUT_FILENO);
	} else if (stdoutFd < 0) {
		// Keep child chatter out of the JSON protocol on our stdout.
		const int devNull = open("/dev/null", O_WRONLY | O_CLOEXEC);
		if (devNull >= 0) {
			dup2(devNull, STDOUT_FILENO);
		}
	}
	if (inheritFd >= 0 && inheritAs >= 0) {
		// dup2 clears FD_CLOEXEC, which is exactly what the child needs.
		dup2(inheritFd, inheritAs);
	}

	// If the helper is killed outright, the encoder must not linger holding the
	// output file open.
	prctl(PR_SET_PDEATHSIG, SIGTERM);

	// Children write diagnostics to our stderr; keep it, it is drained by the
	// parent process that spawned this helper.
	execvp(raw[0], raw.data());
	_exit(127);
}

bool waitForExit(pid_t pid, int timeoutMs, int *exitCode) {
	const int stepMs = 50;
	for (int waited = 0; waited <= timeoutMs; waited += stepMs) {
		int status = 0;
		const pid_t result = waitpid(pid, &status, WNOHANG);
		if (result == pid) {
			if (exitCode) {
				*exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
			}
			return true;
		}
		if (result < 0) {
			// Already reaped or never existed; the status is unknowable.
			if (exitCode) {
				*exitCode = -1;
			}
			return true;
		}
		struct timespec sleepFor = {0, static_cast<long>(stepMs) * 1000000L};
		nanosleep(&sleepFor, nullptr);
	}
	return false;
}

/**
 * Confirms the frame source can actually run before a portal dialog is shown.
 *
 * Without this the user picks a screen, the pipeline dies silently, and the
 * only symptom is a recording that never starts.
 */
bool probeFrameSource(const std::string &gstPath, std::string *problem) {
	const std::vector<std::string> args = {gstPath, "--version"};
	const pid_t pid = spawnChild(args, -1, -1, -1, -1);
	if (pid < 0) {
		*problem = "cannot execute " + gstPath;
		return false;
	}

	int exitCode = -1;
	if (!waitForExit(pid, 5000, &exitCode)) {
		kill(pid, SIGKILL);
		waitForExit(pid, 1000, nullptr);
		*problem = gstPath + " did not respond";
		return false;
	}
	if (exitCode != 0) {
		*problem = gstPath +
		           " is missing. Install gstreamer1 and gstreamer1-plugin-pipewire "
		           "(Fedora: sudo dnf install gstreamer1 gstreamer1-plugin-pipewire)";
		return false;
	}

	// gst-launch exists; make sure the PipeWire element is actually registered.
	const std::vector<std::string> inspect = {"gst-inspect-1.0", "pipewiresrc"};
	const pid_t inspectPid = spawnChild(inspect, -1, -1, -1, -1);
	if (inspectPid < 0) {
		return true;  // cannot check; let the pipeline speak for itself
	}
	int inspectExit = -1;
	if (waitForExit(inspectPid, 5000, &inspectExit) && inspectExit != 0) {
		*problem =
			"the GStreamer pipewiresrc element is missing "
			"(Fedora: sudo dnf install gstreamer1-plugin-pipewire)";
		return false;
	}

	return true;
}

}  // namespace

int main(int argc, char **argv) {
	setvbuf(stdout, nullptr, _IOLBF, 0);

	std::string outputPath;
	std::string restoreToken;
	std::string ffmpegPath = "ffmpeg";
	std::string gstPath = "gst-launch-1.0";
	PortalCursorMode cursorMode = PortalCursorMode::Hidden;
	int frameRate = 60;
	bool usePortalFd = false;

	for (int i = 1; i < argc; i++) {
		const std::string flag = argv[i];
		const bool hasValue = i + 1 < argc;
		if (flag == "--output" && hasValue) {
			outputPath = argv[++i];
		} else if (flag == "--restore-token" && hasValue) {
			// Off by default on purpose. A token replays whatever the portal
			// last associated with it, and in testing that included a source
			// whose geometry matched no connected monitor even though the
			// portal still reported source_type=MONITOR. Showing the picker
			// costs one click and is exactly what Recordly does today, so the
			// token is only worth using once we can verify what came back.
			restoreToken = argv[++i];
		} else if (flag == "--ffmpeg" && hasValue) {
			ffmpegPath = argv[++i];
		} else if (flag == "--gst-launch" && hasValue) {
			gstPath = argv[++i];
		} else if (flag == "--portal-fd") {
			usePortalFd = true;
		} else if (flag == "--fps" && hasValue) {
			frameRate = atoi(argv[++i]);
		} else if (flag == "--cursor-mode" && hasValue) {
			const std::string mode = argv[++i];
			cursorMode = mode == "embedded" ? PortalCursorMode::Embedded
			             : mode == "metadata" ? PortalCursorMode::Metadata
			                                  : PortalCursorMode::Hidden;
		}
	}

	if (outputPath.empty()) {
		emitError("missing --output <path>");
		return 2;
	}
	if (frameRate <= 0 || frameRate > 240) {
		frameRate = 60;
	}

	struct sigaction action = {};
	action.sa_handler = handleSignal;
	sigaction(SIGINT, &action, nullptr);
	sigaction(SIGTERM, &action, nullptr);
	sigaction(SIGHUP, &action, nullptr);
	signal(SIGPIPE, SIG_IGN);

	// Probe before Start(): failing after the user has already picked a screen
	// is a needlessly confusing way to report a missing package.
	std::string probeProblem;
	if (!probeFrameSource(gstPath, &probeProblem)) {
		emitError(probeProblem);
		return 7;
	}

	emitLine("{\"type\":\"status\",\"state\":\"negotiating\",\"timestamp\":" +
	         std::to_string(nowMs()) + "}");

	// Note: session.width/height are the portal's *logical* output size, which
	// is not the stream's pixel size on a scaled display. Nothing depends on
	// them -- Y4M carries the real dimensions to ffmpeg.
	PortalSession session;
	PortalError portalError;
	if (!portalOpenScreenCast(cursorMode, PortalSourceType::Monitor, restoreToken, &session,
	                          &portalError)) {
		// A stale restore token can replay a source the user picked for some
		// other app; drop it and ask again rather than recording the wrong
		// thing or failing outright.
		if (portalError.restoreTokenMismatch) {
			emitLine("{\"type\":\"status\",\"state\":\"restore-token-rejected\",\"reason\":\"" +
			         jsonEscape(portalError.message) +
			         "\",\"timestamp\":" + std::to_string(nowMs()) + "}");
			if (!portalOpenScreenCast(cursorMode, PortalSourceType::Monitor, "", &session,
			                          &portalError)) {
				emitError(portalError.message);
				return portalError.response == 1 ? 5 : 4;
			}
		} else {
			emitError(portalError.message);
			return portalError.response == 1 ? 5 : 4;
		}
	}

	// The portal descriptor is handed to GStreamer as fd 3 so pipewiresrc talks
	// to the restricted remote the portal opened for us, not the session daemon.
	constexpr int kPipeWireChildFd = 3;

	// O_CLOEXEC matters here: dup2 clears it on the copy, so each child keeps
	// only the end it was given and the originals vanish at exec. Without it
	// ffmpeg inherits the *write* end of its own stdin pipe and waits forever
	// for an EOF that can never arrive.
	int frames[2] = {-1, -1};
	if (pipe2(frames, O_CLOEXEC) != 0) {
		emitError(std::string("cannot create the frame pipe: ") + strerror(errno));
		portalCloseScreenCast(&session);
		return 3;
	}

	// gst-launch treats every argv entry as one pipeline token, so each
	// property has to be its own argument exactly as a shell would split it.
	const std::vector<std::string> gstArgs = {
		gstPath,
		usePortalFd ? "-q" : "-q",
		"pipewiresrc",
		// Handing over the portal's own remote is the strict reading of the
		// spec, but pipewiresrc can also reach the node through the session
		// daemon; --frame-source picks between them so a compositor that
		// rejects one still records.
		usePortalFd ? ("fd=" + std::to_string(kPipeWireChildFd))
		            : ("path=" + std::to_string(session.nodeId)),
		usePortalFd ? ("path=" + std::to_string(session.nodeId)) : "do-timestamp=true",
		"!",
		"videoconvert",
		"!",
		"video/x-raw,format=I420",
		"!",
		"y4menc",
		"!",
		"fdsink",
		"fd=1",
	};

	const std::vector<std::string> ffmpegArgs = {
		ffmpegPath, "-hide_banner", "-loglevel", "error",
		"-f", "yuv4mpegpipe", "-i", "-",
		"-r", std::to_string(frameRate),
		"-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
		"-movflags", "+faststart", "-y", outputPath,
	};

	const pid_t gstPid = spawnChild(gstArgs, -1, frames[1],
	                                usePortalFd ? session.pipewireFd : -1,
	                                usePortalFd ? kPipeWireChildFd : -1);
	const pid_t ffmpegPid = spawnChild(ffmpegArgs, frames[0], -1, -1, -1);
	close(frames[0]);
	close(frames[1]);

	if (gstPid < 0 || ffmpegPid < 0) {
		emitError("cannot start the capture pipeline");
		portalCloseScreenCast(&session);
		return 3;
	}

	{
		char buf[768];
		snprintf(buf, sizeof(buf),
		         "{\"type\":\"status\",\"state\":\"recording\",\"nodeId\":%u,\"width\":%u,"
		         "\"height\":%u,\"sourceType\":%u,\"cursorMode\":\"%s\","
		         "\"restoreToken\":\"%s\",\"output\":\"%s\",\"timestamp\":%lld}",
		         session.nodeId, session.width, session.height, session.sourceType,
		         cursorMode == PortalCursorMode::Hidden     ? "hidden"
		         : cursorMode == PortalCursorMode::Embedded ? "embedded"
		                                                    : "metadata",
		         jsonEscape(session.restoreToken).c_str(), jsonEscape(outputPath).c_str(),
		         nowMs());
		emitLine(buf);
	}

	// Wait for "stop" on stdin, a signal, or either child dying on its own.
	while (!g_stopRequested) {
		struct pollfd stdinPoll = {};
		stdinPoll.fd = STDIN_FILENO;
		stdinPoll.events = POLLIN;

		const int ready = poll(&stdinPoll, 1, 200);
		if (ready < 0 && errno != EINTR) {
			break;
		}
		if (ready > 0 && (stdinPoll.revents & (POLLIN | POLLHUP | POLLERR))) {
			char buffer[128];
			const ssize_t bytes = read(STDIN_FILENO, buffer, sizeof(buffer));
			// EOF means Recordly exited; "stop" is the graceful request.
			if (bytes <= 0 ||
			    memmem(buffer, static_cast<size_t>(bytes), "stop", 4) != nullptr) {
				break;
			}
		}

		int status = 0;
		if (waitpid(gstPid, &status, WNOHANG) == gstPid) {
			emitError("the frame source exited unexpectedly");
			break;
		}
	}

	// SIGINT makes gst-launch send EOS, which lets ffmpeg flush and write the
	// moov atom instead of leaving a truncated file behind.
	kill(gstPid, SIGINT);
	int gstExit = 0;
	if (!waitForExit(gstPid, 5000, &gstExit)) {
		kill(gstPid, SIGKILL);
		waitForExit(gstPid, 2000, &gstExit);
	}

	int ffmpegExit = 0;
	if (!waitForExit(ffmpegPid, 15000, &ffmpegExit)) {
		kill(ffmpegPid, SIGTERM);
		waitForExit(ffmpegPid, 5000, &ffmpegExit);
	}

	portalCloseScreenCast(&session);

	char buf[512];
	snprintf(buf, sizeof(buf),
	         "{\"type\":\"status\",\"state\":\"stopped\",\"exitCode\":%d,\"output\":\"%s\","
	         "\"timestamp\":%lld}",
	         ffmpegExit, jsonEscape(outputPath).c_str(), nowMs());
	emitLine(buf);

	return ffmpegExit == 0 ? 0 : 6;
}
