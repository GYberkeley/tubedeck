'use strict';
// Controller test: a checklist of every control on the connected DDJ that lights up as
// it is used, a list of messages tubedeck didn't handle, and two measurements (jog
// ticks per turn, tempo fader direction) to tune the mapping. Results copy as JSON.

const CT_DECK = [
  ['play', 'PLAY'], ['cue', 'CUE'], ['sync', 'BEAT SYNC'], ['shift', 'SHIFT'], ['jog touch', 'Jog: touch top'],
  ['jog scratch', 'Jog: turn while touching'], ['jog bend', 'Jog: turn the rim'], ['tempo', 'Tempo fader'],
  ['loop in', 'LOOP IN'], ['loop out', 'LOOP OUT'], ['reloop / exit', 'RELOOP / EXIT'], ['loop ½', 'Loop ½ / CUE CALL ◀'], ['loop ×2', 'Loop ×2 / CUE CALL ▶'],
  ['pad mode hot', 'HOT CUE mode'], ['pad mode loop', 'BEAT LOOP mode'], ['pad mode jump', 'BEAT JUMP mode'], ['pad mode sampler', 'SAMPLER mode'],
  [/^((hot|loop|jump|roll) pad|sample \d|stop sample|key shift|clear hot cue|stem )/, 'Pads'], ['jump to start', 'SHIFT + CUE'], ['censor (slip reverse)', 'SHIFT + PLAY (censor)'],
  ['channel fader', 'Channel fader'], ['trim', 'TRIM'], ['EQ high', 'EQ HI'], ['EQ mid', 'EQ MID'], ['EQ low', 'EQ LOW'],
  ['filter / color FX', 'FILTER / COLOR FX'], ['headphone cue', 'Headphone CUE'],
];
const CT_EXTRA = {
  flx4: { deck: [['master', 'SHIFT + SYNC hold (MASTER)'], ['tempo range', 'SHIFT + SYNC'], ['pad mode key', 'KEY SHIFT mode'], ['jump back 32 beats', 'SHIFT + CUE CALL ◀'], ['quantize', 'SHIFT + CUE (channel)']],
    mixer: [['waveform zoom', 'SHIFT + BROWSE turn']] },
  1000: { deck: [['key lock', 'KEY LOCK'], ['quantize', 'QUANTIZE'], ['slip', 'SLIP'], ['key sync', 'KEY SYNC'], ['key reset', 'KEY RESET'],
      ['4-beat loop', '4 BEAT LOOP'], ['sampler bank', 'Sampler bank (shift + pad mode)'], ['search back', 'SEARCH ◀'], ['search forward', 'SEARCH ▶'], ['reverse', 'REV'],
      [/^crossfader assign/, 'Crossfader assign switch'], [/^beat jump size/, 'BEAT JUMP size'], ['beat grid slide', 'SHIFT + jog (grid)']],
    mixer: [['sampler volume', 'SAMPLER VOL'], [/^beat FX: /, 'Beat FX selector'], ['browse (fast)', 'SHIFT + BROWSE turn'], ['view: FX panel', 'VIEW']] },
  generic: { deck: [], mixer: [] },
};
const CT_MIXER = [
  ['crossfader', 'Crossfader'], ['master', 'MASTER level'], ['headphones mix', 'HEADPHONES MIX'], ['headphones level', 'HEADPHONES LEVEL'],
  ['browse', 'BROWSE turn'], [/^browser: /, 'BROWSE press / BACK'], ['load deck 1', 'LOAD 1'], ['load deck 2', 'LOAD 2'],
  ['beat FX on/off', 'BEAT FX ON/OFF'], ['beat FX length', 'BEAT ◀ ▶'], ['beat FX select', 'BEAT FX SELECT'], ['beat FX channel', 'BEAT FX CH SELECT'],
  ['FX level', 'LEVEL / DEPTH'], ['all FX off', 'SHIFT + BEAT FX ON/OFF'],
];

// Controls a model doesn't send over MIDI (handled in hardware, or folded into other messages).
const CT_SKIP = {
  flx4: ['master', 'headphones level'],
  1000: ['shift', 'pad mode hot', 'pad mode loop', 'pad mode jump', 'pad mode sampler', 'beat FX select', 'all FX off'],
  generic: [],
};

