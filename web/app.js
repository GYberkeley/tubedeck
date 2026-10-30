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
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined;
  let res;
  try { res = await fetch(path, { signal, ...opts, headers: { 'X-Tubedeck-Token': token(), ...(opts.headers || {}) } }); }
  catch (e) { throw e.name === 'TimeoutError' ? new Error('The helper did not answer. Is it still running?') : e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Helper error ${res.status}`), { status: res.status });
  return data;
}

const audioUrl = id => `/api/audio/${id}?t=${encodeURIComponent(token())}`;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
// Deck clock style: 03:12.4
const fmtTenths = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const beatLabel = b => b >= 1 ? String(b) : `1/${Math.round(1 / b)}`;

// ---------- audio context ----------
// Graph: deck chains -> mixBus -> master -> speakers; FX returns -> master.
let ctx, master, mixBus;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = knobs.master ? knobs.master.value : 0.85;
    mixBus = ctx.createGain();
    mixBus.connect(master);
    master.connect(ctx.destination);
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    fx.forEach(u => u.connect());
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
document.addEventListener('pointerdown', () => audio(), { capture: true });

// ---------- analysis ----------
// Waveform detail follows rekordbox's colour waveform: 150 entries per second,
// each with low / mid / high band levels (drawn blue / amber / white).
const WAVE_RATE = 150;
const MAX_ANALYSIS_SECONDS = 20 * 60;

function waveform(buf) {
  const sr = buf.sampleRate, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const per = sr / WAVE_RATE, n = Math.floor(ch0.length / per);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  const a1 = 1 - Math.exp(-2 * Math.PI * 200 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
  let lp1 = 0, lp2 = 0, i = 0, max = 1e-6;
  for (let e = 0; e < n; e++) {
    let l = 0, m = 0, h = 0;
    for (const end = Math.floor((e + 1) * per); i < end; i++) {
      const x = (ch0[i] + ch1[i]) * 0.5;
      lp1 += a1 * (x - lp1); lp2 += a2 * (x - lp2);
      const al = Math.abs(lp1), am = Math.abs(lp2 - lp1), ah = Math.abs(x - lp2);
      if (al > l) l = al; if (am > m) m = am; if (ah > h) h = ah;
    }
    low[e] = l; mid[e] = m; high[e] = h;
    if (l > max) max = l; if (m > max) max = m; if (h > max) max = h;
  }
  for (let e = 0; e < n; e++) { low[e] /= max; mid[e] /= max; high[e] /= max; }
  return { low, mid, high, length: n };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Tempo and beat phase from a spectral-flux onset envelope. Candidate tempos are
// scored on their beat multiples and weighted toward common DJ tempos, which keeps
// triplet (2/3) and half-time readings from winning.
function detectBeats(buf) {
  const sr = buf.sampleRate, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const dec = Math.max(1, Math.round(sr / 11025)), sr2 = sr / dec;
  const segLen = Math.min(ch0.length, Math.floor(sr * 120)), start = Math.floor((ch0.length - segLen) / 2);
  const m = Math.floor(segLen / dec), x = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let k = 0, j = start + i * dec; k < dec; k++, j++) s += ch0[j] + ch1[j];
    x[i] = s / (2 * dec);
  }
  const N = 512, hop = 128, frames = Math.floor((m - N) / hop), fps = sr2 / hop, bins = N / 2;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(bins), flux = new Float32Array(frames), lowFlux = new Float32Array(frames);
  const lowBins = Math.max(2, Math.round(160 / (sr2 / N)));  // up to ~160 Hz: the kick drum
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0, sl = 0;
    for (let b = 1; b < bins; b++) {
      const lm = Math.log1p(100 * Math.hypot(re[b], im[b]));
      if (f && lm > prev[b]) { s += lm - prev[b]; if (b <= lowBins) sl += lm - prev[b]; }
      prev[b] = lm;
    }
    flux[f] = s; lowFlux[f] = sl;
  }
  const W = Math.round(fps / 2);
  const detrend = src => {
    const out = new Float32Array(frames);
    let acc = 0;
    for (let f = 0; f < frames; f++) {
      acc += src[f]; if (f >= W) acc -= src[f - W];
      out[f] = Math.max(0, src[f] - acc / Math.min(f + 1, W));
    }
    return out;
  };
  const onset = detrend(flux), lowOnset = detrend(lowFlux);
  const maxLag = Math.ceil(fps * 60 / 60 * 4) + 2, ac = new Float32Array(maxLag + 1);
  for (let L = 1; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < frames; i++) s += onset[i] * onset[i + L];
    ac[L] = s / (frames - L);
  }
  const acAt = lag => {
    if (lag >= maxLag) return 0;
    const l = Math.floor(lag), t = lag - l;
    return ac[l] * (1 - t) + ac[l + 1] * t;
  };
  let best = 0, bestScore = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.05) {
    const lag = fps * 60 / bpm;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.6) ** 2);
    // Off-beat energy (lag / 2) favours the faster of two related readings.
    const score = (acAt(lag) + 0.5 * acAt(2 * lag) + 0.25 * acAt(4 * lag) + 0.5 * acAt(lag / 2)) * prior;
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  // Refine: slide a beat comb across the whole window; the best-aligned tempo and
  // offset win. This is far more precise than the autocorrelation peak alone.
  const comb = (env, period, off) => {
    let s = 0;
    for (let p = off; p < frames - 2; p += period) { const l = Math.floor(p), t = p - l; s += env[l] * (1 - t) + env[l + 1] * t; }
    return s;
  };
  let bpm = best, bestSum = -1;
  for (let cand = best - 1; cand <= best + 1; cand += 0.02) {
    const period = fps * 60 / cand;
    for (let off = 0; off < period; off += 0.5) {
      const s = comb(onset, period, off);
      if (s > bestSum) { bestSum = s; bpm = cand; }
    }
  }
  bpm = Math.round(bpm * 10) / 10;
  // Beat phase from the kick drum, so the grid lands on beats rather than hi-hats.
  const period = fps * 60 / bpm, phaseEnv = lowOnset.some(v => v > 0) ? lowOnset : onset;
  let bestOff = 0, bestPhase = -1;
  for (let off = 0; off < period; off += 0.25) {
    const s = comb(phaseEnv, period, off);
    if (s > bestPhase) { bestPhase = s; bestOff = off; }
  }
  const beatSec = 60 / bpm;
  // Flux registers an onset about one hop after the frame centre reaches it.
  const firstHit = start / sr + (bestOff * hop + N / 2 + hop) / sr2;
  return { bpm, firstBeat: ((firstHit % beatSec) + beatSec) % beatSec };
}

// ---------- rotary knobs ----------
// Drag up/down (or sideways) to turn; double-tap resets.
const knobs = {};
class Knob {
  constructor(el, onChange) {
    this.el = el; this.onChange = onChange;
    this.min = +el.dataset.min; this.max = +el.dataset.max; this.def = +el.dataset.default; this.value = +el.dataset.value;
    el.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="#1b1b1b" stroke="#3a3a3a" stroke-width="1.5"/>
      <path class="arc" fill="none" stroke="#2d7ff9" stroke-width="3" stroke-linecap="round"/>
      <line class="ind" x1="20" y1="20" x2="20" y2="7" stroke="#f0f0f0" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    el.setAttribute('role', 'slider');
    this.arc = $('.arc', el); this.ind = $('.ind', el);
    let startY = 0, startX = 0, startV = 0, lastTap = 0, active = null;
    el.addEventListener('pointerdown', e => {
      if (active !== null) return;
      active = e.pointerId; el.setPointerCapture(e.pointerId);
      const now = performance.now();
      if (now - lastTap < 300) this.set(this.def);
      lastTap = now;
      startY = e.clientY; startX = e.clientX; startV = this.value;
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== active) return;
      const d = (startY - e.clientY) + (e.clientX - startX);
      this.set(startV + d / 160 * (this.max - this.min));
    });
    const end = e => { if (e.pointerId === active) active = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    this.render();
  }
  set(v) {
    v = clamp(v, this.min, this.max);
    if (Math.abs(v - this.def) < (this.max - this.min) * 0.02) v = this.def;  // detent at the default
    if (v === this.value) return;
    this.value = v; this.render(); this.onChange(v);
  }
  render() {
    const toAng = v => -135 + 270 * (v - this.min) / (this.max - this.min);
    const a = toAng(this.value), a0 = toAng(this.def <= this.min ? this.min : this.def);
    this.ind.setAttribute('transform', `rotate(${a} 20 20)`);
    const pt = ang => { const r = (ang - 90) * Math.PI / 180; return `${20 + 15 * Math.cos(r)} ${20 + 15 * Math.sin(r)}`; };
    const [from, to] = a0 < a ? [a0, a] : [a, a0];
    this.arc.setAttribute('d', Math.abs(a - a0) < 1 ? '' : `M ${pt(from)} A 15 15 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}`);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
  }
}

// ---------- beat FX ----------
const FX_BEATS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8];
class FxUnit {
  constructor(i) {
    this.i = i; this.root = $(`.fxunit[data-fx="${i}"]`);
    this.root.append($('#fxTpl').content.cloneNode(true));
    $('.fx-name', this.root).textContent = `FX${i + 1}`;
    this.type = 'echo'; this.beatIx = 4; this.on = false; this.assign = { A: i === 0, B: i === 1, M: false };
    this.auto = true; this.tapBpm = 120; this.taps = []; this.bpm = 120;
    $$('[data-assign]', this.root).forEach(b => {
      b.classList.toggle('on', this.assign[b.dataset.assign]);
      b.addEventListener('click', () => { this.assign[b.dataset.assign] = !this.assign[b.dataset.assign]; b.classList.toggle('on'); this.route(); });
    });
    $('select', this.root).addEventListener('change', e => { this.type = e.target.value; this.build(); });
    $$('.arrow', this.root).forEach(b => b.addEventListener('click', () => {
      this.beatIx = clamp(this.beatIx + +b.dataset.step, 0, FX_BEATS.length - 1); this.renderBeat(); this.retime(true);
    }));
    this.level = new Knob($('.knob', this.root), v => { if (this.wet) this.wet.gain.setTargetAtTime(v, ctx.currentTime, 0.02); });
    this.onBtn = $('.fx-on', this.root);
    this.onBtn.addEventListener('click', () => { this.on = !this.on; this.onBtn.classList.toggle('on', this.on); this.route(); });
    $('.auto', this.root).addEventListener('click', e => { this.auto = !this.auto; e.target.classList.toggle('on', this.auto); });
    $('.tap', this.root).addEventListener('click', () => {
      const now = performance.now();
      this.taps = this.taps.filter(t => now - t < 2500); this.taps.push(now);
      if (this.taps.length >= 3) {
        this.tapBpm = 60000 * (this.taps.length - 1) / (now - this.taps[0]);
        this.auto = false; $('.auto', this.root).classList.remove('on');
      }
    });
    this.renderBeat();
  }
  get beats() { return FX_BEATS[this.beatIx]; }
  get seconds() { return Math.min(3.9, this.beats * 60 / this.bpm); }
  renderBeat() { $('.beat-val', this.root).textContent = beatLabel(this.beats); }

  connect() {
    this.input = ctx.createGain(); this.input.gain.value = 0;
    this.wet = ctx.createGain(); this.wet.gain.value = this.level.value;
    this.wet.connect(master);
    this.sends = {};
    this.build(); this.route();
  }
  build() {
    if (!ctx) return;
    (this.nodes || []).forEach(n => { try { n.disconnect(); } catch {} if (n.stop) try { n.stop(); } catch {} });
    this.input.disconnect();
    const n = this.nodes = [];
    const make = (fn, ...a) => { const node = ctx[fn](...a); n.push(node); return node; };
    if (this.type === 'echo' || this.type === 'delay') {
      const d = this.delay = make('createDelay', 4), fb = make('createGain');
      fb.gain.value = this.type === 'echo' ? 0.55 : 0.28;
      this.input.connect(d); d.connect(this.wet); d.connect(fb);
      if (this.type === 'echo') { const lp = make('createBiquadFilter'); lp.type = 'lowpass'; lp.frequency.value = 3500; fb.connect(lp).connect(d); }
      else fb.connect(d);
    } else if (this.type === 'reverb') {
      this.conv = make('createConvolver');
      this.input.connect(this.conv).connect(this.wet);
    } else if (this.type === 'flanger') {
      const d = this.delay = make('createDelay', 0.05), fb = make('createGain'), lfo = this.lfo = make('createOscillator'), depth = make('createGain');
      d.delayTime.value = 0.005; fb.gain.value = 0.6; depth.gain.value = 0.003;
      lfo.connect(depth).connect(d.delayTime); lfo.start();
      this.input.connect(d); d.connect(this.wet); d.connect(fb).connect(d);
    }
    this.retime(true);
  }
  retime(force) {
    if (!ctx) return;
    const bpm = this.auto ? (masterDeck()?.liveBpm || 120) : this.tapBpm;
    if (!force && Math.abs(bpm - this.bpm) < 0.05) return;
    this.bpm = bpm;
    $('.fx-bpm-val', this.root).textContent = bpm.toFixed(1);
    const t = ctx.currentTime;
    if ((this.type === 'echo' || this.type === 'delay') && this.delay) this.delay.delayTime.setTargetAtTime(this.seconds, t, 0.05);
    if (this.type === 'flanger' && this.lfo) this.lfo.frequency.setTargetAtTime(1 / Math.max(0.1, this.beats * 60 / bpm), t, 0.05);
    if (this.type === 'reverb' && this.conv && force) {
      const len = clamp(this.beats * 60 / bpm * 2, 0.4, 6), rate = ctx.sampleRate, ir = ctx.createBuffer(2, Math.floor(len * rate), rate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      }
      this.conv.buffer = ir;
    }
  }
  // Sends feed the FX from each assigned source; switching it off lets the tail ring out.
  route() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const src of ['A', 'B', 'M']) {
      const node = src === 'M' ? mixBus : decks[src].chain?.xf;
      if (!node) continue;
      if (!this.sends[src]) { this.sends[src] = ctx.createGain(); node.connect(this.sends[src]); this.sends[src].connect(this.input); }
      this.sends[src].gain.setTargetAtTime(this.assign[src] ? 1 : 0, t, 0.01);
    }
    this.input.gain.setTargetAtTime(this.on ? 1 : 0, t, 0.01);
  }
}

// ---------- decks ----------
const PAD_COLORS = ['#e8364f', '#f0a030', '#e6d32e', '#3fcf5a', '#2fc0d6', '#2d7ff9', '#9b59f0', '#e85fb4'];
const PAD_LOOPS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const PAD_JUMPS = [-1, -4, -16, -32, 1, 4, 16, 32];
const LOOP_LENGTHS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const SECONDS_PER_JOG_TURN = 1.8;
const decks = {};
const masterDeck = () => Object.values(decks).find(d => d.isMaster && d.bpm) || Object.values(decks).find(d => d.bpm);

class Deck {
  constructor(letter) {
    this.letter = letter;
    this.num = letter === 'A' ? 1 : 2;
    this.root = $(`.deck[data-deck=${letter}]`);
    this.root.append($('#deckTpl').content.cloneNode(true));
    $('.deck-num', this.root).textContent = this.num;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.preservesPitch = this.el.webkitPreservesPitch = true;
    this.track = null; this.cue = 0; this.hot = Array(8).fill(null);
    this.bpm = 0; this.firstBeat = 0; this.tempo = 0; this.keyLock = true; this.synced = false; this.isMaster = false;
    this.loop = null; this.loopBeats = 4; this.manualIn = null; this.mode = 'hot'; this.wave = null; this.bend = 0;
    this.quantize = true; this.slip = false; this.slipFrom = null; this.taps = [];
    this.pending = null; // id of the track being fetched for this deck; stale fetches compare against it
    this.color = letter === 'A' ? '#2d7ff9' : '#e8a13a';
    this.bindUi();
  }

  connect() {
    if (this.chain) return;
    const c = audio();
    const src = c.createMediaElementSource(this.el);
    const trim = c.createGain();
    const low = Object.assign(c.createBiquadFilter(), { type: 'lowshelf' }); low.frequency.value = 200;
    const mid = Object.assign(c.createBiquadFilter(), { type: 'peaking' }); mid.frequency.value = 1000; mid.Q.value = 0.8;
    const high = Object.assign(c.createBiquadFilter(), { type: 'highshelf' }); high.frequency.value = 3500;
    const lpf = Object.assign(c.createBiquadFilter(), { type: 'lowpass' }); lpf.frequency.value = 22000; lpf.Q.value = 1;
    const hpf = Object.assign(c.createBiquadFilter(), { type: 'highpass' }); hpf.frequency.value = 10; hpf.Q.value = 1;
    const ch = c.createGain(), xf = c.createGain(), meter = c.createAnalyser();
    meter.fftSize = 1024;
    src.connect(trim).connect(low).connect(mid).connect(high).connect(lpf).connect(hpf).connect(ch).connect(xf).connect(mixBus);
    ch.connect(meter);
    this.chain = { trim, low, mid, high, lpf, hpf, ch, xf, meter, buf: new Float32Array(1024) };
    mixer.apply();
    fx.forEach(u => u.route());
  }

  bindUi() {
    const r = this.root;
    this.ui = {
      title: $('.title', r), artist: $('.artist', r), bpm: $('.bpm', r), pct: $('.tempo-pct', r), state: $('.deck-state', r),
      canvas: $('.overview', r), elapsed: $('.elapsed', r), remain: $('.remain', r),
      play: $('.play', r), cue: $('.cue', r), ring: $('.jog-ring', r), platter: $('.jog-platter', r),
      jogTime: $('.jog-time', r), jogPct: $('.jog-pct', r),
      tempo: $('.tempo-fader', r), sync: $('.sync', r), masterBtn: $('.master-btn', r),
      padGrid: $('.pad-grid', r), loopbox: $('.loopbox', r), loopLen: $('.loop-len', r), au: $('.loop-au', r), ma: $('.loop-ma', r),
      slip: $('.slip', r), quant: $('.quant', r), mt: $('.mt', r),
    };
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('button');
      p.className = 'pad'; p.style.setProperty('--pc', PAD_COLORS[i]);
      let hold;
      p.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (this.mode === 'hot' && this.hot[i] != null) hold = setTimeout(() => { hold = null; this.hot[i] = null; this.renderPads(); }, 600);
        this.padDown(i);
      });
      const up = () => { if (hold) { clearTimeout(hold); hold = null; } };
      p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up); p.addEventListener('pointerleave', up);
      this.ui.padGrid.append(p);
    }
    $('.pad-mode', r).addEventListener('change', e => { this.mode = e.target.value; this.renderPads(); });
    this.ui.play.addEventListener('pointerdown', e => { e.preventDefault(); this.togglePlay(); });
    this.ui.cue.addEventListener('pointerdown', e => { e.preventDefault(); this.cueDown(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => this.ui.cue.addEventListener(t, () => this.cueUp()));
    this.ui.tempo.addEventListener('input', () => { this.setTempo(+this.ui.tempo.value); this.synced = false; this.renderSync(); });
    $('.reset', r).addEventListener('click', () => { this.setTempo(0); this.synced = false; this.renderSync(); });
    this.ui.mt.addEventListener('click', () => {
      this.keyLock = !this.keyLock;
      this.el.preservesPitch = this.el.webkitPreservesPitch = this.keyLock;
      this.ui.mt.classList.toggle('on', this.keyLock);
    });
    this.ui.quant.addEventListener('click', () => { this.quantize = !this.quantize; this.ui.quant.classList.toggle('on', this.quantize); });
    this.ui.slip.addEventListener('click', () => { this.slip = !this.slip; this.ui.slip.classList.toggle('on', this.slip); });
    this.ui.sync.addEventListener('click', () => (this.synced ? this.unsync() : this.sync()));
    this.ui.masterBtn.addEventListener('click', () => this.makeMaster());
    $('.tap-bpm', r).addEventListener('click', () => this.tap());
    $$('.bpm-fix', r).forEach(b => b.addEventListener('click', () => {
      if (!this.bpm) return;
      this.bpm = Math.round(this.bpm * +b.dataset.f * 10) / 10;
      this.renderBpm();
      if (this.synced) this.sync(true);
      this.notifyFollowers();
    }));
    $('.loop-half', r).addEventListener('click', () => this.resizeLoop(0.5));
    $('.loop-double', r).addEventListener('click', () => this.resizeLoop(2));
    this.ui.au.addEventListener('click', () => (this.loop ? this.exitLoop() : this.beatLoop(this.loopBeats)));
    this.ui.ma.addEventListener('click', () => this.manualLoop());
    this.bindJog();
    this.bindOverview();
    this.renderPads(); this.renderLoop();
    this.el.addEventListener('ended', () => this.ui.play.classList.remove('lit'));
  }

  get loaded() { return !!this.track && this.el.readyState >= 1; }
  get rate() { return 1 + this.tempo / 100; }
  get liveBpm() { return this.bpm ? this.bpm * this.rate : 0; }
  get beatSec() { return this.bpm ? 60 / this.bpm : 0; }

  setState(msg) { this.ui.state.textContent = msg || ''; }

  // Snap to the nearest beat when quantize is on and the grid is known.
  snap(t) {
    if (!this.quantize || !this.bpm) return t;
    return this.firstBeat + Math.round((t - this.firstBeat) / this.beatSec) * this.beatSec;
  }

  async load(meta) {
    this.connect();
    this.el.pause();
    if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    this.track = meta; this.cue = 0; this.hot.fill(null); this.loop = null; this.manualIn = null; this.bpm = 0; this.wave = null; this.overviewImg = null;
    this.ui.title.textContent = meta.title || meta.id;
    this.ui.artist.textContent = meta.channel || '';
    this.ui.bpm.textContent = '--.-';
    this.ui.play.classList.remove('lit');
    this.root.classList.add('loaded');
    this.el.playbackRate = this.rate;
    this.renderPads(); this.renderLoop();
    if ((meta.duration || 0) > MAX_ANALYSIS_SECONDS) {
      this.el.src = audioUrl(meta.id);
      this.setState('Long set: waveform and BPM skipped. Use TAP to set the tempo.');
      return;
    }
    this.setState('Loading audio…');
    try {
      // One download feeds both playback (as a blob) and analysis.
      const res = await fetch(audioUrl(meta.id));
      const bytes = await res.arrayBuffer();
      if (this.track !== meta) return;
      this.blobUrl = URL.createObjectURL(new Blob([bytes], { type: res.headers.get('Content-Type') || 'audio/mp4' }));
      this.el.src = this.blobUrl;
      this.el.playbackRate = this.rate;
      this.setState('Analyzing…');
      const buf = await new Promise((ok, bad) => audio().decodeAudioData(bytes, ok, bad));
      if (this.track !== meta) return;
      await new Promise(r => setTimeout(r));  // let the page paint before the heavier passes
      this.wave = waveform(buf);
      const beats = detectBeats(buf);
      this.bpm = beats.bpm; this.firstBeat = beats.firstBeat;
      this.setState('');
      this.renderBpm();
      if (!masterDeck() || masterDeck() === this) this.makeMaster();
      if (this.synced) this.sync();
      this.notifyFollowers();
    } catch (e) {
      if (this.track !== meta) return;
      if (!this.el.src) this.el.src = audioUrl(meta.id);
      this.setState('Could not analyze this track (it will still play).');
    }
  }

  togglePlay() {
    if (!this.track) return;
    audio();
    if (this.el.paused) {
      this.el.play().catch(e => {
        if (e.name === 'AbortError') return;
        this.setState('Tap play again to start audio.');
        this.ui.play.classList.remove('lit');
      });
      this.ui.play.classList.add('lit');
    } else { this.el.pause(); this.ui.play.classList.remove('lit'); }
  }

  // Pioneer-style CUE: playing → back to cue and pause; paused → set cue here and preview while held.
  cueDown() {
    if (!this.track) return;
    if (!this.el.paused) {
      this.el.pause(); this.el.currentTime = this.cue; this.ui.play.classList.remove('lit'); return;
    }
    const here = this.snap(this.el.currentTime);
    if (Math.abs(here - this.cue) > 0.05) { this.cue = here; this.el.currentTime = here; return; }
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
    this.el.playbackRate = this.rate * (1 + this.bend);
    this.renderBpm();
  }

  notifyFollowers() {
    for (const d of Object.values(decks)) if (d !== this && d.synced) d.sync(true);
  }

  makeMaster() {
    for (const d of Object.values(decks)) { d.isMaster = d === this; d.ui.masterBtn.classList.toggle('on', d.isMaster); }
    if (this.synced) this.unsync();
    this.notifyFollowers();
  }

  // BEAT SYNC: match the other deck's tempo (at double/half time when that fits ±8%)
  // and, on the first press, line up the beat phase.
  sync(silent) {
    const other = decks[this.letter === 'A' ? 'B' : 'A'];
    if (!this.bpm || !other.liveBpm) { if (!silent) this.setState('Sync needs a BPM on both decks.'); return; }
    const target = other.liveBpm;
    const options = [target, target * 2, target / 2].map(t => (t / this.bpm - 1) * 100);
    const pct = options.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a);
    if (Math.abs(pct) > 8) { if (!silent) this.setState(`Too far apart to sync within ±8% (${this.bpm} vs ${target.toFixed(1)}).`); return; }
    const first = !this.synced;
    this.synced = true;
    this.applyTempo(pct);
    this.renderSync();
    if (!silent) this.setState('');
    if (first && !silent && other.loaded && this.loaded) {
      const phase = d => (((d.el.currentTime - d.firstBeat) / d.beatSec) % 1 + 1) % 1;
      let delta = phase(other) - phase(this);
      if (delta > 0.5) delta -= 1; if (delta < -0.5) delta += 1;
      this.el.currentTime = Math.max(0, this.el.currentTime + delta * this.beatSec);
    }
  }
  unsync() { this.synced = false; this.renderSync(); }
  renderSync() { this.ui.sync.classList.toggle('on', this.synced); }
  renderBpm() {
    this.ui.bpm.textContent = this.bpm ? this.liveBpm.toFixed(1) : '--.-';
    const p = (this.tempo > 0 ? '+' : '') + this.tempo.toFixed(1) + '%';
    this.ui.pct.textContent = p;
    this.ui.jogPct.textContent = `${p} ±8`;
  }

  tap() {
    if (!this.track) return;
    const now = performance.now();
    this.taps = this.taps.filter(t => now - t < 2500); this.taps.push(now);
    if (this.taps.length < 4) return this.setState(`Tap ${4 - this.taps.length} more…`);
    this.bpm = Math.round(60000 * (this.taps.length - 1) / (now - this.taps[0]) / this.rate * 10) / 10;
    this.firstBeat = ((this.el.currentTime % this.beatSec) + this.beatSec) % this.beatSec;
    this.setState(''); this.renderBpm(); this.notifyFollowers();
  }

  // --- loops ---
  beatLoop(beats) {
    if (!this.track) return;
    if (!this.bpm) return this.setState('Loops need a BPM. Use TAP to set one.');
    const start = this.quantize ? this.firstBeat + Math.floor((this.el.currentTime - this.firstBeat) / this.beatSec + 0.02) * this.beatSec : this.el.currentTime;
    this.startSlip();
    this.loop = { start: Math.max(0, start), end: Math.max(0, start) + beats * this.beatSec, beats };
    this.loopBeats = beats;
    this.renderLoop(); this.renderPads();
  }
  manualLoop() {
    if (!this.track) return;
    if (this.loop) return this.exitLoop();
    const t = this.snap(this.el.currentTime);
    if (this.manualIn == null) { this.manualIn = t; return this.renderLoop(); }
    if (t - this.manualIn < 0.05) return;
    this.startSlip();
    this.loop = { start: this.manualIn, end: t, beats: this.bpm ? Math.round((t - this.manualIn) / this.beatSec * 100) / 100 : 0 };
    this.manualIn = null;
    this.renderLoop(); this.renderPads();
  }
  exitLoop() {
    this.loop = null; this.manualIn = null;
    this.endSlip();
    this.renderLoop(); this.renderPads();
  }
  resizeLoop(f) {
    const i = LOOP_LENGTHS.indexOf(this.loopBeats);
    const next = LOOP_LENGTHS[clamp((i < 0 ? 7 : i) + (f > 1 ? 1 : -1), 0, LOOP_LENGTHS.length - 1)];
    this.loopBeats = next;
    if (this.loop && this.bpm) this.loop = { ...this.loop, end: this.loop.start + next * this.beatSec, beats: next };
    this.renderLoop(); this.renderPads();
  }
  renderLoop() {
    this.ui.loopLen.textContent = this.loop && !this.loop.beats ? '—' : beatLabel(this.loop ? this.loop.beats : this.loopBeats);
    this.ui.loopbox.classList.toggle('active', !!this.loop);
    this.ui.au.classList.toggle('on', !!this.loop && this.loop.beats === this.loopBeats);
    this.ui.ma.classList.toggle('armed', this.manualIn != null);
  }

  // SLIP: playback keeps moving underneath loops and scratches, and resumes there.
  startSlip() {
    if (this.slip && !this.slipFrom && !this.el.paused) this.slipFrom = { pos: this.el.currentTime, at: performance.now(), rate: this.rate };
  }
  endSlip() {
    if (!this.slipFrom) return;
    const s = this.slipFrom; this.slipFrom = null;
    if (this.slip) this.el.currentTime = s.pos + (performance.now() - s.at) / 1000 * s.rate;
  }

  // --- pads ---
  padDown(i) {
    if (!this.track) return;
    if (this.mode === 'loop') {
      if (this.loop && this.loop.beats === PAD_LOOPS[i]) return this.exitLoop();
      return this.beatLoop(PAD_LOOPS[i]);
    }
    if (this.mode === 'jump') {
      if (!this.bpm) return this.setState('Beat jump needs a BPM.');
      const by = PAD_JUMPS[i] * this.beatSec;
      this.el.currentTime = clamp(this.el.currentTime + by, 0, this.el.duration || 0);
      if (this.loop) this.loop = { ...this.loop, start: this.loop.start + by, end: this.loop.end + by };
      return this.flashPad(i);
    }
    if (this.hot[i] == null) { this.hot[i] = this.snap(this.el.currentTime); return this.renderPads(); }
    this.el.currentTime = this.hot[i];
    if (this.el.paused) this.cue = this.hot[i];
    this.flashPad(i);
  }
  flashPad(i) {
    const p = this.ui.padGrid.children[i];
    p.classList.add('lit'); setTimeout(() => p.classList.remove('lit'), 150);
  }
  renderPads() {
    [...this.ui.padGrid.children].forEach((p, i) => {
      const letter = String.fromCharCode(65 + i);
      if (this.mode === 'loop') {
        p.innerHTML = `<span>${beatLabel(PAD_LOOPS[i])}</span><small>BEAT</small>`;
        p.classList.toggle('set', !!this.loop && this.loop.beats === PAD_LOOPS[i]);
      } else if (this.mode === 'jump') {
        p.innerHTML = `<span>${PAD_JUMPS[i] < 0 ? '◀' : '▶'} ${Math.abs(PAD_JUMPS[i])}</span><small>BEAT</small>`;
        p.classList.remove('set');
      } else {
        p.innerHTML = `<span>${letter}</span><small>${this.hot[i] == null ? '' : fmtTenths(this.hot[i])}</small>`;
        p.classList.toggle('set', this.hot[i] != null);
      }
    });
  }

  // --- jog wheel ---
  // Touching the platter scratches (the track follows your finger, vinyl style);
  // the outer ring nudges the tempo for beatmatching.
  bindJog() {
    const ring = this.ui.ring;
    let active = null, last = null, lastT = 0, mode = null, pos = 0, wasPlaying = false;
    const polar = e => {
      const b = ring.getBoundingClientRect(), dx = e.clientX - (b.left + b.width / 2), dy = e.clientY - (b.top + b.height / 2);
      return { a: Math.atan2(dy, dx), r: Math.hypot(dx, dy) / (b.width / 2) };
    };
    ring.addEventListener('pointerdown', e => {
      if (active !== null || !this.track) return;
      active = e.pointerId; ring.setPointerCapture(e.pointerId);
      const p = polar(e); last = p.a; lastT = performance.now();
      mode = p.r < 0.8 ? 'scratch' : 'bend';
      ring.classList.add(mode === 'scratch' ? 'scratching' : 'bending');
      if (mode === 'scratch') {
        wasPlaying = !this.el.paused; pos = this.el.currentTime;
        this.startSlip();
        this.scratching = true; this.scratchPos = pos;
        this.el.preservesPitch = this.el.webkitPreservesPitch = false;
        this.el.pause();
      }
    });
    ring.addEventListener('pointermove', e => {
      if (e.pointerId !== active) return;
      const a = polar(e).a, now = performance.now();
      let d = a - last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      const dt = Math.max(1, now - lastT) / 1000;
      last = a; lastT = now; this.lastJogMove = now;
      if (mode === 'bend') {
        this.bend = clamp((d / dt) / (2 * Math.PI) * 0.08, -0.12, 0.12);
        this.el.playbackRate = this.rate * (1 + this.bend);
        return;
      }
      const dPos = d / (2 * Math.PI) * SECONDS_PER_JOG_TURN;
      pos = clamp(pos + dPos, 0, this.el.duration || 0);
      this.scratchPos = pos;
      const speed = dPos / dt;
      if (speed > 0.08) {
        // Moving forward: play at the hand's speed so the scratch is audible.
        this.el.playbackRate = clamp(speed, 0.25, 4);
        if (Math.abs(this.el.currentTime - pos) > 0.12) this.el.currentTime = pos;
        if (this.el.paused) this.el.play().catch(() => {});
      } else {
        if (!this.el.paused) this.el.pause();
        this.el.currentTime = pos;
      }
    });
    const end = e => {
      if (e.pointerId !== active) return;
      active = null; ring.classList.remove('scratching', 'bending');
      this.bend = 0;
      if (mode === 'scratch') {
        this.scratching = false;
        this.el.preservesPitch = this.el.webkitPreservesPitch = this.keyLock;
        this.el.currentTime = pos;
        this.endSlip();
        if (wasPlaying) this.el.play().catch(() => {}); else this.el.pause();
      }
      this.el.playbackRate = this.rate;
      mode = null;
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

  get position() { return this.scratching ? this.scratchPos : (this.el.currentTime || 0); }

  tick(now) {
    const el = this.el, dur = el.duration || 0, t = this.position;
    if (this.loop && !this.scratching && t >= this.loop.end) {
      // Wrap when playback runs into the loop end; a seek far past it exits the loop instead.
      if (t - this.loop.end < 0.3) el.currentTime = this.loop.start + (t - this.loop.end);
      else this.exitLoop();
    }
    if (this.bend && !this.scratching && now - (this.lastJogMove || 0) > 80) { this.bend = 0; el.playbackRate = this.rate; }
    if (this.scratching && now - (this.lastJogMove || 0) > 80 && !el.paused) el.pause();
    const playing = !el.paused && !this.scratching;
    this.root.classList.toggle('playing', playing);
    if (!this.previewing) this.ui.play.classList.toggle('lit', playing || (this.scratching && this.ui.play.classList.contains('lit')));
    this.ui.elapsed.textContent = fmtTenths(t);
    this.ui.remain.textContent = '-' + fmtTenths(dur - t);
    this.ui.jogTime.textContent = fmt(t);
    this.ui.platter.style.transform = `rotate(${(t / SECONDS_PER_JOG_TURN) * 360}deg)`;
    this.drawOverview(t, dur);
    if (this.chain) {
      this.chain.meter.getFloatTimeDomainData(this.chain.buf);
      let s = 0; for (const v of this.chain.buf) s += v * v;
      const db = 20 * Math.log10(Math.sqrt(s / this.chain.buf.length) + 1e-6);
      mixer.meter(this.letter, clamp((db + 48) / 48, 0, 1));
    }
  }

  drawOverview(t, dur) {
    const cv = this.ui.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; this.overviewImg = null; }
    const g = cv.getContext('2d');
    if (this.wave && !this.overviewImg) {
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      drawBands(off.getContext('2d'), this.wave, 0, this.wave.length, 0, w, 0, h);
      this.overviewImg = off;
    }
    g.clearRect(0, 0, w, h);
    if (this.overviewImg) g.drawImage(this.overviewImg, 0, 0);
    if (!dur) return;
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, w * t / dur, h);
    if (this.loop) { g.fillStyle = 'rgba(80,200,90,0.3)'; g.fillRect(this.loop.start / dur * w, 0, Math.max(2, (this.loop.end - this.loop.start) / dur * w), h); }
    this.hot.forEach((c, i) => { if (c != null) { g.fillStyle = PAD_COLORS[i]; g.fillRect(c / dur * w - dpr, 0, 2 * dpr, h * 0.35); } });
    g.fillStyle = '#e0a020'; g.fillRect(this.cue / dur * w - dpr, h * 0.65, 2 * dpr, h * 0.35);
    g.fillStyle = '#fff'; g.fillRect(t / dur * w - dpr, 0, 2 * dpr, h);
  }
}

// Draw waveform entries [from, to) across x0..x1 in rekordbox's 3-band colours.
function drawBands(g, wave, from, to, x0, x1, y0, h) {
  const cols = Math.max(1, Math.round(x1 - x0)), per = (to - from) / cols, mid = y0 + h / 2, half = h / 2 * 0.95;
  const layers = [['low', '#1f5fe0', 1], ['mid', '#d9822b', 0.8], ['high', '#f2f2f2', 0.55]];
  for (const [band, color, scale] of layers) {
    g.fillStyle = color;
    const arr = wave[band];
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(from + c * per), b = Math.max(a + 1, Math.floor(from + (c + 1) * per));
      if (b <= 0 || a >= wave.length) continue;
      let v = 0;
      for (let k = Math.max(0, a); k < Math.min(b, wave.length); k++) if (arr[k] > v) v = arr[k];
      const hh = Math.pow(v, 0.65) * half * scale;  // lift quiet detail, like rekordbox's display curve
      if (hh > 0.3) g.fillRect(x0 + c, mid - hh, 1, hh * 2);
    }
  }
}

// ---------- big scrolling waveforms (one lane per deck, playhead in the middle) ----------
const ZOOMS = [4, 6, 8, 12, 16, 24, 32];
const waves = {
  zoom: 2,
  init() {
    this.cv = $('#waveCanvas');
    $('#zoomIn').addEventListener('click', () => { this.zoom = Math.max(0, this.zoom - 1); });
    $('#zoomOut').addEventListener('click', () => { this.zoom = Math.min(ZOOMS.length - 1, this.zoom + 1); });
    // Dragging a lane scrubs that deck.
    let drag = null;
    this.cv.addEventListener('pointerdown', e => {
      const b = this.cv.getBoundingClientRect(), d = decks[(e.clientY - b.top) < b.height / 2 ? 'A' : 'B'];
      if (!d.loaded) return;
      this.cv.setPointerCapture(e.pointerId);
      drag = { d, x: e.clientX, pos: d.el.currentTime, id: e.pointerId };
    });
    this.cv.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const secsPerPx = ZOOMS[this.zoom] / this.cv.getBoundingClientRect().width;
      drag.d.el.currentTime = clamp(drag.pos - (e.clientX - drag.x) * secsPerPx, 0, drag.d.el.duration || 0);
    });
    const end = e => { if (drag && e.pointerId === drag.id) drag = null; };
    this.cv.addEventListener('pointerup', end); this.cv.addEventListener('pointercancel', end);
  },
  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d'), span = ZOOMS[this.zoom], lane = h / 2;
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    ['A', 'B'].forEach((L, i) => {
      const d = decks[L], y0 = i * lane, t = d.position;
      const t0 = t - span / 2, pxPerSec = w / span;
      // Beat grid: thin lines on beats, brighter on every bar.
      if (d.bpm && d.loaded) {
        const bs = d.beatSec;
        for (let k = Math.ceil((t0 - d.firstBeat) / bs); ; k++) {
          const bt = d.firstBeat + k * bs, x = (bt - t0) * pxPerSec;
          if (x > w) break;
          g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.13)';
          g.fillRect(Math.round(x), y0, dpr, lane);
        }
      }
      if (d.loop) { g.fillStyle = 'rgba(70,190,80,0.25)'; g.fillRect((d.loop.start - t0) * pxPerSec, y0, (d.loop.end - d.loop.start) * pxPerSec, lane); }
      if (d.wave) drawBands(g, d.wave, t0 * WAVE_RATE, (t0 + span) * WAVE_RATE, 0, w, y0 + 4 * dpr, lane - 8 * dpr);
      else if (d.track) { g.fillStyle = '#333'; g.font = `${11 * dpr}px -apple-system, sans-serif`; g.fillText(d.ui.state.textContent || 'Loading…', 12 * dpr, y0 + lane / 2); }
      d.hot.forEach((c, k) => {
        if (c == null) return;
        const x = (c - t0) * pxPerSec;
        if (x < -10 || x > w + 10) return;
        g.fillStyle = PAD_COLORS[k]; g.fillRect(x, y0, 2 * dpr, lane);
        g.fillRect(x, y0, 14 * dpr, 12 * dpr);
        g.fillStyle = '#000'; g.font = `bold ${9 * dpr}px -apple-system, sans-serif`; g.fillText(String.fromCharCode(65 + k), x + 3 * dpr, y0 + 9 * dpr);
      });
      const cx = (d.cue - t0) * pxPerSec;
      if (d.track && cx > -10 && cx < w + 10) {
        g.fillStyle = '#e0a020';
        g.beginPath(); g.moveTo(cx - 5 * dpr, y0 + lane); g.lineTo(cx + 5 * dpr, y0 + lane); g.lineTo(cx, y0 + lane - 7 * dpr); g.fill();
      }
      g.fillStyle = d.color; g.font = `bold ${10 * dpr}px -apple-system, sans-serif`; g.fillText(String(d.num), 6 * dpr, y0 + 13 * dpr);
      if (i === 0) { g.fillStyle = '#1a1a1a'; g.fillRect(0, lane - dpr / 2, w, dpr); }
    });
    g.fillStyle = '#e5484d'; g.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
  },
};

// ---------- mixer ----------
const mixer = {
  channels: {},
  init() {
    for (const L of ['A', 'B']) {
      const root = $(`.channel[data-ch=${L}]`);
      root.append($('#channelTpl').content.cloneNode(true));
      $('.ch-label', root).textContent = L === 'A' ? '1' : '2';
      const ui = this.channels[L] = { root, fill: $('.meter-fill', root), fader: $('.chfader', root), knobs: {} };
      $$('.knob', root).forEach(k => { ui.knobs[k.dataset.role] = new Knob(k, () => this.apply()); });
      ui.fader.addEventListener('input', () => this.apply());
    }
    knobs.master = new Knob($('.knob[data-role=master]'), v => { if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.01); });
    $('#xfader').addEventListener('input', () => this.apply());
    $('#xfader').addEventListener('dblclick', e => { e.target.value = 0; this.apply(); });
  },
  apply() {
    const x = +$('#xfader').value, p = (x + 1) / 2 * Math.PI / 2;
    const xg = { A: Math.cos(p), B: Math.sin(p) };
    for (const L of ['A', 'B']) {
      const d = decks[L], c = d && d.chain;
      if (!c) continue;
      const ui = this.channels[L], k = ui.knobs, now = ctx.currentTime;
      c.trim.gain.setTargetAtTime(k.trim.value, now, 0.01);
      c.low.gain.setTargetAtTime(k.low.value, now, 0.01);
      c.mid.gain.setTargetAtTime(k.mid.value, now, 0.01);
      c.high.gain.setTargetAtTime(k.high.value, now, 0.01);
      const f = k.cfx.value;
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

// Each search bumps this; a response from an older search is dropped.
let searchSeq = 0;
async function search(q) {
  const seq = ++searchSeq;
  const id = linkId(q);
  if (id) { results = [{ id, title: 'YouTube video ' + id, channel: 'Pasted link', thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }]; return showTab('results'); }
  list.innerHTML = '<li class="empty">Searching…</li>';
  showTab('results', true);
  const key = store.get('ytKey');
  let found;
  try {
    if (key) {
      try { found = await searchWithKey(q, key); }
      catch (e) {
        if (seq !== searchSeq) return;
        found = await helperSearch(q);
        if (seq !== searchSeq) return;
        flash(`API key search failed (${e.message}). Used the helper instead.`);
      }
    } else {
      found = await helperSearch(q);
    }
  } catch (e) {
    if (seq !== searchSeq) return;
    results = [];
    list.innerHTML = `<li class="empty">${escapeHtml(e.message)}</li>`;
    return;
  }
  if (seq !== searchSeq) return;
  results = found;
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
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
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
      ${cls === 'ready' ? '<span></span>' : '<button class="load prep" title="Download in the background">+</button>'}
      <button class="load a" title="Load on deck 1">1</button><button class="load b" title="Load on deck 2">2</button>
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
        : 'Downloading from YouTube (throttled, usually 15–30 s)…');
      await new Promise(r => setTimeout(r, 2000));
      st = await api(`/api/status?id=${meta.id}`);
    }
    if (d.pending !== meta.id) return;
    await refreshLibrary();
    if (d.pending !== meta.id) return;
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
  const q = $('#queueInfo'); q.textContent = msg; q.style.color = '#d9a440';
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
$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) search(q); $('#q').blur(); });
$('#fxToggle').addEventListener('click', e => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on); e.currentTarget.setAttribute('aria-pressed', on);
  $('#fxbar').classList.toggle('hidden', !on);
});
mixer.init();
decks.A = new Deck('A');
decks.B = new Deck('B');
const fx = [new FxUnit(0), new FxUnit(1)];
waves.init();
(function frame(now) {
  decks.A.tick(now); decks.B.tick(now);
  waves.draw();
  fx.forEach(u => u.retime());
  requestAnimationFrame(frame);
})(performance.now());
const clock = () => { const d = new Date(); $('#clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
clock(); setInterval(clock, 10000);
refreshHelper(); refreshLibrary();
setInterval(refreshHelper, 3000);
