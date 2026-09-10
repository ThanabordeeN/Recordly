#pragma once
#include <algorithm>
#include <cstdint>
#include <optional>
#include <stdexcept>

// All inputs are segment running-time nanoseconds, NOT raw PTS or wall time.
// PAUSED time is already removed by GStreamer. This class never subtracts it.
class CaptureTimeline {
  std::optional<int64_t> origin_;
  std::optional<int64_t> end_;
public:
  void anchor(int64_t runningTime) {
    if (runningTime < 0) throw std::runtime_error("invalid video running time");
    if (!origin_) origin_ = runningTime;
  }
  bool anchored() const { return origin_.has_value(); }
  int64_t origin() const { return origin_.value(); }
  std::optional<int64_t> normalize(int64_t runningTime) const {
    if (runningTime < 0) throw std::runtime_error("invalid sample running time");
    if (!origin_ || runningTime < *origin_) return {};
    const auto time = runningTime - *origin_;
    if (end_ && time >= *end_) return {};
    return time;
  }
  void stop(int64_t runningTime) {
    if (!end_) end_ = origin_ ? std::max<int64_t>(0, runningTime - *origin_) : 0;
  }
  int64_t end() const { return end_.value(); }
  int64_t clipDuration(int64_t time, int64_t duration) const {
    return end_ ? std::max<int64_t>(0, std::min(duration, *end_ - time)) : duration;
  }
};
