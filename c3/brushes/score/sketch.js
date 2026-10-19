// Score Brush
// A p5.js brush that lays down a ribbon of five staff lines along the stroke
// and paints randomized "graphic score" snippets onto it: dots that melt into
// tapered rods, rods that swell into dots, zig-zag melodies, thick bars that
// thin out into hairlines, stemmed notes, chords, tall tapered arches with a
// drop at the tip, hooks, fans, parentheses, spirals, blobs and swipes.
//
// Snippets are recorded as primitives (dots, variable-width paths, blobs) and
// then animated: each grows out from the point where it was stamped, paths
// advancing with a liquid drop at their tip, dots swelling up as the drop
// arrives. Finished snippets are baked into the paint layer. Every stamp also
// sounds the staff note it landed on (see shared/audio.js).
//
// createScoreFace(size) builds one independent instance of this brush,
// running as its own p5 instance into a hidden size×size canvas — one per
// room wall in world.js. `bs`, `density`, `colorLock`, `eraser` and
// `showStaff` below are shared tool settings, held in common by every face;
// everything else (the staff, the paint, the live stroke) is private to the
// face that owns it.

const STAFF_COLOR = [216, 80, 125]; // #d8507d, the five staff lines' colour

const PALETTE = {
  ink:     '#05012D',
  pink:    '#E62662',
  indigo:  '#1E0685',
  maroon:  '#8E0420',
  violet:  '#8D13B3',
  magenta: '#D94DDB',
};
const COLOR_KEYS = ['ink', 'pink', 'indigo', 'maroon', 'violet', 'magenta'];
const COLOR_WEIGHTS = { ink: 3, pink: 2, indigo: 1.6, maroon: 1.6, violet: 1.4, magenta: 1.4 };

// Snippet generators and how often each one is chosen.
const SNIPPETS = [
  ['chain',   20],
  ['cluster', 16],
  ['zigzag',  10],
  ['swell',    8],
  ['bar',     10],
  ['stem',     9],
  ['chord',    6],
  ['arch',     7],
  ['hook',     6],
  ['fan',      4],
  ['parens',   4],
  ['spiral',   3],
  ['cross',    3],
  ['blob',     4],
  ['swipe',    4],
];

const SMOOTH_FACTOR = 0.4;   // fraction of the gap to the raw pointer closed on each pointermove
const SMOOTH_HEADING = 0.15; // how quickly the ribbon heading may turn

const TWIST_THRESHOLD = 0.018; // rad per px of travel; turns faster than this twist the ribbon
const TWIST_GAIN = 1.5;       // how much roll a fast turn adds per radian of heading change
const TWIST_RELAX = 0.015;    // per px of travel, how quickly the ribbon settles flat again

const GROW_SPEED = 0.4;    // px per ms that liquid spreads out from the stamp point
const DOT_MS = 160;        // how long a dot takes to swell up

const BRUSH = {
  name: 'Score Brush',
  swatch: true,
  help: [
    ['drag', 'paint a wall; the staff note at each snippet plays as you go'],
    ['right-drag / arrows', 'look around the room'],
    ['w a s d', 'fly around inside it (otherwise it drifts on its own)'],
    ['1 finger', 'paint (touch)'],
    ['2 fingers', 'drag to look around, pinch to fly (touch)'],
    ['1–6 / 0', 'ink, pink, indigo, maroon, violet, magenta / random'],
    ['[ ]', 'brush size   - = density'],
    ['space', 'auto-fill the wall you are facing   e eraser'],
    ['g', 'hide staff   c clear wall   r new staff'],
    ['p', 'save wall PNG   h hide this'],
  ],
};

// exposed explicitly to world.js, which loads as a separate script
window.BRUSH = BRUSH;
window.COLOR_KEYS = COLOR_KEYS;
window.PALETTE = PALETTE;

// shared across every wall — the tool's own settings
let bs = 1;             // brush size multiplier
let density = 1;        // snippets per unit of drag distance
let colorLock = null;   // one of COLOR_KEYS, or null for random
let eraser = false;
let showStaff = true;

