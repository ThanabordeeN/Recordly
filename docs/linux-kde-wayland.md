# Recordly on KDE Plasma Wayland

This documents the dedicated **Linux KDE / KWin native-Wayland build** of Recordly:
what it does differently, how to build it, what permissions it needs, and how to
verify cursor telemetry and Auto Zoom on a real Plasma session.

Target for V1: Linux · KDE Plasma · KWin · native Wayland · x86_64 · Fedora-compatible · AppImage.
GNOME and generic wlroots compositors are explicitly out of scope for V1.

## Why a separate build

Screen capture already works on Wayland through the XDG desktop portal
(`screen:linux-portal` → `getDisplayMedia()` → `xdg-desktop-portal` → PipeWire).
**Cursor telemetry did not.**

On KWin Wayland the legacy Linux path is structurally broken:

- `uiohook-napi` reads the X11 pointer, so under Wayland it only ever sees
  XWayland's stale idea of the cursor;
- Electron's `screen.getCursorScreenPoint()` only updates while the pointer is
  over one of Recordly's own surfaces — no Wayland client may query the global
  pointer position;
- the old code then divided those coordinates by the primary display's
  `scaleFactor`, which Chromium reports as `1.7496962547302246` for a 175%
  output, throwing the point far off-screen.

Measured symptom: hundreds of move samples collapsing to only ~15–50 unique
positions, and missing clicks. Auto Zoom depends on both, so it produced nothing
usable.

## Architecture

```
KWin (compositor, knows the real pointer position)
  └── recordly-cursor-bridge.js          KWin script, loaded over D-Bus
        │  workspace.cursorPosChanged  →  callDBus(...)
        ▼
  org.recordly.WaylandCursorBridge      session-bus name owned by the helper
  └── recordly-wayland-cursor            long-running C++ helper
        ├── D-Bus: absolute cursor position + output layout
        └── libinput (/dev/input/event*): BTN_LEFT / BTN_RIGHT / BTN_MIDDLE
        │  merged, stamped, written as JSON lines on stdout
        ▼
  Electron main process
  ├── latestWaylandCursorPoint  (electron/ipc/state.ts)
  ├── normalizeWaylandCursorPoint  (electron/ipc/cursor/waylandCoordinates.ts)
  └── existing pushCursorSample / recordCursorMouseDown / recordCursorMouseUp
        ▼
  <recording>.cursor.json  →  unchanged Auto Zoom + editor pipeline
```

Nothing polls. `workspace.cursorPosChanged` fires on real pointer motion, and
the helper's event loop blocks in `poll()` on the bus fd, stdin, an inotify
watch of `/dev/input`, and the open pointer devices. No `qdbus`/`busctl`
subprocess is ever spawned per sample.

### Coordinate mapping

KWin reports the pointer in its **global logical coordinate space**. Each output
sits at its configured logical position and has a logical size of
`mode size ÷ scale`. The KWin bridge also reports that layout, so normalization
happens entirely inside KWin's own space:

```
cx = (pointer.x − output.x) / output.width
cy = (pointer.y − output.y) / output.height
```

Because the scale is already divided out of the logical geometry, this is
correct for 100%, 125%, 150%, fractional scaling, negative monitor origins, and
multi-monitor layouts without ever touching `scaleFactor`. The captured Electron
display is matched to a KWin output by exact rect, then overlap, then output
name, then layout order (`matchWaylandOutputForDisplay`).

## Building

```bash
# just the native helper (Linux only)
npm run build:wayland-cursor

# the full dedicated artifact
npm run build:linux-wayland
# → release/Recordly-wayland-kde-linux-x64.AppImage
```

`electron-builder.wayland.json5` differs from the normal config in three ways:

- it ships `recordly-build-variant.json` in the resources directory — the
  runtime flag. (Deliberately a resource file rather than electron-builder's
  `extraMetadata`, which rewrites the source `package.json` in place and strips
  its `scripts`.);
- `!node_modules/uiohook-napi/**` — the X11 hook is not shipped at all;
- `electron/native/wayland-cursor/kwin/**` is unpacked from the asar, because
  KWin loads the bridge script by filesystem path.

