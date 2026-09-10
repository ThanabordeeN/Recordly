#include "capture_runner.h"
#include "gst_capture.h"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

volatile sig_atomic_t g_stopRequested = 0;
void handleSignal(int) { g_stopRequested = 1; }

constexpr int kProgressChildFd = 3;
constexpr int kRecordingTimeoutMs = 30000;
constexpr int kTransportFlushTimeoutMs = 5000;
constexpr int kFfmpegExitTimeoutMs = 15000;

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

struct InheritedFd {
  int from = -1;
  int as = -1;
};

pid_t spawnChild(const std::vector<std::string> &argv, int stdinFd, int stdoutFd,
                 const std::vector<InheritedFd> &inherited = {}) {
  std::vector<char *> raw;
  raw.reserve(argv.size() + 1);
  for (const std::string &argument : argv) raw.push_back(const_cast<char *>(argument.c_str()));
  raw.push_back(nullptr);

  const pid_t pid = fork();
  if (pid != 0) return pid;

  if (stdinFd >= 0 && stdinFd != STDIN_FILENO) dup2(stdinFd, STDIN_FILENO);
  if (stdoutFd >= 0 && stdoutFd != STDOUT_FILENO) {
    dup2(stdoutFd, STDOUT_FILENO);
  } else if (stdoutFd < 0) {
    const int devNull = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (devNull >= 0) dup2(devNull, STDOUT_FILENO);
  }
  for (const InheritedFd &entry : inherited) {
    if (entry.from < 0 || entry.as < 0) continue;
    if (entry.from != entry.as) dup2(entry.from, entry.as);
    // dup2 clears FD_CLOEXEC on a real copy, but dup2(fd, fd) is a no-op that
    // leaves the flag set and would drop the fd at exec. Clear it explicitly.
    fcntl(entry.as, F_SETFD, 0);
  }
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  execvp(raw[0], raw.data());
  _exit(127);
}

bool progressShowsEncodedFrame(const std::string &progress, long long *outTimeUs) {
  bool frameSeen = false;
  long long frameTimeUs = -1;
  size_t lineStart = 0;
  while (lineStart <= progress.size()) {
    const size_t lineEnd = progress.find('\n', lineStart);
    const size_t contentEnd = lineEnd == std::string::npos ? progress.size() : lineEnd;
    if (contentEnd > lineStart) {
      const std::string line = progress.substr(lineStart, contentEnd - lineStart);
      const size_t equals = line.find('=');
      if (equals != std::string::npos && equals > 0) {
        const std::string key = line.substr(0, equals);
        const std::string value = line.substr(equals + 1);
        if (key == "frame") {
          frameSeen = frameSeen || strtoll(value.c_str(), nullptr, 10) > 0;
        } else if (key == "out_time_us") {
          frameTimeUs = strtoll(value.c_str(), nullptr, 10);
        } else if (key == "out_time_ms" && frameTimeUs < 0) {
          frameTimeUs = strtoll(value.c_str(), nullptr, 10);
        }
      }
    }
    if (lineEnd == std::string::npos) break;
    lineStart = lineEnd + 1;
  }
  if (frameSeen && outTimeUs != nullptr) *outTimeUs = frameTimeUs;
  return frameSeen;
}

bool waitForExit(pid_t pid, int timeoutMs, int *exitCode, int progressFd = -1) {
  const int stepMs = 50;
  for (int waited = 0; waited <= timeoutMs; waited += stepMs) {
    if (progressFd >= 0) {
      char buffer[4096];
      while (read(progressFd, buffer, sizeof(buffer)) > 0) {}
    }
    int status = 0;
    const pid_t result = waitpid(pid, &status, WNOHANG);
    if (result == pid) {
      if (exitCode) *exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
      return true;
    }
    if (result < 0) {
      if (exitCode) *exitCode = -1;
      return true;
    }
    struct timespec sleepFor = {0, static_cast<long>(stepMs) * 1000000L};
    nanosleep(&sleepFor, nullptr);
  }
  return false;
}

std::vector<std::string> buildFfmpegArgs(const CaptureConfig &config) {
  std::vector<std::string> args = {
      config.ffmpegPath,  "-hide_banner", "-loglevel", "error",
      "-progress",        "pipe:" + std::to_string(kProgressChildFd),
      "-stats_period",    "0.05",
      "-analyzeduration", "0",           "-probesize", "32",
      "-f",               "matroska",    "-i",         "pipe:0",
  };

  if (config.audioTracks == 2) {
    args.insert(args.end(), {"-map", "0:v:0", "-filter_complex",
                             "[0:a:0][0:a:1]amix=inputs=2:normalize=0[aout]", "-map", "[aout]"});
  } else if (config.audioTracks == 1) {
    args.insert(args.end(), {"-map", "0:v:0", "-map", "0:a:0"});
  } else {
    args.insert(args.end(), {"-map", "0:v:0"});
  }

  args.insert(args.end(), {"-r", std::to_string(config.fps), "-fps_mode", "cfr"});

  args.insert(args.end(),
              {"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"});

  if (config.audioTracks > 0) args.insert(args.end(), {"-c:a", "aac", "-b:a", "192k"});

  args.insert(args.end(), {"-movflags", "+faststart", "-y", config.outputPath});
  return args;
}

}  // namespace

