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
  `BrowserWindow.setBounds()` x/y is silently ignored. Recordly already handles
  this: on Linux the drag handle is `-webkit-app-region: drag` and the
  compositor moves the window, with `win.on("moved")` mirroring the result back
  into `hudUserPosition`. The IPC drag path returns early on Linux, and nothing
  re-applies bounds in response to a move, so there is no resize/position loop.
  The HUD therefore appears where KWin decides to put it and is dragged by the
  user rather than programmatically re-anchored. A proper fix needs a Wayland
  layer-shell surface, which is deliberately deferred.
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
