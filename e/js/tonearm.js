// Tonearm: geometry, drag / drop / lift, sweep mode, hit testing and drawing.
// Pivot, length and artwork all come from DG.artwork, measured from the source illustration.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const rec = DG.record;

  // States: rest → dragging → dropping → playing (→ gliding → dropping …) → dragging → returning → rest
  const T = (DG.tonearm = {
    pivot: { x: 0, y: 0 },
    length: 0,
    angle: 0,
    restAngle: 0,
    outerAngle: 0,
    innerAngle: 0,
    farAngle: 0,
    lift: 0,
    liftTarget: 0,
    state: 'rest',
    sweepR: 0,
    glideTarget: 0,
    onLand: null,
    onLift: null,
  });

  let grabOffset = 0;

  T.isOnRecord = () => T.state === 'dropping' || T.state === 'playing' || T.state === 'gliding';
  T.isReading = () => T.state === 'playing';

  T.needleAt = (a) => ({ x: T.pivot.x + T.length * Math.cos(a), y: T.pivot.y + T.length * Math.sin(a) });
  T.needle = () => T.needleAt(T.angle);
  const rAt = (a) => {
    const n = T.needleAt(a);
    return Math.hypot(n.x - rec.cx, n.y - rec.cy) / rec.radius;
  };
  T.needleR = () => rAt(T.angle);
  T.needlePolar = function () {
    const n = T.needle();
    return {
      angle: Math.atan2(n.y - rec.cy, n.x - rec.cx),
      rn: Math.hypot(n.x - rec.cx, n.y - rec.cy) / rec.radius,
      x: n.x, y: n.y,
    };
  };

  // Needle radius falls monotonically as the arm swings from "pointing away from the
  // spindle" (farAngle) to "pointing at the spindle" (farAngle + π).
  T.angleForR = function (rn) {
    let lo = T.farAngle, hi = T.farAngle + Math.PI;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rAt(mid) > rn) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  T.layout = function () {
    const keepR = T.isOnRecord() ? T.needleR() : null;
    const R = rec.radius, g = cfg.geometry, art = DG.artwork.arm;
    T.pivot = { x: rec.cx + art.pivot.x * R, y: rec.cy + art.pivot.y * R };
    T.length = art.length * R;
    T.farAngle = Math.atan2(T.pivot.y - rec.cy, T.pivot.x - rec.cx);
    T.restAngle = T.angleForR(cfg.restRadius);
    T.outerAngle = T.angleForR(g.drawMax - 0.004);
    T.innerAngle = T.angleForR(Math.max(cfg.innerRadius, g.drawMin + 0.012));
    if (keepR != null && isFinite(keepR)) {
      T.angle = T.angleForR(keepR);
      T.sweepR = keepR;
    } else if (T.state === 'rest') {
      T.angle = T.restAngle;
    }
  };

  // ---- interaction ----
  // Hit testing happens in the artwork's own coordinates, so the headshell block at the
  // stylus end and the square counterweight at the top can both be grabbed, not just the tube.
  T.toSprite = function (x, y) {
    const s = DG.artwork.arm.sprite;
    const scale = T.length / s.len;
    const dx = x - T.pivot.x, dy = y - T.pivot.y;
    const th = T.angle - s.angle;
    const cos = Math.cos(th), sin = Math.sin(th);
    return {
      x: (dx * cos + dy * sin) / scale + s.pivot.x,
      y: (-dx * sin + dy * cos) / scale + s.pivot.y,
      scale,
    };
  };

  T.hitTest = function (x, y) {
    const s = DG.artwork.arm.sprite;
    const p = T.toSprite(x, y);
    const pad = Math.max(60, 16 / p.scale); // keep a comfortable target on small screens
    const inRect = (x0, y0, x1, y1) =>
      p.x > x0 - pad && p.x < x1 + pad && p.y > y0 - pad && p.y < y1 + pad;
    if (inRect(0, 1430, 330, 1720)) return true;      // headshell + stylus
    if (inRect(520, 0, 820, 500)) return true;        // counterweight and square
    return distToSegment(p.x, p.y, s.pivot.x, s.pivot.y, s.needle.x, s.needle.y) < 70 + pad * 0.5;
  };

  T.startDrag = function (x, y) {
    if (T.isOnRecord() && T.onLift) T.onLift();
    T.state = 'dragging';
    T.liftTarget = 1;
    grabOffset = T.angle - Math.atan2(y - T.pivot.y, x - T.pivot.x);
  };

  T.drag = function (x, y) {
    if (T.state !== 'dragging') return;
    let a = Math.atan2(y - T.pivot.y, x - T.pivot.x) + grabOffset;
    while (a < T.restAngle - Math.PI) a += TAU;
    while (a > T.restAngle + Math.PI) a -= TAU;
    T.angle = Math.max(T.restAngle - 0.08, Math.min(T.innerAngle, a));
  };

  T.endDrag = function () {
    if (T.state !== 'dragging') return;
    if (T.angle >= T.outerAngle - 0.02) {
      T.angle = Math.max(T.outerAngle, Math.min(T.innerAngle, T.angle));
      T.sweepR = T.needleR();
      T.state = 'dropping';
      T.liftTarget = 0;
    } else {
      T.state = 'returning';
      T.liftTarget = 0;
    }
  };

  T.syncSweep = function () {
    if (T.isOnRecord()) T.sweepR = T.needleR();
  };

  // ---- motion ----
  T.update = function (dt, sweepSpeed) {
    const g = cfg.geometry, lw = rec.laneWidth();
    const liftTau = T.liftTarget > T.lift ? 0.08 : 0.13;
    T.lift += (T.liftTarget - T.lift) * (1 - Math.exp(-dt / liftTau));

    switch (T.state) {
      case 'dropping':
        if (T.lift < 0.02) {
          T.lift = 0;
          T.state = 'playing';
          if (T.onLand) T.onLand();
        }
        break;
      case 'returning':
        T.angle += (T.restAngle - T.angle) * (1 - Math.exp(-dt / 0.16));
        if (Math.abs(T.restAngle - T.angle) < 0.002) {
          T.angle = T.restAngle;
          T.state = 'rest';
        }
        break;
      case 'playing':
        if (cfg.mode === 'sweep' && sweepSpeed > 0) {
          T.sweepR -= sweepSpeed * dt;
          if (T.sweepR <= Math.max(cfg.innerRadius, g.drawMin + lw * 0.5)) {
            T.state = 'gliding';
            T.liftTarget = 0.6;
            T.glideTarget = g.drawMax - lw * 0.5;
          }
          T.angle = T.angleForR(T.sweepR);
        }
        break;
      case 'gliding':
        if (T.lift > 0.45) {
          T.sweepR += (T.glideTarget - T.sweepR) * (1 - Math.exp(-dt / 0.3));
          T.angle = T.angleForR(T.sweepR);
          if (Math.abs(T.glideTarget - T.sweepR) < 0.004) {
            T.state = 'dropping';
            T.liftTarget = 0;
          }
        }
        break;
    }
  };

  // ---- drawing ----
  T.draw = function (ctx, pulse) {
    const R = rec.radius, art = DG.artwork;
    const sprite = art.images.tonearm ? art.armSprite(T.length) : null;
    const lift = T.lift;

    if (sprite) {
      const dpr = art.view.dpr;
      const w = sprite.width / dpr, h = sprite.height / dpr;
      ctx.save();
      ctx.translate(T.pivot.x, T.pivot.y);
      ctx.rotate(T.angle - art.arm.sprite.angle);
      const s = 1 + lift * 0.03;
      ctx.scale(s, s);
      ctx.shadowColor = `rgba(1,62,31,${0.18 + lift * 0.22})`;
      ctx.shadowBlur = (0.02 + lift * 0.06) * R;
      ctx.drawImage(sprite, -sprite.pivotX, -sprite.pivotY, w, h);
      ctx.restore();
    }

    // needle light
    if (T.isOnRecord() && T.lift < 0.3) {
      const n = T.needle();
      const glowR = 0.06 * R * (1 + pulse * 0.7);
      const gl = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowR);
      gl.addColorStop(0, `rgba(255,236,190,${0.5 + pulse * 0.35})`);
      gl.addColorStop(1, 'rgba(255,214,150,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.arc(n.x, n.y, glowR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  };

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
})();
