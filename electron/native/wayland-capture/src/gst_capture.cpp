#include "gst_capture.h"
#include "capture_timeline.h"

#include <gst/app/gstappsrc.h>
#include <gst/app/gstappsink.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace {

constexpr int64_t kSecond = GST_SECOND;
constexpr int64_t kAudioRate = 48000;
constexpr size_t kAudioFrameBytes = 4;  // S16LE interleaved stereo
constexpr size_t kVideoByteLimit = 128 * 1024 * 1024;
constexpr size_t kAudioByteLimit = 2 * kAudioRate * kAudioFrameBytes;  // 2 s of PCM
constexpr int64_t kReorderWindow = 100 * GST_MSECOND;

using Sample = std::shared_ptr<GstSample>;

struct Pending {
  Sample sample;
  int64_t time;  // segment running-time nanoseconds
  size_t bytes;
};

GstElement *parse(const std::string &description) {
  GError *error = nullptr;
  GstElement *element = gst_parse_launch(description.c_str(), &error);
  if (error) {
    std::string message = error->message;
    g_error_free(error);
    if (element) gst_object_unref(element);
    throw std::runtime_error(message);
  }
  if (!element) throw std::runtime_error("cannot create GStreamer pipeline");
  return element;
}

int64_t wallMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

int64_t sampleRunningTime(GstSample *sample) {
  GstBuffer *buffer = gst_sample_get_buffer(sample);
  const GstSegment *segment = gst_sample_get_segment(sample);
  if (!buffer || !GST_BUFFER_PTS_IS_VALID(buffer) || !segment ||
      segment->format != GST_FORMAT_TIME || segment->rate != 1.0 ||
      segment->applied_rate != 1.0)
    throw std::runtime_error("invalid sample timestamp or unsupported segment rate");

  const guint64 running =
      gst_segment_to_running_time(segment, GST_FORMAT_TIME, GST_BUFFER_PTS(buffer));
  if (!GST_CLOCK_TIME_IS_VALID(running) || running > static_cast<guint64>(INT64_MAX))
    throw std::runtime_error("sample timestamp is outside its segment");
  return static_cast<int64_t>(running);
}

struct CaptureEngine::Impl {
  struct Track {
    Impl *owner = nullptr;
    unsigned index = 0;
    std::deque<Pending> queue;
    size_t bytes = 0;
    int64_t lastTime = -1;
    GstCaps *caps = nullptr;
    GstElement *sink = nullptr;
    GstElement *src = nullptr;
    int64_t audioCursor = 0;  // integer PCM frames to avoid cumulative rounding
  };

  GstElement *acquisition;
  GstElement *transport = nullptr;
  GstClock *clock = nullptr;
  std::array<Track, 3> tracks;
  unsigned count;
  int fps;
  int fd;
  mutable std::mutex mutex;
  std::string problem;
  bool accepting = true;
  std::atomic<bool> abort{false};
  CaptureTimeline timeline;
  Sample lastVideo;
  int64_t videoFrame = 0;
  int64_t epoch = 0;
  int64_t pauseRunning = 0;
  bool paused = false;
  bool stopping = false;
  bool acceptedFirst = false;
  bool eos = false;

  Impl(GstElement *source, unsigned audioTracks, int frameRate, int outputFd)
      : acquisition(source), count(audioTracks + 1), fps(frameRate), fd(outputFd) {
    if (!acquisition || count > tracks.size() || fps < 1 || fps > 240)
      throw std::runtime_error("invalid capture configuration");

    const int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
      throw std::runtime_error("cannot make encoder transport nonblocking");

    clock = gst_system_clock_obtain();
    gst_pipeline_use_clock(GST_PIPELINE(acquisition), clock);

    for (unsigned i = 0; i < count; ++i) {
      Track &track = tracks[i];
      track.owner = this;
      track.index = i;
      track.sink = gst_bin_get_by_name(GST_BIN(acquisition),
                                       i == 0 ? "video" : ("audio" + std::to_string(i - 1)).c_str());
      if (!track.sink || !GST_IS_APP_SINK(track.sink))
        throw std::runtime_error("acquisition pipeline is missing appsink " +
                                 std::string(i == 0 ? "video" : ("audio" + std::to_string(i - 1))));

      // Each device branch must not wait on another branch's preroll.
      g_object_set(track.sink, "sync", FALSE, "async", FALSE, "max-buffers", 1u,
                   "enable-last-sample", FALSE, "wait-on-eos", FALSE, nullptr);
      GstAppSinkCallbacks callbacks{};
      callbacks.new_sample = receive;
      gst_app_sink_set_callbacks(GST_APP_SINK(track.sink), &callbacks, &track, nullptr);
    }
  }

