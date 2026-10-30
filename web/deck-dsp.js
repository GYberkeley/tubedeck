'use strict';
// Deck playback core, shared by the AudioWorklet (secure pages) and the
// ScriptProcessor fallback (plain-http pages such as an iPad on the LAN).
//
// Audio is held as Int16 interleaved stereo: the original "mix", plus optional
// stems added later. Stems normally sit at gain 0; muting one sets it to -1, so the
// deck plays the original minus that stem (with nothing muted, exactly the original).
// Playback modes:
//   resample  - linear-interpolated varispeed (vinyl: pitch follows tempo)
//   key lock  - WSOLA time-stretch so tempo changes keep the pitch
//   scratch   - the position chases a target set by the jog wheel, at any
//               speed and in either direction
// Loops wrap sample-accurately inside the processing loop.

class DeckDSP {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.stems = [];          // [{name, data: Int16Array, gain, cur}]
    this.length = 0;          // frames
    this.pos = 0;             // frames: what is being heard now
    this.playing = false; this.rate = 1; this.keylock = true; this.ended = false;
    this.loop = null;         // {start, end} in frames
    this.scratching = false; this.target = 0; this.vel = 0;
    this.motion = null;       // vinyl brake / backspin: {kind, v0, dur, t}
    this.W = 1024; this.Hs = 512; this.search = 192;
    this.win = new Float32Array(this.W).map((_, j) => 0.5 - 0.5 * Math.cos(2 * Math.PI * j / this.W));
    this.olaL = new Float32Array(this.W); this.olaR = new Float32Array(this.W);
    this.fifoL = new Float32Array(8192); this.fifoR = new Float32Array(8192); this.fifoN = 0;
    this.ws = null;           // WSOLA state while stretching
    this.mode = 'resample';
  }

  handle(m) {
    if (m.seq) this.seq = m.seq;
    switch (m.type) {
      case 'load': {
        const keep = m.keepPos ? this.pos : 0;
        const old = Object.fromEntries(this.stems.map(s => [s.name, s.gain]));
        this.stems = m.stems.map(s => this.stem(s, old));
        this.length = m.length;
        this.pos = Math.min(keep, this.length); this.ended = false;
        this.resetStretch();
        break;
      }
      case 'addStems':
        // Stems join the playing mix in place: no restart, position kept.
        this.stems = [...this.stems.filter(s => !m.stems.some(n => n.name === s.name)), ...m.stems.map(s => this.stem(s, {}))];
        break;
      case 'set':
        if ('playing' in m) { if (m.playing && !this.playing) { this.ended = false; this.resetStretch(); } this.playing = m.playing; }
        if ('rate' in m) this.rate = m.rate;
        if ('keylock' in m) this.keylock = m.keylock;
        if ('loop' in m) {
          const prev = this.loop;
          this.loop = m.loop ? { start: m.loop.start * this.sr, end: m.loop.end * this.sr } : null;
          // A loop shrunk while playing can leave the playhead past its new end (it would
          // never cross the end again); fold it back in. Only if it was inside the old loop,
          // so a deliberate jump elsewhere still leaves the loop.
          const L = this.loop;
          if (prev && L && this.pos >= L.end && this.pos >= L.start && this.pos <= prev.end) {
            this.pos = L.start + ((this.pos - L.start) % (L.end - L.start));
            this.resetStretch();
          }
        }
        if (m.gains) for (const s of this.stems) if (s.name in m.gains) s.gain = m.gains[s.name];
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(m.pos * this.sr, this.length)); this.ended = false; this.resetStretch();
        break;
      case 'motion':
        // Vinyl brake: slow from the current speed to a stop. Backspin: a fast reverse
        // spin that winds down. Both hold silent at the end until released. Like
        // rekordbox's Beat FX, the deck keeps running underneath: on release, playback
        // continues where the track would be had it never stopped.
        if (m.kind) this.motion = { kind: m.kind, v0: m.kind === 'spin' ? -3.5 : (this.playing ? this.rate : 0), dur: m.seconds * this.sr, t: 0, start: this.pos };
        else {
          if (this.motion && this.playing) this.pos = Math.max(0, Math.min(this.length - 1, this.motion.start + this.motion.t * this.rate));
          this.motion = null; this.resetStretch();
        }
        break;
      case 'scratch':
        if (m.on && !this.scratching) { this.vel = 0; this.resetStretch(); }
        this.scratching = m.on;
        if (m.target != null) this.target = m.target * this.sr;
        if (!m.on) {
          // Land exactly where the hand let go.
          if (m.target != null) this.pos = Math.max(0, Math.min(this.length - 1, this.target));
          this.vel = 0; if ('playing' in m) this.playing = m.playing; this.resetStretch();
        }
        break;
    }
  }

  stem(s, old) {
    const g = old[s.name] ?? s.gain ?? 1;
    return { name: s.name, data: s.data, offset: s.offset || 0, gain: g, cur: g };
  }

  // seq echoes the last command handled, so the page can drop reports older than its latest command.
  state() { return { pos: this.pos / this.sr, playing: this.playing && !this.scratching, ended: this.ended, rate: this.effectiveRate(), seq: this.seq || 0 }; }
  effectiveRate() { return this.scratching ? this.vel : this.motion ? (this.motionV || 0) : (this.playing ? this.rate : 0); }
  resetStretch() { this.ws = null; this.fifoN = 0; this.olaL.fill(0); this.olaR.fill(0); }

  // Sample frame i (fractional ok) mixed across stems, into out[0..1].
  frame(i, out) {
    let l = 0, r = 0;
    if (i >= 0 && i < this.length - 1) {
      const i0 = Math.floor(i), f = i - i0;
      for (const s of this.stems) {
        if (!s.cur) continue;
        const k = i0 + s.offset;
        if (k < 0 || k >= s.data.length / 2 - 1) continue;
        const d = s.data, a = k * 2;
        l += s.cur * (d[a] + (d[a + 2] - d[a]) * f);
        r += s.cur * (d[a + 1] + (d[a + 3] - d[a + 1]) * f);
      }
    }
    out[0] = l / 32768; out[1] = r / 32768;
  }

  wrap(i) {
    const L = this.loop;
    return L && i >= L.end && i < L.end + this.sr ? i - (L.end - L.start) : i;
  }

  rampGains(n) {
    for (const s of this.stems) {
      if (s.cur === s.gain) continue;
      const step = (s.gain - s.cur) / Math.max(1, n), next = s.cur + step * n;
      s.cur = Math.abs(next - s.gain) < 1e-4 ? s.gain : next;
    }
  }

  process(L, R, n) {
    const tmp = this._tmp || (this._tmp = [0, 0]);
    this.rampGains(n);
    if (!this.length || (!this.playing && !this.scratching)) { L.fill(0); R.fill(0); return; }
    if (this.motion && !this.scratching) {
      const mo = this.motion;
      for (let j = 0; j < n; j++) {
        const left = Math.max(0, 1 - mo.t / mo.dur), v = mo.v0 * (mo.kind === 'spin' ? left * left : left);
        mo.t++; this.motionV = v;
        this.pos = Math.max(0, Math.min(this.length - 1, this.pos + v));
        if (v === 0) { L[j] = 0; R[j] = 0; continue; }
        this.frame(this.pos, tmp); L[j] = tmp[0] * Math.min(1, left * 4); R[j] = tmp[1] * Math.min(1, left * 4);
      }
      return;
    }
    if (this.scratching) {
      // Chase the jog target: velocity eases toward closing the gap in ~30 ms.
      const a = 1 - Math.exp(-1 / (0.012 * this.sr));
      const want = Math.max(-12, Math.min(12, (this.target - this.pos) / (0.03 * this.sr)));
      for (let j = 0; j < n; j++) {
        this.vel += (want - this.vel) * a;
        this.pos = Math.max(0, Math.min(this.length - 1, this.pos + this.vel));
        this.frame(this.pos, tmp); L[j] = tmp[0]; R[j] = tmp[1];
      }
      return;
    }
    if (this.keylock && Math.abs(this.rate - 1) > 1e-4) return this.stretch(L, R, n, tmp);
    this.ws = null;
    for (let j = 0; j < n; j++) {
      const before = this.pos;
      this.pos += this.rate;
      if (this.loop && before < this.loop.end && this.pos >= this.loop.end) this.pos -= this.loop.end - this.loop.start;
      if (this.pos >= this.length - 1) { this.end(L, R, j, n); return; }
      this.frame(this.pos, tmp); L[j] = tmp[0]; R[j] = tmp[1];
    }
  }

  end(L, R, from, n) {
    for (let j = from; j < n; j++) { L[j] = 0; R[j] = 0; }
    this.pos = this.length - 1; this.playing = false; this.ended = true;
  }

  // Mono, gain-weighted sample for the WSOLA similarity search.
  mono(i) { const t = this._m || (this._m = [0, 0]); this.frame(this.wrap(i), t); return t[0] + t[1]; }

  stretch(L, R, n, tmp) {
    const { W, Hs } = this;
    if (!this.ws) this.ws = { ap: this.pos, prev: Math.round(this.pos) - Hs };
    const ws = this.ws;
    while (this.fifoN < n) {
      // Pick the frame near the ideal analysis position that best continues the last one.
      const natural = ws.prev + Hs, centre = Math.round(ws.ap);
      let best = centre, bestScore = -Infinity;
      if (natural >= 0) {
        const ref = this._ref || (this._ref = new Float32Array(128));
        for (let k = 0; k < 128; k++) ref[k] = this.mono(natural + k * 2);
        for (let d = -this.search; d <= this.search; d += 4) {
          let s = 0;
          for (let k = 0; k < 128; k++) s += ref[k] * this.mono(centre + d + k * 2);
          if (s > bestScore) { bestScore = s; best = centre + d; }
        }
        // Refine around the coarse peak.
        for (let d = best - 3; d <= best + 3; d++) {
          let s = 0;
          for (let k = 0; k < 128; k++) s += ref[k] * this.mono(d + k * 2);
          if (s > bestScore) { bestScore = s; best = d; }
        }
      }
      for (let j = 0; j < W; j++) {
        this.frame(this.wrap(best + j), tmp);
        this.olaL[j] += this.win[j] * tmp[0]; this.olaR[j] += this.win[j] * tmp[1];
      }
      // The first Hs samples are now complete (Hann at 50% overlap sums to 1).
      if (this.fifoN + Hs > this.fifoL.length) break;
      this.fifoL.set(this.olaL.subarray(0, Hs), this.fifoN); this.fifoR.set(this.olaR.subarray(0, Hs), this.fifoN);
      this.fifoN += Hs;
      this.olaL.copyWithin(0, Hs); this.olaL.fill(0, W - Hs);
      this.olaR.copyWithin(0, Hs); this.olaR.fill(0, W - Hs);
      ws.prev = best;
      ws.ap += Hs * this.rate;
      if (this.loop && ws.ap >= this.loop.end && ws.ap < this.loop.end + this.sr) {
        const len = this.loop.end - this.loop.start; ws.ap -= len; ws.prev -= len;
      }
      if (ws.ap >= this.length - W) { this.end(L, R, 0, n); this.resetStretch(); return; }
    }
    L.set(this.fifoL.subarray(0, n)); R.set(this.fifoR.subarray(0, n));
    this.fifoL.copyWithin(0, n, this.fifoN); this.fifoR.copyWithin(0, n, this.fifoN);
    this.fifoN -= n;
    // What is heard now lags the analysis position by the queued output.
    this.pos = Math.max(0, ws.ap - (this.fifoN + Hs) * this.rate);
  }
}

if (typeof registerProcessor === 'function') {
  class DeckProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new DeckDSP(sampleRate);
      this.port.onmessage = e => { this.dsp.handle(e.data); this.report(); };
      this.blocks = 0;
    }
    report() { this.port.postMessage({ ...this.dsp.state(), t: currentTime }); }
    process(_inputs, outputs) {
      const o = outputs[0];
      this.dsp.process(o[0], o[1] || o[0], o[0].length);
      if (++this.blocks % 6 === 0 || this.dsp.ended) this.report();
      return true;
    }
  }
  registerProcessor('deck-processor', DeckProcessor);
}
if (typeof module !== 'undefined') module.exports = { DeckDSP };
