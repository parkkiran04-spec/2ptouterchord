// All tunable mapping rules live here.
window.DG = window.DG || {};

DG.config = {
  // ---- Musical grid ----
  lanes: 12,             // concentric lanes; lane 0 is the outermost (= lowest note)
  steps: 16,             // quantize steps per revolution (16 or 32)
  maxSustainSteps: 6,    // a stroke running along a lane merges into one note, up to this many steps
  maxNotesPerStep: 7,

  // ---- Turntable ----
  rpm: 33.333,
  speedMultiplier: 0.42, // "feel" multiplier on top of the real RPM (about half the real speed)
  spinUpTime: 1.1,       // seconds (exponential time constant) — a slow, deliberate start
  spinDownTime: 0.9,
  minReadSpeed: 0.7,     // fraction of target speed before notes start (lower = longer pitch wow)

  // ---- Record geometry (fractions of the record radius) ----
  geometry: { drawMin: 0.24, drawMax: 0.96 },
  restRadius: 1.09,  // where the parked needle sits, in record radii
  innerRadius: 0.65, // how far in the needle may travel, in record radii

  // ---- Tonearm reading ----
  mode: 'fixed',                              // 'fixed' | 'sweep'
  bands: { narrow: 0.5, wide: 3, whole: 99 }, // half-width of the reading band, in lanes
  band: 'whole',
  sweepLanesPerRev: 0.2,                      // sweep mode: how far the needle creeps inward per revolution

  // ---- Pitch ----
  keys: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  key: 'C',
  scales: {
    'Pentatonic Major': [0, 2, 4, 7, 9],
    'Pentatonic Minor': [0, 3, 5, 7, 10],
    'Major': [0, 2, 4, 5, 7, 9, 11],
    'Minor': [0, 2, 3, 5, 7, 8, 10],
    'Dorian': [0, 2, 3, 5, 7, 9, 10],
    'Lydian': [0, 2, 4, 6, 7, 9, 11],
    'In (Japanese)': [0, 1, 5, 7, 8],
  },
  scale: 'Pentatonic Major',
  baseMidi: 48, // C3 at the outermost lane

  // ---- Brushes: color -> instrument ----
  brushes: [
    { id: 'red',   color: '#ba2d0b', name: 'Piano',   instrument: 'piano',   octave: 0 },
    { id: 'mint',  color: '#73ba9b', name: 'Marimba', instrument: 'marimba', octave: 0 },
    { id: 'cream', color: '#fff9f2', name: 'Bell',    instrument: 'bell',    octave: 1 },
    { id: 'green', color: '#003e1f', name: 'Bass',    instrument: 'bass',    octave: -1 },
  ],

  // Sizes in record radii; size sets velocity (between minWidth and maxWidth).
  // A press stamps one dot; holding it longPressMs turns it into a line (faster = thinner).
  // dotScale: drawn dot radius = size × dotScale (visual only, velocity unchanged).
  // dotSpacing: gap between dots when presets are stamped from paths.
  brush: { minWidth: 0.011, maxWidth: 0.03, dotWidth: 0.022, dotScale: 0.9, dotSpacing: 0.06, longPressMs: 1000, fastSpeed: 1.6 /* px per ms */ },

  audio: {
    lookahead: 0.05,
    masterGain: 0.55,
    lowpass: 3800,
    reverbWet: 0.24,
    crackle: 0.09,
    heart: 0.85,     // heartbeat drum level
    noiseBed: 0.22,  // noise-window static level
    glass: 0.3,      // glass shard collisions in the white window
    maxPolyphony: 10,
  },

  // The frame lines stretch out while the record plays, and pull back when it stops.
  background: { growTime: 1.4, shrinkTime: 0.9 },

  // The "bl" state: every `every` seconds the whole picture becomes black with white
  // line art for `hold` seconds, with everything still running.
  bl: { enabled: true, every: 5, hold: 2 },

  // Stop-motion look: the picture is held and stepped at a low, slightly uneven rate.
  // The music is unaffected — notes stay on the audio clock.
  motion: "stop",     // "stop" or "smooth"
  stopMotionFps: 12,
  stopMotionJitter: 0.3,

  crowdedRatio: 0.4, // share of all (lane, step) cells filled before the "too crowded" hint
  maxPoints: 9000,
  storageKey: 'drawn-groove/v1',
};
