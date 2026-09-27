// Artwork: the illustrated layers (background, pan, record, inner windows, tonearm).
// Geometry is expressed in a fixed 2000x1125 "design space" that matches the source files,
// and window/arm positions are kept in record-radius units so everything scales together.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const A = (DG.artwork = {
    ready: false,
    missing: [],
    images: {},
    design: { w: 2000, h: 1125 },
    disc: { x: 967, y: 587.25, r: 422.75 },
    panRect: { x: 414, y: 87.5, w: 1203.75, h: 1019.5 },
    view: { scale: 1, ox: 0, oy: 0, dpr: 1 },
    bgView: { scale: 1, ox: 0, oy: 0 },
    colors: { beige: '#cfccc2', green: '#013e1f', red: '#bc2d0b', mint: '#73ba9c', vinyl: '#120306' },

    // Circles inside the record, in record-radius units relative to the record centre.
    windows: [
      { id: 'cells', src: 'cells', ox: -0.36193, oy: -0.22648, r: 0.49261, kind: 'heart', energy: 0, clock: 0, pulse: 0, leanX: 0, leanY: 0 },
      { id: 'noise', src: 'noise', ox: 0.37494, oy: 0.35247, r: 0.32052, kind: 'drift', dx: 0, dy: 0, vx: 0, vy: 0, spin: 0, spinV: 0 },
      // glass shards tumbling in the white window; falls back to the iris if Matter.js is missing
      { id: 'blank', ox: 0.49438, oy: -0.38497, r: 0.28622, kind: 'glass', sim: null, irisX: 0, irisY: 0, targetX: 0, targetY: 0, energy: 0, rings: [] },
    ],
    arc: { ox: 0.47487, oy: -0.40509, half: 0.30574 },
    arm: {
      pivot: { x: 1.24304, y: -0.77410 }, // offset from the record centre, in radii
      length: 1.47393,                    // pivot → stylus, in radii
      sprite: { pivot: { x: 685, y: 500 }, needle: { x: 248, y: 1667 }, len: 1246.2, angle: 1.92933, w: 820, h: 1720 },
    },

    ambient: false,      // true while the record is playing: the heart keeps a baseline beat
    onBeat: null,        // (strong, intensity) — hook used for the heartbeat sound
    mono: false,         // the "bl" state: black ground, white line art, everything still moving

    // Hook for the animation that will live in the white window (added later).
    // Signature: function (ctx, cx, cy, r, time) — already clipped to the circle.
    renderBlankWindow: null,
  });

  const FILES = {
    background: 'assets/background.png',
    backgroundShort: 'assets/background-short.png',
    pan: 'assets/pan.png',
    disc: 'assets/disc.png',
    arc: 'assets/arc.png',
    cells: 'assets/cells.png',
    noise: 'assets/noise.png',
    tonearm: 'assets/tonearm.png',
    // the "bl" set: the same layers drawn as white line art
    blBackground: 'assets/bl-background.png',
    blPan: 'assets/bl-pan.png',
    blDisc: 'assets/bl-disc.png',
    blCells: 'assets/bl-cells.png',
    blNoise: 'assets/bl-noise.png',
    blTonearm: 'assets/bl-tonearm.png',
  };

  // the bl record art is drawn on a square wider than the disc, so its rings can spill
  // out past the rim exactly as they do in the artwork
  const BL_DISC_HALF = 1.1828; // in record radii

  // The two frame lines grow from their short length to their full one. Measured from
  // the artwork, in design space.
  A.lines = [
    { from: 792.5, to: 1454.5, y: 42, h: 10 },    // top
    { from: 538, to: 1454.5, y: 1074, h: 12 },    // bottom
  ];
  A.lineGrowth = 0; // 0 = short, 1 = full

  // The panels the sound is drawn into, also measured from the artwork.
  A.graphs = {
    wave: { x: 1640, y: 45, w: 317, h: 79 },   // the long ruled rectangle
    scope: { x: 1869.5, y: 156, w: 88, h: 88 }, // the square below it
  };

  const sprites = {};
  const BEAT_PERIOD = 0.95;
  const BEAT_OFFSETS = [0, 0.24];
  let time = 0;

  A.load = function () {
    const jobs = Object.keys(FILES).map((key) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { A.images[key] = img; resolve(); };
      img.onerror = () => { A.missing.push(FILES[key]); resolve(); };
      img.src = FILES[key];
    }));
    return Promise.all(jobs).then(() => {
      A.ready = A.missing.length === 0;
      return A.ready;
    });
  };

  // ---- view mapping (design space → canvas) ----
  // The turntable is fitted to the stage with a margin (so it stays large on a phone),
  // while the background fills the canvas. On a 16:9 stage the two line up as drawn.
  A.setView = function (W, H, dpr) {
    const p = A.panRect, margin = 105;
    const scale = Math.min(W / (p.w + margin), H / (p.h + margin));
    A.view = {
      scale,
      ox: W / 2 - (p.x + p.w / 2) * scale,
      oy: H / 2 - (p.y + p.h / 2) * scale,
      dpr,
    };
    // the background is fitted whole: its frame lines and the two graph panels sit at
    // the very edges of the design, so nothing may be cropped away
    const bgScale = Math.min(W / A.design.w, H / A.design.h);
    A.bgView = { scale: bgScale, ox: (W - A.design.w * bgScale) / 2, oy: (H - A.design.h * bgScale) / 2 };
    sprites.disc = sprites.arm = sprites.arc = sprites.cells = sprites.noise = null;
    sprites.discMono = sprites.armMono = sprites.arcMono = sprites.cellsMono = sprites.noiseMono = sprites.panMono = null;
    return { scale, radius: A.disc.r * scale, cx: A.view.ox + A.disc.x * scale, cy: A.view.oy + A.disc.y * scale };
  };

  function makeSprite(img, w, h) {
    const dpr = A.view.dpr;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const c = cv.getContext('2d');
    if (img) c.drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  }

    // ---- static layers ----
  A.drawStage = function (ctx, W, H) {
    const v = A.view, b = A.bgView;
    const p = A.panRect;
    const pw = p.w * v.scale, ph = p.h * v.scale;
    const px = v.ox + p.x * v.scale, py = v.oy + p.y * v.scale;

    if (A.mono) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      if (A.images.blBackground) {
        ctx.drawImage(A.images.blBackground, b.ox, b.oy, A.design.w * b.scale, A.design.h * b.scale);
      }
      if (A.images.blPan) ctx.drawImage(A.images.blPan, px, py, pw, ph);
      return;
    }

    ctx.fillStyle = A.colors.beige;
    ctx.fillRect(0, 0, W, H);
    const bw = A.design.w * b.scale, bh = A.design.h * b.scale;
    // the short-line version is the ground; the full-length one is revealed over it
    const base = A.images.backgroundShort || A.images.background;
    if (base) ctx.drawImage(base, b.ox, b.oy, bw, bh);
    if (A.images.background && A.lineGrowth > 0) {
      for (const L of A.lines) {
        const x0 = b.ox + L.from * b.scale;
        const x1 = b.ox + (L.from + (L.to - L.from) * A.lineGrowth) * b.scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, b.oy + L.y * b.scale, x1 - x0, L.h * b.scale);
        ctx.clip();
        ctx.drawImage(A.images.background, b.ox, b.oy, bw, bh);
        ctx.restore();
      }
    }
    if (A.images.pan) ctx.drawImage(A.images.pan, px, py, pw, ph);
  };

  // ---- the sound, drawn into the two panels on the background ----
  // wave: a white line rippling across the ruled rectangle.
  // scope: a scatter of dots whose places shift with the sound.
  A.drawGraphs = function (ctx, wave) {
    const b = A.bgView;
    const toX = (x) => b.ox + x * b.scale;
    const toY = (y) => b.oy + y * b.scale;
    const n = wave ? wave.length : 0;

    const g = A.graphs.wave;
    const x0 = toX(g.x + 3), x1 = toX(g.x + g.w - 3);
    const mid = toY(g.y + g.h / 2), amp = (g.h / 2 - 4) * b.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(toX(g.x), toY(g.y), g.w * b.scale, g.h * b.scale);
    ctx.clip();
    ctx.beginPath();
    ctx.lineWidth = Math.max(1, 1.6 * b.scale);
    ctx.strokeStyle = '#ffffff';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const steps = 96;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const v = n ? wave[Math.floor(t * (n - 1))] : 0;
      const x = x0 + (x1 - x0) * t;
      const y = mid - v * amp * 1.8;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();

    const s = A.graphs.scope;
    const cx = toX(s.x + s.w / 2), cy = toY(s.y + s.h / 2);
    const half = (s.w / 2 - 5) * b.scale;
    const dot = Math.max(1, 1.9 * b.scale);
    ctx.fillStyle = '#ffffff';
    const dots = 26;
    for (let i = 0; i < dots; i++) {
      const a = n ? wave[Math.floor((i / dots) * (n - 1))] : 0;
      const bq = n ? wave[Math.floor(((i / dots) + 0.27) % 1 * (n - 1))] : 0;
      ctx.beginPath();
      ctx.arc(cx + clamp(a * 3.2, -1, 1) * half, cy + clamp(bq * 3.2, -1, 1) * half, dot, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };

  // ---- record ----
  // In the bl state the disc is black with the printed rings on top, drawn from a square
  // wider than the disc; record.js asks for the size to use.
  A.discSprite = function (R) {
    if (A.mono) {
      const size = R * 2 * BL_DISC_HALF;
      if (!sprites.discMono) sprites.discMono = makeMonoDisc(R, size);
      return sprites.discMono;
    }
    if (!sprites.disc) sprites.disc = makeSprite(A.images.disc, R * 2, R * 2);
    return sprites.disc;
  };

  A.discHalfSize = function (R) {
    return A.mono ? R * BL_DISC_HALF : R;
  };

  function makeMonoDisc(R, size) {
    const dpr = A.view.dpr;
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.max(2, Math.round(size * dpr));
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, (size / 2) * dpr, (size / 2) * dpr);
    c.beginPath();
    c.arc(0, 0, R, 0, TAU);
    c.fillStyle = '#000000';
    c.fill();
    if (A.images.blDisc) c.drawImage(A.images.blDisc, -size / 2, -size / 2, size, size);
    return cv;
  }

  // two beats per cycle, like a heart
  function heartbeat(t) {
    const c = ((t % BEAT_PERIOD) + BEAT_PERIOD) % BEAT_PERIOD;
    return Math.exp(-Math.pow(c / 0.055, 2)) + 0.6 * Math.exp(-Math.pow((c - 0.24) / 0.07, 2));
  }

  A.update = function (dt) {
    time += dt;
    for (const w of A.windows) {
      if (w.kind === 'heart') {
        const prev = w.clock;
        w.clock += dt;
        w.energy *= Math.exp(-dt / 2.6);
        if (A.ambient) w.energy = Math.max(w.energy, 0.18);
        if (w.energy < 0.002) w.energy = 0;
        w.pulse = w.energy * heartbeat(w.clock);
        w.leanX *= Math.exp(-dt * 2.4);
        w.leanY *= Math.exp(-dt * 2.4);
        if (A.onBeat && w.energy > 0.05) {
          for (const o of BEAT_OFFSETS) {
            const k0 = Math.ceil((prev - o) / BEAT_PERIOD), k1 = Math.floor((w.clock - o) / BEAT_PERIOD);
            for (let k = k0; k <= k1; k++) A.onBeat(o === 0, Math.min(1, w.energy));
          }
        }
      } else if (w.kind === 'drift') {
        const k = 42, damp = 5.5;
        w.vx += (-k * w.dx - damp * w.vx) * dt;
        w.vy += (-k * w.dy - damp * w.vy) * dt;
        w.dx += w.vx * dt;
        w.dy += w.vy * dt;
        w.spinV += (-k * w.spin - damp * w.spinV) * dt;
        w.spin += w.spinV * dt;
        const max = 0.14;
        const len = Math.hypot(w.dx, w.dy);
        if (len > max) { w.dx *= max / len; w.dy *= max / len; }
        w.spin = clamp(w.spin, -0.32, 0.32);
      } else if (w.kind === 'glass') {
        // starts as an unbroken pane; a higher hit threshold keeps the tumbling
        // shards from clattering over the music once it has broken
        if (!w.sim && DG.glass && DG.glass.available) {
          w.sim = DG.glass.create({ rays: 10, rings: [0.3, 0.58, 0.8], hitThreshold: 1.6 });
        }
        if (w.sim) {
          // "down" follows the record, so the shards tumble as it turns
          w.sim.setGravityAngle(DG.record.rot);
          w.sim.update(dt);
        } else {
          w.kind = 'iris';
        }
      } else if (w.kind === 'iris') {
        w.irisX += (w.targetX - w.irisX) * (1 - Math.exp(-dt * 7));
        w.irisY += (w.targetY - w.irisY) * (1 - Math.exp(-dt * 7));
        w.energy *= Math.exp(-dt / 0.8);
        for (const ring of w.rings) ring.age += dt;
        w.rings = w.rings.filter((ring) => ring.age < ring.life);
      }
    }
  };

  // Energy of the noise window, used to drive its background sound.
  A.noiseEnergy = function () {
    const w = A.windows[1];
    return clamp(Math.hypot(w.vx, w.vy) * 0.6 + Math.hypot(w.dx, w.dy) * 2.2, 0, 1);
  };

  // ---- pointer reactions ----
  // Everything reacts to every pointer event, wherever it lands: the closer the pointer,
  // the stronger the response, but nothing is limited to the inside of a circle.
  A.react = function (rn, t, strength, click) {
    const px = rn * Math.cos(t), py = rn * Math.sin(t);
    for (const w of A.windows) {
      const dx = px - w.ox, dy = py - w.oy;
      const dist = Math.hypot(dx, dy);
      const near = clamp(1 - (dist - w.r) / 1.5, 0.12, 1); // 1 inside the circle, fading outwards
      const s = strength * near;

      if (w.kind === 'heart') {
        w.energy = Math.min(1, w.energy + (click ? 0.5 * near + 0.12 : 0.24 * s));
        if (click) w.clock = 0;
        const lean = (click ? 0.028 : 0.012) * near;
        if (dist > 0.001) {
          w.leanX = clamp(w.leanX + (dx / dist) * lean, -0.04, 0.04);
          w.leanY = clamp(w.leanY + (dy / dist) * lean, -0.04, 0.04);
        }
      } else if (w.kind === 'drift') {
        const push = (click ? 3.4 : 1.6) * s;
        if (dist > 0.001) {
          w.vx -= (dx / dist) * push;
          w.vy -= (dy / dist) * push;
        }
        w.spinV += (dx * w.vy - dy * w.vx) * 0.5 * near;
      } else if (w.kind === 'glass') {
        if (w.sim) {
          w.sim.impulse(dx / w.r, dy / w.r, (click ? 1.5 : 0.7) * near * (click ? 1 : strength + 0.15));
          if (click && near > 0.6) w.sim.shake(0.5 * near);
        }
        // nothing here breaks the pane — only the needle coming down does that
      } else if (w.kind === 'iris') {
        const reach = 0.3;
        const d = Math.max(dist, 0.001);
        const pull = Math.min(1, dist / w.r);
        w.targetX = (dx / d) * reach * pull;
        w.targetY = (dy / d) * reach * pull;
        w.energy = Math.min(1, w.energy + (click ? 0.9 : 0.25 * s));
        if (click && w.rings.length < 6) w.rings.push({ age: 0, life: 1.1 });
      }
    }
  };

  // Break the glass pane, struck at (x, y) in window units. This is called when the
  // needle comes down on the record — nothing else breaks it.
  A.shatterGlass = function (x, y) {
    const w = A.windows.find((win) => win.kind === 'glass');
    if (!w || !w.sim || w.sim.state !== 'intact') return false;
    return w.sim.shatter(x == null ? 0.35 : x, y == null ? -0.3 : y);
  };

  // True while the glass is still whole or mid-crack: the record waits, and only
  // starts to turn once the pane has fallen apart.
  A.glassHoldsRecord = function () {
    const w = A.windows.find((win) => win.kind === 'glass');
    return !!(w && w.sim && w.sim.state !== 'broken');
  };

  A.resetGlass = function () {
    const w = A.windows.find((win) => win.kind === 'glass');
    if (w && w.sim) w.sim.reset();
  };

  A.windowAt = function (rn, t) {
    const x = rn * Math.cos(t), y = rn * Math.sin(t);
    for (const w of A.windows) {
      if (Math.hypot(x - w.ox, y - w.oy) <= w.r) return { win: w, lx: x - w.ox, ly: y - w.oy };
    }
    return null;
  };

  // ---- inner windows (drawn in record space: origin at the record centre, unrotated) ----
  A.renderWindows = function (c, R) {
    // The arc artwork carries its own white disc, so it goes down first and the white
    // window is drawn over it — otherwise it would hide what happens inside that circle.
    // the arc belongs to the colour artwork; in the bl state the record layer carries its own
    if (!A.mono && A.images.arc) {
      const size = A.arc.half * 2 * R;
      if (!sprites.arc) sprites.arc = makeSprite(A.images.arc, size, size);
      c.drawImage(sprites.arc, A.arc.ox * R - size / 2, A.arc.oy * R - size / 2, size, size);
    }

    for (const w of A.windows) {
      const wx = w.ox * R, wy = w.oy * R, wr = w.r * R;
      c.save();
      c.beginPath();
      c.arc(wx, wy, wr, 0, TAU);
      c.clip();

      if (w.kind === 'heart') {
        const img = A.mono ? (A.images.blCells || A.images[w.src]) : A.images[w.src];
        if (img) {
          const h = wr * 2 * 1.5;
          if (A.mono) {
            if (!sprites.cellsMono) sprites.cellsMono = makeSprite(img, h * (img.width / img.height), h);
          } else if (!sprites.cells) {
            sprites.cells = makeSprite(img, h * (img.width / img.height), h);
          }
          const sp = A.mono ? sprites.cellsMono : sprites.cells;
          const dw = sp.width / A.view.dpr, dh = sp.height / A.view.dpr;
          const s = 1 + 0.09 * w.pulse;
          c.translate(wx + w.leanX * R, wy + w.leanY * R);
          c.scale(s, s);
          c.drawImage(sp, -dw / 2, -dh / 2, dw, dh);
        }
      } else if (w.kind === 'drift') {
        const img = A.mono ? (A.images.blNoise || A.images[w.src]) : A.images[w.src];
        if (img) {
          const h = wr * 2 * 1.8;
          if (A.mono) {
            if (!sprites.noiseMono) sprites.noiseMono = makeSprite(img, h * (img.width / img.height), h);
          } else if (!sprites.noise) {
            sprites.noise = makeSprite(img, h * (img.width / img.height), h);
          }
          const sp = A.mono ? sprites.noiseMono : sprites.noise;
          const dw = sp.width / A.view.dpr, dh = sp.height / A.view.dpr;
          c.translate(wx + w.dx * R, wy + w.dy * R);
          c.rotate(w.spin);
          c.drawImage(sp, -dw / 2, -dh / 2, dw, dh);
        }
      } else if (w.kind === 'glass' && w.sim) {
        // counter-rotate the light so it keeps coming from the same place on screen
        if (A.mono) c.filter = 'grayscale(1) brightness(1.5) contrast(2.6)';
        w.sim.render(c, wx, wy, wr, { grain: 0.05, vignette: 0.22, lightAngle: -DG.record.rot - 0.9 });
        c.filter = 'none';
      } else {
        // white window: an iris that follows the pointer, plus rings when tapped
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(wx, wy, wr, 0, TAU);
        c.fill();
        c.translate(wx, wy);
        const irisR = wr * (0.3 + 0.06 * w.energy);
        c.fillStyle = A.colors.green;
        c.beginPath();
        c.arc(w.irisX * wr, w.irisY * wr, irisR, 0, TAU);
        c.fill();
        c.fillStyle = A.colors.mint;
        c.beginPath();
        c.arc(w.irisX * wr * 1.12, w.irisY * wr * 1.12, irisR * 0.42, 0, TAU);
        c.fill();
        c.lineWidth = Math.max(1, wr * 0.03);
        for (const ring of w.rings) {
          const k = ring.age / ring.life;
          c.globalAlpha = (1 - k) * 0.7;
          c.strokeStyle = A.colors.green;
          c.beginPath();
          c.arc(0, 0, wr * (0.15 + 0.95 * k), 0, TAU);
          c.stroke();
        }
        c.globalAlpha = 1;
        if (A.renderBlankWindow) A.renderBlankWindow(c, 0, 0, wr, time);
      }
      c.restore();
    }
  };

  // ---- tonearm ----
  A.armSprite = function (length) {
    const s = A.arm.sprite;
    const key = A.mono ? 'armMono' : 'arm';
    if (!sprites[key]) {
      const img = A.mono ? (A.images.blTonearm || A.images.tonearm) : A.images.tonearm;
      const scale = length / s.len;
      const w = img ? img.width * scale : 1, h = img ? img.height * scale : 1;
      sprites[key] = makeSprite(img, w, h);
      sprites[key].pivotX = s.pivot.x * scale;
      sprites[key].pivotY = s.pivot.y * scale;
      sprites[key].scale = scale;
    }
    return sprites[key];
  };
})();
