'use strict';

// ---------- storage + helper API ----------
const store = {
  get(k) { try { return localStorage.getItem('tubedeck.' + k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem('tubedeck.' + k, v) : localStorage.removeItem('tubedeck.' + k); } catch {} },
};

(function takeTokenFromUrl() {
  const u = new URL(location.href);
  const t = u.searchParams.get('t');
  if (t) {
    store.set('token', t);
    u.searchParams.delete('t');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
})();

const token = () => store.get('token');

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'X-Tubedeck-Token': token(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Helper error ${res.status}`), { status: res.status });
  return data;
}

const audioUrl = id => `/api/audio/${id}?t=${encodeURIComponent(token())}`;
const $ = (sel, root = document) => root.querySelector(sel);
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- audio context ----------
let ctx, master;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = +$('#master').value;
    master.connect(ctx.destination);
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
document.addEventListener('pointerdown', () => audio(), { capture: true });

// ---------- analysis: waveform peaks + BPM ----------
const MAX_ANALYSIS_SECONDS = 20 * 60;

function peaks(buf, bins = 1200) {
  const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / bins)), out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    let m = 0;
    for (let i = b * step, e = Math.min(d.length, i + step); i < e; i += 4) { const v = Math.abs(d[i]); if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}

function detectBpm(buf) {
  const sr = buf.sampleRate, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const segLen = Math.min(ch0.length, sr * 90), start = Math.floor((ch0.length - segLen) / 2);
  const hop = 256, n = Math.floor(segLen / hop);
  const alpha = 1 - Math.exp(-2 * Math.PI * 150 / sr); // ~150 Hz low-pass to follow the kick
  const env = new Float32Array(n);
  let lp = 0;
  for (let h = 0; h < n; h++) {
    let e = 0;
    for (let i = 0; i < hop; i++) {
      const j = start + h * hop + i;
      lp += alpha * ((ch0[j] + ch1[j]) * 0.5 - lp);
      e += lp * lp;
    }
    env[h] = Math.sqrt(e / hop);
  }
  const onset = new Float32Array(n);
  for (let h = 1; h < n; h++) onset[h] = Math.max(0, env[h] - env[h - 1]);
  const hopS = hop / sr, lagFor = bpm => 60 / bpm / hopS;
  const minLag = Math.floor(lagFor(180)), maxLag = Math.ceil(lagFor(70));
  const r = new Float32Array(maxLag + 2);
  for (let L = minLag - 1; L <= maxLag + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += onset[i] * onset[i + L];
    r[L] = s;
  }
  let best = minLag;
  for (let L = minLag; L <= maxLag; L++) if (r[L] > r[best]) best = L;
  const a = r[best - 1], b = r[best], c = r[best + 1], denom = a - 2 * b + c;
  const lag = best + (denom ? 0.5 * (a - c) / denom : 0);
  let bpm = 60 / (lag * hopS);
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// ---------- decks ----------
const PAD_COLORS = ['#ff4d6d', '#ffb020', '#3ddc84', '#3fb6ff', '#b36bff', '#ff8a3d', '#4de1d2', '#f5f5f5'];
const LOOP_BEATS = [0.5, 1, 2, 4, 8, 16, 32];
const SECONDS_PER_JOG_TURN = 1.8;
const decks = {};

class Deck {
  constructor(letter) {
    this.letter = letter;
    this.root = $(`.deck[data-deck=${letter}]`);
    this.root.append($('#deckTpl').content.cloneNode(true));
    $('.deck-letter', this.root).textContent = letter;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.preservesPitch = this.el.webkitPreservesPitch = true;
    this.track = null; this.cue = 0; this.hot = Array(8).fill(null);
    this.bpm = 0; this.tempo = 0; this.keyLock = true; this.synced = false;
    this.loop = null; this.mode = 'hot'; this.peaks = null; this.bend = 0; this.lastJogMove = 0;
    this.pending = null; // id of the track being fetched for this deck; stale fetches compare against it
    this.lastDraw = '';
    this.color = letter === 'A' ? '#3fb6ff' : '#ff8a3d';
    this.bindUi();
  }

  connect() {
    if (this.chain) return;
    const c = audio();
    const src = c.createMediaElementSource(this.el);
    const low = Object.assign(c.createBiquadFilter(), { type: 'lowshelf' }); low.frequency.value = 200;
    const mid = Object.assign(c.createBiquadFilter(), { type: 'peaking' }); mid.frequency.value = 1000; mid.Q.value = 0.8;
    const high = Object.assign(c.createBiquadFilter(), { type: 'highshelf' }); high.frequency.value = 3500;
    const lpf = Object.assign(c.createBiquadFilter(), { type: 'lowpass' }); lpf.frequency.value = 22000; lpf.Q.value = 1;
    const hpf = Object.assign(c.createBiquadFilter(), { type: 'highpass' }); hpf.frequency.value = 10; hpf.Q.value = 1;
    const ch = c.createGain(), xf = c.createGain(), meter = c.createAnalyser();
    meter.fftSize = 1024;
    src.connect(low).connect(mid).connect(high).connect(lpf).connect(hpf).connect(ch).connect(xf).connect(master);
    ch.connect(meter);
    this.chain = { low, mid, high, lpf, hpf, ch, xf, meter, buf: new Float32Array(1024) };
    mixer.apply();
  }

  bindUi() {
    const r = this.root;
    this.ui = {
      title: $('.title', r), sub: $('.sub', r), bpm: $('.bpm', r), state: $('.deck-state', r),
      canvas: $('.overview', r), elapsed: $('.elapsed', r), remain: $('.remain', r),
      play: $('.play', r), cue: $('.cue', r), jog: $('.jog-ring', r), dot: $('.jog-dot', r),
      tempo: $('.tempo-fader', r), tempoVal: $('.tempo-val', r), keylock: $('.keylock', r), sync: $('.sync', r),
      padGrid: $('.pad-grid', r),
    };
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('button');
      p.className = 'pad'; p.style.setProperty('--pc', PAD_COLORS[i]);
      p.addEventListener('pointerdown', e => { e.preventDefault(); this.pad(i); });
      this.ui.padGrid.append(p);
    }
    r.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
      this.mode = b.dataset.mode;
      r.querySelectorAll('.mode').forEach(x => x.classList.toggle('on', x === b));
      this.renderPads();
    }));
    this.ui.play.addEventListener('pointerdown', e => { e.preventDefault(); this.togglePlay(); });
    this.ui.cue.addEventListener('pointerdown', e => { e.preventDefault(); this.cueDown(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => this.ui.cue.addEventListener(t, () => this.cueUp()));
    this.ui.tempo.addEventListener('input', () => { this.setTempo(+this.ui.tempo.value); this.synced = false; this.renderSync(); });
    $('.reset', r).addEventListener('click', () => { this.setTempo(0); this.synced = false; this.renderSync(); });
    this.ui.keylock.addEventListener('click', () => {
      this.keyLock = !this.keyLock;
      this.el.preservesPitch = this.el.webkitPreservesPitch = this.keyLock;
      this.ui.keylock.classList.toggle('on', this.keyLock);
    });
    this.ui.sync.addEventListener('click', () => this.sync());
    r.querySelectorAll('.bpm-fix').forEach(b => b.addEventListener('click', () => {
      if (!this.bpm) return;
      this.bpm = Math.round(this.bpm * +b.dataset.f * 10) / 10;
      this.renderBpm();
      if (this.synced) this.sync(true);
      this.notifyFollowers();
    }));
    this.bindJog();
    this.bindOverview();
    this.renderPads();
    // Layout sizes change only on resize, so measure them there instead of every frame.
    this.size = { jog: 0, w: 0, h: 0 };
    new ResizeObserver(() => {
      this.size = { jog: this.ui.jog.clientHeight, w: this.ui.canvas.clientWidth, h: this.ui.canvas.clientHeight };
      this.ui.dot.style.transformOrigin = `4px ${this.size.jog * 0.44}px`;
      this.lastDraw = '';
    }).observe(this.root);
    this.el.addEventListener('ended', () => this.ui.play.classList.remove('lit'));
  }

  get loaded() { return !!this.track && this.el.readyState >= 1; }
  get rate() { return 1 + this.tempo / 100; }
  get liveBpm() { return this.bpm ? this.bpm * this.rate : 0; }

  setState(msg) { this.ui.state.textContent = msg || ''; }

  async load(meta) {
    this.connect();
    this.el.pause();
    this.track = meta; this.cue = 0; this.hot.fill(null); this.loop = null; this.bpm = 0; this.peaks = null;
    this.ui.title.textContent = meta.title || meta.id;
    this.ui.sub.textContent = meta.channel || '';
    this.ui.bpm.textContent = '--.-';
    this.ui.play.classList.remove('lit');
    this.el.src = audioUrl(meta.id);
    this.el.playbackRate = this.rate;
    this.renderPads();
    this.setState('Analyzing…');
    if ((meta.duration || 0) > MAX_ANALYSIS_SECONDS) {
      this.setState('Long set: waveform and BPM skipped. Tap BPM is coming later.');
      return;
    }
    try {
      const bytes = await (await fetch(audioUrl(meta.id))).arrayBuffer();
      if (this.track !== meta) return;
      const buf = await new Promise((ok, bad) => audio().decodeAudioData(bytes, ok, bad));
      if (this.track !== meta) return;
      this.peaks = peaks(buf);
      this.bpm = detectBpm(buf);
      this.setState('');
      this.renderBpm();
      if (this.synced) this.sync();
    } catch (e) {
      this.setState('Could not analyze this track (it will still play).');
    }
  }

  togglePlay() {
    if (!this.track) return;
    audio();
    if (this.el.paused) { this.el.play().catch(() => this.setState('Tap play again to start audio.')); this.ui.play.classList.add('lit'); }
    else { this.el.pause(); this.ui.play.classList.remove('lit'); }
  }

  // Pioneer-style CUE: playing → back to cue and pause; paused → set cue here and preview while held.
  cueDown() {
    if (!this.track) return;
    if (!this.el.paused) {
      this.el.pause(); this.el.currentTime = this.cue; this.ui.play.classList.remove('lit'); return;
    }
    if (Math.abs(this.el.currentTime - this.cue) > 0.05) { this.cue = this.el.currentTime; return; }
    this.previewing = true; this.ui.cue.classList.add('lit'); this.el.play().catch(() => {});
  }
  cueUp() {
    if (!this.previewing) return;
    this.previewing = false; this.ui.cue.classList.remove('lit');
    this.el.pause(); this.el.currentTime = this.cue;
  }

  setTempo(pct) {
    this.applyTempo(pct);
    this.notifyFollowers();
  }

  // Updates this deck's tempo and display without re-syncing the other deck.
  applyTempo(pct) {
    this.tempo = clamp(pct, -8, 8);
    this.ui.tempo.value = this.tempo;
    this.ui.tempoVal.textContent = (this.tempo > 0 ? '+' : '') + this.tempo.toFixed(1) + '%';
    this.el.playbackRate = this.rate * (1 + this.bend);
    this.renderBpm();
  }

  notifyFollowers() {
    for (const d of Object.values(decks)) if (d !== this && d.synced) d.sync(true);
  }

  sync(silent) {
    const other = decks[this.letter === 'A' ? 'B' : 'A'];
    if (!this.bpm || !other.liveBpm) { if (!silent) this.setState('Sync needs a BPM on both decks.'); return; }
    let target = other.liveBpm;
    // Match at double/half time when that keeps us inside the ±8% fader.
    const options = [target, target * 2, target / 2].map(t => (t / this.bpm - 1) * 100);
    const pct = options.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a);
    if (Math.abs(pct) > 8) { if (!silent) this.setState(`Too far apart to sync within ±8% (${this.bpm} vs ${other.liveBpm.toFixed(1)}).`); return; }
    this.synced = true;
    this.applyTempo(pct);
    this.renderSync();
    if (!silent) this.setState('');
  }
  renderSync() { this.ui.sync.classList.toggle('on', this.synced); }
  renderBpm() { this.ui.bpm.textContent = this.bpm ? this.liveBpm.toFixed(1) : '--.-'; }

  pad(i) {
    if (!this.track) return;
    if (this.mode === 'loop') {
      if (i === 7 || (this.loop && this.loop.pad === i)) { this.loop = null; return this.renderPads(); }
      if (!this.bpm) return this.setState('Beat loops need a BPM.');
      const beats = LOOP_BEATS[i], len = beats * 60 / this.bpm, start = this.el.currentTime;
      this.loop = { start, end: start + len, pad: i };
      return this.renderPads();
    }
    if (this.mode === 'clear') { this.hot[i] = null; return this.renderPads(); }
    if (this.hot[i] == null) { this.hot[i] = this.el.currentTime; return this.renderPads(); }
    this.el.currentTime = this.hot[i];
    if (this.el.paused) this.cue = this.hot[i];
    const p = this.ui.padGrid.children[i];
    p.classList.add('lit'); setTimeout(() => p.classList.remove('lit'), 150);
  }

  renderPads() {
    [...this.ui.padGrid.children].forEach((p, i) => {
      if (this.mode === 'loop') {
        p.textContent = i === 7 ? 'EXIT' : (LOOP_BEATS[i] < 1 ? '½' : LOOP_BEATS[i]);
        p.classList.toggle('set', !!this.loop && this.loop.pad === i);
      } else {
        p.textContent = this.hot[i] == null ? (this.mode === 'clear' ? '' : String.fromCharCode(65 + i)) : fmt(this.hot[i]);
        p.classList.toggle('set', this.hot[i] != null);
      }
    });
  }

  bindJog() {
    const ring = this.ui.jog;
    let last = null, lastT = 0;
    const angle = e => {
      const b = ring.getBoundingClientRect();
      return Math.atan2(e.clientY - (b.top + b.height / 2), e.clientX - (b.left + b.width / 2));
    };
    ring.addEventListener('pointerdown', e => {
      if (!this.track) return;
      ring.setPointerCapture(e.pointerId); ring.classList.add('touched');
      last = angle(e); lastT = performance.now();
    });
    ring.addEventListener('pointermove', e => {
      if (last == null) return;
      const a = angle(e), now = performance.now();
      let d = a - last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      const dt = Math.max(1, now - lastT) / 1000;
      last = a; lastT = now; this.lastJogMove = now;
      if (this.el.paused) {
        this.el.currentTime = clamp(this.el.currentTime + d / (2 * Math.PI) * SECONDS_PER_JOG_TURN, 0, this.el.duration || 0);
      } else {
        // Pitch bend: spinning nudges the speed, like the outer ring of a jog wheel.
        this.bend = clamp((d / dt) / (2 * Math.PI) * 0.08, -0.12, 0.12);
        this.el.playbackRate = this.rate * (1 + this.bend);
      }
    });
    const end = () => {
      last = null; ring.classList.remove('touched');
      this.bend = 0; this.el.playbackRate = this.rate;
    };
    ring.addEventListener('pointerup', end); ring.addEventListener('pointercancel', end);
  }

  bindOverview() {
    const cv = this.ui.canvas;
    const seek = e => {
      if (!this.loaded) return;
      const b = cv.getBoundingClientRect();
      this.el.currentTime = clamp((e.clientX - b.left) / b.width, 0, 1) * this.el.duration;
    };
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); seek(e); });
    cv.addEventListener('pointermove', e => { if (e.buttons) seek(e); });
  }

  tick() {
    const el = this.el, dur = el.duration || 0, t = el.currentTime || 0;
    if (this.loop && t >= this.loop.end) {
      // Wrap when playback runs into the loop end; a seek far past it exits the loop instead.
      if (t - this.loop.end < 0.3) el.currentTime = this.loop.start + (t - this.loop.end);
      else { this.loop = null; this.renderPads(); }
    }
    // A finger resting on the jog wheel stops nudging the speed.
    if (this.bend && performance.now() - this.lastJogMove > 80) {
      this.bend = 0; el.playbackRate = this.rate;
    }
    this.ui.elapsed.textContent = fmt(t);
    this.ui.remain.textContent = '-' + fmt(dur - t);
    this.ui.dot.style.transform = `rotate(${(t / SECONDS_PER_JOG_TURN) * 360}deg)`;
    this.draw(t, dur);
    if (this.chain) {
      this.chain.meter.getFloatTimeDomainData(this.chain.buf);
      let s = 0; for (const v of this.chain.buf) s += v * v;
      const db = 20 * Math.log10(Math.sqrt(s / this.chain.buf.length) + 1e-6);
      mixer.meter(this.letter, clamp((db + 48) / 48, 0, 1));
    }
  }

  draw(t, dur) {
    const cv = this.ui.canvas, dpr = window.devicePixelRatio || 1;
    const w = this.size.w * dpr, h = this.size.h * dpr;
    // Skip redrawing a waveform that would come out identical (e.g. a paused deck).
    const key = [t, dur, w, h, !!this.peaks, this.cue, this.loop && `${this.loop.start}-${this.loop.end}`, this.hot.join()].join('|');
    if (key === this.lastDraw) return;
    this.lastDraw = key;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const color = this.color;
    const played = dur ? t / dur : 0;
    if (this.peaks) {
      const p = this.peaks, bw = w / p.length;
      for (let i = 0; i < p.length; i++) {
        const v = p[i] * h * 0.9;
        g.fillStyle = i / p.length < played ? color : color + '66';
        g.fillRect(i * bw, (h - v) / 2, Math.max(1, bw), v);
      }
    } else if (dur) {
      g.fillStyle = color + '33'; g.fillRect(0, h / 2 - 1, w, 2);
      g.fillStyle = color; g.fillRect(0, h / 2 - 1, w * played, 2);
    }
    if (!dur) return;
    if (this.loop) {
      g.fillStyle = '#3ddc8433';
      g.fillRect(this.loop.start / dur * w, 0, (this.loop.end - this.loop.start) / dur * w, h);
    }
    this.hot.forEach((c, i) => { if (c != null) { g.fillStyle = PAD_COLORS[i]; g.fillRect(c / dur * w - dpr, 0, 2 * dpr, h * 0.3); } });
    g.fillStyle = '#ffb020'; g.fillRect(this.cue / dur * w - dpr, h * 0.7, 2 * dpr, h * 0.3);
    g.fillStyle = '#fff'; g.fillRect(played * w - dpr, 0, 2 * dpr, h);
  }
}

// ---------- mixer ----------
const mixer = {
  channels: {},
  init() {
    for (const L of ['A', 'B']) {
      const root = $(`.channel[data-ch=${L}]`);
      root.append($('#channelTpl').content.cloneNode(true));
      $('.ch-label', root).textContent = L;
      this.channels[L] = {
        root, fill: $('.meter-fill', root), cfx: $('.cfx', root), fader: $('.chfader', root),
        eq: { low: $('.eq[data-band=low]', root), mid: $('.eq[data-band=mid]', root), high: $('.eq[data-band=high]', root) },
      };
      root.querySelectorAll('input').forEach(i => i.addEventListener('input', () => this.apply()));
      root.querySelectorAll('.eq, .cfx').forEach(i => i.addEventListener('dblclick', () => { i.value = 0; this.apply(); }));
    }
    $('#xfader').addEventListener('input', () => this.apply());
    $('#xfader').addEventListener('dblclick', e => { e.target.value = 0; this.apply(); });
    $('#master').addEventListener('input', () => { if (master) master.gain.value = +$('#master').value; });
  },
  apply() {
    const x = +$('#xfader').value, p = (x + 1) / 2 * Math.PI / 2;
    const xg = { A: Math.cos(p), B: Math.sin(p) };
    for (const L of ['A', 'B']) {
      const d = decks[L], c = d && d.chain;
      if (!c) continue;
      const ui = this.channels[L], now = ctx.currentTime;
      for (const band of ['low', 'mid', 'high']) c[band].gain.setTargetAtTime(+ui.eq[band].value, now, 0.01);
      const f = +ui.cfx.value;
      c.lpf.frequency.setTargetAtTime(f < -0.02 ? 20000 * Math.pow(10, f * 3) : 22000, now, 0.01);
      c.hpf.frequency.setTargetAtTime(f > 0.02 ? 20 * Math.pow(10, f * 3) : 10, now, 0.01);
      c.ch.gain.setTargetAtTime((+ui.fader.value) ** 2, now, 0.01);
      c.xf.gain.setTargetAtTime(xg[L], now, 0.01);
    }
  },
  meter(L, v) { this.channels[L].fill.style.height = (v * 100).toFixed(1) + '%'; },
};

// ---------- browser: search, library, queue ----------
const list = $('#list');
let tab = 'results', results = [], library = [], helperState = { queue: [], downloading: [] };
const readyIds = () => new Set(library.map(t => t.id));
const htmlDecoder = document.createElement('textarea');

function linkId(text) {
  const m = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(text.trim()) ? text.trim() : null);
}

function isoDuration(s) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
}

async function searchWithKey(q, key) {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: 15, q, key });
  const r = await fetch(u);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'YouTube search failed');
  const items = d.items.filter(i => i.id?.videoId);
  const v = new URL('https://www.googleapis.com/youtube/v3/videos');
  v.search = new URLSearchParams({ part: 'contentDetails', id: items.map(i => i.id.videoId).join(','), key });
  const durs = {};
  try { (await (await fetch(v)).json()).items.forEach(i => { durs[i.id] = isoDuration(i.contentDetails.duration); }); } catch {}
  const decode = s => { htmlDecoder.innerHTML = s; return htmlDecoder.value; };
  return items.map(i => ({
    id: i.id.videoId, title: decode(i.snippet.title), channel: decode(i.snippet.channelTitle),
    duration: durs[i.id.videoId] ?? null, thumbnail: i.snippet.thumbnails?.medium?.url,
  }));
}

const helperSearch = async q => (await api('/api/search?q=' + encodeURIComponent(q))).results;

async function search(q) {
  const id = linkId(q);
  if (id) { results = [{ id, title: 'YouTube video ' + id, channel: 'Pasted link', thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }]; return showTab('results'); }
  list.innerHTML = '<li class="empty">Searching…</li>';
  showTab('results', true);
  const key = store.get('ytKey');
  try {
    if (key) {
      try { results = await searchWithKey(q, key); }
      catch (e) { results = await helperSearch(q); flash(`API key search failed (${e.message}). Used the helper instead.`); }
    } else {
      results = await helperSearch(q);
    }
  } catch (e) {
    results = [];
    list.innerHTML = `<li class="empty">${escapeHtml(e.message)}</li>`;
    return;
  }
  showTab('results');
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function stateLabel(id, ready) {
  if (ready.has(id)) return ['ready', 'Ready'];
  if (helperState.downloading.includes(id)) return ['', 'Downloading…'];
  const pos = helperState.queue.indexOf(id);
  if (pos >= 0) return ['', `Queued #${pos + 1}`];
  return ['', ''];
}

function showTab(name, keepContent) {
  tab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (keepContent) return;
  const items = name === 'results' ? results : library;
  if (!items.length) {
    list.innerHTML = `<li class="empty">${name === 'results' ? 'Search for a track to get started.' : 'Nothing downloaded yet. Tracks you load are saved here and never re-downloaded.'}</li>`;
    return;
  }
  const ready = readyIds();
  list.innerHTML = items.map(t => {
    const [cls, label] = stateLabel(t.id, ready);
    return `<li data-id="${escapeHtml(t.id)}">
      <img src="${escapeHtml(t.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(t.id)}/mqdefault.jpg`)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="meta"><div class="t">${escapeHtml(t.title)}</div><div class="c">${escapeHtml(t.channel)}</div></div>
      <span class="dur">${t.duration ? fmt(t.duration) : ''}</span>
      <span class="state ${cls}">${label}</span>
      ${cls === 'ready' ? '' : '<button class="load prep" title="Download in the background">+</button>'}
      <button class="load a">A</button><button class="load b">B</button>
    </li>`;
  }).join('');
}

list.addEventListener('click', e => {
  const btn = e.target.closest('.load'); if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const meta = [...results, ...library].find(t => t.id === id) || { id };
  if (btn.classList.contains('prep')) return prep(meta);
  loadOnDeck(btn.classList.contains('a') ? 'A' : 'B', meta);
});

async function prep(meta) {
  try { await api(`/api/fetch?id=${meta.id}`, { method: 'POST' }); refreshHelper(); }
  catch (e) { flash(e.message); }
}

async function loadOnDeck(L, meta) {
  const d = decks[L];
  d.connect();
  d.pending = meta.id;
  try {
    let st = await api(`/api/fetch?id=${meta.id}&now=1`, { method: 'POST' });
    while (st.state !== 'ready') {
      if (d.pending !== meta.id) return;
      if (st.state === 'error') { d.setState('Download failed: ' + st.error); return; }
      d.setState(st.state === 'queued' ? `Queued #${st.position}. Downloads are spaced out to stay under YouTube's radar…`
        : 'Downloading (throttled, usually 15–30 s)…');
      await new Promise(r => setTimeout(r, 2000));
      st = await api(`/api/status?id=${meta.id}`);
    }
    if (d.pending !== meta.id) return;
    await refreshLibrary();
    d.load({ ...meta, ...st });
  } catch (e) { d.setState(e.message); }
}

