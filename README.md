# tubedeck

A practice DJ console for the browser, laid out like a two-deck controller (DDJ-FLX4 style), that plays tracks from YouTube. Made for practicing mixing on an iPad or laptop, not for performing.

A small helper runs on your computer. It serves the app, searches YouTube, and downloads each track's audio once with [yt-dlp](https://github.com/yt-dlp/yt-dlp). The browser then has the real audio, so the decks get full DJ features:

- waveform overview, Pioneer-style CUE, play/pause, jog wheel (scrub when paused, nudge when playing)
- tempo ±8% with key lock, automatic BPM detection (with ½ and ×2 fixes), SYNC
- 8 hot cues and beat loops from ½ to 32 beats
- mixer with 3-band EQ, filter, channel faders with meters, equal-power crossfader

## Run it

Needs Python 3.10+ and an up-to-date yt-dlp (`python3 -m pip install -U yt-dlp`).

```bash
python3 server.py
```

The helper prints a link with a pairing code, for example `http://192.168.1.20:8765/?t=abc123`. Open it on this computer, or on an iPad on the same Wi-Fi. The page saves the pairing code, so you only need the full link once. On macOS, allow Python to accept incoming connections if asked.

Downloaded audio, the pairing code and throttle state live in `~/.tubedeck` (set `TUBEDECK_HOME` to move it, `TUBEDECK_PORT` to change the port).

## How YouTube requests are throttled

Every request the helper makes to YouTube, for every person using it, goes through one queue:

- one yt-dlp process at a time, using yt-dlp's `-t sleep` preset (10–20 s before each download, 0.75 s between requests)
- at least 10 s between YouTube jobs and at most 40 per hour
- a 30-minute pause if YouTube shows a bot check or rate limit
- no cookies, so a block can only ever affect the network, never a Google account
- audio only, and each track is downloaded once and then served from the cache

Searches don't queue behind downloads: if the helper is busy, the search returns a "try again" message.

## Search with your own YouTube API key (optional)

Searches go through the helper by default. To search directly from the browser on your own free daily allowance (about 100 searches), add a YouTube Data API v3 key in Settings (⚙︎). The key is saved only in that browser. To get one: create a project at console.cloud.google.com, enable **YouTube Data API v3**, then create an API key under Credentials and restrict it to that API.

## Stems (optional)

The helper can split a downloaded track into four stems (vocals, drums, bass, other) with [Demucs](https://github.com/adefossez/demucs), so you can mute or isolate parts while you practice. Separation runs locally on this Mac (on the GPU via Metal when it can, otherwise the CPU). It never contacts YouTube and doesn't count against the throttle.

```bash
./scripts/install-stems.sh    # one-time: a venv in ~/.tubedeck/stems-venv with Demucs and PyTorch
```

The install downloads about 140 MB (PyTorch), and the htdemucs model (about 84 MB) downloads the first time you separate a track. A 6-minute track took about 75 seconds on an Apple Silicon Mac (GPU, first run including the model download). Stems are cached as MP3s in `~/.tubedeck/cache/stems/`, so each track is separated only once. Restart the helper after installing; it prints whether stems are available.

## Tests

```bash
python3 -m unittest discover -s tests     # helper, against a fake yt-dlp (offline)
python3 tests/browser_smoke.py            # the web app in headless Chrome (needs Playwright, Chrome, ffmpeg)
```

## Notes

YouTube's terms don't allow downloading. This is a personal practice tool; keep the throttle settings as they are and use it for your own practice.
