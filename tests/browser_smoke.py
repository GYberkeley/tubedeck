"""Drive the real web app in headless Chrome against the helper and a fake YouTube.

Needs Python Playwright, Google Chrome and ffmpeg. Run it on its own (it sets up
its own helper, separate from the unit tests):
    python3 tests/browser_smoke.py
"""

import math
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="tubedeck-browser-"))
FIXTURE = TMP / "track.m4a"
BPM = 120


def make_fixture():
    """A 40 s stereo track: a kick on every beat at 120 BPM over a quiet bass tone."""
    sr, secs = 44100, 40
    frames = bytearray()
    beat = 60 / BPM
    for i in range(sr * secs):
        t = i / sr
        since = t % beat
        v = math.sin(2 * math.pi * 55 * since) * math.exp(-since / 0.04) * 0.8
        v += math.sin(2 * math.pi * 110 * t) * 0.1
        s = int(max(-1, min(1, v)) * 32767)
        frames += struct.pack("<hh", s, s)
    with wave.open(str(TMP / "track.wav"), "wb") as w:
        w.setnchannels(2), w.setsampwidth(2), w.setframerate(sr)
        w.writeframes(bytes(frames))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(TMP / "track.wav"), "-c:a", "aac", str(FIXTURE)],
                   check=True)
    # Stems: the kick track as "drums", near-silence for the rest.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(TMP / "track.wav"), "-b:a", "192k", str(TMP / "drums.mp3")], check=True)
    for name in ("vocals", "bass", "other"):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(TMP / "track.wav"), "-af", "volume=0.01", "-b:a", "192k",
                        str(TMP / f"{name}.mp3")], check=True)


FAKE = TMP / "fake-yt-dlp"
FAKE.write_text(f"""#!{sys.executable}
import json, re, shutil, sys
args = sys.argv[1:]
target = args[-1]
if target.startswith("ytsearch"):
    q = target.split(":", 1)[1]
    print(json.dumps({{"entries": [{{"id": "kickTrack01", "title": f"Kick Test 120 ({{q}})", "channel": "tubedeck", "duration": 40}}]}}))
    sys.exit(0)
vid = re.search(r"v=([A-Za-z0-9_-]{{11}})", target).group(1)
shutil.copy({str(FIXTURE)!r}, args[args.index("-o") + 1].replace("%(id)s", vid).replace("%(ext)s", "m4a"))
print(json.dumps({{"id": vid, "title": "Kick Test 120", "channel": "tubedeck", "duration": 40}}))
""")
FAKE.chmod(FAKE.stat().st_mode | stat.S_IEXEC)

# Fake Demucs: copies pre-made MP3 stems (made from the fixture in make_fixture) into place.
FAKE_DEMUCS = TMP / "fake-demucs"
FAKE_DEMUCS.write_text(f"""#!{sys.executable}
import os, shutil, sys
args = sys.argv[1:]
out, src = args[args.index("-o") + 1], args[-1]
d = os.path.join(out, "htdemucs", os.path.splitext(os.path.basename(src))[0])
os.makedirs(d, exist_ok=True)
for name in ("vocals", "drums", "bass", "other"):
    shutil.copy(os.path.join({str(TMP)!r}, name + ".mp3"), os.path.join(d, name + ".mp3"))
""")
FAKE_DEMUCS.chmod(FAKE_DEMUCS.stat().st_mode | stat.S_IEXEC)

os.environ.update({
    "TUBEDECK_HOME": str(TMP / "home"),
    "TUBEDECK_YTDLP": str(FAKE),
    "TUBEDECK_MIN_GAP": "0.2",
    "TUBEDECK_SKIP_YTDLP_CHECK": "1",
    "TUBEDECK_DEMUCS": str(FAKE_DEMUCS),
})
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


