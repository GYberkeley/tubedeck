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
let ctx, master, mixBus, masterDry;
function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = knobs.master ? knobs.master.value : 0.85;
    mixBus = ctx.createGain(); masterDry = ctx.createGain();
    mixBus.connect(masterDry).connect(master);
    master.connect(ctx.destination);
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    fx.forEach(u => u.connect());
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
document.addEventListener('pointerdown', () => audio(), { capture: true });

// Analysis (waveform, beats, Int16 conversion) lives in analysis.js and runs in a worker.

// ---------- rotary knobs ----------
// Drag up/down (or sideways) to turn; double-tap resets.
const knobs = {};
class Knob {
  constructor(el, onChange) {
    this.el = el; this.onChange = onChange;
    this.min = +el.dataset.min; this.max = +el.dataset.max; this.def = +el.dataset.default; this.value = +el.dataset.value;
    // Centre-detented knobs (EQ, trim, CFX) put the default at 12 o'clock even when
    // the range is lopsided (EQ: -26 dB kill .. +6 dB), like a real mixer.
    this.center = 'center' in el.dataset;
    el.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="#1b1b1b" stroke="#3a3a3a" stroke-width="1.5"/>
      <path class="arc" fill="none" stroke="#2d7ff9" stroke-width="3" stroke-linecap="round"/>
      <line class="ind" x1="20" y1="20" x2="20" y2="7" stroke="#f0f0f0" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    el.setAttribute('role', 'slider');
    this.arc = $('.arc', el); this.ind = $('.ind', el);
    let startY = 0, startX = 0, startP = 0, lastTap = 0, active = null;
    el.addEventListener('pointerdown', e => {
      if (active !== null) return;
      active = e.pointerId; el.setPointerCapture(e.pointerId);
      const now = performance.now();
      if (now - lastTap < 300) this.set(this.def);
      lastTap = now;
      startY = e.clientY; startX = e.clientX; startP = this.toPos(this.value);
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerId !== active) return;
      const d = (startY - e.clientY) + (e.clientX - startX);
      this.set(this.fromPos(startP + d / 160));
    });
    const end = e => { if (e.pointerId === active) active = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    this.render();
  }
  // Knob travel 0..1 <-> value; centred knobs split the travel at the default.
  toPos(v) {
    if (!this.center) return (v - this.min) / (this.max - this.min);
    return v <= this.def ? 0.5 * (v - this.min) / (this.def - this.min) : 0.5 + 0.5 * (v - this.def) / (this.max - this.def);
  }
  fromPos(p) {
    p = clamp(p, 0, 1);
    if (!this.center) return this.min + p * (this.max - this.min);
    return p <= 0.5 ? this.min + (p / 0.5) * (this.def - this.min) : this.def + ((p - 0.5) / 0.5) * (this.max - this.def);
  }
  set(v) {
    v = clamp(v, this.min, this.max);
    if (Math.abs(this.toPos(v) - this.toPos(this.def)) < 0.02) v = this.def;  // detent at the default
    if (v === this.value) return;
    this.value = v; this.render(); this.onChange(v);
  }
  render() {
    const toAng = v => -135 + 270 * this.toPos(v);
    const a = toAng(this.value), a0 = toAng(this.center ? this.def : this.min);  // level knobs fill from the left
    this.ind.setAttribute('transform', `rotate(${a} 20 20)`);
    const pt = ang => { const r = (ang - 90) * Math.PI / 180; return `${20 + 15 * Math.cos(r)} ${20 + 15 * Math.sin(r)}`; };
    const [from, to] = a0 < a ? [a0, a] : [a, a0];
    this.arc.setAttribute('d', Math.abs(a - a0) < 1 ? '' : `M ${pt(from)} A 15 15 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}`);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
  }
}

// ---------- beat FX ----------
// Three kinds, like rekordbox's Beat FX:
//   send   - adds a wet signal on top of the track (echo, delay, reverb, ...)
//   insert - replaces the track while on (trans, filter, crush): the source's dry path is muted
//   deck   - moves the deck itself (vinyl brake, backspin)
const FX_BEATS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8];
const FX_KIND = {
  echo: 'send', delay: 'send', pingpong: 'send', spiral: 'send', reverb: 'send', flanger: 'send', phaser: 'send',
  trans: 'insert', filter: 'insert', crush: 'insert', brake: 'deck', spin: 'deck',
};
const fxSources = () => ({ A: decks.A.chain?.xf, B: decks.B.chain?.xf, M: mixBus });

// Mute a source's dry path while any insert effect assigned to it is on.
function updateDry() {
  if (!ctx) return;
  const dry = { A: decks.A.chain?.dry, B: decks.B.chain?.dry, M: masterDry };
  for (const src of ['A', 'B', 'M']) {
    const muted = fx.some(u => u.on && FX_KIND[u.type] === 'insert' && u.assign[src]);
    dry[src]?.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.005);
  }
}

function crushCurve(bits) {
  const n = 4096, curve = new Float32Array(n), steps = 2 ** bits;
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.round(x * steps / 2) / (steps / 2); }
  return curve;
}

