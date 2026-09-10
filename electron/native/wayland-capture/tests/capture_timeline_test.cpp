#include "capture_timeline.h"
#include <iostream>
#include <stdexcept>
#define CHECK(x) do { if (!(x)) { std::cerr << __LINE__ << ": " #x "\n"; return 1; } } while (0)
int main() {
  CaptureTimeline t;
  CHECK(!t.normalize(4000000000LL));
  t.anchor(5000000000LL);
  CHECK(t.normalize(5000000000LL) == 0);
  CHECK(t.normalize(5020000000LL) == 20000000LL);
  CHECK(!t.normalize(4999999999LL));
  CHECK(t.normalize(5250000000LL) == 250000000LL);
  // GStreamer running time already excludes pause: never subtract it again.
  CHECK(t.normalize(8000000000LL) == 3000000000LL);
  CHECK(t.normalize(8020000000LL) == 3020000000LL);
  t.stop(30000000000LL);
  CHECK(t.end() == 25000000000LL);
  CHECK(!t.normalize(30000000000LL));
  CHECK(!t.normalize(31000000000LL));
  CHECK(t.clipDuration(24990000000LL, 20000000LL) == 10000000LL);
  CHECK(t.clipDuration(25000000000LL, 20000000LL) == 0);
  bool invalid = false;
  try { CaptureTimeline bad; bad.anchor(-1); } catch (const std::runtime_error&) { invalid = true; }
  CHECK(invalid);
  std::cout << "timeline: origin, late/pre-epoch audio, pause, stop clipping, invalid PTS passed\n";
}