@unittest.skipUnless(sync_playwright and shutil.which("ffmpeg"), "needs playwright and ffmpeg")
class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        make_fixture()
        cls.httpd = server.make_server(0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chrome", headless=True,
                                             args=["--autoplay-policy=no-user-gesture-required"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        shutil.rmtree(TMP, ignore_errors=True)

    def page(self, token=True, width=1180, height=820):
        pg = self.browser.new_page(viewport={"width": width, "height": height}, has_touch=True)
        self.errors = []
        pg.on("pageerror", lambda e: self.errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and self.errors.append(f"{m.text} {m.location.get('url', '')}"))
        pg.goto(self.base + (f"/?t={server.TOKEN}" if token else "/"))
        return pg

    def test_full_flow(self):
        pg = self.page()
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        self.assertEqual(pg.url, self.base + "/", "pairing code should be removed from the address bar")

        pg.fill("#q", "kick test")
        pg.press("#q", "Enter")
        pg.wait_for_selector("#list li[data-id=kickTrack01]")
        pg.click("#list li[data-id=kickTrack01] .load.a")
        pg.wait_for_function("decks.A.bpm > 0", timeout=20000)
        bpm = pg.evaluate("decks.A.bpm")
        self.assertAlmostEqual(bpm, BPM, delta=0.3)
        # The beat grid sits on the kicks (one every 0.5 s from t=0 in the fixture).
        first = pg.evaluate("decks.A.firstBeat")
        self.assertLess(min(first % 0.5, 0.5 - first % 0.5), 0.02)
        self.assertIn("Kick Test", pg.inner_text(".deck[data-deck=A] .title"))

        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.wait_for_function("decks.A.el.currentTime > 0.5")
        self.assertEqual(pg.evaluate("ctx.state"), "running")

        # Tempo changes speed and the displayed BPM.
        pg.evaluate("decks.A.setTempo(4)")
        self.assertAlmostEqual(pg.evaluate("decks.A.el.playbackRate"), 1.04, places=3)
        self.assertEqual(pg.inner_text(".deck[data-deck=A] .bpm"), f"{bpm * 1.04:.1f}")

        # A beat loop wraps; a seek far past it exits the loop.
        pg.select_option(".deck[data-deck=A] .pad-mode", "loop")
        pg.dispatch_event(".deck[data-deck=A] .pad-grid .pad:nth-child(5)", "pointerdown")  # 4 beats
        self.assertEqual(pg.evaluate("decks.A.loop.beats"), 4)
        self.assertAlmostEqual(pg.evaluate("decks.A.loop.end - decks.A.loop.start"), 4 * 60 / bpm, places=3)
        pg.evaluate("decks.A.el.currentTime = decks.A.loop.end + 5")
        pg.wait_for_function("decks.A.loop === null")

        # The loop box: AU starts a loop of the shown length, the arrows halve it, AU again exits.
        pg.click(".deck[data-deck=A] .loop-au")
        self.assertEqual(pg.evaluate("decks.A.loop.beats"), 4)
        pg.click(".deck[data-deck=A] .loop-half")
        self.assertEqual(pg.evaluate("decks.A.loop.beats"), 2)
        self.assertEqual(pg.inner_text(".deck[data-deck=A] .loop-len"), "2")
        pg.click(".deck[data-deck=A] .loop-au")
        self.assertIsNone(pg.evaluate("decks.A.loop"))
        # Tapping the loop length itself starts and exits the loop, like the DDJ's beat loop button.
        pg.click(".deck[data-deck=A] .loop-len")
        self.assertEqual(pg.evaluate("decks.A.loop.beats"), 2)
        pg.click(".deck[data-deck=A] .loop-len")
        self.assertIsNone(pg.evaluate("decks.A.loop"))

        # Dragging the platter scratches: the track follows the finger.
        box = pg.locator(".deck[data-deck=A] .jog-ring").bounding_box()
        cx, cy, r = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, box["width"] / 2
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")  # pause
        start = pg.evaluate("decks.A.el.currentTime")
        pg.mouse.move(cx + r * 0.5, cy)
        pg.mouse.down()
        self.assertTrue(pg.evaluate("decks.A.scratching"))
        for i in range(1, 9):  # a quarter turn clockwise = forward
            a = i / 8 * math.pi / 2
            pg.mouse.move(cx + r * 0.5 * math.cos(a), cy + r * 0.5 * math.sin(a))
        pg.mouse.up()
        pg.wait_for_timeout(100)
        moved = pg.evaluate("decks.A.el.currentTime") - start
        self.assertAlmostEqual(moved, 1.8 / 4, delta=0.15)
        self.assertFalse(pg.evaluate("decks.A.scratching"))
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")  # play again

        # Turning the LOW knob down cuts the low shelf.
        k = pg.locator(".channel[data-ch=A] .knob[data-role=low]").bounding_box()
        pg.mouse.move(k["x"] + k["width"] / 2, k["y"] + k["height"] / 2)
        pg.mouse.down()
        pg.mouse.move(k["x"] + k["width"] / 2, k["y"] + 200)
        pg.mouse.up()
        pg.wait_for_timeout(200)
        self.assertLess(pg.evaluate("decks.A.chain.low.gain.value"), -20)

        # Stems arrive after separation and swap in; a stem button mutes that stem.
        pg.wait_for_function("decks.A.stemsReady", timeout=30000)
        self.assertIn("ready", pg.get_attribute(".deck[data-deck=A] .stem-row", "class"))
        pg.click(".deck[data-deck=A] .stem[data-stem=drums]")
        self.assertIn("off", pg.get_attribute(".deck[data-deck=A] .stem[data-stem=drums]", "class"))
        self.assertFalse(pg.evaluate("decks.A.stemOn.drums"))
        pg.click(".deck[data-deck=A] .stem[data-stem=drums]")

        pg.evaluate("mixer.channels.A.knobs.low.set(0)")  # undo the LOW cut above: the fixture is all kick

        # FX1 (assigned to deck 1) only receives audio while ON, and its echo is audible.
        pg.evaluate("""() => { window.fxProbe = ctx.createAnalyser(); fx[0].wet.connect(window.fxProbe); }""")
        self.assertEqual(pg.evaluate("fx[0].input.gain.value"), 0)
        pg.click(".fxunit[data-fx='0'] .fx-on")
        pg.wait_for_timeout(200)
        self.assertGreater(pg.evaluate("fx[0].input.gain.value"), 0.9)
        self.assertAlmostEqual(pg.evaluate("fx[0].delay.delayTime.value"), 60 / pg.evaluate("decks.A.liveBpm"), delta=0.02)
        pg.wait_for_timeout(800)
        level = pg.evaluate("""() => { const b = new Float32Array(2048); fxProbe.getFloatTimeDomainData(b); return Math.max(...b.map(Math.abs)); }""")
        self.assertGreater(level, 0.01, "echo output should be audible")
        pg.click(".fxunit[data-fx='0'] .fx-on")

        # A resting finger on the jog wheel stops bending the speed.
        pg.evaluate("decks.A.bend = 0.1; decks.A.lastJogMove = performance.now(); decks.A.el.playbackRate = decks.A.rate * 1.1")
        pg.wait_for_function("decks.A.bend === 0 && Math.abs(decks.A.el.playbackRate - decks.A.rate) < 1e-6")

        # Sync deck B to deck A.
        pg.click(".tab[data-tab=library]")
        pg.click("#list li[data-id=kickTrack01] .load.b")
        pg.wait_for_function("decks.B.bpm > 0", timeout=20000)
        pg.click(".deck[data-deck=B] .sync")
        self.assertAlmostEqual(pg.evaluate("decks.B.liveBpm"), pg.evaluate("decks.A.liveBpm"), delta=0.05)

        # Reloading deck A re-matches deck B, which follows it.
        pg.evaluate("decks.B.applyTempo(0)")
        pg.click("#list li[data-id=kickTrack01] .load.a")
        pg.wait_for_function("decks.A.bpm > 0 && Math.abs(decks.B.liveBpm - decks.A.liveBpm) < 0.05", timeout=20000)

        # Crossfader is equal-power.
        pg.fill("#xfader", "1")
        pg.dispatch_event("#xfader", "input")
        pg.wait_for_timeout(200)
        self.assertLess(pg.evaluate("decks.A.chain.xf.gain.value"), 0.05)
        self.assertGreater(pg.evaluate("decks.B.chain.xf.gain.value"), 0.95)
        # Thumbnails for the fake video ids 404 on YouTube's image server; anything else is a bug.
        self.assertEqual([e for e in self.errors if "i.ytimg.com" not in e], [])

    def test_script_processor_engine(self):
        """The plain-http fallback (iPad on the LAN) plays, seeks, loops and loads stems."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0", timeout=30000)
        self.assertEqual(pg.evaluate("decks.A.el.kind"), "scriptprocessor")
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.wait_for_function("decks.A.el.currentTime > 0.8")
        # The play button stays lit and the position only moves forward while playing.
        flicker = pg.evaluate("""() => new Promise(done => {
            let n = 0, unlit = 0, back = 0, last = decks.A.el.currentTime;
            (function f() {
                if (!decks.A.ui.play.classList.contains('lit')) unlit++;
                const t = decks.A.el.currentTime; if (t < last - 0.001) back++; last = t;
                if (++n < 90) requestAnimationFrame(f); else done({unlit, back});
            })();
        })""")
        self.assertEqual(flicker, {"unlit": 0, "back": 0})
        # ...and stays unlit, without blinking, once paused.
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        lit = pg.evaluate("""() => new Promise(done => { let n = 0, lit = 0;
            (function f() { if (decks.A.ui.play.classList.contains('lit')) lit++; if (++n < 30) requestAnimationFrame(f); else done(lit); })(); })""")
        self.assertEqual(lit, 0)
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.evaluate("decks.A.el.currentTime = 10")
        pg.wait_for_function("decks.A.el.currentTime > 10.2 && decks.A.el.currentTime < 12")
        pg.click(".deck[data-deck=A] .loop-len")  # 4-beat loop = 2 s
        pg.wait_for_timeout(2600)
        loop = pg.evaluate("decks.A.loop")
        t = pg.evaluate("decks.A.el.currentTime")
        self.assertTrue(loop["start"] - 0.05 <= t <= loop["end"] + 0.05, f"{t} outside {loop}")
        pg.wait_for_function("decks.A.stemsReady", timeout=30000)
        self.assertEqual([s["name"] for s in pg.evaluate("decks.A.el.dsp.stems.map(s => ({name: s.name}))")],
                         ["vocals", "other", "bass", "drums"])
        pg.click(".deck[data-deck=A] .stem[data-stem=vocals]")
        pg.wait_for_function("decks.A.el.dsp.stems[0].gain === 0")
        pg.close()

    def test_slow_older_search_does_not_overwrite_newer(self):
        pg = self.page()
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        # Hold back the first search's response so it lands after the second one.
        pg.evaluate("""() => {
            const real = window.fetch;
            window.fetch = async (u, o) => {
                const r = await real(u, o);
                if (String(u).includes('q=first')) await new Promise(ok => setTimeout(ok, 1500));
                return r;
            };
            search('first'); search('second');
        }""")
        pg.wait_for_selector("#list li[data-id=kickTrack01]")
        pg.wait_for_timeout(2000)
        self.assertIn("(second)", pg.inner_text("#list li[data-id=kickTrack01] .t"))

    def test_settings_enter_saves_and_pairing_prompt_opens_once(self):
        pg = self.page(token=False)
        pg.wait_for_function("document.querySelector('#settings').open")
        pg.click("#cancelSettings")
        pg.wait_for_timeout(3500)  # past one helper refresh
        self.assertFalse(pg.evaluate("document.querySelector('#settings').open"))

        pg.click("#settingsBtn")
        pg.fill("#tokenInput", server.TOKEN)
        pg.press("#tokenInput", "Enter")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        self.assertEqual(pg.evaluate("localStorage.getItem('tubedeck.token')"), server.TOKEN)

    def test_layout_fits_phone_and_ipad_widths(self):
        for w, h in [(1180, 820), (820, 1180), (390, 844)]:
            pg = self.page(width=w, height=h)
            overflow = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            self.assertLessEqual(overflow, 0, f"horizontal scroll at {w}px")
            xfader_bottom, browser_top = pg.evaluate(
                "[document.querySelector('.xfader-row').getBoundingClientRect().bottom,"
                " document.querySelector('.browser').getBoundingClientRect().top]")
            self.assertLessEqual(xfader_bottom, browser_top, f"track list covers the mixer at {w}px")
            pg.screenshot(path=str(Path(os.environ.get("SHOT_DIR", TMP)) / f"tubedeck-{w}x{h}.png"))
            pg.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
