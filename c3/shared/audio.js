// Shared audio for the score brush: the ribbon's five staff lines (plus the
// ledger lines/spaces just above and below) are nine positions, stepped
// through a scale one degree at a time just like real staff notation. Every
// time the brush stamps a snippet onto one of those positions, the matching
// note plays immediately — the drawing *is* the score being sounded out.

const STAFF_SCALE = (() => {
  const semitones = [0, 2, 4, 5, 7, 9, 11, 12, 14]; // major scale, C4..D5
  const C4 = 261.6256;
  return semitones.map(s => C4 * Math.pow(2, s / 12));
})();

// li: staff line/space index, -4 (lowest ledger line) .. 4 (highest), 0 = centre line
function staffNoteFreq(li) {
  const idx = Math.round(Math.min(4, Math.max(-4, li))) + 4;
  return STAFF_SCALE[idx];
}

let audioCtx = null;

// A handful of partials above the fundamental, each its own gain envelope —
// higher ones louder and quicker to fade, like a struck piano string: bright
// at the attack, warming and thinning out through a long decay. `mult`
// 4.02 rather than a clean 4 gives it a touch of the slight inharmonicity
// real strings have.
const PIANO_PARTIALS = [
  { mult: 1,    gain: 0.30, decay: 1.6 },
  { mult: 2,    gain: 0.14, decay: 1.1 },
  { mult: 3,    gain: 0.08, decay: 0.75 },
  { mult: 4.02, gain: 0.04, decay: 0.45 },
  { mult: 6.03, gain: 0.02, decay: 0.25 },
];

// A struck note, shaped to read more like a piano than a pure tone. Also
// folds this note into the slowly-growing background pad (see below), so
// every note drawn so far keeps sounding, very softly, underneath.
function pluckNote(freq) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const t0 = audioCtx.currentTime;
  for (const { mult, gain: peak, decay } of PIANO_PARTIALS) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * mult, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.006); // fast hammer-strike attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }

  addToPad(freq);
}

// The ambient pad: one sustained, very quiet sine tone per distinct note
// that has ever been drawn, each starting the first time its note is
// struck and then just... staying on, fading up slowly so a new one never
// pokes out of the texture. Since every note comes from the same nine-step
// staff scale, any combination of them is already consonant, so this never
// needs to be more careful than "is this frequency already playing".
const PAD_VOICES = new Map(); // rounded freq -> { osc, gain }
const PAD_GAIN = 0.025;
const PAD_FADE_IN = 5; // seconds — slow enough to stay in the background

function addToPad(freq) {
  const key = Math.round(freq);
  if (PAD_VOICES.has(key)) return;

  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(PAD_GAIN, t0 + PAD_FADE_IN);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  PAD_VOICES.set(key, { osc, gain });
}