const ctlTest = {
  open: false, seen: new Set(), unmapped: new Map(), jog: {}, tempo: {},
  model() { return midi.preset?.model || 'generic'; },
  decks() { return this.model() === '1000' ? 4 : 2; },
  items() {
    const x = CT_EXTRA[this.model()], skip = CT_SKIP[this.model()], out = [];
    for (let n = 1; n <= this.decks(); n++) for (const [m, label] of [...CT_DECK, ...x.deck]) if (!skip.includes(m)) out.push({ group: `Deck ${n}`, key: `${n}|${m}`, m, deck: n, label });
    for (const [m, label] of [...CT_MIXER, ...x.mixer]) if (!skip.includes(m)) out.push({ group: 'Mixer, FX and browser', key: `0|${m}`, m, deck: 0, label });
    return out;
  },
  // Which deck (1-4) a message belongs to, or 0 for the mixer.
  deckOf(st, d1) {
    const type = st & 0xF0, ch = st & 0x0F;
    if ((type === 0x90 || type === 0xB0) && ch <= 3) return ch + 1;
    if (st >= 0x97 && st <= 0x9E) return ((st - 0x97) >> 1) + 1;
    if (st === 0xB6 && ((d1 >= 0x17 && d1 <= 0x1A) || (d1 >= 0x37 && d1 <= 0x3A))) return (d1 & 0x1F) - 0x17 + 1;
    return 0;
  },
  record(data, action) {
    if (!this.open) return;
    const [st, d1 = 0, d2 = 0] = data;
    if (st === 0xF0) return;
    const deck = this.deckOf(st, d1);
    const release = ((st & 0xF0) === 0x90 && d2 === 0) || (st & 0xF0) === 0x80;
    if (!action && !release) {
      const k = [st, d1].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1);
    } else {
      for (const it of this.items()) {
        const hit = typeof it.m === 'string' ? action === it.m || action.startsWith(it.m) : it.m.test(action);
        if (hit && it.deck === deck) this.seen.add(it.key);
      }
    }
    // Measurements: jog ticks per touch, tempo fader readings.
    const j = this.jog[deck] || (this.jog[deck] = { ticks: 0, last: null });
    if ((st & 0xF0) === 0x90 && d1 === 0x36) { if (d2) j.ticks = 0; else j.last = j.ticks; }
    if ((st & 0xF0) === 0xB0 && d1 === 0x22) j.ticks += d2 - 64;
    if ((st & 0xF0) === 0xB0 && (d1 === 0x00 || d1 === 0x20) && deck) this.tempo[deck] = { raw: d2, msb: d1 === 0x00, tempo: decks[deck % 2 ? 'A' : 'B'].tempo };
    this.render();
  },
  render() {
    if (!this.open) return;
    const items = this.items(), groups = [...new Set(items.map(i => i.group))], done = items.filter(i => this.seen.has(i.key)).length;
    $('#ctProgress').textContent = `${done} of ${items.length} controls tested (${midi.preset ? midi.preset.name : 'no built-in mapping'}).`;
    $('#ctGrid').innerHTML = groups.map(g => `<section><h3>${g}</h3><div class="ct-chips">${items.filter(i => i.group === g)
      .map(i => `<span class="ct-chip${this.seen.has(i.key) ? ' ok' : ''}">${escapeHtml(i.label)}</span>`).join('')}</div></section>`).join('');
    const tpt = midi.preset?.ticksPerTurn || 1024;
    $('#ctMeasure').innerHTML = Object.entries(this.jog).filter(([d]) => +d).map(([d, j]) =>
      `<li>Deck ${d} jog: ${j.last == null ? `turning, ${j.ticks} ticks so far` : `last touch ${Math.abs(j.last)} ticks = ${(Math.abs(j.last) / tpt).toFixed(2)} turns at the current setting (${tpt} per turn)`}</li>`).join('')
      + Object.entries(this.tempo).map(([d, t]) => `<li>Deck ${d} tempo fader: reading ${t.raw}${t.msb ? '' : ' (fine)'} → ${t.tempo > 0 ? '+' : ''}${t.tempo.toFixed(1)}%</li>`).join('');
    const un = [...this.unmapped].map(([k, n]) => `${k} ×${n}`);
    $('#ctUnmapped').textContent = un.length ? un.join(', ') : 'None so far.';
  },
  report() {
    const items = this.items();
    return JSON.stringify({
      controller: midi.preset?.name || null, ports: midi.access ? [...midi.access.inputs.values()].map(i => i.name) : [],
      tested: items.filter(i => this.seen.has(i.key)).map(i => `${i.group}: ${i.label}`),
      notTested: items.filter(i => !this.seen.has(i.key)).map(i => `${i.group}: ${i.label}`),
      unmapped: Object.fromEntries(this.unmapped), jog: this.jog, tempo: this.tempo, ticksPerTurn: midi.preset?.ticksPerTurn,
      jogScreens: { state: jogScreens.state, log: jogScreens.log },
    }, null, 2);
  },
  show() {
    this.open = true; $('#settings').close(); $('#ctlTest').showModal(); this.render();
  },
  reset() { this.seen.clear(); this.unmapped.clear(); this.jog = {}; this.tempo = {}; this.render(); },
};
$('#ctOpen').addEventListener('click', () => ctlTest.show());
$('#ctReset').addEventListener('click', () => ctlTest.reset());
$('#ctCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ctlTest.report()); flash('Controller test results copied.'); }
  catch { $('#ctReport').value = ctlTest.report(); $('#ctReport').hidden = false; $('#ctReport').select(); }
});
$('#ctlTest').addEventListener('close', () => { ctlTest.open = false; });
