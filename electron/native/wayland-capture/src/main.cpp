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
#include <sys/stat.h>
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

/** One descriptor to hand to a child under a fixed number. */
struct InheritedFd {
	int from = -1;
	int as = -1;
};

/** Spawns a child with the given stdin/stdout plus any extra inherited fds. */
pid_t spawnChild(const std::vector<std::string> &argv, int stdinFd, int stdoutFd,
                 const std::vector<InheritedFd> &inherited = {}) {
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
	for (const InheritedFd &entry : inherited) {
		if (entry.from < 0 || entry.as < 0) {
			continue;
		}
		if (entry.from != entry.as) {
			dup2(entry.from, entry.as);
		}
		// dup2 clears FD_CLOEXEC on the copy, but dup2(fd, fd) is a no-op that
		// leaves the flag alone -- the descriptor would then vanish at exec and
		// the child would silently receive nothing. Clear it explicitly.
		fcntl(entry.as, F_SETFD, 0);
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
	const pid_t pid = spawnChild(args, -1, -1);
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
	const pid_t inspectPid = spawnChild(inspect, -1, -1);
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
	std::string systemAudioDevice;
	std::string microphoneDevice;
	std::string vaapiDevice;
	(void)usePortalFd;

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
		} else if (flag == "--vaapi-device" && hasValue) {
			// A DRM render node, e.g. /dev/dri/renderD128. Only useful with an
			// ffmpeg built with VAAPI; the caller checks that first.
			vaapiDevice = argv[++i];
		} else if (flag == "--system-audio" && hasValue) {
			// A PulseAudio/PipeWire source name, normally "<default sink>.monitor".
			systemAudioDevice = argv[++i];
		} else if (flag == "--microphone" && hasValue) {
			microphoneDevice = argv[++i];
		} else if (flag == "--portal-fd") {
			// Kept only so older callers do not fail; this is now the only route.
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

	// Audio rides alongside the video in the same GStreamer process, each track
	// on its own descriptor, so ffmpeg can mux everything in one pass. WAV is
	// used as the transport because it is self-describing like Y4M.
	constexpr int kSystemAudioChildFd = 4;
	constexpr int kMicrophoneChildFd = 5;

	int systemAudioPipe[2] = {-1, -1};
	int microphonePipe[2] = {-1, -1};
	if (!systemAudioDevice.empty() && pipe2(systemAudioPipe, O_CLOEXEC) != 0) {
		emitError(std::string("cannot create the system audio pipe: ") + strerror(errno));
		portalCloseScreenCast(&session);
		return 3;
	}
	if (!microphoneDevice.empty() && pipe2(microphonePipe, O_CLOEXEC) != 0) {
		emitError(std::string("cannot create the microphone pipe: ") + strerror(errno));
		portalCloseScreenCast(&session);
		return 3;
	}

	// gst-launch treats every argv entry as one pipeline token, so each
	// property has to be its own argument exactly as a shell would split it.
	std::vector<std::string> gstArgs = {
		gstPath,
		"-q",
		"pipewiresrc",
		// The node id is only meaningful on the remote the portal opened for
		// us. Connecting to the session daemon instead and reusing the number
		// there resolves to an unrelated node -- in testing it landed on this
		// process's own client object, and could just as easily be a camera.
		"fd=" + std::to_string(kPipeWireChildFd),
		"path=" + std::to_string(session.nodeId),
		"do-timestamp=true",
		// Without this the pipeline adopts PipeWire's clock, whose running time
		// advanced at half real speed here: a 21 s recording came out as an
		// 11 s video regardless of frame rate, transport or encoder. Using the
		// system clock instead makes the timestamps match the wall clock.
		"provide-clock=false",
		"!",
		// pipewiresrc negotiates the display's refresh rate (120/1 here) while
		// delivering roughly half that, so every timestamp downstream ran at
		// half speed and a 22 s recording came out as 11 s. Declaring the
		// stream variable-rate stops anything inferring a rate from the caps.
		"video/x-raw,framerate=0/1",
		"!",
		"videoconvert",
		"!",
		// A compositor only emits a frame when something is damaged, and with
		// the cursor hidden from the stream even moving the pointer damages
		// nothing. An idle screen therefore produces no frames at all, and the
		// recording ends up as short as the parts that changed. videorate
		// repeats the last frame so the timeline keeps pace with the clock.
		"videorate",
		"!",
		"video/x-raw,format=I420,framerate=" + std::to_string(frameRate) + "/1",
		"!",
		// Matroska, not Y4M. A screen only produces frames when something
		// changes, so the stream is variable rate -- and Y4M carries no
		// timestamps, which left ffmpeg deriving the length from "frames
		// received / declared rate". Any frame not delivered then shortened the
		// video and sped it up; measured at exactly half on this hardware.
		// Matroska carries the timestamps, so the length follows the clock no
		// matter how the frames arrive.
		"matroskamux",
		"streamable=true",
		"!",
		"fdsink",
		// async=false on every sink: a single pipeline will not reach PLAYING
		// until each branch has prerolled, and a suspended PulseAudio monitor
		// took ~10 s to wake. The screen produced nothing for that whole window,
		// so the recording came out that much shorter than the webcam beside it.
		"async=false",
		"fd=1",
	};

	std::vector<std::string> audioArgs = {gstPath, "-q"};
	const auto appendAudioBranch = [&audioArgs](const std::string &device, int childFd) {
		// Branches are simply concatenated; each already begins with pulsesrc.
		for (const std::string &token : {
				 std::string("pulsesrc"),
				 "device=" + device,
				 std::string("provide-clock=false"),
				 std::string("!"),
				 std::string("queue"),
				 std::string("!"),
				 std::string("audioconvert"),
				 std::string("!"),
				 std::string("audioresample"),
				 std::string("!"),
				 std::string("audio/x-raw,format=S16LE,rate=48000,channels=2"),
				 std::string("!"),
				 std::string("wavenc"),
				 std::string("!"),
				 std::string("fdsink"),
				 std::string("async=false"),
				 "fd=" + std::to_string(childFd),
			 }) {
			audioArgs.push_back(token);
		}
	};

	if (!systemAudioDevice.empty()) {
		appendAudioBranch(systemAudioDevice, kSystemAudioChildFd);
	}
	if (!microphoneDevice.empty()) {
		appendAudioBranch(microphoneDevice, kMicrophoneChildFd);
	}

	std::vector<std::string> ffmpegArgs = {
		ffmpegPath,
		"-hide_banner",
		"-loglevel",
		"error",
		// ffmpeg probes the input before deciding stream parameters, which for
		// this pipe meant roughly seven seconds of screen recorded and thrown
		// away before the first byte was written. The stream layout is known
		// here, so there is nothing to probe for.
		"-analyzeduration",
		"0",
		"-probesize",
		"32",
		"-f",
		"matroska",
		// pipewiresrc's timestamps advance at half real speed on this
		// compositor: a 21 s recording arrived stamped as 11 s, unchanged by
		// frame rate, transport, encoder or clock choice, while the identical
		// pipeline fed by videotestsrc was exact. Rather than trusting the
		// source's idea of time, stamp each frame as it actually arrives.
		"-use_wallclock_as_timestamps",
		"1",
		"-i",
		"pipe:0",
	};

	int audioInputs = 0;
	if (!systemAudioDevice.empty()) {
		ffmpegArgs.push_back("-f");
		ffmpegArgs.push_back("wav");
		ffmpegArgs.push_back("-i");
		ffmpegArgs.push_back("pipe:" + std::to_string(kSystemAudioChildFd));
		audioInputs++;
	}
	if (!microphoneDevice.empty()) {
		ffmpegArgs.push_back("-f");
		ffmpegArgs.push_back("wav");
		ffmpegArgs.push_back("-i");
		ffmpegArgs.push_back("pipe:" + std::to_string(kMicrophoneChildFd));
		audioInputs++;
	}

	ffmpegArgs.push_back("-r");
	ffmpegArgs.push_back(std::to_string(frameRate));
	// Explicitly constant rate: the wall-clock stamps above are what the
	// duplication is derived from.
	ffmpegArgs.push_back("-fps_mode");
	ffmpegArgs.push_back("cfr");

	if (audioInputs == 2) {
		// System audio and microphone become one track; keeping them separate
		// would need a second output file and a muxing step downstream.
		ffmpegArgs.push_back("-filter_complex");
		ffmpegArgs.push_back("[1:a][2:a]amix=inputs=2:normalize=0[aout]");
		ffmpegArgs.push_back("-map");
		ffmpegArgs.push_back("0:v");
		ffmpegArgs.push_back("-map");
		ffmpegArgs.push_back("[aout]");
	} else if (audioInputs == 1) {
		ffmpegArgs.push_back("-map");
		ffmpegArgs.push_back("0:v");
		ffmpegArgs.push_back("-map");
		ffmpegArgs.push_back("1:a");
	}

	if (audioInputs > 0) {
		ffmpegArgs.push_back("-c:a");
		ffmpegArgs.push_back("aac");
		ffmpegArgs.push_back("-b:a");
		ffmpegArgs.push_back("192k");
		// The screen stream drives the length; audio that outlives it would
		// leave a tail of frozen video.
		ffmpegArgs.push_back("-shortest");
	}

	if (!vaapiDevice.empty()) {
		// Hardware encoding keeps a 2880x1800 screen comfortably real time and
		// leaves the CPU to the rest of the app.
		for (const std::string &token : {
				 std::string("-vaapi_device"), vaapiDevice, std::string("-vf"),
				 std::string("format=nv12,hwupload"), std::string("-c:v"),
				 std::string("h264_vaapi"), std::string("-qp"), std::string("24"),
			 }) {
			ffmpegArgs.push_back(token);
		}
	} else {
		// ultrafast, not veryfast: a 2880x1800 screen has to be encoded in real
		// time alongside the rest of the app, and an encoder that falls behind
		// stalls the pipeline.
		for (const std::string &token : {
				 std::string("-c:v"), std::string("libx264"), std::string("-preset"),
				 std::string("ultrafast"), std::string("-pix_fmt"), std::string("yuv420p"),
			 }) {
			ffmpegArgs.push_back(token);
		}
	}

	for (const std::string &token : {
			 std::string("-movflags"), std::string("+faststart"), std::string("-y"), outputPath,
		 }) {
		ffmpegArgs.push_back(token);
	}

	std::vector<InheritedFd> gstFds;
	gstFds.push_back({session.pipewireFd, kPipeWireChildFd});

	std::vector<InheritedFd> gstAudioFds;
	if (systemAudioPipe[1] >= 0) {
		gstAudioFds.push_back({systemAudioPipe[1], kSystemAudioChildFd});
	}
	if (microphonePipe[1] >= 0) {
		gstAudioFds.push_back({microphonePipe[1], kMicrophoneChildFd});
	}

	std::vector<InheritedFd> ffmpegFds;
	if (systemAudioPipe[0] >= 0) {
		ffmpegFds.push_back({systemAudioPipe[0], kSystemAudioChildFd});
	}
	if (microphonePipe[0] >= 0) {
		ffmpegFds.push_back({microphonePipe[0], kMicrophoneChildFd});
	}

	// Two processes on purpose: a single pipeline does not reach PLAYING until
	// every branch has prerolled, and a suspended PulseAudio monitor took about
	// ten seconds to wake -- ten seconds in which the screen recorded nothing.
	const pid_t gstPid = spawnChild(gstArgs, -1, frames[1], gstFds);
	pid_t audioPid = -1;
	if (audioArgs.size() > 2) {
		audioPid = spawnChild(audioArgs, -1, -1, gstAudioFds);
	}
	const pid_t ffmpegPid = spawnChild(ffmpegArgs, frames[0], -1, ffmpegFds);
	// The parent must not keep any pipe end open, or neither child ever sees EOF.
	for (int fd : {frames[0], frames[1], systemAudioPipe[0], systemAudioPipe[1],
	               microphonePipe[0], microphonePipe[1]}) {
		if (fd >= 0) {
			close(fd);
		}
	}

	if (gstPid < 0 || ffmpegPid < 0) {
		emitError("cannot start the capture pipeline");
		portalCloseScreenCast(&session);
		return 3;
	}

	// The portal returns before the compositor is actually streaming: frames
	// took about six seconds to start flowing here. Announcing "recording" then
	// would start Recordly's clock and the webcam on an empty screen, leaving
	// the finished video that much shorter than the timer said.
	for (int waited = 0; waited < 20000; waited += 100) {
		struct stat outputStat = {};
		if (stat(outputPath.c_str(), &outputStat) == 0 && outputStat.st_size > 0) {
			break;
		}
		int status = 0;
		if (waitpid(gstPid, &status, WNOHANG) == gstPid) {
			emitError("the frame source exited before producing anything");
			portalCloseScreenCast(&session);
			return 3;
		}
		struct timespec pollDelay = {0, 100 * 1000 * 1000L};
		nanosleep(&pollDelay, nullptr);
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
	// The portal connection is polled alongside stdin: it has to stay serviced
	// for the whole recording, because the session dies with it.
	bool paused = false;
	while (!g_stopRequested) {
		struct pollfd fds[2] = {};
		fds[0].fd = STDIN_FILENO;
		fds[0].events = POLLIN;
		fds[1].fd = portalBusFd(&session);
		fds[1].events = fds[1].fd >= 0 ? POLLIN : 0;

		const int ready = poll(fds, 2, 200);
		if (ready < 0 && errno != EINTR) {
			break;
		}

		portalPumpScreenCast(&session);

		const struct pollfd &stdinPoll = fds[0];
		if (ready > 0 && (stdinPoll.revents & (POLLIN | POLLHUP | POLLERR))) {
			char buffer[128];
			const ssize_t bytes = read(STDIN_FILENO, buffer, sizeof(buffer));
			// EOF means Recordly exited; "stop" is the graceful request.
			if (bytes <= 0 ||
			    memmem(buffer, static_cast<size_t>(bytes), "stop", 4) != nullptr) {
				break;
			}

			const size_t length = static_cast<size_t>(bytes);
			// Pausing suspends the frame source rather than the encoder, so the
			// paused stretch simply produces no frames and disappears from the
			// finished video -- which is what pausing a recording should do.
			// ffmpeg stays alive and blocks on an empty pipe meanwhile.
			if (memmem(buffer, length, "pause", 5) != nullptr && !paused) {
				kill(gstPid, SIGSTOP);
				if (audioPid > 0) {
					kill(audioPid, SIGSTOP);
				}
				paused = true;
				emitLine("{\"type\":\"status\",\"state\":\"paused\",\"timestamp\":" +
				         std::to_string(nowMs()) + "}");
			} else if (memmem(buffer, length, "resume", 6) != nullptr && paused) {
				kill(gstPid, SIGCONT);
				if (audioPid > 0) {
					kill(audioPid, SIGCONT);
				}
				paused = false;
				emitLine("{\"type\":\"status\",\"state\":\"resumed\",\"timestamp\":" +
				         std::to_string(nowMs()) + "}");
			}
		}

		int status = 0;
		// WUNTRACED is deliberately absent: a paused source is stopped, not
		// dead, and must not be mistaken for a crash.
		if (waitpid(gstPid, &status, WNOHANG) == gstPid) {
			emitError("the frame source exited unexpectedly");
			break;
		}
	}

	// A suspended process would never see SIGINT, so wake it before asking it
	// to finish.
	if (paused) {
		kill(gstPid, SIGCONT);
		if (audioPid > 0) {
			kill(audioPid, SIGCONT);
		}
	}
	if (audioPid > 0) {
		kill(audioPid, SIGINT);
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
