// Recordly Wayland screen capture helper (KDE Plasma / KWin, native Wayland).
//
// Exists for one reason: to record without the system cursor burned into the
// frames. Chromium's getDisplayMedia always asks xdg-desktop-portal for an
// *embedded* cursor and offers no way to change it (`cursor` is not in
// getSupportedConstraints(), Electron's display-media callback carries only
// video/audio/enableLocalEcho, and no Chromium switch controls it). The portal
// itself supports hiding the cursor (KDE advertises AvailableCursorModes = 7),
// so this helper negotiates its own ScreenCast session with cursor_mode=hidden
// and Recordly draws its own cursor from telemetry instead.
//
// Acquisition is in-process: portal -> PipeWire -> GStreamer appsink callbacks.
// CaptureEngine normalizes every track against the first video sample's running
// time and multiplexes timestamped raw video + PCM into a single streamable
// Matroska pipe. The bundled ffmpeg binary performs the actual encoding.

#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "capture_runner.h"
#include "portal.h"

namespace {

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
           "\",\"timestamp\":" + std::to_string(
             [] { struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
                  return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL; }()) + "}");
}

/** Confirms the required GStreamer elements are registered before the portal
 *  dialog is shown, so a missing plugin is reported up front. */
bool probeElements(const std::vector<std::string> &names, std::string *problem) {
  for (const std::string &name : names) {
    GstElementFactory *factory = gst_element_factory_find(name.c_str());
    if (!factory) {
      if (name == "pipewiresrc") {
        *problem = "the GStreamer pipewiresrc element is missing "
                   "(Fedora: sudo dnf install gstreamer1-plugin-pipewire)";
      } else {
        *problem = "the GStreamer " + name + " element is missing";
      }
      return false;
    }
    gst_object_unref(factory);
  }
  return true;
}

GstElement *parseOrThrow(const std::string &description) {
  GError *error = nullptr;
  GstElement *element = gst_parse_launch(description.c_str(), &error);
  if (error) {
    std::string message = error->message;
    g_error_free(error);
    if (element) gst_object_unref(element);
    throw std::runtime_error(message);
  }
  if (!element) throw std::runtime_error("cannot create the acquisition pipeline");
  return element;
}

GstElement *buildPortalAcquisition(const PortalSession &session,
                                   const std::string &systemAudio,
                                   const std::string &microphone) {
  std::string description =
      "pipewiresrc fd=" + std::to_string(session.pipewireFd) +
      " path=" + std::to_string(session.nodeId) +
      // No keepalive resend: an idle screen sends no frames, and the engine
      // renders the last image at every CFR boundary anyway.
      " do-timestamp=true provide-clock=false ! video/x-raw,framerate=0/1 ! videoconvert ! "
      "video/x-raw,format=I420 ! appsink name=video ";

  unsigned audioIndex = 0;
  const auto appendAudio = [&](const std::string &device) {
    description += "pulsesrc name=audiosrc" + std::to_string(audioIndex) +
                   " provide-clock=false ! audioconvert ! audioresample ! "
                   "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
                   "appsink name=audio" + std::to_string(audioIndex) + " ";
    audioIndex++;
  };
  if (!systemAudio.empty()) appendAudio(systemAudio);
  if (!microphone.empty()) appendAudio(microphone);

  GstElement *pipeline = parseOrThrow(description);

  // Device names are user supplied and must not be parsed as pipeline syntax;
  // set them on the named elements after parsing.
  audioIndex = 0;
  const auto setDevice = [&](const std::string &device) {
    GstElement *src =
        gst_bin_get_by_name(GST_BIN(pipeline), ("audiosrc" + std::to_string(audioIndex)).c_str());
    if (src) {
      g_object_set(src, "device", device.c_str(), nullptr);
      gst_object_unref(src);
    }
    audioIndex++;
  };
  if (!systemAudio.empty()) setDevice(systemAudio);
  if (!microphone.empty()) setDevice(microphone);

  return pipeline;
}

}  // namespace

int main(int argc, char **argv) {
  setvbuf(stdout, nullptr, _IOLBF, 0);

  CaptureConfig config;
  config.fps = 60;
  PortalCursorMode cursorMode = PortalCursorMode::Hidden;
  std::string systemAudioDevice;
  std::string microphoneDevice;

  for (int i = 1; i < argc; i++) {
    const std::string flag = argv[i];
    const bool hasValue = i + 1 < argc;
    if (flag == "--output" && hasValue) {
      config.outputPath = argv[++i];
    } else if (flag == "--ffmpeg" && hasValue) {
      config.ffmpegPath = argv[++i];
    } else if (flag == "--system-audio" && hasValue) {
      systemAudioDevice = argv[++i];
    } else if (flag == "--microphone" && hasValue) {
      microphoneDevice = argv[++i];
    } else if (flag == "--fps" && hasValue) {
      config.fps = std::atoi(argv[++i]);
    } else if (flag == "--cursor-mode" && hasValue) {
      const std::string mode = argv[++i];
      cursorMode = mode == "embedded" ? PortalCursorMode::Embedded
                   : mode == "metadata" ? PortalCursorMode::Metadata
                                        : PortalCursorMode::Hidden;
    }
  }

  if (config.outputPath.empty()) {
    emitError("missing --output <path>");
    return 2;
  }
  if (config.fps < 1 || config.fps > 240) config.fps = 60;
  config.audioTracks =
      (systemAudioDevice.empty() ? 0u : 1u) + (microphoneDevice.empty() ? 0u : 1u);

  gst_init(&argc, &argv);

  // Probe before Start(): failing after the user has already picked a screen
  // is a needlessly confusing way to report a missing package.
  std::vector<std::string> required = {"pipewiresrc"};
  if (!systemAudioDevice.empty() || !microphoneDevice.empty()) required.push_back("pulsesrc");
  std::string probeProblem;
  if (!probeElements(required, &probeProblem)) {
    emitError(probeProblem);
    return 7;
  }

  emitLine("{\"type\":\"status\",\"state\":\"negotiating\",\"timestamp\":" +
           std::to_string(
             [] { struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
                  return static_cast<long long>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL; }()) +
           "}");

  PortalSession session;
  PortalError portalError;
  if (!portalOpenScreenCast(cursorMode, PortalSourceType::Monitor, &session, &portalError)) {
    emitError(portalError.message);
    return portalError.response == 1 ? 5 : 4;
  }

  config.hasPortal = true;
  config.nodeId = session.nodeId;
  config.sourceType = session.sourceType;
  config.cursorMode = cursorMode == PortalCursorMode::Hidden     ? "hidden"
                      : cursorMode == PortalCursorMode::Embedded ? "embedded"
                                                                  : "metadata";

  AcquisitionFactory factory = [&](const CaptureConfig &) -> GstElement * {
    return buildPortalAcquisition(session, systemAudioDevice,
                                  microphoneDevice);
  };

  CaptureExternals externals;
  externals.service = [&] { portalPumpScreenCast(&session); };
  externals.pollFd = [&] { return portalBusFd(&session); };
  externals.close = [&] { portalCloseScreenCast(&session); };

  return runCapture(config, factory, externals);
}