The normal `npm run build`, `build:mac`, `build:win`, and `build:linux` targets
are unchanged.

### Build dependencies (Fedora)

```bash
sudo dnf install cmake gcc-c++ systemd-devel
```

`systemd-devel` provides `sd-bus`, which the helper uses for the session bus.
If CMake or the headers are missing, `scripts/build-wayland-cursor.mjs` reuses
the helper already staged at `electron/native/bin/linux-x64/` instead of failing
the build.

## Runtime dependencies

| Component | Requirement |
| --- | --- |
| Session | `XDG_SESSION_TYPE=wayland` on KDE Plasma (KWin 6 tested on 6.7.4) |
| D-Bus | a session bus (`DBUS_SESSION_BUS_ADDRESS`) |
| KWin | `org.kde.KWin` `/Scripting` interface (standard Plasma) |
| libsystemd | `libsystemd.so.0` — present on every systemd distro |
| libinput | `libinput.so.10` — dlopen'd for button events; present on every Wayland session |
| Capture | `xdg-desktop-portal` + `xdg-desktop-portal-kde` + PipeWire (unchanged) |

No root. No `sudo`. Nothing is installed into the compositor permanently: the
KWin script is loaded when a recording starts and unloaded when it stops or when
Recordly quits.

## Permission setup: `/dev/input` for click detection

Mouse **button** events come from libinput reading the pointer device nodes,
which needs read access to them. On Fedora those are `root:input` mode `0660`,
so your user must be in the `input` group.

```bash
# check
id -nG | tr ' ' '\n' | grep -x input

# grant (log out and back in afterwards — group changes need a new session)
sudo usermod -aG input "$USER"
```

Recordly **never** changes groups or permissions itself. If access is denied it
logs an actionable message and keeps running:

```
[CursorTelemetry] Mouse button capture unavailable: permission denied for /dev/input/event4
Auto Zoom click detection will be unavailable. Add your user to the 'input' group
(see docs/linux-kde-wayland.md) and log back in.
```

Cursor **movement** telemetry does not use evdev at all and keeps working in
that state; only click/mouseup events (and therefore click-driven Auto Zoom) are
lost.

### Why libinput and not raw evdev

On a laptop touchpad, **tap-to-click produces no kernel button event at all**.
libinput synthesises the button in userspace, which is why KWin registers a
click while a raw evdev reader sees nothing. Measured on this hardware: during a
burst of taps, a raw evdev watcher on the touchpad, mouse, and virtual pointer
recorded **0** `BTN_*` events alongside 721 motion events.

Reading through libinput therefore isn't a refinement, it's a correctness
requirement — and it also brings clickfinger mapping (two-finger tap = right
button), button areas, and palm rejection, so the helper records exactly the
buttons the compositor acted on. Physical mouse and physical touchpad presses
work identically through either path.

libinput is `dlopen`'d rather than linked: no `libinput-devel` is needed to
build, and a system without the library degrades to
`button-capture-unavailable` instead of failing to start.

Per-device settings are read from `~/.config/kcminputrc`
(`[Libinput][<vendor>][<product>][<name>]`) so the helper's idea of a click
matches Plasma's: `TapToClick`, `LmrTapButtonMap`, and `ClickMethod` are applied
to the libinput device. If you turn tap-to-click off in System Settings, a tap
stops producing telemetry too.

### What the helper opens, and what it ignores

- A device is handed to libinput only if it exposes pointer axes (`REL_X`/`REL_Y`
  or `ABS_X`/`ABS_Y`) **and** `BTN_LEFT`, and anything that also reports
  alphabetic key codes is screened out first — so this process never holds a
  file descriptor that could carry typed input.
- In the event loop only `BTN_LEFT`, `BTN_RIGHT`, and `BTN_MIDDLE` are acted on.
  Every other libinput event, including all key events, is destroyed without
  being inspected or logged.
- libinput never takes an exclusive grab, so the compositor keeps receiving the
  same input.
- No raw input contents are ever written to the log.

## Manual test procedure (KDE Wayland machine)

