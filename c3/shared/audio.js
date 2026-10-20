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

// Strikes one note with the piano partials above, `gainScale` and
// `decayScale` scaling the whole envelope — 1 for the sharp, immediate
// stamp sound, smaller/longer for the quieter, more lingering ambient notes
// below. Shared so the ambient melody is made of literally the same struck-
// piano timbre as every stamp, just played back softer.
function strikeNote(freq, gainScale, decayScale) {
  const t0 = audioCtx.currentTime;
  for (const { mult, gain: peak, decay } of PIANO_PARTIALS) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const d = decay * decayScale;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * mult, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak * gainScale, t0 + 0.006); // fast hammer-strike attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + d + 0.05);
  }
}

// A struck note, shaped to read more like a piano than a pure tone. Also
// folds this note into the ambient background melody (see below), so
// every note drawn so far can turn up again, very softly, on its own.
function pluckNote(freq) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  strikeNote(freq, 1, 1);
  addToAmbient(freq);
}

// The ambient background: used to be one sustained sine drone per distinct
// note ever drawn, all stacking into a held hum that only ever got louder
// and thicker — not what a piece about a musical staff should sound like
// left alone. This instead replays little melodic phrases, quietly, built
// only from notes the brush has actually stamped so far: the piece humming
// back a bit of what's been drawn rather than holding a chord under it.
// `ambientIdx` walks the list of distinct notes by a small random step each
// time rather than jumping to a fresh random one, so a phrase has some
// melodic shape to it instead of reading as scattered plinks.
const AMBIENT_NOTES = []; // distinct note frequencies seen so far, in first-struck order
const AMBIENT_GAIN_SCALE = 0.2;   // quieter than the main pluck
const AMBIENT_DECAY_SCALE = 1.3;  // a little more lingering, like a soft felt piano
const AMBIENT_PHRASE_LEN = [2, 5];      // notes per little phrase
const AMBIENT_NOTE_GAP = [260, 520];    // ms between notes within a phrase
const AMBIENT_PHRASE_GAP = [2500, 7000]; // ms of quiet between phrases
let ambientTimer = null;
let ambientIdx = 0;

function randBetween(lo, hi) { return lo + Math.random() * (hi - lo); }

function addToAmbient(freq) {
  const key = Math.round(freq);
  if (AMBIENT_NOTES.includes(key)) return;
  AMBIENT_NOTES.push(key);
  if (!ambientTimer) scheduleAmbientPhrase(randBetween(1200, 3000));
}

function nextAmbientFreq() {
  ambientIdx = Math.max(0, Math.min(AMBIENT_NOTES.length - 1, ambientIdx + Math.round(randBetween(-2.4, 2.4))));
  return AMBIENT_NOTES[ambientIdx];
}

function scheduleAmbientPhrase(delayMs) {
  ambientTimer = setTimeout(playAmbientPhrase, delayMs);
}

function playAmbientPhrase() {
  ambientTimer = null;
  if (!AMBIENT_NOTES.length) return;
  const len = Math.round(randBetween(AMBIENT_PHRASE_LEN[0], AMBIENT_PHRASE_LEN[1]));
  let delay = 0;
  for (let i = 0; i < len; i++) {
    const freq = nextAmbientFreq();
    setTimeout(() => strikeNote(freq, AMBIENT_GAIN_SCALE, AMBIENT_DECAY_SCALE), delay);
    delay += randBetween(AMBIENT_NOTE_GAP[0], AMBIENT_NOTE_GAP[1]);
  }
  scheduleAmbientPhrase(delay + randBetween(AMBIENT_PHRASE_GAP[0], AMBIENT_PHRASE_GAP[1]));
}