  ~Impl() {
    abort = true;
    {
      std::lock_guard<std::mutex> lock(mutex);
      accepting = false;
    }
    gst_element_set_state(acquisition, GST_STATE_NULL);
    if (transport) gst_element_set_state(transport, GST_STATE_NULL);
    for (Track &track : tracks) {
      if (track.sink) gst_object_unref(track.sink);
      if (track.src) gst_object_unref(track.src);
      if (track.caps) gst_caps_unref(track.caps);
    }
    if (transport) gst_object_unref(transport);
    gst_object_unref(acquisition);
    gst_object_unref(clock);
  }

  void fail(const std::string &message) {
    std::lock_guard<std::mutex> lock(mutex);
    if (problem.empty()) problem = message;
  }

  std::string error() const {
    std::lock_guard<std::mutex> lock(mutex);
    return problem;
  }

  int64_t runningNow() const {
    if (paused) return pauseRunning;
    const guint64 base = gst_element_get_base_time(acquisition);
    const guint64 now = gst_clock_get_time(clock);
    return now >= base ? static_cast<int64_t>(now - base) : 0;
  }

  static GstFlowReturn receive(GstAppSink *sink, gpointer data) {
    Track &track = *static_cast<Track *>(data);
    Impl &self = *track.owner;
    Sample sample(gst_app_sink_pull_sample(sink), gst_sample_unref);
    if (!sample) return GST_FLOW_EOS;

    try {
      int64_t time = sampleRunningTime(sample.get());
      GstCaps *caps = gst_sample_get_caps(sample.get());
      GstBuffer *buffer = gst_sample_get_buffer(sample.get());
      if (!caps || !buffer) throw std::runtime_error("sample has no caps or buffer");
      const size_t size = gst_buffer_get_size(buffer);

      const guint64 now = gst_clock_get_time(self.clock);
      const guint64 base = gst_element_get_base_time(self.acquisition);
      // Reject samples whose segment time is ahead of the acquisition clock:
      // they came from a broken timestamp source, not a healthy live device.
      if (base > now || static_cast<guint64>(time) > now - base + kSecond)
        throw std::runtime_error("sample clock is ahead of acquisition clock");

      std::lock_guard<std::mutex> lock(self.mutex);
      if (!self.accepting) return GST_FLOW_OK;
      // A live source does not promise monotonic timestamps -- pipewiresrc came
      // back 161 ms early on KDE -- and nothing downstream needs it to: video
      // leaves as CFR frames counted off the pipeline clock, audio as a PCM
      // frame cursor. Keep only the queue order every consumer does assume.
      // ponytail: clamped silently, so a source that always runs backwards
      // freezes the image with no trace; log the step here if that needs it.
      if (track.lastTime > time) time = track.lastTime;
      if (track.caps && !gst_caps_is_equal(track.caps, caps))
        throw std::runtime_error("capture caps changed during recording");
      if (!track.caps) track.caps = gst_caps_ref(caps);
      track.lastTime = time;

      if (track.index == 0) {
        if (size > kVideoByteLimit / 3) throw std::runtime_error("video frame exceeds memory bound");
        // Preserve the first (epoch) image plus the newest pending image.
        // Replacing an intermediate image never retimestamps the survivors.
        while (track.queue.size() >= 3) {
          track.bytes -= track.queue[1].bytes;
          track.queue.erase(track.queue.begin() + 1);
        }
      } else {
        if (size % kAudioFrameBytes != 0 || size > kAudioByteLimit ||
            track.bytes + size > kAudioByteLimit ||
            (!track.queue.empty() && time - track.queue.front().time > 2 * kSecond))
          throw std::runtime_error("audio queue overflow or invalid PCM buffer");
      }
      track.bytes += size;
      track.queue.push_back({std::move(sample), time, size});
      return GST_FLOW_OK;
    } catch (const std::exception &e) {
      self.fail(e.what());
      return GST_FLOW_ERROR;
    }
  }