### 1. Helper-level check, no app build required

```bash
npm run build:wayland-cursor
RECORDLY_LIVE_WAYLAND_TEST=1 npx vitest --run electron/ipc/cursor/waylandKdeLive.test.ts
```

Move the mouse continuously and click ~10 times during the 12-second collection
window. It prints the KWin output layout and asserts that unique positions and
paired press/release counts are sane. Expect several hundred unique positions
from a few seconds of movement.

Run the helper by hand for raw output:

```bash
electron/native/bin/linux-x64/recordly-wayland-cursor \
  --kwin-script electron/native/wayland-cursor/kwin/recordly-cursor-bridge.js
```

### 2. Full recording check

Launch `Recordly-wayland-kde-linux-x64.AppImage` and confirm the startup log:

```
[Wayland] compositor: KDE/KWin
[CursorTelemetry] backend: linux-kde-wayland
```

Record a monitor through the portal and perform:

- 10 left clicks,
- 2 double-click sequences,
- continuous cursor movement across the screen.

Then:

```bash
f=$(ls -t ~/.config/Recordly/recordings/*.cursor.json | head -1)

jq '{
  total: (.samples | length),
  unique_positions: ([.samples[] | [.cx,.cy]] | unique | length),
  interactions: (
    [.samples[].interactionType]
    | group_by(.)
    | map({type: .[0], count:length})
  )
}' "$f"
```

Expected: `unique_positions` in the hundreds (not 15–50); `click` +
`double-click` totalling ~12 with a matching number of `mouseup` entries; Auto
Zoom in the editor producing zoom regions around the clicked positions.

### 3. X11 rejection check

Log into a **Plasma (X11)** session and launch the same AppImage. It must show
an error dialog and exit rather than falling back to uiohook.

### 4. Forcing the backend in a source checkout

```bash
RECORDLY_BUILD_VARIANT=linux-kde-wayland npm run dev
# or, without the X11 rejection:
RECORDLY_CURSOR_BACKEND=linux-kde-wayland npm run dev
```

## HUD behaviour and known limitations

- **HUD positioning.** Wayland forbids client-side window placement, so
  `BrowserWindow.setBounds()` x/y is silently ignored. On KDE/KWin, the
  existing KWin bridge script now watches the uniquely titled `Recordly HUD`
  window and assigns its `frameGeometry` to the bottom-center of the active
  work area. The bridge starts at application startup with `--no-buttons`, so
  the placement is active before the HUD surface appears; it is also loaded
  again when recording starts for cursor telemetry. Popover resize remains in
  Electron, while KWin keeps the resized window bottom-anchored.
- **Window capture targets.** Cursor coordinates are normalized to the captured
  *monitor*. Recordly cannot read another window's geometry on Wayland, so if a
  window source is selected the point is normalized to the output the cursor is
  on. Monitor capture — the normal Wayland flow — is exact.
- **Portal screen choice.** The portal dialog lets the user pick a different
  screen than the one pre-selected in Recordly. When that happens, telemetry is
  normalized to the pre-selected monitor. This is pre-existing behaviour of the
  portal path.
- **Cursor visual type.** `cursorType` (arrow/text/pointer/…) has no Wayland
  source; there is no protocol for reading the compositor's cursor shape. It
  stays `undefined`, exactly as it did on Linux before. Auto Zoom does not use it.
- **Hot-plug.** A mouse plugged in mid-recording is picked up via an inotify
  watch on `/dev/input`. A device unplugged mid-recording simply stops
  delivering events.
- **Touchpad settings are read once**, when the helper starts. Changing
  tap-to-click in System Settings mid-recording is not picked up until the next
  recording.
- **Compositor scope.** Only KDE/KWin in V1. On GNOME or wlroots the normal
  build stays on the existing uiohook path.

## Cursor-free capture (`recordly-wayland-capture`)

The desktop portal embeds the system cursor into every captured frame, so a
recording made through Chromium's `getDisplayMedia` shows two cursors: the real
one and the one Recordly draws from telemetry. Chromium cannot be asked to
change that. Measured on this machine:

