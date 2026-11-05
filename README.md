# tubedeck

A practice DJ console for the browser, laid out like a two-deck controller (DDJ-FLX4 style), that plays tracks from YouTube. Made for practicing mixing on an iPad or laptop, not for performing.

A small helper runs on your computer. It serves the app, searches YouTube, and downloads each track's audio once with [yt-dlp](https://github.com/yt-dlp/yt-dlp). The browser then has the real audio, so the decks get full DJ features:

- waveform overview, Pioneer-style CUE, play/pause, jog wheel (scrub when paused, nudge when playing)
- tempo ±8% with key lock, automatic BPM detection (with ½ and ×2 fixes), SYNC
- 8 hot cues and beat loops from ½ to 32 beats
- mixer with 3-band EQ, filter, channel faders with meters, equal-power crossfader

## Screenshots

![tubedeck with the Classic theme, a track playing on deck 1](docs/screenshots/classic.jpg)

Every theme, with a track playing on deck 1. The scene themes are live 3D scenes that move with the music.

<details>
<summary>Show all 16 themes</summary>

**Forest**

![Forest theme](docs/screenshots/forest.jpg)

**Waterfall (with the reef below)**

![Waterfall (with the reef below) theme](docs/screenshots/waterfall.jpg)

**Meadow**

![Meadow theme](docs/screenshots/meadow.jpg)

**Ocean**

![Ocean theme](docs/screenshots/ocean.jpg)

**Desert**

![Desert theme](docs/screenshots/desert.jpg)

**Snowy Mountain**

![Snowy Mountain theme](docs/screenshots/snow.jpg)

**ISS / Orbit**

![ISS / Orbit theme](docs/screenshots/space.jpg)

**Rainforest**

![Rainforest theme](docs/screenshots/rainforest.jpg)

**Switzerland**

![Switzerland theme](docs/screenshots/alps.jpg)

**Hakone**

![Hakone theme](docs/screenshots/hakone.jpg)

**Wulong Karst**

![Wulong Karst theme](docs/screenshots/wulong.jpg)

**Chongqing**

![Chongqing theme](docs/screenshots/chongqing.jpg)

**Times Square**

![Times Square theme](docs/screenshots/timessquare.jpg)

**Williamsburg**

![Williamsburg theme](docs/screenshots/williamsburg.jpg)

**Aurora**

![Aurora theme](docs/screenshots/aurora.jpg)

</details>

## Run it

Needs Python 3.10+ and an up-to-date yt-dlp (`python3 -m pip install -U yt-dlp`).

```bash
python3 server.py
```

The helper prints a link with a pairing code, for example `http://192.168.1.20:8765/?t=abc123`. Open it on this computer, or on an iPad on the same Wi-Fi. The page saves the pairing code, so you only need the full link once. On macOS, allow Python to accept incoming connections if asked.

Downloaded audio, the pairing code and throttle state live in `~/.tubedeck` (set `TUBEDECK_HOME` to move it, `TUBEDECK_PORT` to change the port).

## Use it on your iPad from anywhere (Tailscale)

The helper is a small web server: the iPad opens a link to it, the page then runs on the iPad, and the helper does the YouTube searching, downloading and stem separation. On the same Wi-Fi the link the helper prints just works. To use it from anywhere, and over HTTPS (which gives the iPad the better audio engine, a home-screen app and a screen that stays on while playing), use [Tailscale](https://tailscale.com), a free private network between your own devices:

1. Install Tailscale on the computer that runs the helper and on the iPad, and sign in to the same account on both.
2. On the computer, turn on HTTPS for your devices once in the Tailscale admin console (DNS, then HTTPS Certificates), then run:
   ```bash
   tailscale serve --bg 8765
   ```
   This gives the helper a private HTTPS address like `https://your-mac.your-tailnet.ts.net` that only your own devices can reach. It keeps working across restarts; `tailscale serve reset` turns it off.
3. Start the helper as usual. It prints the Tailscale link (with the pairing code) next to the Wi-Fi ones.
4. On the iPad, open that link in Safari. To install it: Share, then Add to Home Screen. The installed app keeps its own storage, so it asks for the pairing code once.

The pairing code is still required on every address, and the helper only answers your own devices. The computer running the helper has to stay on and awake.

### An always-on helper on a Raspberry Pi (optional)

If your Mac is a laptop you carry around, a Raspberry Pi 4 or 5 left plugged in at home can be the helper instead (stems are slow on a Pi, so skip them there):

```bash
sudo apt install -y python3 python3-pip git ffmpeg
python3 -m pip install -U --break-system-packages yt-dlp
git clone https://github.com/GYberkeley/tubedeck.git && cd tubedeck
python3 server.py
```

To start it on boot, create `/etc/systemd/system/tubedeck.service`:

```ini
[Unit]
Description=tubedeck helper
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/tubedeck
ExecStart=/usr/bin/python3 server.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now tubedeck`, install Tailscale on the Pi (`curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`) and run `tailscale serve --bg 8765` there. Update yt-dlp now and then with `python3 -m pip install -U --break-system-packages yt-dlp`, since YouTube changes often. The pairing code is in `~/.tubedeck/token` on the Pi.

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

The helper can split a downloaded track into four stems (vocals, drums, bass, other) with [Demucs](https://github.com/adefossez/demucs), so you can mute or isolate parts while you practice. Separation runs locally on this Mac's CPU. (On Apple Silicon the GPU backend returns wrong stems without reporting an error, so it's off by default; set `TUBEDECK_STEMS_DEVICE` to try another device.) It never contacts YouTube and doesn't count against the throttle.

```bash
./scripts/install-stems.sh    # one-time: a venv in ~/.tubedeck/stems-venv with Demucs and PyTorch
```

The install downloads about 140 MB (PyTorch), and the htdemucs model (about 84 MB) downloads the first time you separate a track. A 6-minute track takes about 2.5 minutes (measured: 156 s) on an Apple Silicon Mac's CPU. Decks keep playing the original track; muting a stem subtracts it, so with every stem on you hear the original exactly. Stems are cached as MP3s in `~/.tubedeck/cache/stems/`, so each track is separated only once. Restart the helper after installing; it prints whether stems are available.

## Tests

```bash
python3 -m unittest discover -s tests     # helper, against a fake yt-dlp (offline)
python3 tests/browser_smoke.py            # the web app in headless Chrome (needs Playwright, Chrome, ffmpeg)
```

## Notes

YouTube's terms don't allow downloading. This is a personal practice tool; keep the throttle settings as they are and use it for your own practice.
