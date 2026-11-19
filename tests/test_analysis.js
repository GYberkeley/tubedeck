// Track analysis tests: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectKey } = require('../web/analysis.js');

const SR = 22050;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiHz = n => 440 * 2 ** ((n - 69) / 12);

// A chord progression with a bass note and harmonic-rich voices, 2 s per chord.
function progression(chords) {
  const per = 2 * SR, x = new Float32Array(per * chords.length);
  chords.forEach((notes, c) => {
    for (const [j, n] of notes.entries()) {
      const f = midiHz(n), amp = j === 0 ? 0.25 : 0.15;
      for (let i = 0; i < per; i++) {
        const t = i / SR, env = Math.min(1, i / 400) * Math.exp(-t * 0.6);
        let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
        x[c * per + i] += v * amp * env;
      }
    }
  });
  return { sampleRate: SR, numberOfChannels: 1, getChannelData: () => x };
}
// Triads from a root (MIDI note), major or minor, with the root an octave down as bass.
const tri = (root, minor) => [root - 12, root, root + (minor ? 3 : 4), root + 7];

const cases = [
  ['A minor', 9, 'min', [tri(57, 1), tri(62, 1), tri(64, 1), tri(57, 1), tri(53, 0), tri(55, 0), tri(57, 1), tri(64, 0)]],
  ['C major', 0, 'maj', [tri(60, 0), tri(65, 0), tri(67, 0), tri(60, 0), tri(57, 1), tri(62, 1), tri(67, 0), tri(60, 0)]],
  ['F# minor', 6, 'min', [tri(54, 1), tri(59, 1), tri(61, 1), tri(54, 1), tri(50, 0), tri(52, 0), tri(61, 0), tri(54, 1)]],
  ['Eb major', 3, 'maj', [tri(63, 0), tri(56, 0), tri(58, 0), tri(63, 0), tri(60, 1), tri(65, 1), tri(58, 0), tri(63, 0)]],
];
for (const [name, tonic, mode, chords] of cases) {
  test(`detects ${name}`, () => {
    const k = detectKey(progression(chords));
    assert.strictEqual(`${NAMES[k.tonic]} ${k.mode}`, `${NAMES[tonic]} ${mode}`);
  });
}

test('every transposition of a progression is detected in its own key', () => {
  for (let shift = 0; shift < 12; shift++) {
    const k = detectKey(progression([tri(57, 1), tri(62, 1), tri(64, 1), tri(57, 1)].map(ch => ch.map(n => n + shift))));
    assert.strictEqual(`${NAMES[k.tonic]} ${k.mode}`, `${NAMES[(9 + shift) % 12]} min`, `shift ${shift}`);
  }
});
