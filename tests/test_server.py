"""Integration tests for the tubedeck helper.

A fake yt-dlp script stands in for YouTube, so these run offline and fast:
    python3 -m unittest discover -s tests
"""

import contextlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="tubedeck-test-"))
FAKE = TMP / "fake-yt-dlp"
CALLS = TMP / "calls.log"

# The fake yt-dlp logs every call, then acts on the URL or search it was given:
#   ...watch?v=blockedXXXX -> prints YouTube's bot-check error and fails
#   ...watch?v=<id>        -> sleeps FAKE_DELAY, writes <id>.m4a, prints metadata
#   ytsearch15:<q>         -> prints two search results
FAKE.write_text(f"""#!{sys.executable}
import json, os, sys, time, re
args = sys.argv[1:]
with open({str(CALLS)!r}, "a") as f:
    f.write(json.dumps({{"t": time.time(), "args": args}}) + "\\n")
target = args[-1]
if target.startswith("ytsearch"):
    print(json.dumps({{"entries": [
        {{"id": "AAAAAAAAAAA", "title": "First", "channel": "Chan", "duration": 200}},
        {{"id": "not-a-valid-id", "title": "Bad"}},
        {{"id": "BBBBBBBBBBB", "title": "Second", "uploader": "Up", "duration": 300}}]}}))
    sys.exit(0)
vid = re.search(r"v=([A-Za-z0-9_-]{{11}})", target).group(1)
if vid.startswith("blocked"):
    sys.stderr.write("ERROR: [youtube] Sign in to confirm you're not a bot\\n")
    sys.exit(1)
time.sleep(float(os.environ.get("FAKE_DELAY", "0")))
out = args[args.index("-o") + 1].replace("%(id)s", vid).replace("%(ext)s", "m4a")
with open(out, "wb") as f:
    f.write(bytes(range(256)) * 40)
print(json.dumps({{"id": vid, "title": "Track " + vid, "channel": "Chan", "duration": 123}}))
""")
FAKE.chmod(FAKE.stat().st_mode | stat.S_IEXEC)

os.environ.update({
    "TUBEDECK_HOME": str(TMP / "home"),
    "TUBEDECK_YTDLP": str(FAKE),
    "TUBEDECK_MIN_GAP": "0.6",
    "TUBEDECK_SEARCH_WAIT": "0.3",
    "TUBEDECK_SKIP_YTDLP_CHECK": "1",
})
sys.path.insert(0, str(ROOT))
import server  # noqa: E402  (must import after the environment is set)


def calls():
    if not CALLS.exists():
        return []
    return [json.loads(line) for line in CALLS.read_text().splitlines()]


