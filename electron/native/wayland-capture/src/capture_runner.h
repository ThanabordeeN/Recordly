#pragma once

#include <gst/gst.h>
#include <functional>
#include <string>

// One capture session's configuration. Both the production helper and the
// generated fixture use this exact runner, so the lifecycle and v2 protocol
// cannot drift between them.
struct CaptureConfig {
  std::string outputPath;
  std::string ffmpegPath = "ffmpeg";
  int fps = 60;
  unsigned audioTracks = 0;
  // Portal metadata for the `recording` event. The fixture leaves these zero.
  bool hasPortal = false;
  unsigned nodeId = 0;
  unsigned sourceType = 0;
  std::string cursorMode = "hidden";
};

// Builds the acquisition pipeline. Ownership transfers to the runner, which
// hands it to CaptureEngine and destroys it at the end of the session.
using AcquisitionFactory = std::function<GstElement *(const CaptureConfig &)>;

// External connection (the desktop portal) that must be serviced while the
// pipeline runs. The fixture leaves both callbacks empty.
struct CaptureExternals {
  std::function<void()> service = [] {};
  std::function<int()> pollFd = [] { return -1; };
  std::function<void()> close = [] {};
};

// Runs one capture session to completion. Returns the helper exit code
// (0 success, 2 usage, 3 pipeline/encoder failure, 4/5 portal refusal, 6
// encoder failure).
int runCapture(const CaptureConfig &config, const AcquisitionFactory &factory,
               const CaptureExternals &externals);
