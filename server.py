#!/usr/bin/env python3
"""tubedeck helper: serves the web app and fetches YouTube audio with yt-dlp.

Every YouTube request goes through one throttled queue:
  - one yt-dlp process at a time
  - yt-dlp's `-t sleep` preset (10-20 s before each download, 0.75 s between requests)
  - a minimum gap between jobs and an hourly cap
  - a long pause if YouTube shows a bot check or rate limit
  - no cookies, audio only, and each track is downloaded once and cached

Optional stem separation runs Demucs locally on its own queue; it never touches YouTube or the throttle.
"""

import json
import math
import os
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("TUBEDECK_PORT", "8765"))
HOME = Path(os.environ.get("TUBEDECK_HOME", Path.home() / ".tubedeck"))
CACHE = HOME / "cache"
WEB = Path(__file__).parent / "web"
YTDLP = os.environ.get("TUBEDECK_YTDLP", "yt-dlp")
STEMS_DIR = CACHE / "stems"
DEMUCS = shlex.split(os.environ.get("TUBEDECK_DEMUCS", "")) or [str(HOME / "stems-venv" / "bin" / "python"), "-m", "demucs"]
STEMS = ("vocals", "drums", "bass", "other")
STEM_TIMEOUT_S = 20 * 60

MIN_GAP_S = float(os.environ.get("TUBEDECK_MIN_GAP", "10"))  # never start two YouTube jobs closer than this
MAX_JOBS_PER_HOUR = 40    # downloads + searches, across every user of this helper
COOLDOWN_S = 30 * 60      # pause after a bot check / rate limit
SEARCH_TTL_S = 24 * 3600
SEARCH_WAIT_S = float(os.environ.get("TUBEDECK_SEARCH_WAIT", "15"))  # searches give up instead of queueing longer

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
BLOCK_SIGNS = ("confirm you're not a bot", "confirm you’re not a bot", "http error 429",
               "too many requests", "rate-limit", "rate limit")

CACHE.mkdir(parents=True, exist_ok=True)
TOKEN_FILE = HOME / "token"
if not TOKEN_FILE.exists():
    TOKEN_FILE.write_text(secrets.token_urlsafe(9))
    TOKEN_FILE.chmod(0o600)
TOKEN = TOKEN_FILE.read_text().strip()


AUDIO_TYPES = {".m4a": "audio/mp4", ".webm": "audio/webm", ".mp3": "audio/mpeg",
               ".opus": "audio/ogg", ".ogg": "audio/ogg"}


def find_audio(video_id):
    for ext in AUDIO_TYPES:
        p = CACHE / f"{video_id}{ext}"
        if p.exists():
            return p
    return None


def redact(text):
    """Keep the pairing code out of logs (audio URLs carry it as ?t=)."""
    return re.sub(r"([?&]t=)[^&\s\"]+", r"\1***", text)


def read_meta(video_id):
    p = CACHE / f"{video_id}.json"
    return json.loads(p.read_text()) if p.exists() else {"id": video_id}


