// Sequencer: turns strokes into a (step -> notes) table and scans it under the needle.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const S = (DG.sequencer = { table: [], dirty: true, occupancy: 0, totalPoints: 0 });

  S.markDirty = () => { S.dirty = true; };
  S.invalidateAll = (strokes) => {
    strokes.forEach((s) => { s.cellsDirty = true; });
    S.dirty = true;
  };

  // Which (lane, step) cells a stroke touches, with the loudest velocity per cell.
  function computeCells(stroke) {
    const g = cfg.geometry, N = cfg.steps, lanes = cfg.lanes;
    const lw = (g.drawMax - g.drawMin) / lanes;
    const d = TAU / N;
    const b = cfg.brush;
    const cells = new Map();

    const mark = (x, y, w) => {
      const rn = Math.hypot(x, y);
      if (rn < g.drawMin - 0.004 || rn > g.drawMax + 0.004) return;
      const lane = Math.max(0, Math.min(lanes - 1, Math.floor((g.drawMax - rn) / lw)));
      const s = mod(Math.round(-Math.atan2(y, x) / d), N);
      const v = 0.42 + 0.58 * clamp01((w - b.minWidth) / (b.maxWidth - b.minWidth));
      const k = lane * N + s;
      if (!(cells.get(k) >= v)) cells.set(k, v);
    };

    const pts = stroke.points;
    let px = 0, py = 0, pw = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p.r * Math.cos(p.t), y = p.r * Math.sin(p.t);
      if (i === 0) {
        mark(x, y, p.w);
      } else {
        const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / 0.005));
        for (let j = 1; j <= n; j++) {
          const f = j / n;
          mark(px + (x - px) * f, py + (y - py) * f, pw + (p.w - pw) * f);
        }
      }
      px = x; py = y; pw = p.w;
    }
    stroke.cells = cells;
    stroke.cellsDirty = false;
  }

  S.rebuild = function (strokes) {
    const N = cfg.steps, maxLen = cfg.maxSustainSteps;
    const table = Array.from({ length: N }, () => []);
    const occupied = new Set();
    let points = 0;

    for (const stroke of strokes) {
      if (stroke.cellsDirty || !stroke.cells) computeCells(stroke);
      points += stroke.points.length;

      const byLane = new Map();
      for (const [k, v] of stroke.cells) {
        occupied.add(k);
        const lane = Math.floor(k / N);
        let arr = byLane.get(lane);
        if (!arr) byLane.set(lane, (arr = new Float32Array(N)));
        arr[k % N] = v;
      }

      // Consecutive steps in one lane become a single sustained note.
      for (const [lane, arr] of byLane) {
        let gap = -1;
        for (let s = 0; s < N; s++) if (arr[s] === 0) { gap = s; break; }
        const startIdx = gap === -1 ? 0 : gap + 1;
        let runStart = -1, runLen = 0, runVel = 0;
        const flush = () => {
          if (runLen > 0) {
            table[runStart].push({ lane, brush: stroke.brush, vel: runVel, len: runLen, sid: stroke.id });
          }
          runStart = -1; runLen = 0; runVel = 0;
        };
        for (let i = 0; i < N; i++) {
          const s = (startIdx + i) % N;
          const v = arr[s];
          if (v > 0) {
            if (runLen === 0) runStart = s;
            runLen++;
            runVel = Math.max(runVel, v);
            if (runLen >= maxLen) flush();
          } else {
            flush();
          }
        }
        flush();
      }
    }

    S.table = table;
    S.occupancy = occupied.size / (cfg.lanes * N);
    S.totalPoints = points;
    S.dirty = false;
  };

  S.midiFor = function (lane, brushIndex) {
    const iv = cfg.scales[cfg.scale];
    const keyIdx = Math.max(0, cfg.keys.indexOf(cfg.key));
    return cfg.baseMidi + keyIdx + iv[lane % iv.length] + 12 * Math.floor(lane / iv.length) +
      12 * cfg.brushes[brushIndex].octave;
  };

  S.readRange = function (needleRn) {
    const c = DG.record.laneFloat(needleRn);
    const half = cfg.bands[cfg.band];
    return {
      lo: Math.max(0, Math.ceil(c - half - 1e-6)),
      hi: Math.min(cfg.lanes - 1, Math.floor(c + half + 1e-6)),
    };
  };

  /**
   * Trigger every step that crossed the needle between rotPrev and rotCur.
   * onNote(event, step, time, duration, play) — play=false means a duplicate (visual only).
   */
  S.process = function (rotPrev, rotCur, dt, needle, omega, baseTime, onNote) {
    if (!(rotCur > rotPrev) || S.table.length !== cfg.steps) return;
    const N = cfg.steps, d = TAU / N;
    const p0 = (rotPrev - needle.angle) / d;
    const p1 = (rotCur - needle.angle) / d;
    let k0 = Math.floor(p0) + 1;
    const k1 = Math.floor(p1);
    if (k1 - k0 >= N) k0 = k1 - N + 1;

    const { lo, hi } = S.readRange(needle.rn);
    const stepDur = d / Math.max(omega, 1e-3);

    for (let k = k0; k <= k1; k++) {
      const s = mod(k, N);
      const list = S.table[s];
      if (!list.length) continue;
      const ago = ((p1 - k) / (p1 - p0)) * dt;
      const time = baseTime - ago;

      const hits = list.filter((e) => e.lane >= lo && e.lane <= hi).sort((a, b) => b.vel - a.vel);
      const seen = new Set();
      let played = 0;
      for (const e of hits) {
        const key = e.brush * 100 + e.lane;
        const play = !seen.has(key) && played < cfg.maxNotesPerStep;
        if (play) { seen.add(key); played++; }
        const dur = Math.max(0.12, e.len * stepDur * 0.97);
        onNote(e, s, time, dur, play);
      }
    }
  };
})();