- `cursor` is **not** in `navigator.mediaDevices.getSupportedConstraints()` --
  the `cursor: "never"` constraint Recordly passes is silently discarded;
- Electron's display-media callback accepts only `video`, `audio` and
  `enableLocalEcho`;
- Chromium ships no switch for it (only `OpenPipeWireRemote`,
  `pipewire-main-loop`, `WebRtcPipeWireCamera` mention PipeWire at all).

The portal itself is perfectly capable -- KDE reports
`AvailableCursorModes = 7` (hidden | embedded | metadata) -- so
`recordly-wayland-capture` negotiates its own ScreenCast session and asks for
`cursor_mode=hidden`:

```
portal ScreenCast (cursor_mode=hidden)   sd-bus, no external deps
  -> PipeWire node
  -> in-process GStreamer pipeline (appsink callbacks)  moves pixels only
       screen + system audio + microphone, one clock
  -> timestamped raw video/PCM muxed into one Matroska pipe
  -> ffmpeg (the one Recordly already bundles)          does the encoding
  -> H.264 mp4
```

The helper links GStreamer directly rather than spawning `gst-launch-1.0`,
because every track has to share one epoch: the running time of the **first
valid video sample**. That epoch is what the `capture-started` event carries,
and it is what the cursor telemetry and the webcam recorder start against.
Encoded-output readiness only *confirms* the start; it never redefines it.
This is the same shape macOS (first video sample timestamp) and Windows WGC
(first written frame) already use.

Getting that wrong is what made webcam and cursor run ~4.3 s longer than the
screen: readiness was measured after FFmpeg had probed and encoded, several
seconds after pixels started flowing.

### Verifying it by hand

```bash
npm run build:wayland-capture
electron/native/bin/linux-x64/recordly-wayland-capture   --output /tmp/test.mp4   --ffmpeg node_modules/ffmpeg-static/ffmpeg   --cursor-mode hidden --fps 60
# pick a screen in the portal dialog, then type "stop" and press enter
```

Confirm the cursor really is absent by cropping the frame at the position the
cursor helper reports, at full resolution -- a downscaled frame is not proof, a
cursor is only about 24 px wide.

`scripts/test-wayland-capture-timing.py` does the timing half of this
automatically. Measured on this machine, 2026-09-10, 25 s idle with system
audio: video 25.033 s, audio 25.033 s, **32 ms** from the first-sample epoch to
the stop boundary. The encoder confirmed readiness 553 ms after that epoch --
which is precisely the lag that must not reach the companion clocks, and the
reason the old file-size gate put webcam and cursor about 4.3 s out.

### Extra runtime dependency

This path needs `gstreamer1`, `gstreamer1-plugins-base` and
`gstreamer1-plugin-pipewire`, which Plasma already pulls in (the helper links
`libgstreamer-1.0` and `libgstapp-1.0`, so the first two are load-time
requirements, not just element lookups). Building it additionally needs
`gstreamer1-devel` and `gstreamer1-plugins-base-devel`; without them
`npm run build:wayland-capture` reports the missing modules and keeps the
bundled helper instead of failing in CMake. The helper probes for them *before* showing the portal dialog
and exits with code 7 and an actionable message if either is missing, so a
machine without them falls back to the existing browser capture instead of
failing mysteriously after the user has picked a screen.

### Three mistakes worth not repeating

Both were found the hard way and both produced a recording of *something else*
rather than an obvious failure:

- **The portal session dies with the D-Bus connection.** Closing the connection
  after negotiating tears the session down, and the PipeWire node is gone before
  a frame arrives. The connection is held open for the whole recording and
  polled alongside stdin.
- **The node id only means something on the portal's own remote.** Connecting to
  the session daemon and reusing the number there resolves to an unrelated node
  -- in testing it landed on this process's own client object, and the resulting
  file was not the screen at all. `pipewiresrc` is always given the portal's
  descriptor (`fd=`), and the daemon route has been removed rather than left as
  a fallback.

