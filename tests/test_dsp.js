// Deck playback core tests: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DeckDSP } = require('../web/deck-dsp.js');

const SR = 48000;

function tone(freq, secs, amp = 0.5) {
  const n = Math.floor(secs * SR), d = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) d[i * 2] = d[i * 2 + 1] = Math.round(Math.sin(2 * Math.PI * freq * i / SR) * amp * 32767);
  return d;
}

function deck(stems, secs) {
  const dsp = new DeckDSP(SR);
  dsp.handle({ type: 'load', stems, length: Math.floor(secs * SR) });
  return dsp;
}

function render(dsp, secs, block = 128) {
  const n = Math.floor(secs * SR), L = new Float32Array(n), R = new Float32Array(n);
  for (let o = 0; o < n; o += block) {
    const m = Math.min(block, n - o);
    dsp.process(L.subarray(o, o + m), R.subarray(o, o + m), m);
  }
  return L;
}

// Dominant frequency from zero crossings (fine for a pure tone).
function freqOf(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++;
  return c / 2 / (x.length / SR);
}

test('plays at normal speed and pitch', () => {
  const dsp = deck([{ name: 'mix', data: tone(440, 3) }], 3);
  dsp.handle({ type: 'set', playing: true, rate: 1 });
  const out = render(dsp, 1);
  assert.ok(Math.abs(freqOf(out.subarray(4800)) - 440) < 3);
  assert.ok(Math.abs(dsp.pos / SR - 1) < 0.01);
});

test('varispeed (key lock off) raises pitch with tempo', () => {
  const dsp = deck([{ name: 'mix', data: tone(440, 3) }], 3);
  dsp.handle({ type: 'set', playing: true, rate: 1.06, keylock: false });
  const out = render(dsp, 1);
  assert.ok(Math.abs(freqOf(out.subarray(4800)) - 466.4) < 4);
  assert.ok(Math.abs(dsp.pos / SR - 1.06) < 0.01);
});

for (const block of [128, 2048]) {
  test(`key lock keeps pitch while the tempo changes (block ${block})`, () => {
    const dsp = deck([{ name: 'mix', data: tone(440, 4) }], 4);
    dsp.handle({ type: 'set', playing: true, rate: 1.06, keylock: true });
    const out = render(dsp, 2, block);
    assert.ok(Math.abs(freqOf(out.subarray(9600)) - 440) < 4, `freq ${freqOf(out.subarray(9600))}`);
    // Position still advances at the faster tempo.
    assert.ok(Math.abs(dsp.pos / SR - 2 * 1.06) < 0.05, `pos ${dsp.pos / SR}`);
    // No dropouts: the stretched output stays near full level throughout.
    let min = Infinity;
    for (let o = 9600; o + 960 < out.length; o += 960) {
      let p = 0; for (let i = o; i < o + 960; i++) p = Math.max(p, Math.abs(out[i]));
      min = Math.min(min, p);
    }
    assert.ok(min > 0.4, `quietest window peak ${min}`);
  });
}

test('loops wrap at the exact sample', () => {
  const d = new Int16Array(SR * 4 * 2);
  for (let i = 0; i < SR * 4; i++) d[i * 2] = d[i * 2 + 1] = Math.min(32767, i);  // a ramp: value = frame index
  const dsp = deck([{ name: 'mix', data: d }], 4);
  dsp.handle({ type: 'seek', pos: 0.1 });
  dsp.handle({ type: 'set', playing: true, rate: 1, loop: { start: 0.1, end: 0.2 } });
  render(dsp, 0.5);
  assert.ok(dsp.pos >= 0.1 * SR && dsp.pos < 0.2 * SR, `pos ${dsp.pos / SR}`);
});

test('scratch follows the jog target forwards and backwards, then resumes', () => {
  const dsp = deck([{ name: 'mix', data: tone(440, 10) }], 10);
  dsp.handle({ type: 'seek', pos: 5 });
  dsp.handle({ type: 'set', playing: true, rate: 1 });
  dsp.handle({ type: 'scratch', on: true, target: 4.2 });
  render(dsp, 0.4);
  assert.ok(Math.abs(dsp.pos / SR - 4.2) < 0.01, `backward ${dsp.pos / SR}`);
  dsp.handle({ type: 'scratch', on: true, target: 4.9 });
  render(dsp, 0.4);
  assert.ok(Math.abs(dsp.pos / SR - 4.9) < 0.01, `forward ${dsp.pos / SR}`);
  dsp.handle({ type: 'scratch', on: false, playing: true });
  render(dsp, 0.5);
  assert.ok(Math.abs(dsp.pos / SR - 5.4) < 0.02, `resumed ${dsp.pos / SR}`);
});

test('stem gains mute and unmute without clicks', () => {
  const dsp = deck([{ name: 'vocals', data: tone(440, 3) }, { name: 'drums', data: tone(880, 3) }], 3);
  dsp.handle({ type: 'set', playing: true, rate: 1, gains: { vocals: 0 } });
  render(dsp, 0.1);
  const out = render(dsp, 0.5);
  assert.ok(Math.abs(freqOf(out) - 880) < 5, 'only the drums stem plays');
  let jump = 0;
  dsp.handle({ type: 'set', gains: { vocals: 1 } });
  const after = render(dsp, 0.1);
  for (let i = 1; i < after.length; i++) jump = Math.max(jump, Math.abs(after[i] - after[i - 1]));
  assert.ok(jump < 0.3, `largest step ${jump}`);
});

test('stem offset lines stems up with the mix timeline', () => {
  const d = new Int16Array(SR * 2 * 2);
  for (let i = 0; i < SR * 2; i++) d[i * 2] = d[i * 2 + 1] = Math.min(32767, i);
  const dsp = deck([{ name: 'vocals', data: d }], 2);
  dsp.handle({ type: 'load', stems: [{ name: 'vocals', data: d }], length: SR * 2, offset: 100 });
  const t = [0, 0];
  dsp.frame(1000, t);
  assert.ok(Math.abs(t[0] * 32768 - 1100) < 1);
});

test('reaching the end stops and reports ended', () => {
  const dsp = deck([{ name: 'mix', data: tone(440, 0.5) }], 0.5);
  dsp.handle({ type: 'set', playing: true, rate: 1 });
  render(dsp, 1);
  assert.strictEqual(dsp.playing, false);
  assert.strictEqual(dsp.state().ended, true);
});