class FxUnit {
  constructor(i) {
    this.i = i; this.root = $(`.fxunit[data-fx="${i}"]`);
    this.root.append($('#fxTpl').content.cloneNode(true));
    $('.fx-name', this.root).textContent = `FX${i + 1}`;
    this.type = 'echo'; this.beatIx = 4; this.on = false; this.assign = { A: i === 0, B: i === 1, M: false };
    this.auto = true; this.tapBpm = 120; this.taps = []; this.bpm = 120; this.nodes = []; this.lfos = [];
    $$('[data-assign]', this.root).forEach(b => {
      b.classList.toggle('on', this.assign[b.dataset.assign]);
      b.addEventListener('click', () => {
        if (this.on && FX_KIND[this.type] === 'deck') this.motion(false);
        this.assign[b.dataset.assign] = !this.assign[b.dataset.assign]; b.classList.toggle('on');
        this.route(); if (this.on && FX_KIND[this.type] === 'deck') this.motion(true);
      });
    });
    $('select', this.root).addEventListener('change', e => {
      if (this.on && FX_KIND[this.type] === 'deck') this.motion(false);
      this.type = e.target.value; this.build(); this.route();
      if (this.on && FX_KIND[this.type] === 'deck') this.motion(true);
    });
    $$('.arrow', this.root).forEach(b => b.addEventListener('click', () => {
      this.beatIx = clamp(this.beatIx + +b.dataset.step, 0, FX_BEATS.length - 1); this.renderBeat(); this.retime(true);
    }));
    this.level = new Knob($('.knob', this.root), () => this.applyLevel());
    this.onBtn = $('.fx-on', this.root);
    this.onBtn.addEventListener('click', () => this.toggle());
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
  get kind() { return FX_KIND[this.type]; }
  renderBeat() { $('.beat-val', this.root).textContent = beatLabel(this.beats); }

  toggle() {
    audio();
    this.on = !this.on; this.onBtn.classList.toggle('on', this.on);
    if (this.kind === 'deck') return this.motion(this.on);
    if (this.on) this.alignLfos();
    this.route();
  }
  // Vinyl brake / backspin act on the assigned decks themselves.
  motion(on) {
    const targets = this.assign.M ? ['A', 'B'] : ['A', 'B'].filter(L => this.assign[L]);
    for (const L of targets) decks[L].el.motion(on ? this.type : null, this.beats * 60 / this.bpm);
  }

  connect() {
    this.input = ctx.createGain(); this.input.gain.value = 0;
    this.wet = ctx.createGain();
    this.wet.connect(master);
    this.sends = {};
    this.build(); this.route();
  }
  build() {
    if (!ctx) return;
    for (const n of this.nodes) { try { n.disconnect(); } catch {} if (n.stop) try { n.stop(); } catch {} }
    this.nodes = []; this.lfos = []; this.delay = this.delays = this.conv = this.shaper = null;
    this.input.disconnect();
    const make = (fn, ...a) => { const node = ctx[fn](...a); this.nodes.push(node); return node; };
    const lfo = (type, depth, target) => {
      const o = make('createOscillator'), g = make('createGain');
      o.type = type; g.gain.value = depth; o.connect(g).connect(target); o.start();
      this.lfos.push({ osc: o, depth: g }); return { osc: o, depth: g };
    };
    const t = this.type, inp = this.input, wet = this.wet;
    if (t === 'echo' || t === 'delay') {
      const d = this.delay = make('createDelay', 4), fb = make('createGain');
      fb.gain.value = t === 'echo' ? 0.55 : 0.28;
      inp.connect(d); d.connect(wet); d.connect(fb);
      if (t === 'echo') { const lp = make('createBiquadFilter'); lp.type = 'lowpass'; lp.frequency.value = 3500; fb.connect(lp).connect(d); }
      else fb.connect(d);
    } else if (t === 'pingpong') {
      // Repeats alternate left and right.
      const dl = make('createDelay', 4), dr = make('createDelay', 4), a = make('createGain'), b = make('createGain'), m = make('createChannelMerger', 2);
      this.delays = [dl, dr]; a.gain.value = 0.6; b.gain.value = 0.6;
      inp.connect(dl); dl.connect(a).connect(dr); dr.connect(b).connect(dl);
      dl.connect(m, 0, 0); dr.connect(m, 0, 1); m.connect(wet);
    } else if (t === 'spiral') {
      // An echo whose delay keeps shrinking, so each repeat rises in pitch (Doppler).
      const d = this.delay = make('createDelay', 4), fb = make('createGain'), hp = make('createBiquadFilter');
      fb.gain.value = 0.72; hp.type = 'highpass'; hp.frequency.value = 250;
      inp.connect(d); d.connect(wet); d.connect(hp).connect(fb).connect(d);
      this.spiralLfo = lfo('sawtooth', 0, d.delayTime);
    } else if (t === 'reverb') {
      this.conv = make('createConvolver');
      inp.connect(this.conv).connect(wet);
    } else if (t === 'flanger') {
      const d = this.delay = make('createDelay', 0.05), fb = make('createGain');
      d.delayTime.value = 0.005; fb.gain.value = 0.6;
      lfo('sine', 0.003, d.delayTime);
      inp.connect(d); d.connect(wet); d.connect(fb).connect(d);
    } else if (t === 'phaser') {
      // Four all-pass stages swept together; summed with the dry track they carve moving notches.
      let node = inp, sweep = null;
      for (let k = 0; k < 4; k++) {
        const ap = make('createBiquadFilter'); ap.type = 'allpass'; ap.frequency.value = 500 + k * 400; ap.Q.value = 0.7;
        if (!sweep) sweep = lfo('sine', 2400, ap.detune); else sweep.depth.connect(ap.detune);
        node.connect(ap); node = ap;
      }
      node.connect(wet);
    } else if (t === 'trans') {
      // Chop the volume on the beat: a square wave opens and closes a gate.
      const gate = make('createGain');
      this.gate = gate;
      this.transLfo = lfo('square', 0.5, gate.gain);
      inp.connect(gate).connect(wet);
    } else if (t === 'filter') {
      // A resonant low-pass sweeping up and down once per period.
      const f = make('createBiquadFilter'); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 6;
      this.sweep = lfo('sine', 3600, f.detune);
      inp.connect(f).connect(wet);
    } else if (t === 'crush') {
      this.shaper = make('createWaveShaper');
      inp.connect(this.shaper).connect(wet);
    }
    this.applyLevel();
    this.retime(true);
  }
  applyLevel() {
    if (!ctx || !this.wet) return;
    const v = this.level.value, now = ctx.currentTime;
    // Send effects: LEVEL is the wet level. Insert effects run fully wet; LEVEL is their depth.
    this.wet.gain.setTargetAtTime(this.kind === 'insert' ? 1 : v, now, 0.02);
    if (this.type === 'trans' && this.gate) { this.gate.gain.setValueAtTime(1 - v / 2, now); this.transLfo.depth.gain.setValueAtTime(v / 2, now); }
    if (this.type === 'filter' && this.sweep) this.sweep.depth.gain.setTargetAtTime(600 + v * 3600, now, 0.02);
    if (this.type === 'crush' && this.shaper) this.shaper.curve = crushCurve(Math.round(12 - v * 9));
  }
  // Start beat-synced LFOs on the master deck's next beat.
  alignLfos() {
    const d = masterDeck();
    if (!this.lfos.length || !d || !d.loaded || !d.bpm || d.el.paused) return;
    const period = this.beats * 60 / this.bpm, beat = 60 / d.liveBpm;
    const into = (((d.el.currentTime - d.firstBeat) / d.beatSec) % 1 + 1) % 1, wait = (1 - into) * beat;
    for (const l of this.lfos) {
      const o = ctx.createOscillator(); o.type = l.osc.type; o.frequency.value = 1 / period;
      o.connect(l.depth); o.start(ctx.currentTime + wait);
      try { l.osc.stop(ctx.currentTime + wait); } catch {}
      this.nodes.push(o); l.osc = o;
    }
  }
  retime(force) {
    if (!ctx) return;
    const bpm = this.auto ? (masterDeck()?.liveBpm || 120) : this.tapBpm;
    if (!force && Math.abs(bpm - this.bpm) < 0.05) return;
    this.bpm = bpm;
    $('.fx-bpm-val', this.root).textContent = bpm.toFixed(1);
    const t = ctx.currentTime, sec = this.seconds, period = this.beats * 60 / bpm;
    if (this.delay && this.type !== 'flanger') this.delay.delayTime.setTargetAtTime(sec, t, 0.05);
    if (this.delays) this.delays.forEach(d => d.delayTime.setTargetAtTime(sec, t, 0.05));
    if (this.type === 'spiral' && this.spiralLfo) { this.spiralLfo.osc.frequency.setValueAtTime(1 / (period * 4), t); this.spiralLfo.depth.gain.setValueAtTime(-sec * 0.35, t); }
    for (const l of this.lfos) if (this.type !== 'spiral') l.osc.frequency.setTargetAtTime(1 / Math.max(0.05, period), t, 0.05);
    if (this.type === 'reverb' && this.conv && force) {
      const len = clamp(period * 2, 0.4, 6), rate = ctx.sampleRate, ir = ctx.createBuffer(2, Math.floor(len * rate), rate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      }
      this.conv.buffer = ir;
    }
  }
  // Sends feed the FX from each assigned source; switching it off lets send tails ring out.
  route() {
    if (!ctx) return;
    const t = ctx.currentTime, src = fxSources(), audible = this.kind !== 'deck';
    for (const k of ['A', 'B', 'M']) {
      if (!src[k]) continue;
      if (!this.sends[k]) { this.sends[k] = ctx.createGain(); src[k].connect(this.sends[k]); this.sends[k].connect(this.input); }
      this.sends[k].gain.setTargetAtTime(audible && this.assign[k] ? 1 : 0, t, 0.01);
    }
    // Inserts cut instantly with the dry path; sends fade so their tails stay.
    this.input.gain.setTargetAtTime(this.on && audible ? 1 : 0, t, this.kind === 'insert' ? 0.005 : 0.01);
    if (this.kind === 'insert' && !this.on) this.wet.gain.setTargetAtTime(0, t, 0.005);
    else this.applyLevel();
    updateDry();
  }
}

// ---------- deck engine ----------
// A Player looks like an <audio> element to the deck code (currentTime, paused,
// play(), playbackRate, preservesPitch, duration) but plays decoded PCM through
// DeckDSP (deck-dsp.js): on the audio thread via AudioWorklet where the page is a
// secure context, otherwise through a ScriptProcessor callback (plain-http pages,
// e.g. an iPad on the LAN, can't use AudioWorklet).
let workletReady = null;
const forceScriptProcessor = new URLSearchParams(location.search).has('sp') || store.get('engine') === 'sp';
function loadWorklet() {
  if (!workletReady) {
    // Fall back if the worklet can't load or never answers (seen in headless browsers).
    workletReady = (!forceScriptProcessor && ctx.audioWorklet)
      ? Promise.race([ctx.audioWorklet.addModule('deck-dsp.js').then(() => true, () => false),
        new Promise(ok => setTimeout(() => ok(false), 3000))])
      : Promise.resolve(false);
  }
  return workletReady;
}

class Player {
  constructor() {
    this.node = null; this.port = null; this.dsp = null;
    this._playing = false; this._rate = 1; this.keylock = true; this.frames = 0; this.sr = 48000;
    this.st = { pos: 0, playing: false, ended: false, rate: 0, t: 0 };
    this.handlers = { ended: [] };
  }
  async attach() {
    const worklet = await loadWorklet();
    if (worklet) {
      this.node = new AudioWorkletNode(ctx, 'deck-processor', { numberOfInputs: 0, outputChannelCount: [2] });
      this.port = this.node.port;
      this.port.onmessage = e => this.update(e.data);
      this.kind = 'worklet';
    } else {
      this.dsp = new DeckDSP(ctx.sampleRate);
      this.node = ctx.createScriptProcessor(2048, 1, 2);
      this.node.onaudioprocess = e => {
        const o = e.outputBuffer;
        this.dsp.process(o.getChannelData(0), o.getChannelData(1), o.length);
        this.update({ ...this.dsp.state(), t: ctx.currentTime });
      };
      this.kind = 'scriptprocessor';
    }
    this.sr = ctx.sampleRate;
    this.post({ type: 'set', playing: this._playing, rate: this._rate, keylock: this.keylock });
    return this.node;
  }
  post(m, transfer) {
    m.seq = this.sent = (this.sent || 0) + 1;
    if (this.port) this.port.postMessage(m, transfer || []); else if (this.dsp) this.dsp.handle(m);
  }
  // Reports from the engine; one sent before our latest command would undo it (the
  // play button and waveform flicker), so only reports that have seen it count.
  update(st) {
    if ((st.seq || 0) < (this.sent || 0)) return;
    const wasEnded = this.st.ended;
    this.st = st;
    if (st.ended && !wasEnded) { this._playing = false; this.handlers.ended.forEach(f => f()); }
  }
  addEventListener(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); }
  load(stems, frames, { offset = 0, keepPos = false } = {}) {
    this.frames = frames;
    if (!keepPos) this.st = { pos: 0, playing: false, ended: false, rate: 0, t: ctx.currentTime };
    this.post({ type: 'load', stems, length: frames, offset, keepPos }, stems.map(s => s.data.buffer));
  }
  addStems(stems) { this.post({ type: 'addStems', stems }, stems.map(s => s.data.buffer)); }
  unload() { this.frames = 0; this._playing = false; this.post({ type: 'load', stems: [], length: 0 }); this.st = { pos: 0, playing: false, ended: false, rate: 0, t: 0 }; }
  get duration() { return this.frames ? this.frames / this.sr : NaN; }
  get readyState() { return this.frames ? 4 : 0; }
  get paused() { return !this._playing; }
  get currentTime() {
    const s = this.st, ahead = s.playing || this.scratching ? Math.max(0, (ctx ? ctx.currentTime : 0) - s.t) * s.rate : 0;
    let t = s.pos + ahead;
    // Between engine reports, wrap the estimate the way the engine wraps the audio.
    const L = this.loop;
    if (L && s.pos < L.end && t >= L.end && !this.scratching) t = L.start + ((t - L.start) % (L.end - L.start));
    return clamp(t, 0, this.duration || 0);
  }
  // Last position the engine actually reported (no estimate).
  get reportedTime() { return this.st.pos; }
  set currentTime(v) {
    v = clamp(v, 0, this.duration || 0);
    this.st = { ...this.st, pos: v, t: ctx ? ctx.currentTime : 0, ended: false };
    this.post({ type: 'seek', pos: v });
  }
  play() {
    if (!this.frames) return Promise.reject(Object.assign(new Error('not loaded'), { name: 'NotLoaded' }));
    this._playing = true; this.st = { ...this.st, playing: true, rate: this._rate, t: ctx.currentTime, ended: false };
    this.post({ type: 'set', playing: true });
    return Promise.resolve();
  }
  pause() {
    // Stop where the display says we are, so the engine and the UI agree and play resumes there.
    const at = this.currentTime;
    this._playing = false; this.st = { ...this.st, pos: at, playing: false, t: ctx ? ctx.currentTime : 0 };
    this.post({ type: 'set', playing: false }); this.post({ type: 'seek', pos: at });
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { if (r === this._rate) return; this.st = { ...this.st, pos: this.currentTime, t: ctx ? ctx.currentTime : 0, rate: this.st.playing ? r : 0 }; this._rate = r; this.post({ type: 'set', rate: r }); }
  set preservesPitch(b) { this.keylock = b; this.post({ type: 'set', keylock: b }); }
  get preservesPitch() { return this.keylock; }
  set webkitPreservesPitch(b) { this.preservesPitch = b; }
  motion(kind, seconds) { this.post({ type: 'motion', kind, seconds }); }
  setLoop(loop) { this.loop = loop ? { start: loop.start, end: loop.end } : null; this.post({ type: 'set', loop: this.loop }); }
  setGains(gains) { this.post({ type: 'set', gains }); }
  scratch(on, target, playing) {
    this.scratching = on;
    const m = { type: 'scratch', on, target };
    if (!on) { m.playing = playing; this._playing = playing; }
    this.post(m);
    if (target != null) this.st = { ...this.st, pos: target, t: ctx.currentTime, rate: 0 };
  }
}

// Analysis worker: waveform, beats and PCM conversion off the main thread.
const analyzer = {
  seq: 0, waiting: new Map(),
  worker: null,
  run(msg, transfer) {
    if (!this.worker) {
      this.worker = new Worker('analysis.js');
      this.worker.onmessage = e => { const w = this.waiting.get(e.data.id); this.waiting.delete(e.data.id); w && w(e.data); };
    }
    const id = ++this.seq;
    return new Promise(ok => { this.waiting.set(id, ok); this.worker.postMessage({ ...msg, id }, transfer); });
  },
  // Copies the channels out of an AudioBuffer (the copies move to the worker).
  channels(buf) {
    const ch0 = buf.getChannelData(0).slice(), ch1 = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
    return { msg: { ch0, ch1, sr: buf.sampleRate }, transfer: [ch0.buffer, ch1.buffer] };
  },
};

const STEM_NAMES = ['vocals', 'other', 'bass', 'drums'];
const MAX_TRACK_SECONDS = 30 * 60;  // decoded PCM for longer sets would exhaust an iPad's memory  // rekordbox: VOCAL, INST, BASS, DRUMS
const stemUrl = (id, name) => `/api/stem/${id}/${name}?t=${encodeURIComponent(token())}`;

// ---------- decks ----------
const PAD_COLORS = ['#e8364f', '#f0a030', '#e6d32e', '#3fcf5a', '#2fc0d6', '#2d7ff9', '#9b59f0', '#e85fb4'];
const PAD_LOOPS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const PAD_JUMPS = [-1, -4, -16, -32, 1, 4, 16, 32];
const PAD_ROLLS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4];
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
    this.el = new Player();
    this.track = null; this.cue = 0; this.hot = Array(8).fill(null);
    this.bpm = 0; this.firstBeat = 0; this.tempo = 0; this.keyLock = true; this.synced = false; this.isMaster = false;
    this.loop = null; this.loopBeats = 4; this.manualIn = null; this.mode = 'hot'; this.wave = null; this.bend = 0;
    this.quantize = true; this.slip = false; this.slipFrom = null; this.taps = []; this.scratching = false;
    this.stemOn = { vocals: true, other: true, bass: true, drums: true }; this.stemsReady = false;
    this.pending = null; // id of the track being fetched for this deck; stale fetches compare against it
    this.bindUi();
  }

  connect() {
    return this._connecting || (this._connecting = this.buildChain());
  }
  async buildChain() {
    const c = audio();
    const src = await this.el.attach();
    const trim = c.createGain();
    const low = Object.assign(c.createBiquadFilter(), { type: 'lowshelf' }); low.frequency.value = 200;
    const mid = Object.assign(c.createBiquadFilter(), { type: 'peaking' }); mid.frequency.value = 1000; mid.Q.value = 0.8;
    const high = Object.assign(c.createBiquadFilter(), { type: 'highshelf' }); high.frequency.value = 3500;
    const lpf = Object.assign(c.createBiquadFilter(), { type: 'lowpass' }); lpf.frequency.value = 22000; lpf.Q.value = 1;
    const hpf = Object.assign(c.createBiquadFilter(), { type: 'highpass' }); hpf.frequency.value = 10; hpf.Q.value = 1;
    const ch = c.createGain(), xf = c.createGain(), dry = c.createGain(), meter = c.createAnalyser();
    meter.fftSize = 1024;
    src.connect(trim).connect(low).connect(mid).connect(high).connect(lpf).connect(hpf);
    const cfx = buildColorFx(c, hpf, ch);
    ch.connect(xf).connect(dry).connect(mixBus);
    ch.connect(meter);
    this.chain = { trim, low, mid, high, lpf, hpf, cfx, ch, xf, dry, meter, buf: new Float32Array(1024) };
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
      stemRow: $('.stem-row', r), stemStatus: $('.stem-status', r), stemBtns: $$('.stem', r),
    };
    this.ui.stemBtns.forEach(b => b.addEventListener('click', () => this.toggleStem(b.dataset.stem)));
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('button');
      p.className = 'pad'; p.style.setProperty('--pc', PAD_COLORS[i]);
      let hold;
      p.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (this.mode === 'hot' && this.hot[i] != null) hold = setTimeout(() => { hold = null; this.hot[i] = null; this.renderPads(); }, 600);
        this.padDown(i);
      });
      const up = () => { if (hold) { clearTimeout(hold); hold = null; } this.padUp(i); };
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
    const toggleLoop = () => (this.loop ? this.exitLoop() : this.beatLoop(this.loopBeats));
    this.ui.au.addEventListener('click', toggleLoop);
    this.ui.loopLen.addEventListener('click', toggleLoop);
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
    await this.connect();
    this.el.pause();
    this.track = meta; this.cue = 0; this.hot.fill(null); this.loop = null; this.manualIn = null; this.bpm = 0; this.wave = null; this.overviewImg = null;
    this.stemsReady = false; this.mixRef = null;
    this.ui.title.textContent = meta.title || meta.id;
    this.ui.artist.textContent = meta.channel || '';
    this.ui.bpm.textContent = '--.-';
    this.ui.play.classList.remove('lit');
    this.root.classList.add('loaded');
    this.el.unload();
    this.el.playbackRate = this.rate;
    this.renderPads(); this.renderLoop(); this.renderStems('Separating…');
    if ((meta.duration || 0) > MAX_TRACK_SECONDS) {
      this.setState(`Tracks over ${MAX_TRACK_SECONDS / 60} minutes are too long to load into the deck yet.`);
      return;
    }
    this.setState('Loading audio…');
    try {
      const bytes = await (await fetch(audioUrl(meta.id))).arrayBuffer();
      if (this.track !== meta) return;
      this.setState('Decoding…');
      const buf = await new Promise((ok, bad) => audio().decodeAudioData(bytes, ok, bad));
      if (this.track !== meta) return;
      this.setState('Analyzing…');
      const { msg, transfer } = analyzer.channels(buf);
      const r = await analyzer.run({ type: 'analyze', ...msg }, transfer);
      if (this.track !== meta) return;
      this.el.load([{ name: 'mix', data: r.pcm }], buf.length);
      this.mixRef = r.ref;
      this.wave = r.wave; this.bpm = r.bpm; this.firstBeat = r.firstBeat;
      this.setState('');
      this.renderBpm();
      if (!masterDeck() || masterDeck() === this) this.makeMaster();
      if (this.synced) this.sync();
      this.notifyFollowers();
      this.fetchStems(meta);
    } catch (e) {
      if (this.track !== meta) return;
      this.setState('Could not load this track: ' + (e.message || e));
    }
  }

  // Ask the helper for stems; when they're ready, swap them in without a gap.
  async fetchStems(meta) {
    let st;
    try { st = await api(`/api/stems?id=${meta.id}`, { method: 'POST' }); } catch { return this.renderStems('Stems unavailable'); }
    while (this.track === meta && (st.state === 'queued' || st.state === 'separating')) {
      this.renderStems(st.state === 'queued' ? `Stems queued #${st.position}` : 'Separating stems… (about a minute)');
      await new Promise(r => setTimeout(r, 2500));
      try { st = await api(`/api/stems?id=${meta.id}`); } catch { return this.renderStems('Stems unavailable'); }
    }
    if (this.track !== meta) return;
    if (st.state !== 'ready') return this.renderStems(st.state === 'unavailable' ? 'Stems not installed' : 'Stems failed', st.error);
    this.renderStems('Loading stems…');
    try {
      const stems = [], refs = [];
      for (const name of STEM_NAMES) {
        const bytes = await (await fetch(stemUrl(meta.id, name))).arrayBuffer();
        const buf = await new Promise((ok, bad) => audio().decodeAudioData(bytes, ok, bad));
        if (this.track !== meta) return;
        const { msg, transfer } = analyzer.channels(buf);
        const r = await analyzer.run({ type: 'pcm', ...msg }, transfer);
        stems.push({ name, data: r.pcm });
        refs.push(r.ref);
      }
      if (this.track !== meta) return;
      const sum = new Float32Array(Math.min(...refs.map(r => r.length)));
      for (const r of refs) for (let i = 0; i < sum.length; i++) sum[i] += r[i];
      const { offset } = this.mixRef ? await analyzer.run({ type: 'align', mix: this.mixRef, stems: sum }, []) : { offset: 0 };
      if (this.track !== meta) return;
      // The original keeps playing; stems sit at 0 and a muted one is subtracted (-1).
      for (const s of stems) { s.offset = offset; s.gain = this.stemOn[s.name] ? 0 : -1; }
      this.el.addStems(stems);
      this.stemsReady = true;
      this.renderStems();
    } catch (e) {
      if (this.track === meta) this.renderStems('Stems failed', e.message);
    }
  }

  toggleStem(name) {
    if (!this.stemsReady) return;
    this.stemOn[name] = !this.stemOn[name];
    this.el.setGains({ [name]: this.stemOn[name] ? 0 : -1 });
    this.renderStems();
  }
  renderStems(status, detail) {
    this.ui.stemRow.classList.toggle('ready', !!this.stemsReady);
    this.ui.stemStatus.textContent = this.stemsReady ? '' : (status || '');
    this.ui.stemStatus.title = detail || '';
    for (const b of this.ui.stemBtns) b.classList.toggle('off', !this.stemOn[b.dataset.stem]);
  }

  togglePlay() {
    if (!this.track) return;
    audio();
    if (this.el.paused) {
      this.el.play().catch(e => {
        if (e.name === 'AbortError' || e.name === 'NotLoaded') return;
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
    if (this.loop && this.bpm) {
      const start = this.loop.start, len = next * this.beatSec, t = this.el.currentTime;
      this.loop = { ...this.loop, end: start + len, beats: next };
      // Shrinking can leave the playhead past the new end; fold it back in, as a DDJ does.
      if (t >= start + len) this.el.currentTime = start + ((t - start) % len);
    }
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
    if (this.mode === 'roll') return this.rollDown(i);
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
  // ROLL: while a pad is held, repeat a slice on the beat grid; the track keeps
  // moving underneath and picks up there on release (rekordbox's slip roll).
  rollDown(i) {
    if (!this.bpm) return this.setState('Roll needs a BPM.');
    const len = PAD_ROLLS[i] * this.beatSec, t = this.el.currentTime;
    const start = this.quantize ? this.firstBeat + Math.floor((t - this.firstBeat) / len + 1e-6) * len : t;
    if (!this.roll) this.roll = { pos: t, at: performance.now(), rate: this.el.paused ? 0 : this.rate };
    this.roll.pad = i;
    this.loop = { start, end: start + len, beats: PAD_ROLLS[i], roll: true };
    this.renderPads(); this.renderLoop();
  }
  padUp(i) {
    if (!this.roll || this.roll.pad !== i) return;
    const r = this.roll; this.roll = null; this.loop = null;
    this.el.currentTime = r.pos + (performance.now() - r.at) / 1000 * r.rate;
    this.renderPads(); this.renderLoop();
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
      } else if (this.mode === 'roll') {
        p.innerHTML = `<span>${beatLabel(PAD_ROLLS[i])}</span><small>ROLL</small>`;
        p.classList.toggle('set', !!this.roll && this.roll.pad === i);
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
      // A release that never arrived would leave the deck scratching (silent); finish it first.
      if (active !== null && e.pointerId !== active) end({ pointerId: active });
      if (active !== null || !this.track) return;
      active = e.pointerId;
      try { ring.setPointerCapture(e.pointerId); } catch {}  // throws if the pointer is already gone
      const p = polar(e); last = p.a; lastT = performance.now();
      mode = p.r < 0.8 ? 'scratch' : 'bend';
      ring.classList.add(mode === 'scratch' ? 'scratching' : 'bending');
      if (mode === 'scratch') {
        wasPlaying = !this.el.paused; pos = this.el.currentTime;
        this.startSlip();
        this.scratching = true; this.scratchPos = pos;
        this.el.scratch(true, pos);
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
      // The engine chases this target, so the audio follows the hand in both directions.
      pos = clamp(pos + d / (2 * Math.PI) * SECONDS_PER_JOG_TURN, 0, this.el.duration || 0);
      this.scratchPos = pos;
      this.el.scratch(true, pos);
    });
    function end(e) {
      if (e.pointerId !== active) return;
      deck.finishJog();
    }
    this.finishJog = () => {
      if (active === null) return;
      active = null; ring.classList.remove('scratching', 'bending');
      this.bend = 0;
      if (mode === 'scratch') {
        this.scratching = false;
        this.el.scratch(false, pos, wasPlaying);
        this.endSlip();
      }
      this.el.playbackRate = this.rate;
      mode = null;
    };
    const deck = this;
    // lostpointercapture also fires when the browser drops the touch without a pointerup.
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => ring.addEventListener(t, end));
    window.addEventListener('blur', () => this.finishJog());
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
    // The engine wraps loops at the exact sample; a seek far past the end exits the loop.
    if (this.loop !== this.sentLoop) { this.sentLoop = this.loop; el.setLoop(this.loop); }
    if (this.loop && !this.scratching && el.reportedTime > this.loop.end + 0.3) this.exitLoop();
    if (this.bend && !this.scratching && now - (this.lastJogMove || 0) > 80) { this.bend = 0; el.playbackRate = this.rate; }
    const playing = !el.paused && !this.scratching;
    this.root.classList.toggle('playing', playing);
    // toggle() with an undefined force flips the class, so always pass a real boolean.
    if (!this.previewing) this.ui.play.classList.toggle('lit', playing || (!!this.scratching && this.ui.play.classList.contains('lit')));
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

// ---------- themes ----------
// The skin (colours, glassy panels, an animated nature scene) comes from themes.css;
// canvas drawing reads the theme's colours from its CSS variables.
const THEME = {};
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  store.set('theme', name);
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  Object.assign(THEME, { low: v('--wave-low'), mid: v('--wave-mid'), high: v('--wave-high'), playhead: v('--playhead'), A: v('--deck-a'), B: v('--deck-b') });
  for (const d of Object.values(decks)) { d.color = THEME[d.letter]; d.overviewImg = null; }
  $('#themeSel').value = name;
}
let sceneBpm = 0;
// The scene breathes with the music: --beat follows the master deck's tempo.
function syncSceneTempo() {
  const bpm = Math.round((masterDeck()?.liveBpm || 120) * 10) / 10;
  if (bpm !== sceneBpm) { sceneBpm = bpm; document.documentElement.style.setProperty('--beat', `${(60 / bpm).toFixed(3)}s`); }
}

// Draw waveform entries [from, to) across x0..x1 in the theme's 3-band colours.
function drawBands(g, wave, from, to, x0, x1, y0, h) {
  const cols = Math.max(1, Math.round(x1 - x0)), per = (to - from) / cols, mid = y0 + h / 2, half = h / 2 * 0.95;
  const layers = [['low', THEME.low, 1], ['mid', THEME.mid, 0.8], ['high', THEME.high, 0.55]];
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
    g.clearRect(0, 0, w, h);  // the theme's --wave-bg shows through
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
      if (i === 0) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, lane - dpr / 2, w, dpr); }
    });
    g.fillStyle = THEME.playhead; g.fillRect(w / 2 - dpr, 0, 2 * dpr, h);
  },
};