class Throttle:
    """Shared gate for every request this helper sends to YouTube."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state_file = HOME / "throttle.json"
        self.last_end, self.recent, self.cooldown_until = 0.0, deque(), 0.0
        try:
            s = json.loads(self.state_file.read_text())
            recent = deque(t for t in map(float, s.get("recent", [])) if t > time.time() - 3600)
            self.last_end, self.recent, self.cooldown_until = \
                float(s.get("last_end", 0.0)), recent, float(s.get("cooldown_until", 0.0))
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, AttributeError) as e:
            print(f"tubedeck: ignoring unreadable {self.state_file}: {e}", file=sys.stderr)

    def _save(self):
        """Best effort: a failed write must never leave the lock held. Atomic, so a kill can't truncate it."""
        tmp = self.state_file.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps({
                "last_end": self.last_end, "recent": list(self.recent),
                "cooldown_until": self.cooldown_until}))
            os.replace(tmp, self.state_file)
        except OSError as e:
            print(f"tubedeck: couldn't save throttle state: {e}", file=sys.stderr)

    def wait_time(self):
        now = time.time()
        while self.recent and self.recent[0] < now - 3600:
            self.recent.popleft()
        waits = [self.cooldown_until - now, self.last_end + MIN_GAP_S - now]
        if len(self.recent) >= MAX_JOBS_PER_HOUR:
            waits.append(self.recent[0] + 3600 - now)
        return max(0.0, *waits)

    def acquire(self, max_wait=None, skip=None):
        """Block until a YouTube job may start; holds the lock for the job.

        With max_wait, gives up (returns False) rather than waiting longer than that.
        With skip, returns None (lock released, nothing counted) if skip() is true once the slot is free.
        """
        deadline = None if max_wait is None else time.time() + max_wait
        if not self.lock.acquire(timeout=-1 if max_wait is None else max_wait):
            return False
        while (w := self.wait_time()) > 0:
            if deadline is not None and time.time() + w > deadline:
                self.lock.release()
                return False
            time.sleep(min(w, 5))
        if skip and skip():
            self.lock.release()
            return None
        self.recent.append(time.time())
        self._save()
        return True

    def release(self, blocked=False):
        try:
            self.last_end = time.time()
            if blocked:
                self.cooldown_until = self.last_end + COOLDOWN_S
            self._save()
        finally:
            self.lock.release()

    def status(self):
        cutoff = time.time() - 3600
        return {"cooldownSeconds": max(0, int(self.cooldown_until - time.time())),
                "jobsLastHour": sum(t > cutoff for t in list(self.recent)),
                "maxJobsPerHour": MAX_JOBS_PER_HOUR}


throttle = Throttle()


def looks_blocked(text):
    t = text.lower()
    return any(s in t for s in BLOCK_SIGNS)


class Busy(Exception):
    pass


def run_ytdlp(args, timeout, max_wait=None, skip=None):
    """Run yt-dlp through the throttle. Returns (ok, stdout, stderr); raises Busy past max_wait.

    Returns None without running if skip() is true once the throttle slot is free.
    """
    got = throttle.acquire(max_wait, skip)
    if got is None:
        return None
    if not got:
        raise Busy()
    blocked = False
    try:
        p = subprocess.run([YTDLP, "--ignore-config", "--no-cookies", "--no-cookies-from-browser", *args],
                           capture_output=True, text=True, errors="replace", timeout=timeout)
        blocked = looks_blocked(p.stderr)
        return p.returncode == 0, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return False, "", "yt-dlp timed out"
    except OSError as e:
        return False, "", str(e)
    finally:
        throttle.release(blocked)


