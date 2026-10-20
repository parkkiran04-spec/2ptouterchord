// Drawing: stroke input in record coordinates, hand-drawn rendering and note glow.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const rec = DG.record;

  const D = (DG.drawing = {
    strokes: [], // dots (1 point) and lines: { id, brush, group, points: [{ r, t, w }] }
    current: null, // line being drawn (rendered live, not in the cached layer)
    mono: false,   // "bl" state: draw everything white
    brushIndex: 0,
    nextId: 1,
    holding: false,
    layer: null,
    layerDirty: true,
    onChange: null,
  });

  let last = null;  // last pointer sample {x, y, ts}
  let press = null; // current gesture {start, dot}
  let gapped = false;
  let gesture = 0;

  const changed = () => {
    DG.sequencer.markDirty();
    if (D.onChange) D.onChange();
  };

  // A finished dot or line is inked straight onto the cached layer, on top of
  // what is already there. Only removing something (undo, clear, a dot that
  // turns into a line) or a new size/colour needs the whole layer redrawn —
  // which used to happen on every single tap, and grows with every mark.
  const pendingInk = [];
  const inkLater = (s) => { if (!D.layerDirty) pendingInk.push(s); };

  // ---- input: a press stamps one dot; holding it for longPressMs turns it into a line ----
  D.begin = function (x, y) {
    const now = performance.now();
    D.holding = true;
    gesture++;
    D.brushIndex = Math.floor(Math.random() * cfg.brushes.length); // instruments are picked at random
    last = { x, y, ts: now };
    press = { start: now, dot: stampDot(x, y) };
  };

  D.move = function (x, y) {
    if (!D.holding) return;
    const now = performance.now();
    if (D.current) addLinePoint(x, y, now, false);
    last = { x, y, ts: now };
  };

  D.tick = function () {
    if (!D.holding || !press) return;
    const now = performance.now();
    if (!D.current) {
      if (press.dot && now - press.start >= cfg.brush.longPressMs) startLine(now);
      return;
    }
    // While the platter spins, a still pointer keeps drawing onto the moving surface.
    if (rec.omega > 0.01) addLinePoint(last.x, last.y, now, true);
  };

  D.end = function () {
    finishLine();
    D.holding = false;
    press = null;
    last = null;
  };

  // How far along the long press is (for the progress ring), or null.
  D.pressProgress = function () {
    if (!D.holding || !press || !press.dot || D.current) return null;
    const elapsed = performance.now() - press.start;
    return { x: last.x, y: last.y, elapsed, k: Math.min(1, elapsed / cfg.brush.longPressMs) };
  };

  function stampDot(x, y) {
    const p = rec.toRecord(x, y);
    const g = cfg.geometry;
    if (p.rn < g.drawMin || p.rn > g.drawMax) return null;
    const w = cfg.brush.dotWidth * (0.9 + Math.random() * 0.2);
    const dot = { id: D.nextId++, brush: D.brushIndex, group: gesture, points: [{ r: p.rn, t: p.t, w }], glow: 0, cells: null, cellsDirty: true };
    D.strokes.push(dot);
    inkLater(dot);
    changed();
    return dot;
  }

  // The pressed dot becomes the first point of a line — unless the spinning record has
  // already carried it away from the pointer, in which case it stays a dot and the line
  // starts under the pointer (connecting them would slice across the record).
  function startLine(now) {
    const dot = press.dot;
    const p = rec.toRecord(last.x, last.y);
    const d0 = dot.points[0];
    const apart = Math.hypot(
      p.rn * Math.cos(p.t) - d0.r * Math.cos(d0.t),
      p.rn * Math.sin(p.t) - d0.r * Math.sin(d0.t)
    );
    if (apart < cfg.brush.dotWidth) {
      D.current = dot;
      d0.w = cfg.brush.maxWidth;
      D.layerDirty = true;   // the dot is already inked; it has to come off the layer
    } else {
      D.current = newLine();
    }
    gapped = false;
    addLinePoint(last.x, last.y, now, true);
    changed();
  }

  function newLine() {
    const s = { id: D.nextId++, brush: D.brushIndex, group: gesture, points: [], glow: 0, cells: null, cellsDirty: true };
    D.strokes.push(s);
    return s;
  }

  function addLinePoint(x, y, ts, fromTick) {
    const speed = fromTick || !last ? 0 : Math.hypot(x - last.x, y - last.y) / Math.max(1, ts - last.ts);
    const p = rec.toRecord(x, y);
    const g = cfg.geometry;
    if (p.rn < g.drawMin || p.rn > g.drawMax) {
      gapped = true; // leaving the playable area splits the line
      return;
    }
    let prev = D.current.points[D.current.points.length - 1];
    let jump = 0;
    if (prev) {
      jump = Math.hypot(
        p.rn * Math.cos(p.t) - prev.r * Math.cos(prev.t),
        p.rn * Math.sin(p.t) - prev.r * Math.sin(prev.t)
      );
      if (jump * rec.radius < 2.2) return;
    }
    // Re-entering the playable area, or a sudden jump (e.g. a dropped frame while
    // spinning), starts a new line instead of a straight connector.
    if (prev && (gapped || jump > 0.12)) {
      const done = D.current;
      D.current = newLine();
      inkLater(done);
      prev = null;
    }
    gapped = false;

    const b = cfg.brush;
    const targetW = b.maxWidth - (b.maxWidth - b.minWidth) * Math.min(1, speed / b.fastSpeed);
    const pts = D.current.points;
    pts.push({ r: p.rn, t: p.t, w: prev ? prev.w * 0.72 + targetW * 0.28 : targetW });
    D.current.cellsDirty = true;
    changed();
  }

  function finishLine() {
    const s = D.current;
    if (!s) return;
    D.current = null;
    const p = s.points[s.points.length - 1];
    inkLater(s);
    changed();
  }

  // ---- editing ----
  D.setBrush = (i) => { D.brushIndex = i; };
  // Undo removes every dot placed by the last gesture.
  D.undo = function () {
    if (D.holding || !D.strokes.length) return false;
    const g = D.strokes[D.strokes.length - 1].group;
    do {
      D.strokes.pop();
    } while (g != null && D.strokes.length && D.strokes[D.strokes.length - 1].group === g);
    D.layerDirty = true;
    changed();
    return true;
  };
  D.clear = function () {
    if (D.holding) D.end();
    D.strokes = [];
    D.layerDirty = true;
    changed();
  };
  D.setStrokes = function (list) {
    if (D.holding) D.end();
    D.strokes = list.map((s) => ({
      id: D.nextId++,
      brush: Math.max(0, Math.min(cfg.brushes.length - 1, s.brush | 0)),
      points: s.points.map((p) => ({ r: p.r, t: p.t, w: p.w })),
      glow: 0,
      cells: null,
      cellsDirty: true,
    }));
    D.layerDirty = true;
    changed();
  };
  D.byId = (id) => D.strokes.find((s) => s.id === id);

  // ---- effects ----
  D.updateEffects = function (dt) {
    for (const s of D.strokes) if (s.glow > 0) s.glow = s.glow < 0.01 ? 0 : s.glow * Math.exp(-dt * 4.5);
  };

  // ---- rendering (all in record space: origin at record center, unrotated) ----
  const hash = (n) => {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };

  function renderStroke(c, stroke, opt) {
    const pts = stroke.points;
    const n = pts.length;
    if (!n) return;
    const R = rec.radius;
    // in the "bl" state everything drawn on the record reads as white line work
    const color = D.mono ? (opt.mono || '#ffffff') : (opt.color || cfg.brushes[stroke.brush].color);
    const wm = opt.widthMul || 1;
    const jit = opt.jitter == null ? 0.55 : opt.jitter;
    const off = opt.offset || 0;

    c.save();
    c.globalAlpha = opt.alpha == null ? 1 : opt.alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (opt.composite) c.globalCompositeOperation = opt.composite;

    if (n === 1) {
      const p = pts[0];
      c.beginPath();
      c.arc(p.r * R * Math.cos(p.t) + off * 0.5, p.r * R * Math.sin(p.t) - off * 0.5,
        Math.max(1, p.w * R * wm * cfg.brush.dotScale), 0, TAU);
      c.fill();
      c.restore();
      return;
    }

    const xs = new Float32Array(n), ys = new Float32Array(n), ws = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = pts[i].r * R * Math.cos(pts[i].t);
      ys[i] = pts[i].r * R * Math.sin(pts[i].t);
      ws[i] = pts[i].w * R * wm;
    }
    // wobble along the path normal — deterministic, so it is identical every redraw
    const jx = new Float32Array(n), jy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
      const len = Math.hypot(dx, dy) || 1;
      const j = (hash(stroke.id * 97.13 + i * 1.71) - 0.5) * 2 * jit + off;
      jx[i] = xs[i] - (dy / len) * j;
      jy[i] = ys[i] + (dx / len) * j;
    }

    let pathW = (ws[0] + ws[1]) / 2;
    c.lineWidth = pathW;
    c.beginPath();
    c.moveTo(jx[0], jy[0]);
    for (let i = 1; i < n; i++) {
      const w = (ws[i - 1] + ws[i]) / 2;
      if (Math.abs(w - pathW) > 0.5) {
        c.stroke();
        c.beginPath();
        c.moveTo(jx[i - 1], jy[i - 1]);
        pathW = w;
        c.lineWidth = w;
      }
      c.lineTo(jx[i], jy[i]);
    }
    c.stroke();
    c.restore();
  }

  function renderInk(c, stroke) {
    renderStroke(c, stroke, { alpha: 0.95 });
    renderStroke(c, stroke, { alpha: 0.3, widthMul: 0.5, offset: 1.1, jitter: 0.9 });
    renderStroke(c, stroke, { alpha: 0.2, widthMul: 0.28, offset: -0.7, jitter: 0.3, color: '#fffaf0', mono: '#ffffff' });
  }

  D.resize = function () {
    D.layerDirty = true;
  };

  D.rebuildLayer = function () {
    const R = rec.radius, dpr = rec.dpr;
    const size = Math.max(2, Math.ceil(R * 2 * dpr));
    if (!D.layer || D.layer.width !== size) {
      D.layer = document.createElement('canvas');
      D.layer.width = D.layer.height = size;
    }
    const c = D.layer.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, size, size);
    c.setTransform(dpr, 0, 0, dpr, R * dpr, R * dpr);
    for (const s of D.strokes) if (s !== D.current) renderInk(c, s);
    D.layerDirty = false;
    pendingInk.length = 0;
  };

  function inkPending() {
    const R = rec.radius, dpr = rec.dpr;
    const c = D.layer.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, R * dpr, R * dpr);
    for (const s of pendingInk) if (s !== D.current && D.strokes.includes(s)) renderInk(c, s);
    pendingInk.length = 0;
  }

  D.render = function (c) {
    const R = rec.radius;
    if (D.layerDirty || !D.layer) D.rebuildLayer();
    else if (pendingInk.length) inkPending();
    c.drawImage(D.layer, -R, -R, R * 2, R * 2);
    if (D.current) renderInk(c, D.current);

    const wideGlow = !DG.quality || DG.quality.wideGlow;
    for (const s of D.strokes) {
      if (s.glow <= 0.02) continue;
      if (wideGlow) renderStroke(c, s, { alpha: s.glow * 0.35, widthMul: 2.6, jitter: 0, composite: 'lighter' });
      renderStroke(c, s, { alpha: s.glow * 0.55, widthMul: 0.9, jitter: 0.55, color: '#fff6e6', mono: '#ffffff', composite: 'lighter' });
    }
  };

})();