// Builds one independent face of the score brush: its own p5 instance,
// painting into a private size×size canvas. Returns a small controller used
// by world.js to feed it pointer input and keyboard actions.
function createScoreFace(size) {
  let p5inst;
  let staffLayer, paint;
  let u = 9;              // staff line spacing (the unit everything — lines and snippets alike — is built from)
  let st = null;           // current stroke state
  let active = [];         // snippets still growing
  let ribbonQueue = [];    // staff segments scheduled for later (auto-fill)
  let autoDelay = 0;       // ms offset applied to everything created (auto-fill)
  let rec = null;          // primitive list being recorded by the snip* functions
  let forceRefresh = true; // one-shot: tells isAnimating() to report true for exactly one
                           // frame, so a texture upload isn't skipped after a change (like
                           // clearAll) that isn't itself a stroke or a growing snippet —
                           // starts true so the very first frame is covered too
  let resolveReady;
  const readyPromise = new Promise(res => { resolveReady = res; });

  function sketch(p) {
    p.setup = function () {
      p.createCanvas(size, size);
      staffLayer = makeLayer(p);
      paint = makeLayer(p);
      resolveReady(p.canvas);
    };

    p.draw = function () {
      const now = p.millis();
      flushRibbonQueue(p, now);

      // Bake finished snippets into the paint layer first, so nothing
      // flickers. This is wrapped per-snippet: p5's colour parsing has an
      // intermittent internal bug (surfaces as an "is not a valid colour
      // representation" error, likely from running four instances at once)
      // that, uncaught, would kill this draw() call partway through —
      // which, since p5 instances don't restart a crashed loop, means this
      // one wall would freeze on whatever it last rendered and never
      // update again, however many strokes you drew on it afterward. A bad
      // snippet is dropped rather than allowed to take the whole wall down
      // with it.
      const keep = [];
      for (const s of active) {
        try {
          if (now >= s.t0 + s.end) renderSnippet(p, s, paint, Infinity);
          else keep.push(s);
        } catch (err) {
          console.warn('score-brush: dropped a snippet that failed to render', err);
        }
      }
      active = keep;

      p.clear(); // transparent blank canvas, so the room's walls can be see-through
      if (showStaff) p.image(staffLayer, 0, 0);
      p.image(paint, 0, 0);
      for (const s of active) {
        try { renderSnippet(p, s, p, now); } catch (err) { /* see above */ }
      }
    };
  }

  function makeLayer(p) {
    const g = p.createGraphics(size, size);
    g.strokeCap(p.ROUND);
    g.strokeJoin(p.ROUND);
    return g;
  }

  // ---------------------------------------------------------------- stroke
  //
  // A stroke is driven directly by pointer events, not by a separate
  // follower loop running on its own clock: begin/feed/end below are the
  // *entire* lifecycle, called straight from world.js's pointerDown/Move/Up.
  // An earlier version instead stored a target point on each pointermove
  // and chased it with a two-stage smoothing loop ticking inside p.draw(),
  // independent of how often pointer events actually arrived — which meant
  // a stroke's fate depended on how many animation frames happened to land
  // between two events, a timing dependency that was never actually
  // necessary and occasionally meant a drag looked like it had done
  // nothing. Feeding each event straight into the drawing has no such gap.
  //
  // The staff follows the brush: a smoothed point chases the raw pointer
  // position, and five lines are offset perpendicular to its heading.
  // Snippets are stamped in the local frame of the stroke (x along it, y
  // across it), so their dots sit on the ribbon's lines.

  function beginStroke(x, y) {
    st = { x, y, sx: x, sy: y, dx: 0, dy: 0, roll: 0, travel: 0, ends: null, len: 0 };
  }

  // Called on every pointermove while a stroke is live. One exponential-
  // smoothing step filters jitter out of the raw point, then the smoothed
  // point is what actually gets drawn to.
  function feedStroke(p, x, y) {
    if (!st) return;
    st.sx += (x - st.sx) * SMOOTH_FACTOR;
    st.sy += (y - st.sy) * SMOOTH_FACTOR;
    strokeTo(p, st.sx, st.sy);
  }

  function strokeTo(p, x, y) {
    if (!st) return;
    const dx = x - st.x, dy = y - st.y;
    const d = p.sqrt(dx * dx + dy * dy);
    if (d < 0.3) return;

    // smooth the heading as well, and note how fast it is turning
    let dAng = 0;
    if (st.dx === 0 && st.dy === 0) { st.dx = dx / d; st.dy = dy / d; }
    else {
      const prev = p.atan2(st.dy, st.dx);
      st.dx = p.lerp(st.dx, dx / d, SMOOTH_HEADING);
      st.dy = p.lerp(st.dy, dy / d, SMOOTH_HEADING);
      const m = p.sqrt(st.dx * st.dx + st.dy * st.dy) || 1;
      st.dx /= m; st.dy /= m;
      dAng = p.atan2(st.dy, st.dx) - prev;
      if (dAng > p.PI) dAng -= p.TWO_PI;
      if (dAng < -p.PI) dAng += p.TWO_PI;
    }
    const ang = p.atan2(st.dy, st.dx);

    // a fast turn rolls the ribbon over like a twisted strip; otherwise it
    // relaxes to the nearest flat orientation. The denominator is clamped
    // to a minimum: strokeTo now runs once per pointermove rather than in
    // fixed-size substeps, so `d` on its own can be a tiny fraction of a
    // pixel between two close-together real events, and dividing by that
    // was spiking the ratio on ordinary mouse jitter — rolling the ribbon
    // over (which looks like the stroke flipped to the opposite side) on
    // ordinary, not-actually-fast turns.
    if (p.abs(dAng) / p.max(d, 1.5) > TWIST_THRESHOLD) {
      st.roll += dAng * TWIST_GAIN;
    } else {
      const flat = p.round(st.roll / p.PI) * p.PI;
      st.roll = p.lerp(st.roll, flat, p.min(1, d * TWIST_RELAX));
    }
    const squash = p.cos(st.roll); // projected width of the ribbon

    if (eraser) {
      for (const g of [paint, staffLayer]) {
        g.erase(); g.noStroke(); g.circle(x, y, u * 4 * bs); g.noErase();
      }
      st.x = x; st.y = y;
      return;
    }

    // extend the five staff lines
    const nx = -st.dy, ny = st.dx;
    const ends = [];
    for (let k = -2; k <= 2; k++) ends.push([x + nx * k * u * squash, y + ny * k * u * squash]);
    if (st.ends) {
      for (let k = 0; k < 5; k++) {
        ribbonSegment(p, st.ends[k][0], st.ends[k][1], ends[k][0], ends[k][1]);
      }
    }
    st.ends = ends;

    // stamp snippets at intervals along the path (not while the ribbon is
    // mid-twist, where its lines are bunched together)
    st.travel += d;
    st.len += d;
    const spacing = (u * 5.5 * bs) / density;
    if (p.abs(squash) < 0.8) st.travel = p.min(st.travel, spacing);
    else {
      while (st.travel >= spacing) {
        st.travel -= spacing;
        const li = pickLineIndex(p);
        stamp(p, x + nx * li * u, y + ny * li * u, ang, li);
      }
    }
    st.x = x; st.y = y;
  }

  function endStroke() {
    if (st && !eraser && st.len < 4 && p5inst) {
      // a plain click: a short horizontal patch of staff plus one snippet
      const p = p5inst;
      const x0 = st.x - u * 6 * bs, x1 = st.x + u * 6 * bs;
      for (let k = -2; k <= 2; k++) ribbonSegment(p, x0, st.y + k * u, x1, st.y + k * u);
      stamp(p, st.x, st.y, 0, 0);
    }
    st = null;
  }

  function ribbonSegment(p, x1, y1, x2, y2) {
    if (autoDelay > 0) { ribbonQueue.push([p.millis() + autoDelay, x1, y1, x2, y2]); return; }
    staffLayer.stroke(...STAFF_COLOR, 200);
    staffLayer.strokeWeight(0.8);
    staffLayer.line(x1, y1, x2, y2);
  }

  function flushRibbonQueue(p, now) {
    if (!ribbonQueue.length) return;
    staffLayer.stroke(...STAFF_COLOR, 200);
    staffLayer.strokeWeight(0.8);
    const rest = [];
    for (const q of ribbonQueue) {
      if (q[0] <= now) staffLayer.line(q[1], q[2], q[3], q[4]);
      else rest.push(q);
    }
    ribbonQueue = rest;
  }

  // which line (or space between lines) the snippet starts on; biased to the staff
  function pickLineIndex(p) {
    const r = p.random();
    if (r < 0.7) return p.floor(p.random(-2, 3));
    return p.floor(p.random(-4, 5));
  }

  // ---------------------------------------------------------------- stamping

  // Record a snippet at world (x, y) with heading `ang`; `li` is the line
  // index the point sits on. The snip* functions push primitives into
  // `rec`, which are then scheduled to grow outward from the stamp point.
  // Each stamp plays the staff note for its line/space immediately.
  function stamp(p, x, y, ang, li) {
    // Wrapped end to end: if anything in here throws (see the note on the
    // same intermittent p5 colour-parsing bug in p.draw above), `rec` must
    // still end up reset and this stamp must not reach `active` half-built
    // — either of those would corrupt every stamp after it, not just this
    // one.
    try {
      const kind = weightedPick(p, SNIPPETS);
      const col = pickColor(p);
      const dir = p.random() < 0.6 ? -1 : 1; // mostly back over the ribbon just drawn
      const L = { li, dir, col };
      rec = [];
      switch (kind) {
        case 'chain':   snipChain(p, L); break;
        case 'cluster': snipCluster(p, L); break;
        case 'zigzag':  snipZigzag(p, L); break;
        case 'swell':   snipSwell(p, L); break;
        case 'bar':     snipBar(p, L); break;
        case 'stem':    snipStem(p, L); break;
        case 'chord':   snipChord(p, L); break;
        case 'arch':    snipArch(p, L); break;
        case 'hook':    snipHook(p, L); break;
        case 'fan':     snipFan(p, L); break;
        case 'parens':  snipParens(p, L); break;
        case 'spiral':  snipSpiral(p, L); break;
        case 'cross':   snipCross(p, L); break;
        case 'blob':    snipBlob(p, L); break;
        case 'swipe':   snipSwipe(p, L); break;
      }
      const prims = rec;
      active.push(schedule(p, prims, x, y, ang));
      pluckNote(staffNoteFreq(li));
    } catch (err) {
      console.warn('score-brush: a stamp failed partway through and was skipped', err);
    } finally {
      rec = null;
    }
  }

  // Give every primitive a start time and duration based on how far it is
  // from the stamp point (the local origin), so the snippet spreads outward.
  function schedule(p, prims, x, y, ang) {
    const speed = GROW_SPEED * p.random(0.75, 1.25);
    let end = 0;
    for (const pr of prims) {
      if (pr.k === 'dot') {
        pr.start = p.dist(0, 0, pr.x, pr.y) / speed + p.random(0, 20);
        pr.dur = DOT_MS * p.random(0.8, 1.3);
      } else if (pr.k === 'path') {
        const a = pr.pts[0], b = pr.pts[pr.pts.length - 1];
        if (p.dist(0, 0, b[0], b[1]) < p.dist(0, 0, a[0], a[1])) {
          pr.pts.reverse();
          const w = pr.wAt;
          pr.wAt = t => w(1 - t);
        }
        pr.len = pathLength(pr.pts);
        pr.start = p.dist(0, 0, pr.pts[0][0], pr.pts[0][1]) / speed;
        pr.dur = p.max(160, pr.len / speed);
      } else if (pr.k === 'blob') {
        pr.start = p.dist(0, 0, pr.cx, pr.cy) / speed;
        pr.dur = 650;
      }
      end = p.max(end, pr.start + pr.dur);
    }
    return { x, y, ang, prims, t0: p.millis() + autoDelay, end };
  }

  function pathLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      L += Math.hypot(x2 - x1, y2 - y1);
    }
    return L;
  }

  // ---------------------------------------------------------------- rendering

  function easeOutBack(q) {
    const c1 = 1.4, c3 = c1 + 1;
    return 1 + c3 * Math.pow(q - 1, 3) + c1 * Math.pow(q - 1, 2);
  }
  function easeInOutQuad(q) { return q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2; }
  function smoothstep(p, a, b, x) { const t = p.constrain((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  function renderSnippet(p, s, g, now) {
    g.push();
    g.translate(s.x, s.y);
    g.rotate(s.ang);
    for (const pr of s.prims) {
      const q = now === Infinity ? 1 : p.constrain((now - s.t0 - pr.start) / pr.dur, 0, 1);
      if (q <= 0) continue;
      if (pr.k === 'dot') {
        drawDot(g, pr.x, pr.y, pr.d * (q >= 1 ? 1 : easeOutBack(q)), pr.col);
      } else if (pr.k === 'path') {
        if (q >= 1) drawVarStroke(g, pr.pts, pr.wAt, pr.col);
        else drawGrowingPath(p, g, pr, q);
      } else if (pr.k === 'blob') {
        drawBlob(g, pr, q >= 1 ? 1 : easeOutBack(q));
      }
    }
    g.pop();
  }

  function drawDot(g, x, y, d, col) {
    if (d <= 0) return;
    g.noStroke();
    g.fill(col);
    g.circle(x, y, d);
  }

  // The path revealed up to progress `q`, with a liquid drop at the leading
  // edge that shrinks away as the path arrives at its end.
  function drawGrowingPath(p, g, pr, q) {
    const prog = easeInOutQuad(q);
    const n = pr.pts.length;
    const f = prog * (n - 1);
    const i = p.floor(f);
    const frac = f - i;
    const sub = pr.pts.slice(0, i + 1);
    if (i < n - 1) {
      const a = pr.pts[i], b = pr.pts[i + 1];
      sub.push([p.lerp(a[0], b[0], frac), p.lerp(a[1], b[1], frac)]);
    }
    if (sub.length < 2) {
      drawDot(g, pr.pts[0][0], pr.pts[0][1], pr.wAt(0), pr.col);
      return;
    }
    const tipD = p.max(pr.wAt(prog) * 1.8, u * 0.7 * bs) * (1 - smoothstep(p, 0.7, 1, q));
    const melt = u * 0.9 * bs;
    const wAt = tt => {
      const t = tt * prog;
      const base = pr.wAt(t);
      const dTip = (prog - t) * pr.len;
      return p.max(base, tipD * p.exp(-p.pow(dTip / melt, 2)));
    };
    drawVarStroke(g, sub, wAt, pr.col);
  }

  // A variable-width stroke: `pts` is a dense polyline, `wAt(t)` gives the
  // width at parameter t in [0, 1]. Rendered as a filled polygon so widths
  // can swell into dots and melt down into hairlines.
  function drawVarStroke(g, pts, wAt, col) {
    const n = pts.length;
    if (n < 2) return;
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n - 1, i + 1)];
      let tx = p1[0] - p0[0], ty = p1[1] - p0[1];
      const m = Math.hypot(tx, ty) || 1;
      tx /= m; ty /= m;
      const hw = Math.max(0.35, wAt(i / (n - 1)) / 2);
      left.push([pts[i][0] - ty * hw, pts[i][1] + tx * hw]);
      right.push([pts[i][0] + ty * hw, pts[i][1] - tx * hw]);
    }
    g.fill(col);
    g.stroke(col);
    g.strokeWeight(0.6);
    g.beginShape();
    for (const p of left) g.vertex(p[0], p[1]);
    for (let i = n - 1; i >= 0; i--) g.vertex(right[i][0], right[i][1]);
    g.endShape(p5inst.CLOSE);
    // round the ends
    g.noStroke();
    g.circle(pts[0][0], pts[0][1], Math.max(0.7, wAt(0)));
    g.circle(pts[n - 1][0], pts[n - 1][1], Math.max(0.7, wAt(1)));
  }

  function drawBlob(g, pr, scale) {
    if (scale <= 0) return;
    g.noStroke();
    g.fill(pr.col);
    g.push();
    g.translate(pr.cx, pr.cy);
    g.scale(scale);
    g.beginShape();
    for (const v of pr.pts) g.curveVertex(v[0], v[1]);
    g.endShape();
    g.pop();
  }

  // ---------------------------------------------------------------- auto fill

  function autoFill(p) {
    const base = p.millis();
    const writeMs = 6000; // how long the wall takes to write itself
    const rowH = u * 9;
    let row = 0;
    for (let y0 = rowH * 0.6; y0 < size; y0 += rowH, row++) {
      let x = p.random(-u * 4, u * 20), y = y0 + p.random(-u * 2, u * 2);
      const xEnd = size - p.random(0, u * 25);
      let a = p.random() < 0.5 ? 0 : p.random(-0.6, 0.6);
      const seed = p.random(1000);
      beginStroke(x, y);
      let i = 0;
      while (x < xEnd && i < 2000) {
        a = p.lerp(a, (p.noise(seed + i * 0.02) - 0.5) * 0.9, 0.08);
        x += p.cos(a) * 6; y += p.sin(a) * 6;
        autoDelay = (x / size) * writeMs + row * 90 + (p.millis() - base);
        strokeTo(p, x, y);
        i++;
      }
      endStroke();
    }
    // a few free-form strokes on top
    for (let s = 0; s < 3; s++) {
      let x = p.random(size), y = p.random(size), a = p.random(p.TWO_PI);
      const seed = p.random(1000);
      beginStroke(x, y);
      for (let i = 0; i < 120; i++) {
        a += (p.noise(seed + i * 0.05) - 0.5) * 0.2;
        x += p.cos(a) * 6; y += p.sin(a) * 6;
        if (x < 0 || x > size || y < 0 || y > size) break;
        autoDelay = writeMs * 0.3 + (i / 120) * writeMs * 0.7;
        strokeTo(p, x, y);
      }
      endStroke();
    }
    autoDelay = 0;
  }

  // ---------------------------------------------------------------- helpers

  function weightedPick(p, pairs) {
    let total = 0;
    for (const pr of pairs) total += pr[1];
    let r = p.random(total);
    for (const pr of pairs) {
      r -= pr[1];
      if (r < 0) return pr[0];
    }
    return pairs[pairs.length - 1][0];
  }

  function pickColor(p) {
    if (colorLock) return PALETTE[colorLock];
    return PALETTE[weightedPick(p, COLOR_KEYS.map(k => [k, COLOR_WEIGHTS[k]]))];
  }

  function dotD()  { return u * 1.25 * bs; }
  function thinW() { return Math.max(1.2, u * 0.2 * bs); }
  function hairW() { return Math.max(0.9, u * 0.1 * bs); }

  // recorders used by the snippet functions
  function dot(x, y, col, d = dotD()) { rec.push({ k: 'dot', x, y, d, col }); }
  function path(pts, wAt, col) { if (pts.length > 1) rec.push({ k: 'path', pts, wAt, col }); }

  function samplePath(fn, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(fn(i / n));
    return pts;
  }

  function bezierPts(p, x1, y1, cx1, cy1, cx2, cy2, x2, y2, n = 40) {
    return samplePath(t => [
      p.bezierPoint(x1, cx1, cx2, x2, t),
      p.bezierPoint(y1, cy1, cy2, y2, t),
    ], n);
  }

  // width profile: a body width `w` that melts out of a dot of diameter d1 at
  // the start and into a dot of diameter d2 at the end. `k` is the melt
  // length as a fraction of the path.
  function meltProfile(w, d1, d2, k = 0.25) {
    return t => {
      let v = w;
      if (d1 > 0) v = Math.max(v, w + (d1 * 0.9 - w) * Math.exp(-Math.pow(t / k, 1.6) * 4));
      if (d2 > 0) v = Math.max(v, w + (d2 * 0.9 - w) * Math.exp(-Math.pow((1 - t) / k, 1.6) * 4));
      return v;
    };
  }

  // straight rod between two dots, melting out of each of them
  function rod(x1, y1, x2, y2, col, d1 = dotD(), d2 = dotD(), w = thinW()) {
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 0.5) return;
    const k = Math.min(0.5, Math.max(0.08, (u * 1.6 * bs) / L));
    const pts = samplePath(t => [p5inst.lerp(x1, x2, t), p5inst.lerp(y1, y2, t)], Math.max(10, Math.floor(L / 2)));
    path(pts, meltProfile(w, d1, d2, k), col);
  }

  // y of staff line k in the local frame
  function ly(L, k) { return (p5inst.constrain(k, -5, 5) - L.li) * u; }

  // ---------------------------------------------------------------- snippets

  // Dots along one line, joined by rods that melt out of them.
  function snipChain(p, L) {
    const yy = ly(L, L.li);
    const n = p.floor(p.random(2, 7));
    const step = u * p.random(2.2, 4.2) * bs;
    const multi = p.random() < 0.3;
    const pts = [];
    for (let k = 0; k < n; k++) pts.push([L.dir * k * step, yy, p.random() < 0.2 ? dotD() * p.random(0.6, 0.85) : dotD()]);
    for (let k = 0; k < n - 1; k++) {
      rod(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], multi ? PALETTE.ink : L.col, pts[k][2], pts[k + 1][2]);
    }
    for (const pt of pts) dot(pt[0], pt[1], multi ? pickColor(p) : L.col, pt[2]);
    // occasionally the chain trails off into a hairline
    if (p.random() < 0.25) {
      const last = pts[n - 1];
      rod(last[0], last[1], last[0] + L.dir * u * p.random(3, 8) * bs, last[1], L.col, last[2], 0, hairW());
    }
  }

  // Loose dots on nearby lines.
  function snipCluster(p, L) {
    const n = p.floor(p.random(2, 6));
    const multi = p.random() < 0.5;
    let cx = 0;
    for (let k = 0; k < n; k++) {
      const li = L.li + p.floor(p.random(-2, 3));
      const size = p.random() < 0.15 ? dotD() * 0.55 : dotD();
      dot(cx, ly(L, li), multi ? pickColor(p) : L.col, size);
      cx += L.dir * u * p.random(1.6, 3.2) * bs;
    }
  }

  // A melody: dots jumping between lines, joined by melting rods.
  function snipZigzag(p, L) {
    let li = L.li;
    const n = p.floor(p.random(3, 8));
    const pts = [];
    let cx = 0;
    for (let k = 0; k < n; k++) {
      pts.push([cx, ly(L, li)]);
      li = p.constrain(li + p.floor(p.random(1, 4)) * (p.random() < 0.5 ? -1 : 1), -5, 5);
      cx += L.dir * u * p.random(1.5, 3) * bs;
    }
    for (let k = 0; k < n - 1; k++) rod(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], L.col);
    for (const pt of pts) dot(pt[0], pt[1], L.col);
  }

  // One continuous rod whose width swells into dots along its length.
  function snipSwell(p, L) {
    const yy = ly(L, L.li);
    const len = u * p.random(6, 18) * bs;
    const bumps = [];
    const nb = p.floor(p.random(2, 6));
    for (let i = 0; i < nb; i++) bumps.push([p.random(0.05, 0.95), p.random(0.7, 1.15)]);
    const w = thinW() * p.random(0.9, 1.6);
    const wAt = t => {
      let v = w;
      for (const [c, s] of bumps) v = Math.max(v, dotD() * s * Math.exp(-Math.pow((t - c) * len / (u * 0.9 * bs), 2)));
      return v;
    };
    path(samplePath(t => [L.dir * t * len, yy], 80), wAt, L.col);
  }

  // Thick rounded bars, sometimes stacked, sometimes thinning out into a hairline.
  function snipBar(p, L) {
    const count = p.random() < 0.35 ? p.floor(p.random(2, 4)) : 1;
    for (let k = 0; k < count; k++) {
      const yy = ly(L, L.li + k * 2);
      const len = u * p.random(3, 12) * bs;
      const w = u * p.random(1.1, 1.7) * bs;
      const c = k === 0 ? L.col : pickColor(p);
      const ox = p.random(-u * 2, u * 2) * bs;
      if (p.random() < 0.4) {
        // bar that melts into a long thin tail
        const tail = u * p.random(4, 12) * bs;
        const pts = samplePath(t => [ox + L.dir * t * (len + tail), yy], 60);
        const split = len / (len + tail);
        path(pts, t => t < split ? w : Math.max(hairW(), w * Math.pow(1 - (t - split) / (1 - split), 1.8)), c);
      } else {
        path(samplePath(t => [ox + L.dir * t * len, yy], 30), () => w, c);
      }
    }
  }

  // Note head with a stem melting out of it, capped by a dot, a flag, or nothing.
  function snipStem(p, L) {
    const yy = ly(L, L.li);
    const up = p.random() < 0.5 ? -1 : 1;
    const len = u * p.random(3, 8) * bs;
    const ey = yy + up * len;
    const r = p.random();
    const capD = r < 0.4 ? dotD() * p.random(0.5, 1) : 0;
    rod(0, yy, 0, ey, L.col, dotD(), capD);
    dot(0, yy, L.col);
    if (capD > 0) dot(0, ey, p.random() < 0.3 ? pickColor(p) : L.col, capD);
    else if (r < 0.65) {
      const fl = u * p.random(1.5, 3) * bs;
      rod(0, ey, L.dir * fl, ey - up * fl * 0.6, L.col, u * 0.8 * bs, 0, hairW());
    }
  }

  // Vertical stack of dots, sometimes joined by a rod.
  function snipChord(p, L) {
    const n = p.floor(p.random(2, 5));
    const gap = p.random() < 0.5 ? 1 : 2;
    const multi = p.random() < 0.4;
    const top = ly(L, L.li), bottom = ly(L, L.li + (n - 1) * gap);
    if (p.random() < 0.5) rod(0, top, 0, bottom, L.col);
    for (let k = 0; k < n; k++) dot(0, ly(L, L.li + k * gap), multi ? pickColor(p) : L.col);
  }

  // Tall tapered arch: rises from a dot, thins across the top, and comes
  // down to a small drop (or nothing) on the other side.
  function snipArch(p, L) {
    const y0 = ly(L, L.li);
    const span = u * p.random(3, 12) * bs * L.dir;
    const rise = u * p.random(5, 16) * bs * (p.random() < 0.7 ? -1 : 1);
    const y1 = y0 + p.random(-u * 3, u * 3) * bs;
    const pts = bezierPts(p, 0, y0, span * 0.05, y0 + rise * 1.25, span * 0.95, y1 + rise * 1.25, span, y1, 60);
    const d0 = dotD() * p.random(0.8, 1.1);
    const d1 = p.random() < 0.7 ? dotD() * p.random(0.35, 0.7) : 0;
    path(pts, meltProfile(hairW() * p.random(1, 1.6), d0, d1, 0.2), L.col);
    dot(0, y0, L.col, d0);
    if (d1 > 0) dot(span, y1, L.col, d1);
  }

  // A hook: dot with a tail that drops and curls, ending in a tiny drop.
  function snipHook(p, L) {
    const y0 = ly(L, L.li);
    const down = p.random() < 0.6 ? 1 : -1;
    const h = u * p.random(4, 10) * bs;
    const w = u * p.random(1.5, 4) * bs * L.dir;
    const pts = bezierPts(p, 0, y0, 0, y0 + down * h * 0.9, w * 0.2, y0 + down * h * 1.1, w, y0 + down * h * 0.8, 50);
    const dTip = dotD() * p.random(0.3, 0.55);
    path(pts, meltProfile(hairW() * p.random(1, 1.5), dotD(), dTip, 0.3), L.col);
    dot(0, y0, L.col);
    dot(w, y0 + down * h * 0.8, L.col, dTip);
  }

  // A dot with several hairline curves fanning out to smaller dots.
  function snipFan(p, L) {
    const y0 = ly(L, L.li);
    const n = p.floor(p.random(2, 4));
    dot(0, y0, L.col);
    for (let i = 0; i < n; i++) {
      const len = u * p.random(6, 16) * bs;
      const a = p.random(-0.9, 0.9) + (L.dir < 0 ? p.PI : 0);
      const bend = u * p.random(-5, 5) * bs;
      const ex = p.cos(a) * len, ey = y0 + p.sin(a) * len;
      const nx = -p.sin(a), ny = p.cos(a);
      const pts = bezierPts(p, 0, y0, ex * 0.4 + nx * bend, y0 + (ey - y0) * 0.4 + ny * bend, ex * 0.75, ey - (ey - y0) * 0.25, ex, ey, 40);
      const d1 = dotD() * p.random(0.35, 0.7);
      path(pts, meltProfile(hairW(), dotD(), d1, 0.25), L.col);
      dot(ex, ey, p.random() < 0.3 ? pickColor(p) : L.col, d1);
    }
  }

  // Two facing arcs like a pair of parentheses, with a small dot between.
  function snipParens(p, L) {
    const y0 = ly(L, L.li);
    const h = u * p.random(4, 12) * bs;
    const gap = u * p.random(2, 6) * bs;
    const bow = u * p.random(1, 3) * bs;
    const horizontal = p.random() < 0.5;
    const w = hairW() * p.random(1, 1.4);
    const prof = t => w + (w * 1.6) * p.sin(t * p.PI);
    for (const s of [-1, 1]) {
      let pts;
      if (horizontal) {
        pts = bezierPts(p, -h / 2, y0 + s * gap / 2, -h / 6, y0 + s * (gap / 2 + bow), h / 6, y0 + s * (gap / 2 + bow), h / 2, y0 + s * gap / 2, 40);
      } else {
        pts = bezierPts(p, s * gap / 2, y0 - h / 2, s * (gap / 2 + bow), y0 - h / 6, s * (gap / 2 + bow), y0 + h / 6, s * gap / 2, y0 + h / 2, 40);
      }
      path(pts, prof, L.col);
    }
    if (p.random() < 0.7) dot(0, y0, p.random() < 0.4 ? pickColor(p) : L.col, dotD() * p.random(0.5, 1));
  }

  // A spiral that unwinds from a dot, thinning as it goes.
  function snipSpiral(p, L) {
    const y0 = ly(L, L.li);
    const turns = p.random(1.2, 2.5);
    const rMax = u * p.random(2, 5) * bs;
    const cw = p.random() < 0.5 ? 1 : -1;
    const a0 = p.random(p.TWO_PI);
    const pts = samplePath(t => {
      const a = a0 + cw * t * turns * p.TWO_PI;
      const r = rMax * p.pow(t, 0.8);
      return [p.cos(a) * r, y0 + p.sin(a) * r];
    }, 90);
    // the dot sits at the outer end, the line thins toward the centre
    pts.reverse();
    path(pts, meltProfile(hairW(), dotD(), dotD() * 0.3, 0.2), L.col);
    dot(pts[0][0], pts[0][1], L.col);
  }

  // A cross of melting rods radiating from a centre dot.
  function snipCross(p, L) {
    const y0 = ly(L, L.li);
    const arms = p.floor(p.random(3, 5));
    const a0 = p.random() < 0.6 ? 0 : p.random(p.PI);
    dot(0, y0, L.col, dotD() * 1.1);
    for (let i = 0; i < arms; i++) {
      const a = a0 + i * p.TWO_PI / arms + p.random(-0.15, 0.15);
      const len = u * p.random(2.5, 7) * bs;
      const d1 = p.random() < 0.7 ? dotD() * p.random(0.5, 1) : 0;
      rod(0, y0, p.cos(a) * len, y0 + p.sin(a) * len, L.col, dotD() * 1.1, d1, thinW() * p.random(0.8, 1.4));
      if (d1 > 0) dot(p.cos(a) * len, y0 + p.sin(a) * len, L.col, d1);
    }
  }

  // An organic ink blob, sometimes trailing a rod to a small dot.
  function snipBlob(p, L) {
    const y0 = ly(L, L.li);
    const base = u * p.random(1.4, 3) * bs;
    const stretch = p.random(1, 2.2);
    const seed = p.random(1000);
    const rot = p.random(-0.5, 0.5);
    const steps = 28;
    const pts = [];
    for (let k = 0; k <= steps + 3; k++) {
      const t = (k % steps) / steps * p.TWO_PI;
      const r = base * (0.7 + 0.6 * p.noise(seed + p.cos(t) * 1.3, seed + p.sin(t) * 1.3));
      const px = p.cos(t) * r * stretch, py = p.sin(t) * r;
      pts.push([px * p.cos(rot) - py * p.sin(rot), px * p.sin(rot) + py * p.cos(rot)]);
    }
    rec.push({ k: 'blob', pts, cx: 0, cy: y0, col: L.col });
    if (p.random() < 0.45) {
      const a = p.random(p.TWO_PI);
      const len = u * p.random(4, 10) * bs;
      const d1 = dotD() * p.random(0.4, 0.8);
      rod(0, y0, p.cos(a) * len, y0 + p.sin(a) * len, L.col, base * 1.6, d1);
      dot(p.cos(a) * len, y0 + p.sin(a) * len, L.col, d1);
    }
  }

  // A thick painterly swipe that thins out toward its end.
  function snipSwipe(p, L) {
    const y0 = ly(L, L.li);
    const len = u * p.random(5, 14) * bs;
    const w = u * p.random(0.9, 1.6) * bs;
    const a = p.random(-0.6, 0.6) + (L.dir < 0 ? p.PI : 0);
    const nx = -p.sin(a), ny = p.cos(a);
    const wobble = u * p.random(-4, 4) * bs;
    const x2 = p.cos(a) * len, y2 = y0 + p.sin(a) * len;
    const pts = bezierPts(p,
      0, y0,
      p.cos(a) * len * 0.33 + nx * wobble, y0 + p.sin(a) * len * 0.33 + ny * wobble,
      p.cos(a) * len * 0.66 - nx * wobble * 0.5, y0 + p.sin(a) * len * 0.66 - ny * wobble * 0.5,
      x2, y2, 50);
    const taper = p.random() < 0.6;
    path(pts, t => taper ? Math.max(hairW(), w * Math.pow(1 - t, 1.3)) : w, L.col);
  }

  // ---------------------------------------------------------------- API

  function clearAll() {
    paint.clear();
    staffLayer.clear();
    active = [];
    ribbonQueue = [];
    forceRefresh = true;
  }

  function newStaff() {
    clearAll();
    u = p5inst.random(6, 15);
  }

  p5inst = new p5(sketch, document.getElementById('faces'));

  return {
    ready: readyPromise,
    get canvas() { return p5inst.canvas; },
    pointerDown(x, y) { beginStroke(x, y); },
    pointerMove(x, y) { feedStroke(p5inst, x, y); },
    pointerUp() { endStroke(); forceRefresh = true; },
    // true while this wall's canvas could still be changing — a live
    // stroke, a snippet still growing, or auto-fill still queued — so the
    // caller knows when it's safe to skip re-uploading an unchanged canvas
    // to the GPU as a texture.
    isAnimating() {
      if (forceRefresh) { forceRefresh = false; return true; }
      return !!st || active.length > 0 || ribbonQueue.length > 0;
    },
    clearAll,
    newStaff,
    autoFill() { autoFill(p5inst); },
    save(name) { p5inst.saveCanvas(name, 'png'); },
  };
}

// ---------------------------------------------------------------- shared tool settings

function setColorLock(v) { colorLock = v; }
function getColorLock() { return colorLock; }
function setEraser(v) { eraser = v; }
function getEraser() { return eraser; }
function toggleEraser() { eraser = !eraser; return eraser; }
function toggleShowStaff() { showStaff = !showStaff; return showStaff; }
function growBrush() { bs = Math.min(4, bs * 1.2); return bs; }
function shrinkBrush() { bs = Math.max(0.4, bs / 1.2); return bs; }
function growDensity() { density = Math.min(6, density * 1.4); return density; }
function shrinkDensity() { density = Math.max(0.25, density / 1.4); return density; }
function getBrushState() { return { bs, density, colorLock, eraser }; }
