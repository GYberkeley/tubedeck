'use strict';
// Track analysis, shared by the page and a background worker so long passes never
// block the audio callback: rekordbox-style 3-band waveform, tempo + beat phase,
// Int16 conversion for the deck engine, and stem/mix alignment.

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


// Interleaved Int16 stereo for the deck engine (half the memory of Float32).
function toInt16(ch0, ch1) {
  const n = ch0.length, out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(ch0[i] * 32767)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(ch1[i] * 32767)));
  }
  return out;
}

// Mono copy of the first seconds, used to line stems up with the mix.
const REF_SECONDS = 12;
function monoRef(ch0, ch1, sr) {
  const n = Math.min(ch0.length, Math.floor(sr * REF_SECONDS)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
  return out;
}

// Offset (in frames) to add to a mix-timeline frame to find the same audio in the
// stems. MP3 encoding pads the start, so the stems usually run a little late.
function alignOffset(mix, stems, maxLag = 4096) {
  const n = Math.min(mix.length, stems.length) - maxLag, dec = 4;
  let best = 0, bestScore = -Infinity;
  const score = lag => {
    let s = 0;
    for (let i = maxLag; i < n; i += dec) s += mix[i] * stems[i + lag];
    return s;
  };
  for (let lag = -maxLag; lag <= maxLag; lag += dec) { const s = score(lag); if (s > bestScore) { bestScore = s; best = lag; } }
  for (let lag = best - dec; lag <= best + dec; lag++) { const s = score(lag); if (s > bestScore) { bestScore = s; best = lag; } }
  return best;
}

const asBuffer = (ch0, ch1, sr) => ({ sampleRate: sr, numberOfChannels: 2, getChannelData: i => (i ? ch1 : ch0) });

if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
  self.onmessage = ({ data: m }) => {
    const { ch0, ch1, sr } = m, out = { id: m.id };
    if (m.type === 'analyze') {
      const buf = asBuffer(ch0, ch1, sr);
      out.wave = waveform(buf);
      Object.assign(out, detectBeats(buf));
    }
    if (m.type === 'analyze' || m.type === 'pcm') {
      out.pcm = toInt16(ch0, ch1);
      out.ref = monoRef(ch0, ch1, sr);
      const t = [out.pcm.buffer, out.ref.buffer];
      if (out.wave) t.push(out.wave.low.buffer, out.wave.mid.buffer, out.wave.high.buffer);
      self.postMessage(out, t);
      return;
    }
    if (m.type === 'align') { out.offset = alignOffset(m.mix, m.stems); self.postMessage(out); }
  };
}