class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server(0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        shutil.rmtree(TMP, ignore_errors=True)

    def setUp(self):
        os.environ["FAKE_DELAY"] = "0"

    def req(self, path, method="GET", token=True, headers=None):
        h = dict(headers or {})
        if token:
            h["X-Tubedeck-Token"] = server.TOKEN
        r = urllib.request.Request(self.base + path, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=20) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def wait_ready(self, vid, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            st = json.loads(self.req(f"/api/status?id={vid}")[2])
            if st["state"] in ("ready", "error"):
                return st
            time.sleep(0.1)
        self.fail(f"{vid} never finished")

    def test_api_requires_pairing_code(self):
        code, _, body = self.req("/api/ping", token=False)
        self.assertEqual(code, 401)
        self.assertIn("pairing code", json.loads(body)["error"])
        self.assertEqual(self.req("/api/ping", token=False, headers={"X-Tubedeck-Token": "wrong"})[0], 401)
        self.assertEqual(self.req(f"/api/ping?t={server.TOKEN}", token=False)[0], 200)

    def test_static_app_is_public(self):
        code, headers, body = self.req("/", token=False)
        self.assertEqual(code, 200)
        self.assertIn(b"tubedeck", body)
        self.assertEqual(headers.get("Cache-Control"), "no-cache")  # updates must reach cached browsers

    def test_rejects_bad_video_ids(self):
        for path, method in [("/api/fetch?id=../../etc", "POST"), ("/api/status?id=short", "GET")]:
            self.assertEqual(self.req(path, method)[0], 400)
        self.assertEqual(self.req("/api/audio/..%2F..%2Fx")[0], 404)

    def test_download_then_serve_with_ranges(self):
        vid = "dlTest00001"
        code, _, body = self.req(f"/api/fetch?id={vid}&now=1", "POST")
        self.assertEqual(code, 200)
        st = self.wait_ready(vid)
        self.assertEqual(st["state"], "ready")
        self.assertEqual(st["title"], "Track " + vid)
        self.assertIn(vid, [t["id"] for t in json.loads(self.req("/api/library")[2])["tracks"]])

        code, headers, body = self.req(f"/api/audio/{vid}", headers={"Range": "bytes=10-19"})
        self.assertEqual(code, 206)
        self.assertEqual(headers["Content-Range"], "bytes 10-19/10240")
        self.assertEqual(body, bytes(range(10, 20)))
        self.assertEqual(headers["Content-Type"], "audio/mp4")

        code, headers, body = self.req(f"/api/audio/{vid}", headers={"Range": "bytes=-5"})
        self.assertEqual((code, body), (206, bytes(range(251, 256))))
        self.assertEqual(self.req(f"/api/audio/{vid}", headers={"Range": "bytes=99999-"})[0], 416)
        self.assertEqual(len(self.req(f"/api/audio/{vid}")[2]), 10240)

        # A second request for a cached track never reaches YouTube.
        before = len(calls())
        self.req(f"/api/fetch?id={vid}", "POST")
        time.sleep(0.3)
        self.assertEqual(len(calls()), before)

    def test_downloads_are_spaced_out(self):
        ids = ["gapTest0001", "gapTest0002"]
        for vid in ids:
            self.req(f"/api/fetch?id={vid}", "POST")
        for vid in ids:
            self.assertEqual(self.wait_ready(vid)["state"], "ready")
        starts = [c["t"] for c in calls() if any(v in c["args"][-1] for v in ids)]
        self.assertEqual(len(starts), 2)
        self.assertGreaterEqual(starts[1] - starts[0], server.MIN_GAP_S * 0.95)
        args = calls()[-1]["args"]
        self.assertIn("sleep", args[args.index("-t") + 1])
        self.assertIn("--no-cookies", args)

    def test_bot_check_triggers_cooldown(self):
        self.req("/api/fetch?id=blocked0001", "POST")
        st = self.wait_ready("blocked0001")
        self.assertEqual(st["state"], "error")
        self.assertIn("bot check", st["error"])
        ping = json.loads(self.req("/api/ping")[2])
        self.assertGreater(ping["cooldownSeconds"], 0)
        # Clear the cooldown so other tests can keep using the fake YouTube.
        with server.throttle.lock:
            server.throttle.cooldown_until = 0
            server.throttle._save()

    def test_search_filters_and_caches(self):
        time.sleep(server.MIN_GAP_S)  # let any earlier test's YouTube job clear the gap
        code, _, body = self.req("/api/search?q=Cache+Me")
        self.assertEqual(code, 200)
        results = json.loads(body)["results"]
        self.assertEqual([r["id"] for r in results], ["AAAAAAAAAAA", "BBBBBBBBBBB"])
        self.assertEqual(results[1]["channel"], "Up")
        before = len(calls())
        self.assertEqual(json.loads(self.req("/api/search?q=cache%20me")[2])["results"], results)
        self.assertEqual(len(calls()), before)

    def test_search_fails_fast_while_downloads_hold_the_throttle(self):
        os.environ["FAKE_DELAY"] = "2"
        self.req("/api/fetch?id=slowTest001", "POST")
        time.sleep(0.8)  # let the download take the throttle
        t0 = time.time()
        code, _, body = self.req("/api/search?q=while+busy")
        self.assertLess(time.time() - t0, 1.5)
        self.assertEqual(code, 503)
        self.assertIn("busy", json.loads(body)["error"])
        self.wait_ready("slowTest001")

    def test_hourly_cap_blocks_new_youtube_requests(self):
        t = server.throttle
        now = time.time()
        with t.lock:
            saved = deque(t.recent)
            t.recent.clear()
            t.recent.extend([now - 4000] + [now] * server.MAX_JOBS_PER_HOUR)
        try:
            self.assertEqual(t.status()["jobsLastHour"], server.MAX_JOBS_PER_HOUR)  # stale entry not counted
            self.assertGreater(t.wait_time(), server.MIN_GAP_S)
            before = len(calls())
            t0 = time.time()
            code, _, body = self.req("/api/search?q=over+the+cap")
            self.assertLess(time.time() - t0, 1.5)
            self.assertEqual(code, 503)
            self.assertEqual(len(calls()), before)
        finally:
            with t.lock:
                t.recent.clear()
                t.recent.extend(x for x in saved if x > time.time() - 3600)
                t._save()

    def test_search_during_cooldown_says_so(self):
        with server.throttle.lock:
            server.throttle.cooldown_until = time.time() + 10 * 60
        try:
            code, _, body = self.req("/api/search?q=during+cooldown")
            self.assertEqual(code, 503)
            self.assertIn("10 more minutes", json.loads(body)["error"])
        finally:
            with server.throttle.lock:
                server.throttle.cooldown_until = 0
                server.throttle._save()

    def test_identical_searches_share_one_youtube_request(self):
        time.sleep(server.MIN_GAP_S)
        before = len(calls())
        out = []
        with mock.patch.object(server, "SEARCH_WAIT_S", 5):
            ts = [threading.Thread(target=lambda: out.append(self.req("/api/search?q=same+time")))
                  for _ in range(2)]
            for th in ts:
                th.start()
            for th in ts:
                th.join()
        self.assertEqual([r[0] for r in out], [200, 200])
        self.assertEqual(out[0][2], out[1][2])
        self.assertEqual(len(calls()), before + 1)

    def test_missing_ytdlp_fails_the_job_not_the_queue(self):
        with mock.patch.object(server, "YTDLP", str(TMP / "no-such-yt-dlp")):
            self.req("/api/fetch?id=noYtdlp0001", "POST")
            st = self.wait_ready("noYtdlp0001")
        self.assertEqual(st["state"], "error")
        self.req("/api/fetch?id=afterMiss01", "POST")
        self.assertEqual(self.wait_ready("afterMiss01")["state"], "ready")

    def test_download_thread_survives_unexpected_errors(self):
        vid = "metaFail001"
        meta = server.CACHE / f"{vid}.json"
        meta.mkdir()  # makes writing the track's metadata fail
        try:
            self.req(f"/api/fetch?id={vid}", "POST")
            end = time.time() + 15
            while time.time() < end:
                with server.downloader.cv:
                    if server.downloader.jobs.get(vid, {}).get("state") == "error":
                        break
                time.sleep(0.1)
            else:
                self.fail("job never failed")
        finally:
            meta.rmdir()
        self.req("/api/fetch?id=afterErr001", "POST")
        self.assertEqual(self.wait_ready("afterErr001")["state"], "ready")

    def test_unwritable_throttle_state_does_not_wedge_the_queue(self):
        err = io.StringIO()
        with mock.patch.object(server.throttle, "state_file", TMP / "no-such-dir" / "throttle.json"), \
                contextlib.redirect_stderr(err):
            for vid in ["noSave00001", "noSave00002"]:
                self.req(f"/api/fetch?id={vid}", "POST")
                self.assertEqual(self.wait_ready(vid)["state"], "ready")
        self.assertIn("couldn't save throttle state", err.getvalue())

    def test_corrupt_throttle_state_is_ignored(self):
        home = TMP / "corrupt-home"
        home.mkdir()
        (home / "throttle.json").write_text('{"recent": [1, 2')
        with mock.patch.object(server, "HOME", home), contextlib.redirect_stderr(io.StringIO()):
            t = server.Throttle()
            self.assertEqual((t.last_end, list(t.recent), t.cooldown_until), (0.0, [], 0.0))
            t.acquire()
            t.release()
        self.assertEqual(len(json.loads((home / "throttle.json").read_text())["recent"]), 1)
        self.assertFalse((home / "throttle.tmp").exists())

    def test_pairing_code_is_redacted_from_logs(self):
        line = server.redact(f'"GET /api/audio/x?t={server.TOKEN} HTTP/1.1" 206 -')
        self.assertNotIn(server.TOKEN, line)
        self.assertIn("t=***", line)

if __name__ == "__main__":
    unittest.main()
