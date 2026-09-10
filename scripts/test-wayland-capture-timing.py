#!/usr/bin/env python3
"""Opt-in live Wayland timing check (opens portal; records locally in /tmp).

Select a monitor, then leave it idle until the helper stops. Requires GStreamer,
FFmpeg, ffprobe and a built native helper. Does not test browser webcam/cursor.
Example: python3 scripts/test-wayland-capture-timing.py --system-audio @DEFAULT_MONITOR@
"""
import argparse
import json
import pathlib
import selectors
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--duration', type=float, default=25)
parser.add_argument('--tolerance', type=float, default=0.5)
parser.add_argument('--portal-timeout', type=float, default=150)
parser.add_argument('--system-audio')
parser.add_argument('--microphone')
parser.add_argument('--helper', default='electron/native/bin/linux-x64/recordly-wayland-capture')
args = parser.parse_args()
if args.duration <= 0 or args.tolerance < 0 or args.portal_timeout <= 0:
    parser.error('duration and portal-timeout must be positive; tolerance must be nonnegative')

folder = pathlib.Path(tempfile.mkdtemp(prefix='recordly-wayland-timing-'))
output = folder / 'screen.mp4'
command = [args.helper, '--output', str(output), '--fps', '60']
for flag, value in [('--system-audio', args.system_audio), ('--microphone', args.microphone)]:
    if value:
        command.extend([flag, value])
print(f'Artifacts: {folder}', flush=True)
started_at = None  # monotonic arrival of capture-started: the media epoch
started_event = None
ready_event = None
ready_lag = None
with (folder / 'stderr.log').open('w') as stderr, (folder / 'events.jsonl').open('w') as events:
    helper = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=stderr, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(helper.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + args.portal_timeout
    try:
        while helper.poll() is None and time.monotonic() < deadline:
            for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                line = key.fileobj.readline()
                if not line:
                    selector.unregister(key.fileobj)
                    continue
                print(line.strip(), flush=True)
                events.write(line)
                events.flush()
                event = json.loads(line)
                # The media timeline starts at the first sample, not at encoder
                # readiness: companions are started from the same epoch, so that
                # is what the recorded duration has to be measured against.
                if event.get('state') == 'capture-started' and started_at is None:
                    started_at = time.monotonic()
                    started_event = event
                    deadline = started_at + args.duration
                elif event.get('state') == 'recording' and started_at is not None and ready_lag is None:
                    ready_lag = time.monotonic() - started_at
                    ready_event = event
        stopped_at = time.monotonic()
        if helper.poll() is None:
            helper.stdin.write('stop\n')
            helper.stdin.flush()
            helper.stdin.close()
            helper.wait(timeout=35)
        remaining = helper.stdout.read()
        events.write(remaining)
        print(remaining, end='', flush=True)
    finally:
        if helper.poll() is None:
            helper.terminate()
            try:
                helper.wait(timeout=5)
            except subprocess.TimeoutExpired:
                helper.kill()
                helper.wait()
        selector.close()
if started_at is None:
    raise SystemExit('FAIL: no capture-started event before portal timeout/exit')
if ready_event is None:
    raise SystemExit('FAIL: capture started but the encoder never confirmed readiness')
if helper.returncode != 0:
    raise SystemExit(f'FAIL: helper exit {helper.returncode}; see stderr.log')
probe = json.loads(subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,start_time,duration', '-of', 'json', str(output)
], text=True))
video = next(float(s['duration']) for s in probe['streams'] if s['codec_type'] == 'video')
audio = [float(s['duration']) for s in probe['streams'] if s['codec_type'] == 'audio']
wall = stopped_at - started_at
summary = {'epochToStopSeconds': wall, 'videoSeconds': video, 'audioSeconds': audio,
           'videoMinusEpochWallSeconds': video - wall,
           # Readiness only confirms the encoder; it must never move the epoch.
           'encoderReadyLagSeconds': ready_lag,
           'startedEvent': started_event, 'readyEvent': ready_event,
           'toleranceSeconds': args.tolerance, 'scope': 'native helper only; no webcam/cursor'}
(folder / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
assert not (args.system_audio or args.microphone) or audio, 'FAIL: expected audio stream'
assert all(abs(a - video) <= args.tolerance for a in audio), 'FAIL: audio/video duration mismatch'
assert abs(video - wall) <= args.tolerance, 'FAIL: media boundary differs from the first-sample epoch'
print('PASS: native durations within tolerance (not a full webcam/cursor E2E)')