class Downloader:
    def __init__(self):
        self.cv = threading.Condition()
        self.queue = deque()
        self.jobs = {}  # id -> {"state", "error"}
        threading.Thread(target=self._loop, daemon=True).start()

    def request(self, video_id, front=False):
        with self.cv:
            if find_audio(video_id):
                return
            job = self.jobs.get(video_id)
            if job and job["state"] in ("queued", "downloading"):
                if front and job["state"] == "queued":
                    self.queue.remove(video_id)
                    self.queue.appendleft(video_id)
                return
            self.jobs[video_id] = {"state": "queued", "error": None}
            (self.queue.appendleft if front else self.queue.append)(video_id)
            self.cv.notify()

    def status(self, video_id):
        if find_audio(video_id):
            return {"state": "ready", **read_meta(video_id)}
        with self.cv:
            job = self.jobs.get(video_id)
            if not job:
                return {"state": "none"}
            out = dict(job)
            if job["state"] == "queued":
                out["position"] = list(self.queue).index(video_id) + 1
            return out

    def overview(self):
        with self.cv:
            return {"queue": list(self.queue),
                    "downloading": [k for k, j in self.jobs.items() if j["state"] == "downloading"],
                    **throttle.status()}

    def _loop(self):
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                vid = self.queue.popleft()
                self.jobs[vid]["state"] = "downloading"
            try:
                ok, out, err = run_ytdlp([
                    "-t", "sleep", "--no-playlist", "--no-progress",
                    "-f", "bestaudio[ext=m4a]/bestaudio",
                    "--no-write-subs", "--no-write-thumbnail", "--no-write-info-json",
                    "-o", str(CACHE / "%(id)s.%(ext)s"),
                    "--no-simulate",
                    "-O", "%(.{id,title,channel,duration,thumbnail})j",
                    f"https://www.youtube.com/watch?v={vid}",
                ], timeout=15 * 60)
                with self.cv:
                    if ok and find_audio(vid):
                        try:
                            meta = json.loads(out.strip().splitlines()[0])
                        except (ValueError, IndexError):
                            meta = {"id": vid}
                        (CACHE / f"{vid}.json").write_text(json.dumps(meta))
                        self.jobs.pop(vid, None)
                    else:
                        msg = "YouTube asked for a bot check; pausing downloads for 30 minutes." \
                            if looks_blocked(err) else (err.strip().splitlines() or ["download failed"])[-1]
                        self.jobs[vid] = {"state": "error", "error": msg[:300]}
            except Exception as e:  # this is the only download thread, so it must outlive any one job
                with self.cv:
                    self.jobs[vid] = {"state": "error", "error": (str(e) or "download failed")[:300]}


downloader = Downloader()


def stems_available():
    return shutil.which(DEMUCS[0]) is not None


def stem_path(video_id, name):
    return STEMS_DIR / video_id / f"{name}.mp3"


def has_stems(video_id):
    return all(stem_path(video_id, n).exists() for n in STEMS)


class StemSeparator:
    """Runs Demucs on downloaded tracks, one at a time. Local work only: no YouTube requests, no throttle."""

    def __init__(self):
        self.cv = threading.Condition()
        self.queue = deque()
        self.jobs = {}  # id -> {"state", "error"}
        # CPU by default: on Apple Silicon, htdemucs on the GPU ("mps") silently returns wrong
        # stems (about 14 dB quiet and unrelated to the song). TUBEDECK_STEMS_DEVICE overrides.
        self.device = os.environ.get("TUBEDECK_STEMS_DEVICE", "cpu")
        threading.Thread(target=self._loop, daemon=True).start()

    def request(self, video_id):
        with self.cv:
            if has_stems(video_id) or not stems_available():
                return
            if not find_audio(video_id):
                self.jobs[video_id] = {"state": "error", "error": "Download the track before separating stems."}
                return
            if self.jobs.get(video_id, {}).get("state") in ("queued", "separating"):
                return
            self.jobs[video_id] = {"state": "queued", "error": None}
            self.queue.append(video_id)
            self.cv.notify()

    def status(self, video_id):
        if has_stems(video_id):
            return {"state": "ready", "error": None, "stems": list(STEMS)}
        if not stems_available():
            return {"state": "unavailable",
                    "error": "Stem separation isn't installed. Run scripts/install-stems.sh, then restart the helper."}
        with self.cv:
            job = self.jobs.get(video_id)
            if not job:
                return {"state": "none", "error": None}
            out = dict(job)
            if job["state"] == "queued":
                out["position"] = list(self.queue).index(video_id) + 1
            return out

    def overview(self):
        with self.cv:
            return {"available": stems_available(), "queue": list(self.queue),
                    "separating": [k for k, j in self.jobs.items() if j["state"] == "separating"]}

    def _run(self, audio, out, device):
        cmd = [*DEMUCS, "-n", "htdemucs", "--mp3", "--mp3-bitrate", "192",
               *(["-d", device] if device else []), "-o", str(out), str(audio)]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=STEM_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            return "separation timed out"
        except OSError as e:
            return str(e)
        if p.returncode == 0:
            return None
        return ([ln for ln in p.stderr.splitlines() if ln.strip()] or ["separation failed"])[-1]

    def _separate(self, vid):
        audio = find_audio(vid)
        if not audio:
            raise RuntimeError("Download the track before separating stems.")
        HOME.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="stems-", dir=HOME))
        try:
            device = self.device
            err = self._run(audio, tmp, device)
            if err and device == "mps":  # some Macs/torch builds can't run htdemucs on the GPU
                shutil.rmtree(tmp / "htdemucs", ignore_errors=True)
                device = "cpu"
                err = self._run(audio, tmp, device)
            if err:
                raise RuntimeError(err)
            self.device = device
            src = tmp / "htdemucs" / audio.stem
            if not all((src / f"{n}.mp3").exists() for n in STEMS):
                raise RuntimeError("Demucs finished without writing all four stems")
            stem_path(vid, "x").parent.mkdir(parents=True, exist_ok=True)
            for n in STEMS:
                os.replace(src / f"{n}.mp3", stem_path(vid, n))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _loop(self):
        while True:
            with self.cv:
                while not self.queue:
                    self.cv.wait()
                vid = self.queue.popleft()
                self.jobs[vid]["state"] = "separating"
            try:
                self._separate(vid)
                with self.cv:
                    self.jobs.pop(vid, None)
            except Exception as e:  # the only separation thread, so it must outlive any one job
                with self.cv:
                    self.jobs[vid] = {"state": "error", "error": (str(e) or "separation failed")[:300]}


