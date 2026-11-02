'use strict';
// DJ controllers over Web MIDI (Chrome / Edge on a secure page such as http://localhost).
//
// Pioneer's DDJ controllers share one message scheme, so the DDJ-FLX4 and DDJ-1000 use
// the same handler with small per-model differences. The message numbers follow Pioneer's
// published MIDI lists as documented by the open Mixxx mappings. Any other controller (or
// any control a preset misses) can be taught with MIDI learn; learned bindings win.
//
//   notes  0x90+ch  play 0B, cue 0C, sync 58, jog touch 36, loop in 10 / out 11, exit 4D ...
//   CCs    0xB0+ch  jog 21/22/23, tempo 00+20, volume 13+33, trim 04+24, EQ 07/0B/0F (+20)
//   pads   0x97+2*deck (+1 with shift); the pad's bank says which mode the hardware is in
//   mixer  0xB6     filter 17.., crossfader 1F+3F, master 08+28, browse 40
//   beat FX 0x94    on 47, beat 4A/4B, select 63, level 0xB4 02

const MIDI_STEMS = ['vocals', 'other', 'bass', 'drums'];
const PAD_BANKS = { 0x00: 'hot', 0x60: 'loop', 0x20: 'jump', 0x10: 'roll', 0x40: 'stems' };
const MODE_BANK = { hot: 0x00, loop: 0x60, jump: 0x20, roll: 0x10 };
const MODE_BUTTONS = { 0x1B: 'hot', 0x6D: 'loop', 0x20: 'jump', 0x1E: 'roll' };
const FLX4_KEEPALIVE = [0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xF7];

const PRESETS = [
  // Jog resolution in ticks per platter turn, as used by the Mixxx mappings.
  { match: /FLX4/i, name: 'Pioneer DDJ-FLX4', ticksPerTurn: 720, keepAlive: FLX4_KEEPALIVE },
  { match: /DDJ-?1000/i, name: 'Pioneer DDJ-1000', ticksPerTurn: 2048 },
  { match: /DDJ-?(400|800|SX|SR|RB|REV)/i, name: 'Pioneer DDJ (generic)', ticksPerTurn: 1024 },
];