int runCapture(const CaptureConfig &config, const AcquisitionFactory &factory,
               const CaptureExternals &externals) {
  gst_init(nullptr, nullptr);

  struct sigaction action = {};
  action.sa_handler = handleSignal;
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGHUP, &action, nullptr);
  signal(SIGPIPE, SIG_IGN);

  int transport[2] = {-1, -1};
  int progress[2] = {-1, -1};
  if (pipe2(transport, O_CLOEXEC) != 0) {
    emitError(std::string("cannot create the transport pipe: ") + strerror(errno));
    return 3;
  }
  if (pipe2(progress, O_CLOEXEC) != 0) {
    close(transport[0]);
    close(transport[1]);
    emitError(std::string("cannot create the encoder progress pipe: ") + strerror(errno));
    return 3;
  }

  const auto closeTransport = [&]() {
    for (int fd : {transport[0], transport[1]}) {
      if (fd >= 0) close(fd);
    }
  };
  const auto closeProgress = [&]() {
    for (int fd : {progress[0], progress[1]}) {
      if (fd >= 0) close(fd);
    }
  };

  CaptureEngine engine(factory(config), config.audioTracks, config.fps, transport[1]);

  const std::vector<std::string> ffmpegArgs = buildFfmpegArgs(config);
  std::vector<InheritedFd> ffmpegInherited = {{progress[1], kProgressChildFd}};
  const pid_t ffmpegPid = spawnChild(ffmpegArgs, transport[0], -1, ffmpegInherited);

  // The encoder owns the transport read end and the progress write end now.
  close(transport[0]);
  transport[0] = -1;
  close(progress[1]);
  progress[1] = -1;
  if (progress[0] >= 0) {
    const int flags = fcntl(progress[0], F_GETFL, 0);
    fcntl(progress[0], F_SETFL, flags | O_NONBLOCK);
  }

  if (ffmpegPid < 0) {
    emitError("cannot start the encoder");
    closeTransport();
    closeProgress();
    externals.close();
    return 6;
  }

  engine.start();
  if (!engine.error().empty()) {
    emitError(engine.error());
    kill(ffmpegPid, SIGTERM);
    waitForExit(ffmpegPid, 2000, nullptr);
    closeTransport();
    closeProgress();
    externals.close();
    return 3;
  }

  bool captureStartedEmitted = false;
  bool recordingEmitted = false;
  bool encoderFailed = false;
  bool stopBeforeFirstSample = false;
  std::string progressTail;
  long long mediaTimeUs = -1;
  const long long recordingDeadline = nowMs() + kRecordingTimeoutMs;

  while (!g_stopRequested && !encoderFailed) {
    engine.pump();
    if (!engine.error().empty()) {
      encoderFailed = true;
      break;
    }

    if (!captureStartedEmitted && engine.started()) {
      captureStartedEmitted = true;
      emitLine("{\"type\":\"status\",\"state\":\"capture-started\",\"protocolVersion\":2,"
               "\"startedAtMs\":" +
               std::to_string(engine.startedAtMs()) + ",\"timestamp\":" + std::to_string(nowMs()) +
               ",\"output\":\"" + jsonEscape(config.outputPath) + "\"}");
    }

    char chunk[1024];
    ssize_t bytes = 0;
    while ((bytes = read(progress[0], chunk, sizeof(chunk))) > 0) {
      if (!recordingEmitted) progressTail.append(chunk, static_cast<size_t>(bytes));
    }

    if (!recordingEmitted) {
      bool frameSeen = false;
      while (true) {
        const size_t marker = progressTail.find("progress=");
        if (marker == std::string::npos) break;
        const size_t end = progressTail.find('\n', marker);
        if (end == std::string::npos) break;
        const std::string report = progressTail.substr(0, end + 1);
        progressTail.erase(0, end + 1);
        if (progressShowsEncodedFrame(report, &mediaTimeUs)) {
          frameSeen = true;
          break;
        }
      }
      if (frameSeen) {
        recordingEmitted = true;
        emitLine("{\"type\":\"status\",\"state\":\"recording\",\"protocolVersion\":2,"
                 "\"startedAtMs\":" +
                 std::to_string(engine.startedAtMs()) + ",\"timestamp\":" + std::to_string(nowMs()) +
                 ",\"sourceType\":" + std::to_string(config.sourceType) +
                 ",\"nodeId\":" + std::to_string(config.nodeId) + ",\"cursorMode\":\"" +
                 config.cursorMode + "\",\"output\":\"" + jsonEscape(config.outputPath) + "\"}");
      } else if (nowMs() > recordingDeadline) {
        emitError("the encoder did not produce encoded frames");
        encoderFailed = true;
        break;
      }
    }

    int status = 0;
    if (waitpid(ffmpegPid, &status, WNOHANG) == ffmpegPid) {
      encoderFailed = true;
      break;
    }

    struct pollfd fds[2] = {};
    fds[0].fd = STDIN_FILENO;
    fds[0].events = POLLIN;
    fds[1].fd = externals.pollFd();
    fds[1].events = fds[1].fd >= 0 ? POLLIN : 0;

    const int ready = poll(fds, 2, 25);
    if (ready < 0 && errno != EINTR) break;

    externals.service();

    if (ready > 0 && (fds[0].revents & (POLLIN | POLLHUP | POLLERR))) {
      char buffer[128];
      const ssize_t bytes = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (bytes <= 0) {
        break;  // EOF means the parent exited; treat as stop
      }
      const std::string command(buffer, static_cast<size_t>(bytes));
      if (command.find("stop") != std::string::npos) {
        if (!engine.started()) stopBeforeFirstSample = true;
        break;
      }
      if (command.find("pause") != std::string::npos) {
        const int64_t mediaNs = engine.pause();
        if (!engine.error().empty()) {
          encoderFailed = true;
          break;
        }
        emitLine("{\"type\":\"status\",\"state\":\"paused\",\"protocolVersion\":2,"
                 "\"timestamp\":" +
                 std::to_string(nowMs()) + ",\"mediaTimeUs\":" + std::to_string(mediaNs / 1000) +
                 ",\"output\":\"" + jsonEscape(config.outputPath) + "\"}");
      } else if (command.find("resume") != std::string::npos) {
        const int64_t mediaNs = engine.resume();
        if (!engine.error().empty()) {
          encoderFailed = true;
          break;
        }
        emitLine("{\"type\":\"status\",\"state\":\"resumed\",\"protocolVersion\":2,"
                 "\"timestamp\":" +
                 std::to_string(nowMs()) + ",\"mediaTimeUs\":" + std::to_string(mediaNs / 1000) +
                 ",\"output\":\"" + jsonEscape(config.outputPath) + "\"}");
      }
    }
  }

  if (encoderFailed) {
    emitError(engine.error().empty() ? "the encoder failed during recording" : engine.error());
    kill(ffmpegPid, SIGTERM);
    waitForExit(ffmpegPid, 2000, nullptr);
    closeTransport();
    closeProgress();
    externals.close();
    return 6;
  }

  const long long stoppedAtMs = nowMs();
  engine.stop();
  if (!engine.error().empty()) {
    emitError(engine.error());
    kill(ffmpegPid, SIGTERM);
    waitForExit(ffmpegPid, 2000, nullptr);
    closeTransport();
    closeProgress();
    externals.close();
    return 3;
  }

  // A stop that arrived before the first sample never created a transport
  // pipeline; there is nothing to flush. Exit cleanly without capture-started
  // or recording, matching the plan's cancellation contract.
  if (stopBeforeFirstSample || !engine.started()) {
    kill(ffmpegPid, SIGTERM);
    waitForExit(ffmpegPid, 2000, nullptr);
    closeTransport();
    closeProgress();
    externals.close();
    return 0;
  }

  const long long flushDeadline = nowMs() + kTransportFlushTimeoutMs;
  while (!engine.transportEnded() && nowMs() < flushDeadline && engine.error().empty()) {
    char buffer[4096];
    while (read(progress[0], buffer, sizeof(buffer)) > 0) {}
    int status = 0;
    if (waitpid(ffmpegPid, &status, WNOHANG) == ffmpegPid) break;
    struct timespec sleepFor = {0, 10 * 1000000L};
    nanosleep(&sleepFor, nullptr);
  }

  if (!engine.error().empty() || !engine.transportEnded()) {
    emitError(engine.error().empty() ? "the encoder did not flush the transport" : engine.error());
    kill(ffmpegPid, SIGTERM);
    waitForExit(ffmpegPid, 2000, nullptr);
    closeTransport();
    closeProgress();
    externals.close();
    return 6;
  }

  // Every Matroska byte has been written to the pipe; let the encoder observe
  // EOF and flush its own trailer before we report success.
  close(transport[1]);
  transport[1] = -1;

  int ffmpegExit = 0;
  if (!waitForExit(ffmpegPid, kFfmpegExitTimeoutMs, &ffmpegExit, progress[0])) {
    kill(ffmpegPid, SIGTERM);
    if (!waitForExit(ffmpegPid, 5000, &ffmpegExit, progress[0])) {
      kill(ffmpegPid, SIGKILL);
      waitForExit(ffmpegPid, 2000, &ffmpegExit, progress[0]);
    }
    ffmpegExit = 6;
  }
  closeProgress();
  closeTransport();
  externals.close();

  if (ffmpegExit != 0) {
    emitError("the encoder exited with an error");
    return 6;
  }

  emitLine("{\"type\":\"status\",\"state\":\"stopped\",\"protocolVersion\":2,"
           "\"stoppedAtMs\":" +
           std::to_string(stoppedAtMs) + ",\"durationMs\":" +
           std::to_string(engine.durationNs() / 1000000) + ",\"exitCode\":0,\"timestamp\":" +
           std::to_string(nowMs()) + ",\"output\":\"" + jsonEscape(config.outputPath) + "\"}");
  return 0;
}