separator = StemSeparator()
search_cache = {}


def cached_search(key):
    hit = search_cache.get(key)
    return hit[1] if hit and hit[0] > time.time() - SEARCH_TTL_S else None


def ytdlp_search(q):
    key = q.strip().lower()
    if (hit := cached_search(key)) is not None:
        return hit
    try:
        res = run_ytdlp(["--flat-playlist", "--sleep-requests", "0.75", "-J", f"ytsearch15:{q}"],
                        timeout=60, max_wait=SEARCH_WAIT_S, skip=lambda: cached_search(key) is not None)
    except Busy:
        left = throttle.cooldown_until - time.time()
        if left > 0:
            raise RuntimeError(f"YouTube asked for a bot check, so searching is paused for {math.ceil(left / 60)} "
                               "more minutes. Add your own API key in Settings to search in the meantime.")
        raise RuntimeError("The helper is busy downloading (YouTube requests are spaced out). "
                           "Try the search again in a moment, or add your own API key in Settings.")
    if res is None:  # the same search finished while this one waited for the throttle
        return cached_search(key) or []
    ok, out, err = res
    if not ok:
        raise RuntimeError("YouTube asked for a bot check; search is paused for a while."
                           if looks_blocked(err) else "search failed")
    results = [{"id": e.get("id"), "title": e.get("title"), "channel": e.get("channel") or e.get("uploader"),
                "duration": e.get("duration"),
                "thumbnail": f"https://i.ytimg.com/vi/{e.get('id')}/mqdefault.jpg"}
               for e in json.loads(out).get("entries", []) if VIDEO_ID.match(e.get("id") or "")]
    now = time.time()
    for k in [k for k, (t, _) in search_cache.items() if t < now - SEARCH_TTL_S]:
        del search_cache[k]
    search_cache[key] = (now, results)
    return results


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def end_headers(self):
        # Browsers must revalidate the app files, or an update keeps showing the old UI.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        line = redact(fmt % args)
        if not any(s in line for s in ("/api/status", "/api/ping", "GET /api/stems?")):
            super().log_message("%s", line)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self, qs):
        given = self.headers.get("X-Tubedeck-Token") or qs.get("t", [""])[0]
        if secrets.compare_digest(given, TOKEN):
            return True
        self._json({"error": "Wrong or missing pairing code."}, 401)
        return False

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        path = url.path
        if not path.startswith("/api/"):
            return super().do_GET()
        if not self._authed(qs):
            return
        if path == "/api/ping":
            return self._json({"ok": True, **downloader.overview(), "stems": separator.overview()})
        if path == "/api/search":
            q = qs.get("q", [""])[0].strip()
            if not q:
                return self._json({"results": []})
            try:
                return self._json({"results": ytdlp_search(q[:200])})
            except RuntimeError as e:
                return self._json({"error": str(e)}, 503)
        if path == "/api/status":
            vid = qs.get("id", [""])[0]
            if not VIDEO_ID.match(vid):
                return self._json({"error": "bad id"}, 400)
            return self._json(downloader.status(vid))
        if path == "/api/library":
            audio = [p for p in CACHE.iterdir() if p.suffix in AUDIO_TYPES and VIDEO_ID.match(p.stem)]
            audio.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return self._json({"tracks": [{**read_meta(p.stem), "stems": has_stems(p.stem)} for p in audio]})
        if path == "/api/stems":
            vid = qs.get("id", [""])[0]
            if not VIDEO_ID.match(vid):
                return self._json({"error": "bad id"}, 400)
            return self._json(separator.status(vid))
        vid = path.removeprefix("/api/audio/")
        if vid != path and VIDEO_ID.match(vid):
            p = find_audio(vid)
            return self._send_file(p, AUDIO_TYPES[p.suffix]) if p else self._json({"error": "not downloaded"}, 404)
        vid, _, name = path.removeprefix("/api/stem/").partition("/")
        if path.startswith("/api/stem/") and VIDEO_ID.match(vid) and name in STEMS:
            p = stem_path(vid, name)
            return self._send_file(p, "audio/mpeg") if p.exists() else self._json({"error": "stems not ready"}, 404)
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if not self._authed(qs):
            return
        if url.path == "/api/fetch":
            vid = qs.get("id", [""])[0]
            if not VIDEO_ID.match(vid):
                return self._json({"error": "bad id"}, 400)
            downloader.request(vid, front=qs.get("now", ["0"])[0] == "1")
            return self._json(downloader.status(vid))
        if url.path == "/api/stems":
            vid = qs.get("id", [""])[0]
            if not VIDEO_ID.match(vid):
                return self._json({"error": "bad id"}, 400)
            separator.request(vid)
            return self._json(separator.status(vid))
        self._json({"error": "not found"}, 404)

    def _send_file(self, p, ctype):
        size = p.stat().st_size
        start, end = 0, size - 1
        rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if rng and (rng.group(1) or rng.group(2)):
            if rng.group(1):
                start = int(rng.group(1))
                end = int(rng.group(2)) if rng.group(2) else end
            else:
                start = max(0, size - int(rng.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "private, max-age=31536000")
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def check_ytdlp():
    """Fail early, with a fix, when yt-dlp is missing or predates the `-t sleep` preset."""
    try:
        out = subprocess.run([YTDLP, "--help"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        raise SystemExit(f"Can't run yt-dlp ({YTDLP}). Install it with: python3 -m pip install -U yt-dlp")
    if "--preset-alias" not in out:
        raise SystemExit("yt-dlp is too old for the `-t sleep` throttle preset. "
                         "Update it with: python3 -m pip install -U yt-dlp")


def make_server(port):
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True  # open audio streams must not block shutdown
    return httpd


if __name__ == "__main__":
    if not os.environ.get("TUBEDECK_SKIP_YTDLP_CHECK"):
        check_ytdlp()
    host = socket.gethostname().split(".")[0]
    print("tubedeck helper running. Open on this Mac or your iPad (same Wi-Fi):")
    print(f"  http://localhost:{PORT}/?t={TOKEN}")
    print(f"  http://{lan_ip()}:{PORT}/?t={TOKEN}")
    print(f"  http://{host}.local:{PORT}/?t={TOKEN}")
    print(f"Pairing code: {TOKEN}   Cache: {CACHE}")
    print("Stems: available (Demucs)" if stems_available() else "Stems: not installed (run scripts/install-stems.sh)")
    try:
        make_server(PORT).serve_forever()
    except KeyboardInterrupt:
        pass