  static GstFlowReturn writeTransport(GstAppSink *sink, gpointer data) {
    Impl &self = *static_cast<Impl *>(data);
    Sample sample(gst_app_sink_pull_sample(sink), gst_sample_unref);
    if (!sample) return GST_FLOW_EOS;
    GstMapInfo map{};
    GstBuffer *buffer = gst_sample_get_buffer(sample.get());
    if (!buffer || !gst_buffer_map(buffer, &map, GST_MAP_READ)) {
      self.fail("cannot map Matroska transport buffer");
      return GST_FLOW_ERROR;
    }
    size_t offset = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (offset < map.size && !self.abort) {
      const ssize_t written = write(self.fd, map.data + offset, map.size - offset);
      if (written > 0) {
        offset += static_cast<size_t>(written);
        continue;
      }
      if (written < 0 && errno != EAGAIN && errno != EINTR) break;
      if (std::chrono::steady_clock::now() >= deadline) break;
      pollfd pfd{self.fd, POLLOUT, 0};
      poll(&pfd, 1, 20);
    }
    const bool complete = offset == map.size;
    gst_buffer_unmap(buffer, &map);
    if (!complete && !self.abort) self.fail("encoder transport closed or stalled for five seconds");
    return complete ? GST_FLOW_OK : GST_FLOW_ERROR;
  }

