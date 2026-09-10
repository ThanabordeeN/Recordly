#pragma once
#include <gst/gst.h>
GstElement* generatedAcquisition(unsigned audioTracks, int fps, int delayMs, bool idle,
                                 int jitterMs);