async function refreshLibrary() {
  try { library = (await api('/api/library')).tracks; } catch {}
  if (tab === 'library') showTab('library');
}

let lastHelperKey = '', askedForCode = false;
async function refreshHelper() {
  const pill = $('#helperStatus');
  try {
    helperState = await api('/api/ping');
    const n = helperState.queue.length + helperState.downloading.length;
    pill.className = 'pill ok';
    pill.textContent = helperState.cooldownSeconds ? `Paused ${Math.ceil(helperState.cooldownSeconds / 60)} min` : 'Helper connected';
    $('#queueInfo').textContent = n ? `${n} in download queue` : `${helperState.jobsLastHour}/${helperState.maxJobsPerHour} YouTube requests this hour`;
    const key = JSON.stringify([helperState.queue, helperState.downloading]);
    if (key !== lastHelperKey) { if (lastHelperKey) await refreshLibrary(); lastHelperKey = key; showTab(tab); }
  } catch (e) {
    pill.className = 'pill bad';
    pill.textContent = e.status === 401 ? 'Pairing code needed' : 'Helper offline';
    if (e.status === 401 && !askedForCode && !$('#settings').open) { askedForCode = true; openSettings(); }
  }
}

let flashTimer;
function flash(msg) {
  const q = $('#queueInfo'); q.textContent = msg; q.style.color = 'var(--cue)';
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { q.style.color = ''; refreshHelper(); }, 5000);
}

// ---------- settings ----------
function openSettings() {
  $('#tokenInput').value = store.get('token');
  $('#keyInput').value = store.get('ytKey');
  $('#settings').showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#cancelSettings').addEventListener('click', () => $('#settings').close('cancel'));
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  store.set('token', $('#tokenInput').value.trim());
  store.set('ytKey', $('#keyInput').value.trim());
  refreshHelper(); refreshLibrary();
});

// ---------- boot ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q); $('#q').blur(); });
mixer.init();
decks.A = new Deck('A');
decks.B = new Deck('B');
(function frame() { decks.A.tick(); decks.B.tick(); requestAnimationFrame(frame); })();
refreshHelper(); refreshLibrary();
setInterval(refreshHelper, 3000);