// ---------- color FX (one knob per channel) ----------
// FILTER uses the channel's low/high-pass; the others run in parallel paths:
// DUB ECHO and JET add to the track, NOISE adds a filtered noise riser, CRUSH blends in.
function buildColorFx(c, from, to) {
  const g = v => { const n = c.createGain(); n.gain.value = v; return n; };
  const fx = { dry: g(1) };
  from.connect(fx.dry).connect(to);
  // Dub echo: a long dark/bright feedback echo.
  fx.dubSend = g(0); fx.dubDelay = c.createDelay(2); fx.dubDelay.delayTime.value = 0.375;
  const dubFb = g(0.62); fx.dubTone = c.createBiquadFilter(); fx.dubTone.Q.value = 0.7;
  from.connect(fx.dubSend).connect(fx.dubDelay).connect(fx.dubTone).connect(dubFb).connect(fx.dubDelay);
  fx.dubTone.connect(to);
  // Noise: looped white noise through a sweepable filter.
  const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.start();
  fx.noiseFilter = c.createBiquadFilter(); fx.noiseFilter.Q.value = 1.5; fx.noiseGain = g(0);
  ns.connect(fx.noiseFilter).connect(fx.noiseGain).connect(to);
  // Crush: quantised copy blended against the dry signal.
  fx.crushSend = g(0); fx.crush = c.createWaveShaper(); fx.crush.curve = crushCurve(6);
  from.connect(fx.crushSend).connect(fx.crush).connect(to);
  // Jet: a slow, deep flanger.
  fx.jetSend = g(0); const jd = c.createDelay(0.05), jfb = g(0.75), lfo = c.createOscillator(), depth = g(0.0035);
  jd.delayTime.value = 0.004; lfo.frequency.value = 0.25; lfo.connect(depth).connect(jd.delayTime); lfo.start();
  from.connect(fx.jetSend).connect(jd).connect(to); jd.connect(jfb).connect(jd);
  return fx;
}

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
    $('#cfxType').addEventListener('change', () => this.apply());
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
      const f = k.cfx.value, a = Math.abs(f), type = $('#cfxType').value, x = c.cfx, set = (p, v) => p.setTargetAtTime(v, now, 0.02);
      const on = t => (type === t && a > 0.02 ? a : 0);
      set(c.lpf.frequency, type === 'filter' && f < -0.02 ? 20000 * Math.pow(10, f * 3) : 22000);
      set(c.hpf.frequency, type === 'filter' && f > 0.02 ? 20 * Math.pow(10, f * 3) : 10);
      // Left of centre darkens the effect, right of centre brightens it.
      set(x.dubSend.gain, on('dub'));
      x.dubTone.type = f < 0 ? 'lowpass' : 'highpass'; set(x.dubTone.frequency, f < 0 ? 1800 : 600);
      if (d.bpm) set(x.dubDelay.delayTime, Math.min(1.9, 0.75 * 60 / d.liveBpm));
      set(x.noiseGain.gain, on('noise') * 0.25);
      x.noiseFilter.type = f < 0 ? 'lowpass' : 'highpass'; set(x.noiseFilter.frequency, f < 0 ? 200 + a * 4000 : 8000 - a * 7000);
      set(x.crushSend.gain, on('crush')); set(x.dry.gain, type === 'crush' ? 1 - a : 1);
      if (type === 'crush' && Math.round(12 - a * 9) !== x.bits) { x.bits = Math.round(12 - a * 9); x.crush.curve = crushCurve(x.bits); }
      set(x.jetSend.gain, on('jet') * 0.9);
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
applyTheme(store.get('theme') || 'classic');
$('#themeSel').addEventListener('change', e => applyTheme(e.target.value));
const fx = [new FxUnit(0), new FxUnit(1)];
waves.init();
(function frame(now) {
  decks.A.tick(now); decks.B.tick(now);
  waves.draw();
  fx.forEach(u => u.retime());
  syncSceneTempo();
  requestAnimationFrame(frame);
})(performance.now());
const clock = () => { const d = new Date(); $('#clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
clock(); setInterval(clock, 10000);
refreshHelper(); refreshLibrary();
setInterval(refreshHelper, 3000);
