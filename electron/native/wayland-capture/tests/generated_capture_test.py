#!/usr/bin/env python3
"""Native/protocol integration. Never invokes the portal executable or devices."""
import argparse
import json
import pathlib
import selectors
import subprocess
import time


def run_case(binary, root, name, audio=0, duration=1.2, delay=0, pause=False,
             early=False, encoder=None, idle=False, jitter=0):
    output = root / (name + '.mp4')
    args = [binary, '--output', str(output), '--fps', '30',
            '--generated-audio', str(audio), '--video-delay-ms', str(delay),
            '--jitter-ms', str(jitter)]
    if idle:
        args += ['--idle-video']
    if encoder:
        args += ['--ffmpeg', encoder]
    start = time.monotonic()
    events = []
    with (root / (name + '.stderr')).open('w') as err:
        p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=err, text=True, bufsize=1)
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)
        try:
            first_at = None
            paused_at = None
            resumed = False
            sent_stop = False
            while p.poll() is None:
                elapsed = time.monotonic() - start
                assert elapsed < duration + delay / 1000 + 25, (name, 'timeout', events)
                if early and elapsed > 0.1 and not sent_stop:
                    p.stdin.write('stop\n'); p.stdin.flush(); sent_stop = True
                if first_at and pause and not paused_at and time.monotonic() - first_at > .4:
                    p.stdin.write('pause\n'); p.stdin.flush(); paused_at = time.monotonic()
                if paused_at and not resumed and time.monotonic() - paused_at > .5:
                    p.stdin.write('resume\n'); p.stdin.flush(); resumed = True
                if first_at and not sent_stop and time.monotonic() - first_at > duration + (.5 if pause else 0):
                    p.stdin.write('stop\n'); p.stdin.flush(); sent_stop = True
                for key, _ in selector.select(.01):
                    line = key.fileobj.readline()
                    if line:
                        event = json.loads(line); events.append(event)
                        if event.get('state') == 'capture-started':
                            first_at = time.monotonic()
            events += [json.loads(line) for line in p.stdout.read().splitlines()]
            (root / (name + '.json')).write_text(json.dumps(events, indent=2))
            states = [e.get('state') for e in events]
            if encoder:
                assert p.returncode != 0 and 'stopped' not in states, events
                assert any(e.get('type') == 'error' for e in events), events
                return
            assert p.returncode == 0, (name, p.returncode, events)
            if early:
                assert 'capture-started' not in states and 'recording' not in states, events
                return
            assert states.count('capture-started') == states.count('recording') == states.count('stopped') == 1, events
            assert states.index('capture-started') < states.index('recording'), events
            first = next(e for e in events if e.get('state') == 'capture-started')
            ready = next(e for e in events if e.get('state') == 'recording')
            stop = next(e for e in events if e.get('state') == 'stopped')
            assert first['protocolVersion'] == ready['protocolVersion'] == stop['protocolVersion'] == 2
            assert first['startedAtMs'] == ready['startedAtMs']
            assert 0 <= first['timestamp'] - first['startedAtMs'] < 500, first
            assert first['timestamp'] <= ready['timestamp']
            expected = stop['durationMs'] / 1000
            assert abs(expected - duration) < .1, (expected, duration)
            if pause:
                a = next(e for e in events if e.get('state') == 'paused')
                b = next(e for e in events if e.get('state') == 'resumed')
                assert a['mediaTimeUs'] == b['mediaTimeUs'], events
            probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams',
                                                       '-show_format', '-of', 'json', str(output)], text=True))
            (root / (name + '.probe.json')).write_text(json.dumps(probe, indent=2))
            assert len(probe['streams']) == (2 if audio else 1), probe
            for stream in probe['streams']:
                assert abs(float(stream['duration']) - expected) <= .1, (name, expected, stream)
                assert abs(float(stream.get('start_time', 0))) <= .03, stream
            # Decode actual packets too; container metadata alone is insufficient.
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True, timeout=15)
            packets = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_packets', '-of', 'json', str(output)], text=True))
            for index in range(len(probe['streams'])):
                track = [x for x in packets['packets'] if x['stream_index'] == index]
                pts = [float(x['pts_time']) for x in track]
                assert pts == sorted(pts), (name, 'nonmonotonic packets')
                end = max(float(x['pts_time']) + float(x.get('duration_time', 0)) for x in track)
                assert abs(end - expected) <= .1, (name, index, end, expected)
            print(name, 'PASS', expected, flush=True)
        finally:
            selector.close()
            if p.poll() is None:
                p.kill(); p.wait(timeout=5)
            p.stdin.close(); p.stdout.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', required=True)
    parser.add_argument('--artifacts', required=True)
    parser.add_argument('--quick', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(args.artifacts); root.mkdir(parents=True, exist_ok=True)
    assert pathlib.Path(args.fixture).is_file(), 'generated fixture missing; no live fallback'
    run_case(args.fixture, root, 'video')
    run_case(args.fixture, root, 'system', audio=1)
    run_case(args.fixture, root, 'microphone', audio=1)
    run_case(args.fixture, root, 'both', audio=2)
    run_case(args.fixture, root, 'delayed', audio=2, delay=700)
    run_case(args.fixture, root, 'pause', audio=2, pause=True)
    # A live source hands back samples out of order; that must not end the
    # recording, and must not move the output timeline. 200 ms is well past the
    # 161 ms step measured from pipewiresrc on KDE (2026-09-10).
    run_case(args.fixture, root, 'backwards-timestamps', audio=2, jitter=200)
    run_case(args.fixture, root, 'early-stop', delay=1500, early=True)
    run_case(args.fixture, root, 'missing-encoder', encoder='/nonexistent/recordly-encoder')
    run_case(args.fixture, root, 'encoder-failure', encoder='/usr/bin/false')
    if not args.quick:
        run_case(args.fixture, root, 'idle-25s', audio=2, duration=25, idle=True)
        run_case(args.fixture, root, 'progress-drain', audio=2, duration=30)


if __name__ == '__main__':
    main()
