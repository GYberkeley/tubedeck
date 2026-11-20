"""Drive the real web app in headless Chrome against the helper and a fake YouTube.

Needs Python Playwright, Google Chrome and ffmpeg. Run it on its own (it sets up
its own helper, separate from the unit tests):
    python3 tests/browser_smoke.py
"""

import json
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
import urllib.request
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
        pg.wait_for_function("document.documentElement.dataset.theme")  # app.js has finished starting
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
        # Halving a loop down to 1/8 beat keeps looping, even with the playhead late in the loop.
        self.assertIsNotNone(pg.evaluate("decks.A.loop"), "the 4-beat loop from above is still on")
        pg.wait_for_function("decks.A.el.currentTime > decks.A.loop.start + 1.4")  # late in the 2 s loop
        for _ in range(5):  # 4 -> 2 -> 1 -> 1/2 -> 1/4 -> 1/8
            pg.click(".deck[data-deck=A] .loop-half")
        self.assertEqual(pg.inner_text(".deck[data-deck=A] .loop-len"), "1/8")
        pg.wait_for_timeout(1500)
        loop = pg.evaluate("decks.A.loop")
        self.assertIsNotNone(loop, "the 1/8 loop should still be running")
        t = pg.evaluate("decks.A.el.currentTime")
        self.assertTrue(loop["start"] - 0.01 <= t <= loop["end"] + 0.01, f"{t} outside {loop}")
        pg.click(".deck[data-deck=A] .loop-len")
        self.assertIsNone(pg.evaluate("decks.A.loop"))

        # A scratch whose release never arrives (the browser drops the touch) still resumes play.
        box = pg.locator(".deck[data-deck=A] .jog-ring").bounding_box()
        pg.locator(".deck[data-deck=A] .jog-ring").dispatch_event("pointerdown", {
            "pointerId": 7, "clientX": box["x"] + box["width"] / 2 + 20, "clientY": box["y"] + box["height"] / 2})
        self.assertTrue(pg.evaluate("decks.A.scratching"))
        pg.locator(".deck[data-deck=A] .jog-ring").dispatch_event("lostpointercapture", {"pointerId": 7})
        self.assertFalse(pg.evaluate("decks.A.scratching"))
        pg.wait_for_function("!decks.A.el.paused && decks.A.ui.play.classList.contains('lit')")

        pg.wait_for_function("decks.A.stemsReady", timeout=30000)
        # The original mix keeps playing; stems wait at gain 0 and a muted stem is subtracted.
        self.assertEqual(pg.evaluate("decks.A.el.dsp.stems.map(s => [s.name, s.gain])"),
                         [["mix", 1], ["vocals", 0], ["other", 0], ["bass", 0], ["drums", 0]])
        pg.click(".deck[data-deck=A] .stem[data-stem=vocals]")
        pg.wait_for_function("decks.A.el.dsp.stems[1].gain === -1")
        pg.close()

    def test_effects(self):
        """Every Beat FX type is audible, brake/backspin move the deck, ROLL slips, and each Color FX changes the sound."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0", timeout=30000)
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.evaluate("() => { window.probe = ctx.createAnalyser(); probe.fftSize = 4096; master.connect(probe); }")
        level = """() => new Promise(done => setTimeout(() => {
            const b = new Float32Array(4096); probe.getFloatTimeDomainData(b);
            let s = 0; for (const v of b) s += v * v; done(Math.sqrt(s / b.length)); }, 600))"""
        # Spectral fingerprint of the master output, to tell whether an effect changed the sound.
        spectrum = """() => new Promise(done => setTimeout(() => {
            const b = new Float32Array(probe.frequencyBinCount); probe.getFloatFrequencyData(b);
            done(Array.from(b.slice(0, 400)).map(v => Math.max(-140, v))); }, 700))"""
        dry = pg.evaluate(spectrum)
        dry_level = pg.evaluate(level)
        # 3/4 beat, so echoes land between the fixture's kicks instead of hiding under them.
        pg.click(".fxunit[data-fx='0'] .arrow[data-step='-1']")

        def changed(spec):
            return sum(abs(x - y) for x, y in zip(spec, dry)) / len(dry)

        for fx_type in ["echo", "delay", "pingpong", "spiral", "reverb", "trans", "filter", "flanger", "phaser", "crush",
                        "pitch", "helix", "mobius"]:
            pg.select_option(".fxunit[data-fx='0'] select", fx_type)
            pg.click(".fxunit[data-fx='0'] .fx-on")
            on_level = pg.evaluate(level)
            self.assertGreater(on_level, 0.01, f"{fx_type}: silent")
            spec_change, level_change = changed(pg.evaluate(spectrum)), abs(on_level - dry_level) / dry_level
            self.assertTrue(spec_change > 1.0 or level_change > 0.1,
                            f"{fx_type}: no audible change (spectrum {spec_change:.2f} dB, level {level_change:.0%})")
            pg.click(".fxunit[data-fx='0'] .fx-on")
        pg.wait_for_timeout(300)

        # Vinyl brake is held: the deck winds down while held, and on release carries on
        # where the track would be had it kept playing.
        on = pg.locator(".fxunit[data-fx='0'] .fx-on")
        pg.select_option(".fxunit[data-fx='0'] select", "brake")
        t0 = pg.evaluate("decks.A.el.currentTime")
        on.dispatch_event("pointerdown")
        pg.wait_for_timeout(1200)  # 1 beat at 120 BPM = 0.5 s of braking, then stopped
        t1 = pg.evaluate("decks.A.el.currentTime")
        pg.wait_for_timeout(400)
        self.assertAlmostEqual(pg.evaluate("decks.A.el.currentTime"), t1, delta=0.02)
        on.dispatch_event("pointerup")
        pg.wait_for_timeout(150)  # next engine report
        held = pg.evaluate("decks.A.el.currentTime") - t0
        self.assertGreater(held, 1.4, "release continues where the track would have been")
        self.assertFalse(pg.evaluate("fx[0].on"))
        pg.wait_for_timeout(300)
        self.assertFalse(pg.evaluate("decks.A.el.paused"))

        # Back spin: runs backwards while held, then carries on.
        pg.select_option(".fxunit[data-fx='0'] select", "spin")
        t0 = pg.evaluate("decks.A.el.currentTime")
        on.dispatch_event("pointerdown")
        pg.wait_for_timeout(700)
        self.assertLess(pg.evaluate("decks.A.el.currentTime"), t0)
        on.dispatch_event("pointerup")
        pg.wait_for_timeout(150)
        self.assertGreater(pg.evaluate("decks.A.el.currentTime"), t0 + 0.5)

        # ROLL as a Beat FX: held like the brake, it rolls the beat length and lands back in time.
        pg.select_option(".fxunit[data-fx='0'] select", "roll")
        pg.evaluate("decks.A.el.currentTime = 20")
        start = pg.evaluate("decks.A.el.currentTime")
        on.dispatch_event("pointerdown")
        self.assertTrue(pg.evaluate("decks.A.loop && decks.A.loop.roll"))
        pg.wait_for_timeout(1000)
        on.dispatch_event("pointerup")
        pg.wait_for_timeout(50)
        self.assertIsNone(pg.evaluate("decks.A.loop"))
        self.assertAlmostEqual(pg.evaluate("decks.A.el.currentTime"), start + 1.05, delta=0.25)

        # ROLL: hold a pad to repeat a slice, release to land where the track would be.
        pg.evaluate("decks.A.el.currentTime = 10")
        pg.select_option(".deck[data-deck=A] .pad-mode", "roll")
        pad = pg.locator(".deck[data-deck=A] .pad-grid .pad:nth-child(4)")  # 1/4 beat
        start = pg.evaluate("decks.A.el.currentTime")
        pad.dispatch_event("pointerdown")
        self.assertTrue(pg.evaluate("decks.A.loop && decks.A.loop.roll"))
        pg.wait_for_timeout(1000)
        self.assertLess(pg.evaluate("decks.A.el.currentTime"), start + 0.3)  # stuck repeating the slice
        pad.dispatch_event("pointerup")
        pg.wait_for_timeout(50)
        self.assertIsNone(pg.evaluate("decks.A.loop"))
        self.assertAlmostEqual(pg.evaluate("decks.A.el.currentTime"), start + 1.05, delta=0.2)

        # Each Color FX type changes the sound when the CFX knob is turned.
        for cfx in ["filter", "space", "dub", "sweep", "noise", "crush", "jet", "pitch"]:
            pg.select_option("#cfxType", cfx)
            pg.evaluate("mixer.channels.A.knobs.cfx.set(0.8)")
            self.assertGreater(changed(pg.evaluate(spectrum)), 1.0, f"cfx {cfx}: no audible change")
            pg.evaluate("mixer.channels.A.knobs.cfx.set(0)")
        self.assertEqual(errors, [])
        pg.close()

    def test_midi_controller(self):
        """DDJ messages drive the decks and mixer, lights follow the state, and MIDI learn binds any control."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0", timeout=30000)
        # Pretend a DDJ-FLX4 is plugged in, and capture what the app sends back to it.
        pg.evaluate("""() => { midi.preset = PRESETS[0]; window.sent = []; midi.outputs = [{ send: b => sent.push(b) }];
            window.rx = (...b) => midi.receive(new Uint8Array(b)); }""")
        pg.evaluate("rx(0x90, 0x0B, 0x7F); rx(0x90, 0x0B, 0)")                 # PLAY
        pg.wait_for_function("!decks.A.el.paused")
        pg.evaluate("rx(0xB6, 0x1F, 0x7F); rx(0xB6, 0x3F, 0x7F)")              # crossfader all the way right
        self.assertAlmostEqual(pg.evaluate("+document.querySelector('#xfader').value"), 1, places=2)
        pg.evaluate("rx(0xB0, 0x07, 0); rx(0xB0, 0x27, 0)")                    # EQ high fully cut
        self.assertEqual(pg.evaluate("mixer.channels.A.knobs.high.value"), pg.evaluate("mixer.channels.A.knobs.high.min"))
        pg.evaluate("rx(0xB0, 0x00, 0x7F); rx(0xB0, 0x20, 0x7F)")              # tempo fader at the bottom: fastest
        self.assertAlmostEqual(pg.evaluate("decks.A.tempo"), 8, places=1)
        pg.evaluate("rx(0x97, 0x00, 0x7F); rx(0x97, 0x00, 0)")                 # hot cue pad 1 sets a cue
        self.assertIsNotNone(pg.evaluate("decks.A.hot[0]"))
        pg.evaluate("rx(0x97, 0x62, 0x7F)")                                    # beat loop pad 3: a 1-beat loop
        self.assertEqual(pg.evaluate("decks.A.mode"), "loop")
        self.assertEqual(pg.evaluate("decks.A.loop && decks.A.loop.beats"), 1)
        pg.evaluate("rx(0x90, 0x4D, 0x7F)")                                    # RELOOP/EXIT leaves it
        self.assertIsNone(pg.evaluate("decks.A.loop"))
        # Jog: touch the top and turn back half a turn, then let go and play resumes.
        pg.evaluate("decks.A.el.currentTime = 10")
        pg.wait_for_timeout(200)
        before = pg.evaluate("decks.A.el.currentTime")
        pg.evaluate("rx(0x90, 0x36, 0x7F); for (let i = 0; i < 36; i++) rx(0xB0, 0x22, 64 - 10)")   # 360 ticks back
        self.assertAlmostEqual(pg.evaluate("decks.A.scratchPos"), before - 0.9, delta=0.05)   # half a turn of 1.8 s
        pg.evaluate("rx(0x90, 0x36, 0)")
        self.assertIsNone(pg.evaluate("decks.A.hwJog"))
        self.assertFalse(pg.evaluate("decks.A.scratching"))
        # Lights: play is lit on deck 1 and the hot cue pad that holds a cue.
        pg.evaluate("rx(0x90, 0x1B, 0x7F); midi.lights()")                    # HOT CUE mode button
        sent = pg.evaluate("sent.map(b => Array.from(b).join(','))")
        self.assertIn("144,11,127", sent)
        self.assertIn("151,0,127", sent)
        # MIDI learn: click the deck 2 SLIP button, then press an unmapped note.
        pg.evaluate("midi.preset = null; midi.access = {}; midi.startLearn()")
        pg.click(".deck[data-deck=B] .slip")
        pg.evaluate("rx(0x9F, 0x30, 0x7F)")
        pg.evaluate("midi.stopLearn()")
        self.assertFalse(pg.evaluate("decks.B.slip"))
        pg.evaluate("rx(0x9F, 0x30, 0x7F); rx(0x9F, 0x30, 0)")
        self.assertTrue(pg.evaluate("decks.B.slip"))
        pg.evaluate("localStorage.removeItem('tubedeck.midiMap')")
        # Headphone CUE (0x54) and split-cue routing: master left, headphones right.
        pg.evaluate("midi.preset = PRESETS[0]; rx(0x90, 0x54, 0x7F)")
        self.assertTrue(pg.evaluate("decks.A.cueOn"))
        self.assertTrue(pg.evaluate("document.querySelector('.channel[data-ch=A] .pfl').classList.contains('on')"))
        pg.evaluate("phones.toggleCue('A')")
        self.assertEqual(errors, [])
        pg.close()

    def test_headphones(self):
        """Split cue puts the master in the left ear and the cued deck in the right; routing never doubles or leaks."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0", timeout=30000)
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.wait_for_function("!decks.A.el.paused")
        # Split cue, headphone MIX fully on CUE. Tap the merger's two inputs (left, right).
        pg.evaluate("phones.mode = 'split'; phones.setMix(0); phones.route()")
        levels = """() => new Promise(done => {
            const m = phones.nodes.find(n => n instanceof ChannelMergerNode);
            const sp = ctx.createChannelSplitter(2), a = [ctx.createAnalyser(), ctx.createAnalyser()];
            m.connect(sp); sp.connect(a[0], 0); sp.connect(a[1], 1);
            setTimeout(() => done(a.map(x => { const b = new Float32Array(2048); x.getFloatTimeDomainData(b);
                let s = 0; for (const v of b) s += v * v; return Math.sqrt(s / b.length); })), 700); })"""
        # Channel fader down, CUE on: nothing in the left ear (master), the deck in the right (pre-fader cue).
        pg.evaluate("const f = mixer.channels.A.fader; f.value = 0; f.dispatchEvent(new Event('input')); phones.toggleCue('A')")
        left, right = pg.evaluate(levels)
        self.assertLess(left, 0.005, f"master should be silent: {left}")
        self.assertGreater(right, 0.02, f"cue should be audible: {right}")
        # Fader up, CUE off: the deck in the left ear only.
        pg.evaluate("const f = mixer.channels.A.fader; f.value = 1; f.dispatchEvent(new Event('input')); phones.toggleCue('A')")
        left, right = pg.evaluate(levels)
        self.assertGreater(left, 0.02, f"master should be audible: {left}")
        self.assertLess(right, 0.005, f"cue should be silent: {right}")
        # Overlapping reroutes (device switches await) build exactly one graph.
        pg.evaluate("""async () => {
            const real = ctx.setSinkId; phones.mainId = 'slow-device';
            ctx.setSinkId = () => new Promise(r => setTimeout(r, 80));
            await Promise.all([phones.route(), phones.route(), phones.route()]);
            ctx.setSinkId = real; phones.mainId = ''; }""")
        self.assertEqual(pg.evaluate("phones.nodes.filter(n => n instanceof ChannelMergerNode).length"), 1)
        # A 4-output mode on a 2-channel output falls back to one output, never split cue.
        if pg.evaluate("ctx.destination.maxChannelCount") < 4:
            pg.evaluate("phones.mode = 'quad'; phones.route()")
            self.assertEqual(pg.evaluate("phones.nodes.filter(n => n instanceof ChannelMergerNode).length"), 0)
            self.assertIn("one output", pg.evaluate("document.querySelector('#phonesStatus').textContent"))
        # Separate mode without its own device stays off instead of playing on the default.
        pg.evaluate("phones.mode = 'separate'; phones.hpId = ''; phones.route()")
        self.assertIsNone(pg.evaluate("phones.el"))
        pg.evaluate("phones.mode = 'off'; phones.route()")
        self.assertEqual(errors, [])
        pg.close()

    def test_drop_local_file(self):
        """An MP3 dropped on a deck loads, plays and gets a BPM without the helper; non-audio is refused."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        # Build a real File from the fixture MP3 and drop it on deck 2, as the browser would.
        pg.evaluate("""async () => {
            let st = await api('/api/fetch?id=kickTrack01&now=1', { method: 'POST' });
            while (st.state !== 'ready') { await new Promise(r => setTimeout(r, 300)); st = await api('/api/status?id=kickTrack01'); }
            const bytes = await (await fetch(audioUrl('kickTrack01'))).arrayBuffer();
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], 'DJ Test - Kick Loop.mp3', { type: 'audio/mpeg' }));
            const deck = document.querySelector('.deck[data-deck=B] .jog-ring');
            for (const type of ['dragenter', 'dragover', 'drop'])
                deck.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }""")
        pg.wait_for_function("decks.B.bpm > 0", timeout=30000)
        self.assertEqual(pg.evaluate("decks.B.ui.title.textContent"), "Kick Loop")
        self.assertEqual(pg.evaluate("decks.B.ui.artist.textContent"), "DJ Test")
        self.assertIsNone(pg.evaluate("decks.A.track"))
        self.assertFalse(pg.evaluate("document.body.classList.contains('dropping')"))
        pg.dispatch_event(".deck[data-deck=B] .play", "pointerdown")
        pg.wait_for_function("decks.B.el.currentTime > 0.3")
        # Open file with a text file is refused without touching the decks.
        pg.set_input_files("#fileInput", files=[{"name": "notes.txt", "mimeType": "text/plain", "buffer": b"hello"}])
        self.assertIsNone(pg.evaluate("decks.A.track"))
        self.assertIn("not audio", pg.evaluate("document.querySelector('#queueInfo').textContent"))
        self.assertEqual(errors, [])
        pg.close()

    def test_track_memory_and_recorder(self):
        """Hot cues, the cue point and a fixed BPM come back on reload; REC saves the mix to a file."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820}, accept_downloads=True)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("localStorage.removeItem('tubedeck.track:kickTrack01')")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0 && decks.A.memReady", timeout=30000)
        detected = pg.evaluate("decks.A.bpm")
        pg.evaluate("decks.A.el.currentTime = 2.2")
        pg.dispatch_event(".deck[data-deck=A] .pad-grid .pad:nth-child(2)", "pointerdown")
        pg.dispatch_event(".deck[data-deck=A] .pad-grid .pad:nth-child(2)", "pointerup")
        pg.click(".deck[data-deck=A] .bpm-fix[data-f='2']")
        saved = pg.evaluate("[decks.A.hot[1], decks.A.bpm]")
        self.assertIsNotNone(saved[0])
        self.assertAlmostEqual(saved[1], round(detected * 2, 1), places=1)
        # Reload the page and the track: everything comes back.
        pg.reload()
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('B', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.B.memReady", timeout=30000)
        self.assertAlmostEqual(pg.evaluate("decks.B.hot[1]"), saved[0], places=3)
        self.assertAlmostEqual(pg.evaluate("decks.B.bpm"), saved[1], places=1)
        self.assertNotIn("--", pg.evaluate("document.querySelectorAll('.deck[data-deck=B] .pad')[1].textContent") or "")
        pg.evaluate("localStorage.removeItem('tubedeck.track:kickTrack01')")
        # Record a couple of seconds of the mix, surviving a headphone reroute mid-way.
        pg.dispatch_event(".deck[data-deck=B] .play", "pointerdown")
        pg.click("#recBtn")
        self.assertTrue(pg.evaluate("document.querySelector('#recBtn').classList.contains('on')"))
        pg.wait_for_timeout(800)
        pg.evaluate("phones.mode = 'split'; phones.route()")
        pg.wait_for_timeout(1500)
        with pg.expect_download() as dl:
            pg.click("#recBtn")
        d = dl.value
        self.assertRegex(d.suggested_filename, r"^tubedeck-mix-.*\.(webm|m4a)$")
        self.assertGreater(os.path.getsize(d.path()), 5000)
        pg.evaluate("phones.mode = 'off'; phones.route()")
        self.assertEqual(errors, [])
        pg.close()

    def test_ddj_full_mapping(self):
        """Shift-layer and DDJ-1000 controls act on the app: sampler, key shift, censor, jumps, ranges, FX select, VU."""
        pg = self.browser.new_page(viewport={"width": 1180, "height": 820})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(self.base + f"/?sp=1&t={server.TOKEN}")
        pg.wait_for_function("document.querySelector('#helperStatus').textContent === 'Helper connected'")
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.bpm > 0", timeout=30000)
        pg.evaluate("""() => { window.sent = []; midi.outputs = [{ send: b => sent.push(Array.from(b).join(',')) }];
            window.rx = (...b) => midi.receive(new Uint8Array(b)); window.use = i => { midi.preset = PRESETS[i]; midi.lit.clear(); }; }""")
        pg.evaluate("use(0)")                                                 # DDJ-FLX4
        pg.dispatch_event(".deck[data-deck=A] .play", "pointerdown")
        pg.wait_for_function("decks.A.el.currentTime > 0.3")
        # Sampler pad plays a synthesized one-shot; SHIFT + pad stops it.
        pg.evaluate("rx(0x97, 0x30, 0x7F)")
        pg.wait_for_function("sampler.playing['0:0']", timeout=10000)
        self.assertEqual(pg.evaluate("decks.A.mode"), "sampler")
        pg.evaluate("rx(0x98, 0x30, 0x7F)")
        self.assertFalse(pg.evaluate("!!sampler.playing['0:0']"))
        # Key shift pads: pad 2 = +1, SHIFT + pad 1 = +1 more, pad 8 = reset.
        pg.evaluate("rx(0x97, 0x71, 0x7F); rx(0x98, 0x70, 0x7F)")
        self.assertEqual(pg.evaluate("decks.A.keyShift"), 2)
        pg.evaluate("rx(0x97, 0x77, 0x7F)")
        self.assertEqual(pg.evaluate("decks.A.keyShift"), 0)
        # SHIFT + BEAT SYNC cycles the tempo range; the fader follows.
        pg.evaluate("rx(0x90, 0x60, 0x7F)")
        self.assertEqual(pg.evaluate("[decks.A.tempoRange, +decks.A.ui.tempo.max]"), [16, 16])
        # SHIFT + CUE/LOOP CALL jumps 32 beats (16 s at 120 BPM).
        pg.evaluate("decks.A.el.currentTime = 20")
        pg.wait_for_timeout(100)
        t0 = pg.evaluate("decks.A.el.currentTime")
        pg.evaluate("rx(0x90, 0x3E, 0x7F)")
        self.assertAlmostEqual(pg.evaluate("decks.A.el.currentTime"), t0 - 16, delta=0.2)
        # Censor (SHIFT + PLAY): reverses while held, then lands back in time.
        t0 = pg.evaluate("decks.A.el.currentTime")
        pg.evaluate("rx(0x90, 0x0E, 0x7F)")
        pg.wait_for_timeout(800)
        self.assertLess(pg.evaluate("decks.A.el.currentTime"), t0)
        pg.evaluate("rx(0x90, 0x0E, 0)")
        pg.wait_for_timeout(150)
        self.assertGreater(pg.evaluate("decks.A.el.currentTime"), t0 + 0.6)
        # SHIFT + BEAT FX ON/OFF turns every effect off.
        pg.evaluate("fx[0].toggle(); fx[1].toggle(); rx(0x94, 0x43, 0x7F)")
        self.assertEqual(pg.evaluate("[fx[0].on, fx[1].on]"), [False, False])
        # VU meter goes back to the controller.
        pg.evaluate("midi.lights()")
        self.assertTrue(any(m.startswith("176,2,") for m in pg.evaluate("sent")))
        # DDJ-1000: Beat FX selector, crossfader THRU, sampler bank, loop-in adjust with the jog.
        pg.evaluate("use(1)")
        pg.evaluate("rx(0x94, 0x2D, 0x7F)")
        self.assertEqual(pg.evaluate("fx[0].type"), "helix")
        pg.evaluate("rx(0x90, 0x1D, 0x7F)")
        self.assertEqual(pg.evaluate("mixer.xfAssign.A"), "T")
        pg.evaluate("rx(0x90, 0x16, 0x7F)")
        pg.evaluate("rx(0x90, 0x09, 0x7F)")
        self.assertEqual(pg.evaluate("sampler.bank"), 1)
        pg.evaluate("decks.A.beatLoop(4); rx(0x90, 0x4C, 0x7F)")
        start = pg.evaluate("decks.A.loop.start")
        pg.evaluate("for (let i = 0; i < 20; i++) rx(0xB0, 0x21, 64 + 10)")   # 200 ticks forward
        self.assertGreater(pg.evaluate("decks.A.loop.start"), start + 0.01)
        pg.evaluate("rx(0x90, 0x4C, 0x7F); decks.A.exitLoop()")
        self.assertEqual(errors, [])
        pg.close()

    def test_ddj1000_jog_screen_handshake(self):
        """The DDJ-1000 handshake waits for its sound card, answers the challenge correctly, then brings the screens up."""
        pg = self.page()
        # No network in tests: the recorded bring-up is unavailable, so the short one is used.
        pg.evaluate("jogScreens.loadingBurst = Promise.resolve(); jogScreens.burst = null")
        pg.evaluate("""() => { window.sent = []; midi.outputs = [{ send: b => sent.push(Array.from(b)) }]; midi.preset = PRESETS[1];
            window.ddj = body => midi.receive(new Uint8Array([0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x02, 0x00, 0x00, ...body, 0xF7])); }""")
        # Just connected: nothing but the keep-alive until the unit has asked and been answered.
        pg.evaluate("jogScreens.expect(); sent.length = 0; midi.lights()")
        self.assertEqual(pg.evaluate("sent.length"), 0)
        # "Who are you?" before the DDJ's audio is playing: held, not answered.
        pg.evaluate("ddj([0x11, 0x02])")
        self.assertEqual(pg.evaluate("jogScreens.state"), "waiting")
        self.assertEqual(pg.evaluate("sent.filter(m => m[0] === 0xF0 && m[9] === 0x12).length"), 0)
        # Once tubedeck plays through the DDJ's sound card, it answers with its identity.
        pg.evaluate("audio(); phones.mode = 'quad'; phones.mainId = 'ddj'; phones.labels = { ddj: 'DDJ-1000' }; jogScreens.poll()")
        pg.wait_for_function("ctx.state === 'running'")
        pg.evaluate("jogScreens.poll()")
        ident = pg.evaluate("sent.find(m => m[0] === 0xF0 && m[9] === 0x12)")
        self.assertEqual(ident[9:11], [0x12, 0x2A])
        self.assertIn(list(b"PioneerDJ"), [ident[i:i + 9] for i in range(len(ident))])
        # The challenge: seed 12 34 AB CD (as nibbles). The answer's hash is FNV-1a over seed and seed^secret.
        pg.evaluate("ddj([0x13, 0x0C, 0x03, 0x0A, 0x1, 0x2, 0x3, 0x4, 0xA, 0xB, 0xC, 0xD])")
        cap = pg.evaluate("sent.find(m => m[0] === 0xF0 && m[9] === 0x14)")
        self.assertEqual(len(cap), 66)
        hash_spread = [0xE, 0xC, 0x9, 0x8, 0x6, 0x8, 0x8, 0xE]          # ec98688e, computed by the reference code
        self.assertIn(hash_spread, [cap[i:i + 8] for i in range(len(cap))])
        # ACK: unlocked, and the screens are switched on for all four decks.
        pg.evaluate("ddj([0x15, 0x02])")
        self.assertEqual(pg.evaluate("jogScreens.state"), "unlocked")
        pg.wait_for_function("sent.some(m => m[0] === 0x93 && m[1] === 0x5D && m[2] === 0)", timeout=5000)
        self.assertTrue(pg.evaluate("sent.some(m => m[0] === 0x9F && m[1] === 0x09 && m[2] === 0x7F)"))  # PC app connect
        pg.evaluate("sent.length = 0; midi.lit.clear(); midi.lights()")
        self.assertGreater(pg.evaluate("sent.length"), 0)                                           # lights back on
        # With the recorded bring-up available it is replayed whole, timed, and lights wait for it.
        pg.evaluate("""() => { jogScreens.burst = [[0x90, 0x0B, 0x00], [0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x0B, 0x34, 0xF7]];
            window.timed = []; midi.outputs = [{ send: (b, at) => timed.push([Array.from(b), at]) }];
            jogScreens.bringing = false; jogScreens.bringUp(); }""")
        pg.wait_for_function("timed.filter(x => x[1]).length === 2", timeout=5000)
        self.assertFalse(pg.evaluate("jogScreens.quiet()"))                 # lights held during the burst
        pg.wait_for_function("jogScreens.quiet()", timeout=3000)
        # A recording that doesn't match the pinned fingerprint is refused.
        pg.evaluate("""async () => { jogScreens.burst = null; jogScreens.loadingBurst = null;
            const real = window.fetch; window.fetch = async () => new Response('900b00\\n'); await jogScreens.loadBurst(); window.fetch = real; }""")
        self.assertIsNone(pg.evaluate("jogScreens.burst"))
        pg.evaluate("phones.mode = 'off'")
        self.assertEqual(self.errors, [])
        pg.close()

    def test_key_detection_and_shift(self):
        """Each track gets a detected key; − / + / reset shift it and SYNC matches the other deck harmonically."""
        pg = self.page()
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.key", timeout=30000)
        self.assertRegex(pg.evaluate("document.querySelector('.deck[data-deck=A] .key-val').textContent"), r"^(1[0-2]|[1-9])[AB]$")
        pg.click(".deck[data-deck=A] .key-up")
        pg.click(".deck[data-deck=A] .key-up")
        self.assertEqual(pg.evaluate("decks.A.keyShift"), 2)
        self.assertTrue(pg.evaluate("document.querySelector('.deck[data-deck=A] .key-val').classList.contains('shifted')"))
        pg.click(".deck[data-deck=A] .key-reset")
        self.assertEqual(pg.evaluate("decks.A.keyShift"), 0)
        # Key sync against a known key on the other deck: A minor (8A) vs C major (8B) = no shift needed.
        pg.evaluate("decks.A.key = { tonic: 9, mode: 'min' }; decks.B.key = { tonic: 0, mode: 'maj' }; decks.A.keySync()")
        self.assertEqual(pg.evaluate("decks.A.keyShift"), 0)
        pg.evaluate("decks.A.key = { tonic: 2, mode: 'maj' }; decks.A.keySync()")             # D major (10B) -> C major, 2 down
        self.assertTrue(pg.evaluate("keysMix(decks.A.liveKey, decks.B.liveKey)"))
        self.assertEqual(pg.evaluate("decks.A.keyShift"), -2)
        # The DDJ-1000's KEY SYNC button does the same.
        pg.evaluate("decks.A.setKey(0); midi.preset = PRESETS[1]; midi.pioneer(0x90, 0x65, 0x7F)")
        self.assertTrue(pg.evaluate("keysMix(decks.A.liveKey, decks.B.liveKey)"))
        self.assertEqual(self.errors, [])
        pg.close()

    def test_controller_test_page(self):
        """The controller test ticks controls as they arrive, measures the jog, lists unhandled messages and reports it all."""
        pg = self.page()
        pg.evaluate("midi.preset = PRESETS[0]; midi.outputs = [{ send() {} }]; window.rx = (...b) => midi.receive(new Uint8Array(b))")
        pg.evaluate("ctlTest.show()")
        self.assertTrue(pg.evaluate("document.querySelector('#ctlTest').open"))
        total = pg.evaluate("ctlTest.items().length")
        pg.evaluate("rx(0x90, 0x0B, 0x7F); rx(0x90, 0x0B, 0)")                 # deck 1 PLAY
        pg.evaluate("rx(0xB6, 0x1F, 0x40); rx(0xB6, 0x3F, 0x00)")              # crossfader
        self.assertEqual(pg.evaluate("ctlTest.seen.size"), 2)
        self.assertIn(f"2 of {total}", pg.evaluate("document.querySelector('#ctProgress').textContent"))
        self.assertEqual(pg.evaluate("document.querySelectorAll('.ct-chip.ok').length"), 2)
        # Jog: touch, 360 ticks forward, release -> half a turn at the FLX4's 720 per turn.
        pg.evaluate("rx(0x90, 0x36, 0x7F); for (let i = 0; i < 36; i++) rx(0xB0, 0x22, 74); rx(0x90, 0x36, 0)")
        self.assertIn("360 ticks = 0.50 turns", pg.evaluate("document.querySelector('#ctMeasure').textContent"))
        # Something tubedeck doesn't know is listed, a button release isn't.
        pg.evaluate("rx(0xB6, 0x70, 0x10); rx(0x94, 0x47, 0)")
        self.assertEqual(pg.evaluate("[...ctlTest.unmapped.keys()]"), ["B6 70"])
        report = pg.evaluate("JSON.parse(ctlTest.report())")
        self.assertEqual(report["controller"], "Pioneer DDJ-FLX4")
        self.assertEqual(len(report["tested"]) + len(report["notTested"]), total)
        self.assertEqual(report["jog"]["1"]["last"], 360)
        self.assertEqual(self.errors, [])
        pg.close()

    def test_collection_tags_sort_and_match(self):
        """Collection tracks get BPM and key in the background (saved by the helper), sort, and MATCH filters by mix."""
        pg = self.page()
        pg.evaluate("loadOnDeck('A', {id: 'kickTrack01', title: 'Kick Test 120'})")
        pg.wait_for_function("decks.A.key", timeout=30000)
        pg.wait_for_function("library.some(t => t.id === 'kickTrack01' && t.analysis)", timeout=30000)
        saved = json.loads(urllib.request.urlopen(urllib.request.Request(self.base + "/api/library", headers={"X-Tubedeck-Token": server.TOKEN})).read())
        track = next(t for t in saved["tracks"] if t["id"] == "kickTrack01")
        self.assertAlmostEqual(track["analysis"]["bpm"], 120, delta=1)
        pg.click(".tab[data-tab=library]")
        self.assertFalse(pg.evaluate("document.querySelector('#libTools').hidden"))
        self.assertRegex(pg.evaluate("document.querySelector('#list li[data-id=kickTrack01] .tags').textContent"), r"^120\.\d · (1[0-2]|[1-9])[AB]$")
        # Two made-up tracks: one that mixes with deck 1 (same key, same tempo), one that doesn't.
        pg.evaluate("""() => { const k = decks.A.liveKey;
            library.push({ id: 'mixesWell01', title: 'Mixes well', analysis: { bpm: decks.A.liveBpm, firstBeat: 0, key: k }, added: 1 },
                         { id: 'clashing001', title: 'Clashes', analysis: { bpm: 174, firstBeat: 0, key: { tonic: (k.tonic + 6) % 12, mode: k.mode } }, added: 2 });
            showTab('library'); }""")
        pg.select_option("#libSort", "bpm")
        self.assertEqual(pg.evaluate("[...document.querySelectorAll('#list li[data-id]')].map(li => li.dataset.id).pop()"), "clashing001")
        pg.click("#libMatch")
        self.assertEqual(pg.evaluate("[...document.querySelectorAll('#list li[data-id]')].map(li => li.dataset.id)"), ["mixesWell01"])
        pg.click("#libMatch")
        pg.evaluate("library.splice(library.findIndex(t => t.id === 'mixesWell01'), 2); localStorage.removeItem('tubedeck.libSort')")
        self.assertEqual(self.errors, [])
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

    def test_themes(self):
        """Each theme applies its colours to the canvases, keeps the layout intact and is remembered."""
        pg = self.page()
        for theme in ["forest", "waterfall", "meadow", "ocean", "desert", "snow", "space", "rainforest", "alps",
                      "hakone", "wulong", "chongqing", "timessquare", "williamsburg", "aurora", "classic"]:
            pg.select_option("#themeSel", theme)
            self.assertEqual(pg.evaluate("document.documentElement.dataset.theme"), theme)
            colours = pg.evaluate("[THEME.low, THEME.A, decks.A.color]")
            self.assertTrue(all(colours) and colours[1] == colours[2], f"{theme}: {colours}")
            self.assertLessEqual(pg.evaluate("document.documentElement.scrollWidth - innerWidth"), 0)
            self.assertEqual(pg.evaluate("getComputedStyle(document.querySelector('.scene.front')).pointerEvents"), "none")
            # Shader scenes must compile (a GLSL error would leave the band blank).
            if pg.evaluate(f"!!SCENES['{theme}']"):
                pg.wait_for_timeout(100)
                self.assertTrue(pg.evaluate(f"!vista.gl || !!vista.program('{theme}')"), f"{theme}: shader failed to compile")
            if pg.evaluate(f"!!UNDER_SCENES['{theme}']"):
                pg.wait_for_timeout(100)
                self.assertTrue(pg.evaluate(f"!under.gl || !!under.program('{theme}')"), f"{theme}: background shader failed to compile")
        pg.select_option("#themeSel", "meadow")
        pg.reload()
        pg.wait_for_function("document.documentElement.dataset.theme")  # set once app.js has run
        self.assertEqual(pg.evaluate("document.documentElement.dataset.theme"), "meadow")
        pg.evaluate("localStorage.removeItem('tubedeck.theme')")

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
