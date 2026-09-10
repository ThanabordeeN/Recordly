// Generated-source fixture. Runs the SAME CaptureEngine/transport/lifecycle as
// the production helper, but acquires from videotestsrc/audiotestsrc and can
// never invoke the desktop portal or a real screen/camera/microphone.
//
// Protocol and stdin commands (stop/pause/resume) are identical to production.

#include <cstdlib>
#include <string>

#include "capture_runner.h"
#include "generated_source.h"

int main(int argc, char **argv) {
  setvbuf(stdout, nullptr, _IOLBF, 0);

  CaptureConfig config;
  config.outputPath.clear();
  config.fps = 60;
  unsigned generatedAudio = 0;
  int delayMs = 0;
  int jitterMs = 0;
  bool idle = false;

  for (int i = 1; i < argc; i++) {
    const std::string flag = argv[i];
    const bool hasValue = i + 1 < argc;
    if (flag == "--output" && hasValue) {
      config.outputPath = argv[++i];
    } else if (flag == "--fps" && hasValue) {
      config.fps = std::atoi(argv[++i]);
    } else if (flag == "--ffmpeg" && hasValue) {
      config.ffmpegPath = argv[++i];
    } else if (flag == "--generated-audio" && hasValue) {
      generatedAudio = static_cast<unsigned>(std::atoi(argv[++i]));
    } else if (flag == "--video-delay-ms" && hasValue) {
      delayMs = std::atoi(argv[++i]);
    } else if (flag == "--jitter-ms" && hasValue) {
      jitterMs = std::atoi(argv[++i]);
    } else if (flag == "--idle-video") {
      idle = true;
    }
  }

  if (config.outputPath.empty()) {
    fputs("{\"type\":\"error\",\"message\":\"missing --output <path>\"}\n", stdout);
    return 2;
  }
  if (generatedAudio > 2) generatedAudio = 0;
  if (config.fps < 1 || config.fps > 240) config.fps = 60;

  config.audioTracks = generatedAudio;

  AcquisitionFactory factory = [&](const CaptureConfig &) -> GstElement * {
    return generatedAcquisition(generatedAudio, config.fps, delayMs, idle, jitterMs);
  };

  CaptureExternals externals;
  return runCapture(config, factory, externals);
}
