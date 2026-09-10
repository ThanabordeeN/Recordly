#!/usr/bin/env python3
"""Measure screen/webcam/cursor alignment of a finished recording session.

Reads what the app already writes next to the screen video: the session
manifest (webcam file + its offset from the capture epoch) and the cursor
telemetry sidecar. Nothing here records anything or touches the portal.

  python3 scripts/check-wayland-session-timing.py            # newest session
  python3 scripts/check-wayland-session-timing.py --session ~/.../recording-123.mp4
"""
import argparse
import json
import pathlib
import subprocess

DEFAULT_DIR = pathlib.Path.home() / '.config' / 'Recordly' / 'recordings'
MANIFEST = '.recordly-session.json'

parser = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--recordings', type=pathlib.Path, default=DEFAULT_DIR)
parser.add_argument('--session', type=pathlib.Path)
parser.add_argument('--tolerance', type=float, default=0.3, help='seconds')
args = parser.parse_args()


def duration(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                                   'format=duration', '-of', 'json', str(path)], text=True)
    return float(json.loads(out)['format']['duration'])


if args.session:
    video = args.session
    manifest_path = video.parent / (video.stem + MANIFEST)
else:
    manifests = sorted(args.recordings.glob('*' + MANIFEST), key=lambda p: p.stat().st_mtime)
    if not manifests:
        raise SystemExit(f'FAIL: no session manifest in {args.recordings}')
    manifest_path = manifests[-1]
    video = None

manifest = json.loads(manifest_path.read_text())
folder = manifest_path.parent
video = video or folder / manifest['videoFileName']
webcam = folder / manifest['webcamFileName']
offset = manifest.get('timeOffsetMs', 0) / 1000
if not video.is_file() or not webcam.is_file():
    raise SystemExit(f'FAIL: session files missing for {manifest_path.name}')

screen = duration(video)
camera = duration(webcam)
# The webcam starts `offset` after the capture epoch and stops with the screen,
# so its own length is the screen length minus that offset.
camera_error = camera + offset - screen

telemetry = folder / (video.name + '.cursor.json')
samples = json.loads(telemetry.read_text())['samples'] if telemetry.is_file() else []
first = samples[0]['timeMs'] / 1000 if samples else None
last = samples[-1]['timeMs'] / 1000 if samples else None
# A dead backend still pushes samples on a timer, all at the fallback centre.
# Without this, an empty telemetry file passes every timing check.
positions = {(round(s['cx'], 4), round(s['cy'], 4)) for s in samples}
clicks = sum(1 for s in samples if s.get('interactionType') not in (None, 'move'))

report = {'session': manifest_path.name, 'screenSeconds': screen,
          'webcamSeconds': camera, 'webcamOffsetSeconds': offset,
          'webcamErrorSeconds': camera_error, 'cursorSamples': len(samples),
          'cursorFirstSeconds': first, 'cursorLastSeconds': last,
          'cursorEndErrorSeconds': None if last is None else last - screen,
          'cursorDistinctPositions': len(positions), 'cursorClickSamples': clicks,
          'toleranceSeconds': args.tolerance}
print(json.dumps(report, indent=2))

failures = []
if abs(camera_error) > args.tolerance:
    failures.append(f'webcam is {camera_error:+.3f}s off the screen timeline')
if not samples:
    failures.append('no cursor telemetry sidecar')
else:
    if first > args.tolerance:
        failures.append(f'cursor telemetry starts {first:.3f}s late')
    if abs(last - screen) > args.tolerance:
        failures.append(f'cursor telemetry ends {last - screen:+.3f}s off the screen timeline')
    if len(positions) <= 1:
        failures.append(f'cursor never moved ({positions.pop()}): the telemetry backend was dead')
if failures:
    raise SystemExit('FAIL: ' + '; '.join(failures))
if not clicks:
    print('NOTE: no click samples; move the mouse AND click during the run to cover buttons')
print('PASS: webcam and cursor share the screen timeline within tolerance')