const midi = {
  access: null, outputs: [], preset: null, learned: {}, learnTarget: null, learning: false,
  hi: {}, lit: new Map(), log: [], keepTimer: null,

  get supported() { return !!navigator.requestMIDIAccess && window.isSecureContext; },

  async connect(quiet) {
    if (!this.supported) return this.status(navigator.requestMIDIAccess
      ? 'MIDI needs a secure page: open http://localhost:8765 on the computer running the helper.'
      : "This browser can't use MIDI controllers. Use Chrome or Edge on a computer (iPad browsers can't).");
    try {
      // SysEx lets the FLX4 keep-alive through; fall back without it if refused.
      this.access = await navigator.requestMIDIAccess({ sysex: true }).catch(() => navigator.requestMIDIAccess());
    } catch (e) {
      return this.status(quiet ? 'Not connected.' : `MIDI access was refused (${e.message || e.name}).`);
    }
    store.set('midi', 'on');
    this.access.onstatechange = () => this.bind();
    this.bind();
  },

  bind() {
    const ins = [...this.access.inputs.values()];
    this.outputs = [...this.access.outputs.values()];
    for (const i of ins) i.onmidimessage = e => this.receive(e.data);
    const names = ins.map(i => i.name);
    this.preset = PRESETS.find(p => names.some(n => p.match.test(n))) || null;
    clearInterval(this.keepTimer); this.keepTimer = null;
    if (this.preset?.keepAlive && this.access.sysexEnabled) this.keepTimer = setInterval(() => this.send(this.preset.keepAlive), 200);
    this.lit.clear();
    this.status(!ins.length ? 'Connected, but no controller is plugged in.'
      : `${names.join(', ')}${this.preset ? ` (using the ${this.preset.name} mapping)` : ' (no built-in mapping: use MIDI learn)'}.`);
  },

  status(msg) { $('#midiStatus').textContent = msg; },

  send(bytes) { for (const o of this.outputs) { try { o.send(bytes); } catch {} } },

  receive(data) {
    const [st, d1 = 0, d2 = 0] = data;
    if (st >= 0xF0) return;                                  // clock, sysex replies
    const type = st & 0xF0, ch = st & 0x0F;
    const on = type === 0x90 && d2 > 0;
    // Note-off arrives as 0x80 or as a note-on with velocity 0: treat both as the note's release.
    const kind = type === 0x80 ? 0x90 : type;
    const key = `${kind}:${ch}:${d1}`;
    if (this.learning && this.learnTarget && (on || type === 0xB0)) return this.learn(key, data);
    const binding = this.learned[key];
    const action = binding ? this.runLearned(binding, kind, d2) : this.preset ? this.pioneer(type === 0x80 ? 0x90 | ch : st, d1, type === 0x80 ? 0 : d2) : '';
    this.monitor(data, action || (binding ? 'learned' : ''));
  },

  monitor(data, what) {
    const hex = [...data].slice(0, 3).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    this.log.unshift(`${hex}  ${what || '·'}`); this.log.length = Math.min(this.log.length, 8);
    const el = $('#midiMonitor'); if (el && $('#settings').open) el.textContent = this.log.join('\n');
  },

  // ---------- the Pioneer DDJ scheme ----------
  deckOf(ch) { return decks[ch % 2 ? 'B' : 'A']; },
  // 14-bit controls: MSB on n, LSB on n+0x20. Act on the MSB at once, refine on the LSB.
  fine(key, d1, d2, apply) {
    if (d1 < 0x20) { this.hi[key + d1] = d2; apply((d2 << 7) / 16383); } else {
      const m = this.hi[key + (d1 - 0x20)]; if (m != null) apply(((m << 7) | d2) / 16383);
    }
  },
  knob(k, f) { k.set(k.fromPos(f)); },
  fader(el, f) { el.value = +el.min + f * (+el.max - +el.min); el.dispatchEvent(new Event('input', { bubbles: true })); },

  pioneer(st, d1, d2) {
    const type = st & 0xF0, ch = st & 0x0F, on = d2 > 0;
    if (st >= 0x97 && st <= 0x9E) return this.pad(st, d1, on);
    if (type === 0x90 && ch <= 3) return this.deckNote(this.deckOf(ch), d1, on);
    if (type === 0xB0 && ch <= 3) return this.deckCC(this.deckOf(ch), ch, d1, d2);
    if (st === 0xB6) return this.mixerCC(d1, d2);
    if (st === 0x96 && on) {
      if (d1 === 0x46 || d1 === 0x47) { this.loadSelected(d1 === 0x46 ? 'A' : 'B'); return `load deck ${d1 === 0x46 ? 1 : 2}`; }
      return '';
    }
    if (st === 0x94 || st === 0x95) return this.fxNote(d1, on);
    if (st === 0xB4 && (d1 === 0x02 || d1 === 0x22)) { this.fine('fx', d1, d2, f => this.knob(fx[0].level, f)); return 'FX level'; }
    return '';
  },

  deckNote(d, n, on) {
    const press = fn => { if (on) fn(); };
    switch (n) {
      case 0x0B: press(() => d.togglePlay()); return 'play';
      case 0x0C: on ? d.cueDown() : d.cueUp(); return 'cue';
      case 0x58: press(() => (d.synced ? d.unsync() : d.sync())); return 'sync';
      case 0x5C: press(() => d.makeMaster()); return 'master';
      case 0x36: d.jogTouch(on); return on ? 'jog touch' : 'jog release';
      case 0x10: press(() => { if (!d.loop && d.manualIn == null) d.manualLoop(); }); return 'loop in';
      case 0x11: press(() => { if (!d.loop && d.manualIn != null) d.manualLoop(); }); return 'loop out';
      case 0x4D: press(() => (d.loop ? d.exitLoop() : d.beatLoop(d.loopBeats))); return 'reloop / exit';
      case 0x14: press(() => (d.loop ? d.exitLoop() : d.beatLoop(4))); return '4-beat loop';
      case 0x12: case 0x51: press(() => d.resizeLoop(0.5)); return 'loop ½';
      case 0x13: case 0x53: press(() => d.resizeLoop(2)); return 'loop ×2';
      case 0x1A: press(() => d.ui.mt.click()); return 'key lock';
      case 0x68: press(() => d.ui.quant.click()); return 'quantize';
      case 0x54: press(() => phones.toggleCue(d.letter)); return 'headphone cue';
      default:
        if (n in MODE_BUTTONS) { press(() => this.setMode(d, MODE_BUTTONS[n])); return `pad mode ${MODE_BUTTONS[n]}`; }
        return '';
    }
  },

  setMode(d, mode) { d.mode = mode; $('.pad-mode', d.root).value = mode; d.renderPads(); },

  pad(st, d1, on) {
    const off = st - 0x97, d = decks[(off >> 1) % 2 ? 'B' : 'A'], shift = off & 1;
    const bank = d1 & 0xF0, i = d1 & 0x07, mode = PAD_BANKS[bank];
    if (!mode) return '';
    if (mode === 'stems') { if (on && !shift) d.toggleStem(MIDI_STEMS[i & 3]); return `stem ${MIDI_STEMS[i & 3]}`; }
    if (d.mode !== mode) this.setMode(d, mode);
    if (mode === 'hot' && shift) { if (on && d.hot[i] != null) { d.hot[i] = null; d.renderPads(); } return `clear hot cue ${i + 1}`; }
    on ? d.padDown(i) : d.padUp(i);
    return `${mode} pad ${i + 1}`;
  },

  deckCC(d, ch, n, v) {
    const L = d.letter, k = mixer.channels[L].knobs, t = this.preset?.ticksPerTurn || 1024, rel = v - 64;
    switch (n) {
      case 0x22: d.jogTurn(rel / t, true); return 'jog scratch';
      case 0x21: case 0x23: d.jogTurn(rel / t, false); return 'jog bend';
      case 0x29: d.jogTurn(rel * 8 / t, false); return 'jog search';
      case 0x00: case 0x20:
        // Pioneer tempo faders read 0 at the top, which is the slow end.
        this.fine(`tempo${ch}`, n, v, f => { d.setTempo((f * 2 - 1) * 8); d.synced = false; d.renderSync(); });
        return 'tempo';
      case 0x13: case 0x33: this.fine(`vol${ch}`, n, v, f => this.fader(mixer.channels[L].fader, f)); return 'channel fader';
      case 0x04: case 0x24: this.fine(`trim${ch}`, n, v, f => this.knob(k.trim, f)); return 'trim';
      case 0x07: case 0x27: this.fine(`hi${ch}`, n, v, f => this.knob(k.high, f)); return 'EQ high';
      case 0x0B: case 0x2B: this.fine(`mid${ch}`, n, v, f => this.knob(k.mid, f)); return 'EQ mid';
      case 0x0F: case 0x2F: this.fine(`low${ch}`, n, v, f => this.knob(k.low, f)); return 'EQ low';
      default: return '';
    }
  },

  mixerCC(n, v) {
    if ((n >= 0x17 && n <= 0x1A) || (n >= 0x37 && n <= 0x3A)) {
      const ch = (n & 0x1F) - 0x17;
      this.fine(`cfx${ch}`, n, v, f => this.knob(mixer.channels[ch % 2 ? 'B' : 'A'].knobs.cfx, f));
      return 'filter / color FX';
    }
    if (n === 0x1F || n === 0x3F) { this.fine('xf', n, v, f => this.fader($('#xfader'), f)); return 'crossfader'; }
    if (n === 0x08 || n === 0x28) { this.fine('master', n, v, f => this.knob(knobs.master, f)); return 'master'; }
    if (n === 0x0C || n === 0x2C) { this.fine('hpmix', n, v, f => this.knob(phones.mixKnob, f)); return 'headphones mix'; }
    if (n === 0x0D || n === 0x2D) { this.fine('hplvl', n, v, f => this.knob(phones.levelKnob, f)); return 'headphones level'; }
    if (n === 0x40) { this.browse(v > 64 ? v - 128 : v); return 'browse'; }
    return '';
  },

  fxNote(n, on) {
    const u = fx[0];
    if (n === 0x47) {
      // Brake and back spin are held; the other effects toggle.
      if (u.kind === 'deck') { if (on !== u.on) u.toggle(); } else if (on) u.toggle();
      return 'beat FX on/off';
    }
    if (!on) return '';
    if (n === 0x4A || n === 0x4B) { u.beatIx = clamp(u.beatIx + (n === 0x4B ? 1 : -1), 0, FX_BEATS.length - 1); u.renderBeat(); u.retime(true); return 'beat FX length'; }
    if (n === 0x63 || n === 0x64) {
      const sel = $('select', u.root), opts = [...sel.options];
      sel.selectedIndex = (sel.selectedIndex + (n === 0x63 ? 1 : opts.length - 1)) % opts.length;
      sel.dispatchEvent(new Event('change')); return 'beat FX select';
    }
    if (n >= 0x10 && n <= 0x14) {
      const which = n === 0x10 ? 'A' : n === 0x11 ? 'B' : n === 0x14 ? 'M' : null;
      if (which) $$('[data-assign]', u.root).forEach(b => { if (u.assign[b.dataset.assign] !== (b.dataset.assign === which)) b.click(); });
      return 'beat FX channel';
    }
    return '';
  },

  // The browse knob walks the track list; LOAD puts the highlighted track on a deck.
  selected: -1,
  browse(steps) {
    const rows = $$('#list li[data-id]'); if (!rows.length) return;
    this.selected = clamp((this.selected < 0 ? -1 : this.selected) + Math.sign(steps), 0, rows.length - 1);
    rows.forEach((r, i) => r.classList.toggle('midi-sel', i === this.selected));
    rows[this.selected].scrollIntoView({ block: 'nearest' });
  },
  loadSelected(L) {
    const rows = $$('#list li[data-id]'), row = rows[this.selected] || rows[0];
    $(`.load.${L.toLowerCase()}`, row || document.createElement('div'))?.click();
  },

  // ---------- lights ----------
  lights() {
    if (!this.preset || !this.outputs.length) return;
    const want = new Map();
    ['A', 'B'].forEach((L, ch) => {
      const d = decks[L], loaded = !!d.track;
      const set = (st, n, on) => want.set(`${st}:${n}`, on ? 0x7F : 0);
      set(0x90 + ch, 0x0B, loaded && !d.el.paused);
      set(0x90 + ch, 0x0C, loaded && d.el.paused);
      set(0x90 + ch, 0x58, d.synced);
      set(0x90 + ch, 0x54, !!d.cueOn);
      set(0x90 + ch, 0x10, !!d.loop || d.manualIn != null);
      set(0x90 + ch, 0x11, !!d.loop);
      set(0x90 + ch, 0x4D, !!d.loop);
      const pads = 0x97 + 2 * ch, bank = MODE_BANK[d.mode] ?? 0;
      for (let i = 0; i < 8; i++) {
        const lit = d.mode === 'hot' ? d.hot[i] != null : d.mode === 'loop' ? d.loop?.beats === PAD_LOOPS[i] && !d.loop.roll : loaded;
        for (const b of Object.values(MODE_BANK)) set(pads, b + i, b === bank && lit);
      }
    });
    want.set(`${0x94}:${0x47}`, fx[0].on ? 0x7F : 0);
    for (const [k, v] of want) {
      if (this.lit.get(k) === v) continue;
      this.lit.set(k, v);
      const [st, n] = k.split(':').map(Number);
      this.send([st, n, v]);
    }
  },

  // ---------- MIDI learn ----------
  startLearn() {
    $('#settings').close();
    this.learning = true; document.body.classList.add('midi-learning');
    const bar = document.createElement('div'); bar.className = 'midi-learn-bar';
    bar.innerHTML = '<span>MIDI learn: click a control on screen, then move or press it on your controller.</span><button class="btn">Done</button>';
    bar.querySelector('button').addEventListener('click', () => this.stopLearn());
    document.body.append(bar); this.bar = bar;
    this.onPick = e => {
      if (bar.contains(e.target)) return;
      const el = e.target.closest('button, input[type=range], .knob');
      if (!el) return;
      e.preventDefault(); e.stopPropagation();
      $$('.midi-target').forEach(x => x.classList.remove('midi-target'));
      el.classList.add('midi-target'); this.learnTarget = el;
      flash('Now move or press the control on your controller.');
    };
    document.addEventListener('pointerdown', this.onPick, true);
    document.addEventListener('click', this.onPick, true);
    document.addEventListener('keydown', this.onEsc = e => { if (e.key === 'Escape') this.stopLearn(); });
  },
  stopLearn() {
    this.learning = false; this.learnTarget = null; document.body.classList.remove('midi-learning');
    $$('.midi-target').forEach(x => x.classList.remove('midi-target'));
    document.removeEventListener('pointerdown', this.onPick, true);
    document.removeEventListener('click', this.onPick, true);
    document.removeEventListener('keydown', this.onEsc);
    this.bar?.remove();
  },
  learn(key, data) {
    const el = this.learnTarget, kind = el.matches('.knob') ? 'knob' : el.matches('input') ? 'range' : 'button';
    this.learned[key] = { path: cssPath(el), kind };
    store.set('midiMap', JSON.stringify(this.learned));
    el.classList.remove('midi-target'); this.learnTarget = null;
    this.monitor(data, `learned → ${el.getAttribute('aria-label') || el.title || el.textContent.trim().slice(0, 16) || kind}`);
    flash('Learned. Click another control, or press Done.');
  },
  runLearned(b, kind, v) {
    const el = document.querySelector(b.path); if (!el) return 'learned (control missing)';
    if (b.kind === 'knob') this.knob(el._knob, v / 127);
    else if (b.kind === 'range') this.fader(el, v / 127);
    else {
      const down = kind === 0x90 ? v > 0 : v >= 64, init = { bubbles: true, pointerId: 9001, isPrimary: true };
      if (down) { el.dispatchEvent(new PointerEvent('pointerdown', init)); el.click(); } else el.dispatchEvent(new PointerEvent('pointerup', init));
    }
    return 'learned';
  },
};

// A selector that finds the same control after a reload (the layout is static).
function cssPath(el) {
  const parts = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
    const i = [...n.parentElement.children].indexOf(n) + 1;
    parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i})`);
  }
  return parts.join(' > ');
}

try { midi.learned = JSON.parse(store.get('midiMap') || '{}'); } catch { midi.learned = {}; }
$('#midiConnect').addEventListener('click', () => midi.connect());
$('#midiLearn').addEventListener('click', () => (midi.access ? midi.startLearn() : midi.connect().then(() => midi.access && midi.startLearn())));
$('#midiClear').addEventListener('click', () => { midi.learned = {}; store.set('midiMap', '{}'); flash('Learned controls cleared.'); });
if (!midi.supported) midi.status(navigator.requestMIDIAccess ? 'Open http://localhost:8765 on the helper computer to use a controller.' : "This browser can't use MIDI controllers.");
else if (store.get('midi') === 'on') midi.connect(true);
setInterval(() => midi.lights(), 100);
