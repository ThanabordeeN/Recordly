// Generated GStreamer acquisition for the fixture executable.
//
// Builds the SAME acquisition shape the production helper uses (one video
// appsink named `video` plus optional audio appsinks named `audio0`/`audio1`),
// but drives it with videotestsrc/audiotestsrc instead of pipewiresrc/pulsesrc.
// This file must never touch the xdg-desktop-portal or any real device.

#include "generated_source.h"

#include <cstdint>
#include <stdexcept>
#include <string>

namespace {

struct VideoGate {
  GstElement *pipeline = nullptr;
  int64_t delayNs = 0;
  int64_t jitterNs = 0;
  bool idle = false;
  int passCount = 0;
};

GstPadProbeReturn gateProbe(GstPad *, GstPadProbeInfo *info, gpointer data) {
  auto *gate = static_cast<VideoGate *>(data);
  if (!(GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER)) return GST_PAD_PROBE_OK;

  if (gate->delayNs > 0) {
    const guint64 base = gst_element_get_base_time(gate->pipeline);
    GstClock *clock = gst_pipeline_get_clock(GST_PIPELINE(gate->pipeline));
    const guint64 now = clock ? gst_clock_get_time(clock) : 0;
    if (clock) gst_object_unref(clock);
    if (now < base || now - base < static_cast<guint64>(gate->delayNs))
      return GST_PAD_PROBE_DROP;  // video branch has not started yet
    gate->delayNs = 0;
  }

  if (gate->idle && gate->passCount >= 1) return GST_PAD_PROBE_DROP;
  gate->passCount += 1;

  // Reproduce the backwards timestamp step a real live source produces: every
  // tenth frame is handed over slightly behind its predecessor.
  if (gate->jitterNs > 0 && gate->passCount % 10 == 0) {
    GstBuffer *buffer = gst_buffer_make_writable(GST_PAD_PROBE_INFO_BUFFER(info));
    if (!buffer) return GST_PAD_PROBE_DROP;
    if (GST_BUFFER_PTS_IS_VALID(buffer) && GST_BUFFER_PTS(buffer) > (guint64)gate->jitterNs)
      GST_BUFFER_PTS(buffer) -= gate->jitterNs;
    GST_PAD_PROBE_INFO_DATA(info) = buffer;
  }
  return GST_PAD_PROBE_OK;
}

void destroyGate(gpointer data) { delete static_cast<VideoGate *>(data); }

GstElement *parseOrThrow(const std::string &description) {
  GError *error = nullptr;
  GstElement *element = gst_parse_launch(description.c_str(), &error);
  if (error) {
    std::string message = error->message;
    g_error_free(error);
    if (element) gst_object_unref(element);
    throw std::runtime_error(message);
  }
  if (!element) throw std::runtime_error("cannot create generated acquisition pipeline");
  return element;
}

}  // namespace

GstElement *generatedAcquisition(unsigned audioTracks, int fps, int delayMs, bool idle,
                                 int jitterMs) {
  if (audioTracks > 2) throw std::runtime_error("fixture supports at most two audio tracks");
  if (fps < 1 || fps > 240) throw std::runtime_error("invalid fixture frame rate");
  if (delayMs < 0) throw std::runtime_error("invalid fixture video delay");
  if (jitterMs < 0) throw std::runtime_error("invalid fixture timestamp jitter");

  std::string description =
      "videotestsrc name=videosrc pattern=smpte is-live=true ! "
      "video/x-raw,format=I420,width=640,height=360,framerate=" +
      std::to_string(fps) + "/1 ! appsink name=video ";
  for (unsigned i = 0; i < audioTracks; ++i) {
    description += "audiotestsrc name=audiosrc" + std::to_string(i) + " is-live=true wave=" +
                   (i == 0 ? "sine" : "square") + " freq=" + (i == 0 ? "440" : "220") +
                   " ! audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
                   "appsink name=audio" +
                   std::to_string(i) + " ";
  }

  GstElement *pipeline = parseOrThrow(description);
  GstElement *videosrc = gst_bin_get_by_name(GST_BIN(pipeline), "videosrc");
  if (!videosrc) {
    gst_object_unref(pipeline);
    throw std::runtime_error("generated pipeline is missing videotestsrc");
  }

  GstPad *pad = gst_element_get_static_pad(videosrc, "src");
  gst_object_unref(videosrc);
  if (!pad) {
    gst_object_unref(pipeline);
    throw std::runtime_error("generated videotestsrc has no src pad");
  }

  auto *gate = new VideoGate{pipeline, static_cast<int64_t>(delayMs) * GST_MSECOND,
                           static_cast<int64_t>(jitterMs) * GST_MSECOND, idle, 0};
  gst_pad_add_probe(pad, static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER), gateProbe,
                    gate, destroyGate);
  gst_object_unref(pad);
  return pipeline;
}