  void createTransport(GstCaps *videoCaps) {
    std::string description =
        "matroskamux name=mux streamable=true min-cluster-duration=0 "
        "max-cluster-duration=100000000 ! appsink name=output sync=false async=false "
        "max-buffers=1 enable-last-sample=false ";
    for (unsigned i = 0; i < count; ++i)
      description += "appsrc name=input" + std::to_string(i) +
                     " format=time is-live=true block=false ! mux." +
                     (i == 0 ? std::string("video_0") : "audio_" + std::to_string(i - 1)) + " ";

    transport = parse(description);
    gst_pipeline_use_clock(GST_PIPELINE(transport), clock);

    GstElement *sink = gst_bin_get_by_name(GST_BIN(transport), "output");
    if (!sink || !GST_IS_APP_SINK(sink)) {
      if (sink) gst_object_unref(sink);
      throw std::runtime_error("transport pipeline is missing its output appsink");
    }
    GstAppSinkCallbacks callbacks{};
    callbacks.new_sample = writeTransport;
    gst_app_sink_set_callbacks(GST_APP_SINK(sink), &callbacks, this, nullptr);
    gst_object_unref(sink);

    GstCaps *audioCaps = gst_caps_from_string(
        "audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2,"
        "channel-mask=(bitmask)0x3");
    for (unsigned i = 0; i < count; ++i) {
      Track &track = tracks[i];
      track.src = gst_bin_get_by_name(GST_BIN(transport), ("input" + std::to_string(i)).c_str());
      if (!track.src || !GST_IS_APP_SRC(track.src)) {
        if (track.src) gst_object_unref(track.src);
        track.src = nullptr;
        throw std::runtime_error("transport pipeline is missing appsrc input" + std::to_string(i));
      }
      gst_app_src_set_caps(GST_APP_SRC(track.src), i == 0 ? videoCaps : audioCaps);
      gst_app_src_set_max_bytes(GST_APP_SRC(track.src),
                                i == 0 ? kVideoByteLimit : kAudioByteLimit);
    }
    gst_caps_unref(audioCaps);

    if (gst_element_set_state(transport, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE)
      throw std::runtime_error("cannot start timestamped transport");
  }

  void push(unsigned index, GstBuffer *buffer, int64_t time, int64_t duration) {
    GstAppSrc *src = GST_APP_SRC(tracks[index].src);
    const guint64 level = gst_app_src_get_current_level_bytes(src);
    const size_t size = gst_buffer_get_size(buffer);
    if (level + size > (index == 0 ? kVideoByteLimit : kAudioByteLimit)) {
      gst_buffer_unref(buffer);
      throw std::runtime_error("encoder transport queue overflow");
    }
    GST_BUFFER_PTS(buffer) = time;
    GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(buffer) = duration;
    GST_BUFFER_OFFSET(buffer) = GST_BUFFER_OFFSET_NONE;
    GST_BUFFER_OFFSET_END(buffer) = GST_BUFFER_OFFSET_NONE;
    if (gst_app_src_push_buffer(src, buffer) != GST_FLOW_OK)
      throw std::runtime_error("encoder rejected timestamped sample");
  }

  Pending pop(Track &track) {
    Pending item = std::move(track.queue.front());
    track.queue.pop_front();
    track.bytes -= item.bytes;
    return item;
  }

  void audioTo(unsigned index, int64_t target) {
    Track &track = tracks[index];
    const int64_t endFrame = gst_util_uint64_scale(target, kAudioRate, kSecond);
    while (track.audioCursor < endFrame) {
      Sample sample;
      size_t byteOffset = 0;
      int64_t frames = std::min<int64_t>(480, endFrame - track.audioCursor);
      {
        std::lock_guard<std::mutex> lock(mutex);
        while (!track.queue.empty() && track.queue.front().time < timeline.origin())
          pop(track);  // pre-epoch audio is discarded
        if (!track.queue.empty()) {
          const Pending &item = track.queue.front();
          const int64_t start =
              gst_util_uint64_scale_round(item.time - timeline.origin(), kAudioRate, kSecond);
          const int64_t available = static_cast<int64_t>(item.bytes / kAudioFrameBytes);
          if (start + available <= track.audioCursor)
            throw std::runtime_error("audio arrived after its transport deadline");
          if (start <= track.audioCursor) {
            sample = item.sample;
            byteOffset = (track.audioCursor - start) * kAudioFrameBytes;
            frames = std::min(frames, available - (track.audioCursor - start));
            if (track.audioCursor + frames == start + available) pop(track);
          } else {
            // A gap: preserve it as leading silence rather than retiming audio.
            frames = std::min(frames, start - track.audioCursor);
          }
        }
      }
      GstBuffer *buffer =
          sample ? gst_buffer_copy_region(gst_sample_get_buffer(sample.get()),
                                          GST_BUFFER_COPY_MEMORY, byteOffset,
                                          frames * kAudioFrameBytes)
                 : gst_buffer_new_allocate(nullptr, frames * kAudioFrameBytes, nullptr);
      if (!buffer) throw std::runtime_error("cannot allocate PCM transport buffer");
      if (!sample) gst_buffer_memset(buffer, 0, 0, frames * kAudioFrameBytes);
      const int64_t time = gst_util_uint64_scale(track.audioCursor, kSecond, kAudioRate);
      track.audioCursor += frames;
      const int64_t end = gst_util_uint64_scale(track.audioCursor, kSecond, kAudioRate);
      push(index, buffer, time, end - time);
    }
  }

  void render(int64_t target, bool final) {
    const int64_t step = kSecond / fps;
    while (videoFrame * kSecond / fps < target) {
      const int64_t time = videoFrame * kSecond / fps;
      if (!final && time + step > target) break;
      {
        std::lock_guard<std::mutex> lock(mutex);
        Track &video = tracks[0];
        while (!video.queue.empty() && video.queue.front().time - timeline.origin() <= time)
          lastVideo = pop(video).sample;
      }
      if (!lastVideo) throw std::runtime_error("missing anchored video image");
      const int64_t duration = std::min(step, target - time);
      push(0, gst_buffer_copy(gst_sample_get_buffer(lastVideo.get())), time, duration);
      acceptedFirst = true;
      for (unsigned i = 1; i < count; ++i) audioTo(i, time + duration);
      ++videoFrame;
    }
  }

  void checkBus(GstElement *pipeline, bool isTransport) {
    if (!pipeline) return;
    GstBus *bus = gst_element_get_bus(pipeline);
    GstMessage *message;
    while ((message = gst_bus_pop_filtered(
                bus, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_EOS)))) {
      if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *err = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &err, &debug);
        fail(err ? err->message : "GStreamer pipeline error");
        if (err) g_error_free(err);
        g_free(debug);
      } else if (isTransport) {
        eos = true;
      } else if (!stopping) {
        fail("capture sources ended unexpectedly");
      }
      gst_message_unref(message);
    }
    gst_object_unref(bus);
  }

  void pump() {
    try {
      checkBus(acquisition, false);
      checkBus(transport, true);
      if (!error().empty() || stopping || paused) return;

      if (!timeline.anchored()) {
        Sample first;
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (tracks[0].queue.empty()) return;
          const Pending &item = tracks[0].queue.front();
          timeline.anchor(item.time);
          // Wall time is only an IPC bridge; every media decision stays native.
          // Subtracting the sample's running time from the current one recovers
          // how long ago it was captured, so this is as accurate here as it
          // would be in the callback.
          epoch = wallMs() - (runningNow() - item.time) / GST_MSECOND;
          first = item.sample;
        }
        createTransport(gst_sample_get_caps(first.get()));
        // Accept the epoch image immediately, like the native Mac/WGC writers.
        // The audio reorder window must not delay the first-sample notification.
        // Audio remains queued until render() reaches its ordinary deadline.
        {
          std::lock_guard<std::mutex> lock(mutex);
          lastVideo = pop(tracks[0]).sample;
        }
        push(0, gst_buffer_copy(gst_sample_get_buffer(lastVideo.get())), 0, kSecond / fps);
        videoFrame = 1;
        acceptedFirst = true;
      }

      const int64_t target =
          std::max<int64_t>(0, runningNow() - timeline.origin() - kReorderWindow);
      render(target, false);
    } catch (const std::exception &e) {
      fail(e.what());
    }
  }
};

