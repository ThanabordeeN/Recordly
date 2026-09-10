#pragma once
#include <gst/gst.h>
#include <cstdint>
#include <memory>
#include <string>

// Consumes an acquisition pipeline with appsinks named video, audio0, audio1.
// Ownership transfers to CaptureEngine. Both production and generated fixtures
// use this exact acquisition/normalization/transport implementation.
class CaptureEngine {
public:
  CaptureEngine(GstElement* acquisition, unsigned audioTracks, int fps, int transportFd);
  ~CaptureEngine();
  CaptureEngine(const CaptureEngine&) = delete;
  CaptureEngine& operator=(const CaptureEngine&) = delete;
  void start();
  void pump();
  int64_t pause();
  int64_t resume();
  void stop();
  bool transportEnded();
  bool started() const;
  int64_t startedAtMs() const;
  int64_t durationNs() const;
  std::string error() const;
private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Throws on invalid PTS, unsupported segments and out-of-segment samples.
int64_t sampleRunningTime(GstSample* sample);