- **A live source does not promise monotonic timestamps.** The engine used to
  treat a sample arriving behind its predecessor as a broken clock and end the
  recording. On KDE, `pipewiresrc` hands back video samples tens of
  milliseconds early routinely, and 161 ms early was measured twenty seconds
  into an idle capture -- a perfectly good take died with exit 6. Nothing
  downstream needs monotonic input: video leaves as CFR frames counted off the
  pipeline clock, audio as a PCM frame cursor, so a sample's own time only
  decides which image is current and where PCM lands against the epoch. The
  time is clamped to keep the queue ordered and the helper says so once per
  track on stderr.

A related trap: `dup2(fd, fd)` is a no-op that does **not** clear `FD_CLOEXEC`,
so a descriptor that already happens to sit at the target number silently
disappears at `exec`. The flag is cleared explicitly.

A capture that looks plausible is not evidence. Check the stream size against
the monitor's real pixel size, and crop the frame at the position the cursor
helper reports -- at full resolution, since a cursor is only about 24 px wide.

### Safety: the source is always checked

A portal restore token replays whatever the previous session selected. In
testing, a token produced a stream whose geometry matched no connected monitor
while the portal still reported a monitor source type. Both the helper and the
main process therefore verify `source_type == MONITOR` and refuse to record
anything else, and restore tokens are **off by default** -- the picker costs one
click and is what Recordly already does today.

### Audio

System audio and the microphone are captured by the same GStreamer pipeline via
`pulsesrc` (PipeWire's PulseAudio compatibility), rebased against the same video
epoch, and carried as timestamped PCM in the shared Matroska pipe. With both
enabled ffmpeg mixes them into one track. Pass the source names with
`--system-audio` (normally `<default sink>.monitor`) and `--microphone`.

Audio samples that predate the first video sample are dropped rather than
shifted, so a microphone that opens early cannot push the whole timeline.

### How it is wired into the recording UI

`useScreenRecorder.ts` branches on Linux before the browser path: it asks
`evaluateWaylandCapture()`, and when the answer is yes it runs
`startWaylandCaptureWithBoundary()` (`src/hooks/waylandCaptureStartup.ts`),
which subscribes to `wayland-capture-started` *before* starting the helper.
On that event the renderer resets the recording clock to the helper's epoch and
starts the webcam recorder; the main process sets its own recording state with
the same epoch, so cursor telemetry shares it. If the event never arrives, or
the epoch changes, startup fails loudly rather than recording a mismatched set
of tracks.

Because the decision is now a user preference rather than an experiment, a
requested cursor-free recording that cannot start surfaces an error instead of
silently falling back to the browser path with a visible system cursor.

### Testing it without a desktop

The generated-source fixture runs the *production* capture engine with
synthetic video/PCM and no portal, so it needs no permission dialog:

```bash
PKG_CONFIG_PATH=/usr/lib64/pkgconfig npm run build:wayland-capture
python3 electron/native/wayland-capture/tests/generated_capture_test.py \
  --fixture electron/native/wayland-capture/build/recordly-wayland-capture-fixture \
  --artifacts /tmp/recordly-fixture
```

It covers video-only, each audio input, both, a delayed first frame,
pause/resume, early cancellation, encoder failure, a 25 s idle screen and a
30 s run that would fill an undrained progress pipe, and asserts decoded packet
timestamps with ffprobe. Add `--quick` to skip the two long cases.

`scripts/test-wayland-capture-timing.py` is the opt-in live counterpart: it
opens the portal picker and needs a real monitor, so it is never part of an
unattended run.

## Follow-up work for generic Wayland

The backend abstraction (`electron/ipc/cursor/backend.ts`) is shaped so another
compositor can be added without touching telemetry or Auto Zoom:

- add a `linux-gnome-wayland` variant backed by a GNOME Shell extension
  exposing the pointer over D-Bus (the mirror image of the KWin script);
- add a `linux-wlroots-wayland` variant using
  `wlr-virtual-pointer`/`ext-idle`-style protocols or libinput;
- both would reuse `waylandCoordinates.ts`, `waylandProtocol.ts`, and the evdev
  button path in the helper unchanged — only the position source differs;
- a layer-shell HUD surface would remove the positioning limitation for every
  Wayland compositor at once.