CaptureEngine::CaptureEngine(GstElement *acquisition, unsigned audioTracks, int fps, int fd)
    : impl_(std::make_unique<Impl>(acquisition, audioTracks, fps, fd)) {}

CaptureEngine::~CaptureEngine() = default;

void CaptureEngine::start() {
  Impl &s = *impl_;
  if (!s.error().empty()) return;
  if (gst_element_set_state(s.acquisition, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE)
    s.fail("cannot start acquisition");
}

void CaptureEngine::pump() { impl_->pump(); }

bool CaptureEngine::started() const { return impl_->acceptedFirst; }

int64_t CaptureEngine::startedAtMs() const { return impl_->epoch; }

int64_t CaptureEngine::durationNs() const { return impl_->timeline.end(); }

std::string CaptureEngine::error() const { return impl_->error(); }

int64_t CaptureEngine::pause() {
  Impl &s = *impl_;
  if (!s.paused) {
    if (gst_element_set_state(s.acquisition, GST_STATE_PAUSED) == GST_STATE_CHANGE_FAILURE ||
        gst_element_get_state(s.acquisition, nullptr, nullptr, 2 * GST_SECOND) ==
            GST_STATE_CHANGE_ASYNC) {
      s.fail("capture pause failed or timed out");
    } else {
      // GstPipeline records exactly this running-time boundary at PAUSED.
      s.pauseRunning = gst_element_get_current_running_time(s.acquisition);
      s.paused = true;
    }
  }
  return s.timeline.anchored() ? std::max<int64_t>(0, s.pauseRunning - s.timeline.origin()) : 0;
}

int64_t CaptureEngine::resume() {
  Impl &s = *impl_;
  const int64_t boundary =
      s.timeline.anchored() ? std::max<int64_t>(0, s.pauseRunning - s.timeline.origin()) : 0;
  if (s.paused) {
    if (gst_element_set_state(s.acquisition, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
      s.fail("capture resume failed");
    } else {
      s.paused = false;
    }
  }
  return boundary;
}

void CaptureEngine::stop() {
  Impl &s = *impl_;
  if (s.stopping) return;
  s.timeline.stop(s.runningNow());
  s.stopping = true;
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    s.accepting = false;
  }
  if (gst_element_set_state(s.acquisition, GST_STATE_NULL) == GST_STATE_CHANGE_FAILURE)
    s.fail("cannot stop acquisition");
  if (!s.acceptedFirst || !s.error().empty()) return;
  try {
    // Latch the media end, stop accepting new samples, then drain only samples
    // that belong inside the requested interval. Repeat the last video image
    // through the end boundary and trim audio at the matching sample boundary.
    s.render(s.timeline.end(), true);
    for (unsigned i = 0; i < s.count; ++i) {
      if (gst_app_src_end_of_stream(GST_APP_SRC(s.tracks[i].src)) != GST_FLOW_OK)
        throw std::runtime_error("cannot send encoder EOS");
    }
  } catch (const std::exception &e) {
    s.fail(e.what());
  }
}

bool CaptureEngine::transportEnded() {
  impl_->checkBus(impl_->transport, true);
  return impl_->eos;
}
