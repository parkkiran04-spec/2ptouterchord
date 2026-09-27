// Glass: a pane that starts whole, cracks where it is struck, then falls into shards
// that tumble inside a circular boundary with procedural collision sounds.
// Physics runs in its own world where the circle has radius REF, so the same simulation
// can be drawn into a small window on the record or a big circle on a page of its own.
window.DG = window.DG || {};
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const REF = 300; // world radius in physics units
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const G = (DG.glass = {
    REF,
    get available() { return typeof window.Matter !== 'undefined'; },
    defaults: {
      rays: 11,            // radial cracks from the point of impact
      rings: [0.3, 0.58, 0.8], // ring cracks, as a fraction of the way to the pane edge
      paneScale: 1.15,     // the glass is a square pane wider than the round window
      mergeChance: 0.42,   // how often neighbouring cells join into one bigger shard
      splitChance: 0.22,    // how often a cell is cut in two
      gravity: 1,
      restitution: 0.4,
      crackTime: 0.45,     // how long the cracks take to race outwards
      pieceShrink: 0.9,    // shards are cut slightly smaller than their cell, so they can move
      colors: ['#ffffff', '#f6fcfa', '#e6f2ee', '#d3e8e1', '#b9dcd1', '#9fd0c2'],
      hitThreshold: 2.2,
    },
  });

  // ---------- procedural glass sound ----------
  const audio = (G.audio = {
    ctx: null,
    level: 0.45,
    lastHit: -1e9,
    minGap: 0.42,      // seconds between knocks, at the very least
    skipChance: 0.35,  // and even then, some are let go
    strongSpeed: 2.5,  // above this, a knock is always heard
    played: 0,
  });

  audio.init = function (ctx) {
    if (audio.ctx || !ctx) return audio.ctx;
    audio.ctx = ctx;
    audio.master = ctx.createGain();
    audio.master.gain.value = audio.level;
    audio.master.connect(ctx.destination);
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
    audio.noise = buf;
    return ctx;
  };

  audio.setLevel = function (v) {
    audio.level = v;
    if (audio.master) audio.master.gain.value = v;
  };

  // one struck-glass voice. big: 0 (small, high) … 1 (large, low); vel: 0…1
  function voice(big, vel, when) {
    const ctx = audio.ctx;
    const t = when == null ? ctx.currentTime : when;
    // even the smallest shard keeps some body, so nothing rings thin and tinny
    const b = 0.25 + 0.75 * clamp(big, 0, 1);
    const base = 420 + 1200 * (1 - b);
    const ring = 0.14 + 0.5 * b;

    // two sine partials, slightly inharmonic, with a short downward glide
    [1, 2.71].forEach((mult, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const f = base * mult * (0.96 + Math.random() * 0.08);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.88, t + ring);
      const peak = Math.max(0.0002, vel * (i ? 0.11 : 0.3));
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ring);
      osc.connect(g).connect(audio.master);
      osc.start(t);
      osc.stop(t + ring + 0.05);
    });

    // band-passed noise for the impact itself
    const src = ctx.createBufferSource();
    const bp = ctx.createBiquadFilter();
    const ng = ctx.createGain();
    src.buffer = audio.noise;
    bp.type = 'bandpass';
    bp.frequency.value = clamp(base * 1.5, 160, 9000);
    bp.Q.value = 1.3 + Math.random();
    ng.gain.setValueAtTime(Math.max(0.0002, vel * 0.32), t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + 0.06 * b);
    src.connect(bp).connect(ng).connect(audio.master);
    src.start(t, Math.random() * 0.2, 0.25);
  }

  // size: world units (big shard → low, heavy glass), speed: impact speed,
  // range: the size range this simulation uses, so pitch spans it properly
  audio.hit = function (size, speed, range) {
    const ctx = audio.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // Shards knock against each other constantly, so the gentle ones are rationed;
    // a real whack — a poke, or a piece dropping — always gets to speak.
    if (speed < audio.strongSpeed) {
      if (now - audio.lastHit < audio.minGap) return;
      if (Math.random() < audio.skipChance) return;
    } else if (now - audio.lastHit < 0.09) {
      return;
    }
    audio.lastHit = now;
    audio.played++;
    if (window.DG && DG.memory) DG.memory.add('glass', { size: Math.round(size), speed: Math.round(speed * 10) / 10 });
    const lo = range ? range.minSize : 60;
    const hi = range ? range.maxSize : 200;
    voice(clamp((size - lo) / Math.max(1, hi - lo), 0, 1), clamp(speed / 14, 0.05, 1), now);
  };

  // the pane letting go: one crunch, then a shower of tinkles
  audio.shatter = function () {
    const ctx = audio.ctx;
    if (window.DG && DG.memory) DG.memory.add('shatter', {});
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = audio.noise;
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(3000, now);
    bp.frequency.exponentialRampToValueAtTime(520, now + 0.55);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.55, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(bp).connect(g).connect(audio.master);
    src.start(now);
    src.stop(now + 0.6);

    const pieces = 8;
    for (let i = 0; i < pieces; i++) {
      const at = now + 0.02 + Math.random() * 0.45;
      voice(Math.random(), 0.25 + Math.random() * 0.55, at);
    }
  };

  // ---------- the simulation ----------
  G.create = function (options) {
    if (!G.available) return null;
    const M = window.Matter;
    const opt = Object.assign({}, G.defaults, options || {});
    const engine = M.Engine.create();
    engine.gravity.scale = 0.001;
    const world = engine.world;

    let shards = [];
    let state = 'intact';       // intact → cracking → broken
    let pattern = null;         // the crack pattern, in world units
    let crackT = 0;
    let gravityAngle = 0;       // 0 = "down" in the circle's own frame
    let grain = null;
    let grainIndex = 0;
    let sizeRange = { minSize: 60, maxSize: 200 };

    // The glass is a square pane, larger than the round window it is seen through.
    // Its frame is the physics boundary, so shards may slide out of sight at the edges.
    const PANE = REF * opt.paneScale;
    const thick = 120;
    const span = PANE * 2 + thick * 2;
    const wallOpts = { isStatic: true, restitution: 0.35, friction: 0.06 };
    M.Composite.add(world, [
      M.Bodies.rectangle(0, -(PANE + thick / 2), span, thick, wallOpts),
      M.Bodies.rectangle(0, PANE + thick / 2, span, thick, wallOpts),
      M.Bodies.rectangle(-(PANE + thick / 2), 0, thick, span, wallOpts),
      M.Bodies.rectangle(PANE + thick / 2, 0, thick, span, wallOpts),
    ]);

    // ---------- fracture pattern ----------
    // Radial cracks race out from the impact across the square pane, ring cracks join
    // them, and the cells between become the shards. Cells are then merged and split at
    // random so the pieces come out all different sizes, the way real glass breaks.

    // how far the pane edge is from the impact along a direction
    function edgeDist(px, py, a) {
      const dx = Math.cos(a), dy = Math.sin(a);
      let t = Infinity;
      if (Math.abs(dx) > 1e-6) t = Math.min(t, ((dx > 0 ? PANE : -PANE) - px) / dx);
      if (Math.abs(dy) > 1e-6) t = Math.min(t, ((dy > 0 ? PANE : -PANE) - py) / dy);
      return t;
    }

    // position along the pane's perimeter, 0…4, increasing with the angle
    function perimeterU(p) {
      const e = 0.5;
      if (p.x > PANE - e) return (p.y + PANE) / (2 * PANE);
      if (p.y > PANE - e) return 1 + (PANE - p.x) / (2 * PANE);
      if (p.x < -PANE + e) return 2 + (PANE - p.y) / (2 * PANE);
      return 3 + (p.x + PANE) / (2 * PANE);
    }
    const CORNERS = [{ x: PANE, y: -PANE }, { x: PANE, y: PANE }, { x: -PANE, y: PANE }, { x: -PANE, y: -PANE }];

    function buildPattern(px, py) {
      const rays = Math.max(5, Math.round(opt.rays));
      const stops = [0].concat(opt.rings).concat([1]);
      const angles = [];
      for (let i = 0; i < rays; i++) {
        angles.push((i / rays) * TAU + (Math.random() - 0.5) * (TAU / rays) * 0.7);
      }

      // nodes[i][j]: where ray i crosses ring j
      const nodes = angles.map((a) => {
        const d = edgeDist(px, py, a);
        const bias = 0.7 + Math.random() * 0.6; // this crack runs short or long
        return stops.map((t, j) => {
          const tt = j === 0 ? 0.06 + Math.random() * 0.06
            : j === stops.length - 1 ? 1
              : clamp(t * bias * (0.82 + Math.random() * 0.36), 0.1, 0.93);
          const wobble = j === 0 || j === stops.length - 1 ? 0 : (Math.random() - 0.5) * 0.16;
          const ang = a + wobble;
          return { x: px + Math.cos(ang) * d * tt, y: py + Math.sin(ang) * d * tt, t: tt, a: ang };
        });
      });

      // the outer edge of a cell runs along the pane border, around any corner in between
      const borderRun = (from, to) => {
        const run = [];
        let uA = perimeterU(from), uB = perimeterU(to);
        if (uB < uA) uB += 4;
        for (let k = Math.ceil(uA); k < uB; k++) run.push(CORNERS[k % 4]);
        return run;
      };

      const quad = (i, j) => {
        const i2 = (i + 1) % rays;
        const poly = [nodes[i][j], nodes[i][j + 1]];
        if (j === stops.length - 2) poly.push.apply(poly, borderRun(nodes[i][j + 1], nodes[i2][j + 1]));
        poly.push(nodes[i2][j + 1], nodes[i2][j]);
        return poly;
      };

      // ---- cells, with neighbours merged and some cut in two ----
      const taken = [];
      for (let i = 0; i < rays; i++) taken.push(new Array(stops.length - 1).fill(false));
      const cells = [];

      // the pulverised middle, in a few ragged bits
      let bit = [];
      for (let i = 0; i <= rays; i++) {
        bit.push(nodes[i % rays][0]);
        if (bit.length > 2 && (Math.random() < 0.45 || i === rays)) {
          cells.push([{ x: px, y: py }].concat(bit));
          bit = [nodes[i % rays][0]];
        }
      }

      for (let i = 0; i < rays; i++) {
        for (let j = 0; j < stops.length - 1; j++) {
          if (taken[i][j]) continue;
          taken[i][j] = true;
          const i2 = (i + 1) % rays;
          let poly = quad(i, j);

          // merge outwards: this cell and the one beyond it become one long shard
          if (j < stops.length - 2 && !taken[i][j + 1] && Math.random() < opt.mergeChance) {
            taken[i][j + 1] = true;
            poly = [nodes[i][j], nodes[i][j + 1], nodes[i][j + 2]];
            if (j + 1 === stops.length - 2) poly.push.apply(poly, borderRun(nodes[i][j + 2], nodes[i2][j + 2]));
            poly.push(nodes[i2][j + 2], nodes[i2][j + 1], nodes[i2][j]);
          // merge sideways: two neighbouring wedges become one wide shard
          } else if (!taken[i2][j] && Math.random() < opt.mergeChance * 0.8) {
            taken[i2][j] = true;
            const i3 = (i + 2) % rays;
            poly = [nodes[i][j], nodes[i][j + 1]];
            if (j === stops.length - 2) {
              poly.push.apply(poly, borderRun(nodes[i][j + 1], nodes[i2][j + 1]));
              poly.push(nodes[i2][j + 1]);
              poly.push.apply(poly, borderRun(nodes[i2][j + 1], nodes[i3][j + 1]));
            } else {
              poly.push(nodes[i2][j + 1]);
            }
            poly.push(nodes[i3][j + 1], nodes[i3][j], nodes[i2][j]);
          }

          // cut some cells in two along a ragged line
          if (poly.length > 3 && Math.random() < opt.splitChance) {
            const a = Math.floor(Math.random() * poly.length);
            const b = (a + 2 + Math.floor(Math.random() * Math.max(1, poly.length - 3))) % poly.length;
            if (a !== b && (a + 1) % poly.length !== b && (b + 1) % poly.length !== a) {
              const mid = {
                x: (poly[a].x + poly[b].x) / 2 + (Math.random() - 0.5) * 30,
                y: (poly[a].y + poly[b].y) / 2 + (Math.random() - 0.5) * 30,
              };
              const first = [], second = [];
              for (let k = a; ; k = (k + 1) % poly.length) { first.push(poly[k]); if (k === b) break; }
              for (let k = b; ; k = (k + 1) % poly.length) { second.push(poly[k]); if (k === a) break; }
              first.splice(first.length - 1, 0, mid);
              second.splice(second.length - 1, 0, mid);
              cells.push(first, second);
              continue;
            }
          }
          cells.push(poly);
        }
      }

      // extra hairline cracks, drawn but not cut out — the fine damage around the hit
      const hairlines = [];
      for (let k = 0; k < rays; k++) {
        const i = Math.floor(Math.random() * rays);
        const j = Math.floor(Math.random() * (stops.length - 1));
        const from = nodes[i][j];
        const a = Math.atan2(from.y - py, from.x - px) + (Math.random() - 0.5) * 1.6;
        const len = 30 + Math.random() * 120;
        hairlines.push([from, { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len }]);
      }

      // every cell edge, ordered by how far it is from the impact, for the crack animation
      const edges = [];
      let maxD = 1;
      const seen = new Set();
      for (const poly of cells) {
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length];
          const key = [a.x, a.y, b.x, b.y].map((v) => Math.round(v)).sort().join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const d = Math.hypot((a.x + b.x) / 2 - px, (a.y + b.y) / 2 - py);
          maxD = Math.max(maxD, d);
          edges.push({ a, b, d });
        }
      }
      for (const e of edges) e.d /= maxD;

      return { impact: { x: px, y: py }, nodes, cells, stops, edges, hairlines };
    }

    function polyArea(poly) {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        a += p.x * q.y - q.x * p.y;
      }
      return Math.abs(a) / 2;
    }
    function centroid(poly) {
      let x = 0, y = 0;
      for (const p of poly) { x += p.x; y += p.y; }
      return { x: x / poly.length, y: y / poly.length };
    }

    function spawnPieces() {
      const sizes = [];
      for (const cell of pattern.cells) {
        const area = polyArea(cell);
        if (area < 700) continue; // drop slivers too thin to read as glass
        const c = centroid(cell);
        // pull each piece in a little, so the shards have room to slip and settle
        // instead of staying wedged in the circle exactly as they were cut
        const poly = cell.map((p) => ({
          x: c.x + (p.x - c.x) * opt.pieceShrink,
          y: c.y + (p.y - c.y) * opt.pieceShrink,
        }));
        const body = M.Bodies.fromVertices(c.x, c.y, [poly], {
          restitution: opt.restitution,
          friction: 0.04,
          frictionAir: 0.004,
          density: 0.0014,
        }, true);
        if (!body) continue;
        const size = Math.sqrt(area / Math.PI);
        sizes.push(size);
        body.plugin = {
          size,
          colour: opt.colors[Math.floor(Math.random() * opt.colors.length)],
          sparkle: Math.random() * TAU,
        };
        // a push away from the impact, as the pane lets go
        const dx = c.x - pattern.impact.x, dy = c.y - pattern.impact.y;
        const d = Math.max(20, Math.hypot(dx, dy));
        const kick = 2.6 * (1 - Math.min(1, d / REF)) + 0.7;
        M.Body.setVelocity(body, { x: (dx / d) * kick, y: (dy / d) * kick });
        M.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.25);
        shards.push(body);
        M.Composite.add(world, body);
      }
      if (sizes.length) sizeRange = { minSize: Math.min.apply(null, sizes), maxSize: Math.max.apply(null, sizes) };
      state = 'broken';
    }

    M.Events.on(engine, 'collisionStart', (ev) => {
      const now = engine.timing.timestamp;
      for (const pair of ev.pairs) {
        const a = pair.bodyA, b = pair.bodyB;
        const va = a.velocity, vb = b.velocity;
        const n = pair.collision && pair.collision.normal;
        if (!n) continue;
        // only the part of the motion going *into* the contact counts as a knock,
        // otherwise shards sliding along the wall would rattle non-stop
        const impact = Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y);
        if (impact < opt.hitThreshold) continue;
        const sizes = [a.plugin && a.plugin.size, b.plugin && b.plugin.size].filter(Boolean);
        if (!sizes.length) continue;
        const busy = [a, b].some((body) => body.plugin && body.plugin.size && now - (body.plugin.lastHit || -1e9) < 320);
        for (const body of [a, b]) if (body.plugin && body.plugin.size) {
          body.plugin.flash = Math.min(1, impact / 9);
          body.plugin.lastHit = now;
        }
        if (busy) continue;
        audio.hit(Math.min.apply(null, sizes), impact, sizeRange);
      }
    });

    let acc = 0;
    const inst = {
      engine,
      options: opt,
      get shards() { return shards; },
      get state() { return state; },
      get crackProgress() { return state === 'cracking' ? crackT / opt.crackTime : state === 'broken' ? 1 : 0; },

      // x, y in circle units (-1..1). Anything outside is pulled to the rim.
      shatter(x, y) {
        if (state !== 'intact') return false;
        let px = x * REF, py = y * REF;
        const d = Math.hypot(px, py);
        if (d > REF * 0.82) { px *= (REF * 0.82) / d; py *= (REF * 0.82) / d; }
        pattern = buildPattern(px, py);
        state = 'cracking';
        crackT = 0;
        audio.shatter();
        return true;
      },

      reset() {
        for (const s of shards) M.Composite.remove(world, s);
        shards = [];
        pattern = null;
        state = 'intact';
        crackT = 0;
      },

      setGravity(g) { opt.gravity = g; },
      setRestitution(r) {
        opt.restitution = r;
        for (const s of shards) s.restitution = r;
      },
      setRays(n) { opt.rays = n; },

      // Which way is "down" inside the circle; the record's rotation feeds this in.
      setGravityAngle(a) { gravityAngle = a; },

      update(dt) {
        if (state === 'intact') return;
        if (state === 'cracking') {
          crackT += dt;
          if (crackT >= opt.crackTime) spawnPieces();
          return;
        }
        engine.gravity.x = Math.sin(gravityAngle) * opt.gravity;
        engine.gravity.y = Math.cos(gravityAngle) * opt.gravity;
        acc += Math.min(dt, 0.1);
        const step = 1 / 60;
        let guard = 0;
        while (acc >= step && guard++ < 4) {
          M.Engine.update(engine, step * 1000);
          acc -= step;
        }
        for (const s of shards) {
          if (s.plugin.flash) s.plugin.flash *= 0.86;
          // safety net: nothing may escape the pane's frame
          const limit = PANE - s.plugin.size * 0.3;
          const x = clamp(s.position.x, -limit, limit);
          const y = clamp(s.position.y, -limit, limit);
          if (x !== s.position.x || y !== s.position.y) {
            M.Body.setPosition(s, { x, y });
            M.Body.setVelocity(s, { x: s.velocity.x * -0.4, y: s.velocity.y * -0.4 });
          }
        }
      },

      // x, y in circle units (-1..1); pushes the shards away from that point
      impulse(x, y, strength) {
        if (state !== 'broken') return;
        const px = x * REF, py = y * REF;
        for (const s of shards) {
          const dx = s.position.x - px, dy = s.position.y - py;
          const d = Math.max(40, Math.hypot(dx, dy));
          const f = (strength * 0.00022 * s.mass * REF) / d;
          M.Body.applyForce(s, s.position, { x: (dx / d) * f, y: (dy / d) * f });
          M.Body.setAngularVelocity(s, s.angularVelocity + (Math.random() - 0.5) * strength * 0.1);
        }
      },

      shake(strength) {
        if (state !== 'broken') return;
        for (const s of shards) {
          M.Body.setVelocity(s, {
            x: s.velocity.x + (Math.random() - 0.5) * 14 * strength,
            y: s.velocity.y + (Math.random() - 0.5) * 14 * strength,
          });
        }
      },

      // ---------- drawing ----------
      render(ctx, cx, cy, radius, o) {
        o = o || {};
        const scale = radius / REF;
        const lightAngle = o.lightAngle == null ? -0.9 : o.lightAngle;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TAU);
        ctx.clip();
        ctx.fillStyle = o.background || '#ffffff';
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

        ctx.translate(cx, cy);
        ctx.scale(scale, scale);

        if (state === 'broken') {
          for (const s of shards) drawShard(ctx, s, lightAngle);
        } else {
          drawPane(ctx, lightAngle);
          if (state === 'cracking') drawCracks(ctx, crackT / opt.crackTime);
        }
        ctx.restore();

        // screen-space finish: grain, vignette
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TAU);
        ctx.clip();
        drawGrain(ctx, cx, cy, radius, o.grain == null ? 0.055 : o.grain);
        const vig = ctx.createRadialGradient(cx, cy, radius * 0.72, cx, cy, radius);
        vig.addColorStop(0, 'rgba(0,0,0,0)');
        vig.addColorStop(1, `rgba(10,20,14,${o.vignette == null ? 0.26 : o.vignette})`);
        ctx.fillStyle = vig;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        ctx.restore();
      },
    };

    // the unbroken pane: white, with a faint green-glass cast and a soft sheen
    function drawPane(ctx, lightAngle) {
      const lx = Math.cos(lightAngle), ly = Math.sin(lightAngle);
      const g = ctx.createLinearGradient(lx * REF, ly * REF, -lx * REF, -ly * REF);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.45, 'rgba(226,240,236,0.5)');
      g.addColorStop(1, 'rgba(201,228,220,0.75)');
      ctx.fillStyle = g;
      ctx.fillRect(-PANE, -PANE, PANE * 2, PANE * 2);

      // a broad specular sweep across the pane
      const s = ctx.createLinearGradient(lx * REF * 1.2, ly * REF * 1.2, -lx * REF * 0.2, -ly * REF * 0.2);
      s.addColorStop(0, 'rgba(255,255,255,0)');
      s.addColorStop(0.35, 'rgba(255,255,255,0.75)');
      s.addColorStop(0.62, 'rgba(255,255,255,0)');
      ctx.fillStyle = s;
      ctx.fillRect(-PANE, -PANE, PANE * 2, PANE * 2);

      // inner rim, where the glass sits behind the round window
      ctx.beginPath();
      ctx.arc(0, 0, REF - 3, 0, TAU);
      ctx.strokeStyle = 'rgba(150,196,185,0.45)';
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // the fracture drawing itself in, outwards from the impact
    function drawCracks(ctx, p) {
      if (!pattern) return;
      const im = pattern.impact;
      const reach = clamp(p * 1.35, 0, 1);

      const stroke = (path, width, colour, dx, dy) => {
        ctx.save();
        if (dx || dy) ctx.translate(dx || 0, dy || 0);
        ctx.beginPath();
        path();
        ctx.lineWidth = width;
        ctx.strokeStyle = colour;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      };
      // a crack reads as a dark split with a lit edge alongside it
      const crack = (path, scale) => {
        stroke(path, 7 * scale, 'rgba(120,180,170,0.22)');
        stroke(path, 2.4 * scale, 'rgba(38,104,94,0.85)');
        stroke(path, 1.1 * scale, 'rgba(255,255,255,0.95)', -1.6, -1.6);
      };

      // every edge of every shard, revealed as the fracture reaches it
      for (const e of pattern.edges) {
        if (e.d > reach) continue;
        const fade = clamp((reach - e.d) * 6, 0, 1);
        ctx.globalAlpha = fade;
        crack(() => { ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); }, 1);
        ctx.globalAlpha = 1;
      }

      // the fine hairline damage
      ctx.globalAlpha = clamp((reach - 0.2) * 2, 0, 1) * 0.8;
      for (const h of pattern.hairlines) {
        stroke(() => { ctx.moveTo(h[0].x, h[0].y); ctx.lineTo(h[1].x, h[1].y); }, 1.2, 'rgba(38,104,94,0.7)');
      }
      ctx.globalAlpha = 1;

      // the bright bloom at the point of impact
      const flash = Math.max(0, 1 - p * 1.6);
      const bloom = ctx.createRadialGradient(im.x, im.y, 0, im.x, im.y, 90 + 120 * p);
      bloom.addColorStop(0, `rgba(255,255,255,${0.5 + 0.5 * flash})`);
      bloom.addColorStop(0.5, `rgba(190,235,225,${0.3 * (1 - p)})`);
      bloom.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(im.x, im.y, 90 + 120 * p, 0, TAU);
      ctx.fill();
    }

    function shardPath(ctx, s) {
      const v = s.vertices;
      ctx.beginPath();
      ctx.moveTo(v[0].x, v[0].y);
      for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
      ctx.closePath();
    }

    // Each shard is drawn as a solid: a cast shadow, an extruded side, then a top face
    // split into facets that catch the light from different angles.
    function drawShard(ctx, s, lightAngle) {
      const p = s.plugin;
      const flash = p.flash || 0;
      const c = s.position;
      const v = s.vertices;
      const lx = Math.cos(lightAngle), ly = Math.sin(lightAngle);
      const depth = p.size * 0.2;

      ctx.save();
      ctx.translate(-lx * depth * 1.7, -ly * depth * 1.7);
      shardPath(ctx, s);
      ctx.fillStyle = 'rgba(18,30,24,0.16)';
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(-lx * depth, -ly * depth);
      shardPath(ctx, s);
      ctx.fillStyle = hexA(shade(p.colour, -0.55), 0.55);
      ctx.fill();
      ctx.strokeStyle = hexA(shade(p.colour, -0.7), 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        const mx = (a.x + b.x) / 2 - c.x, my = (a.y + b.y) / 2 - c.y;
        const len = Math.hypot(mx, my) || 1;
        const lambert = 0.5 + 0.5 * ((mx / len) * lx + (my / len) * ly);
        const tint = shade(p.colour, -0.3 + 0.5 * lambert);
        const g = ctx.createLinearGradient(c.x, c.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
        g.addColorStop(0, hexA(tint, 0.24));
        g.addColorStop(1, hexA(tint, 0.6));
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + 0.22 * lambert})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo((a.x + b.x) / 2, (a.y + b.y) / 2);
        ctx.stroke();
      }

      // chromatic aberration on the outline
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 2.4;
      const off = 1.6 + flash * 1.8;
      const rgb = ['rgba(255,60,60,0.3)', 'rgba(60,255,160,0.26)', 'rgba(80,120,255,0.3)'];
      const dirs = [[-off, -off * 0.4], [off * 0.5, off * 0.8], [off * 0.6, -off * 0.6]];
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.translate(dirs[i][0], dirs[i][1]);
        ctx.strokeStyle = rgb[i];
        shardPath(ctx, s);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      // bright rim on the lit edges, dark rim on the rest
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        const ex = b.x - a.x, ey = b.y - a.y;
        const el = Math.hypot(ex, ey) || 1;
        const nx = ey / el, ny = -ex / el;
        const lit = nx * lx + ny * ly;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = lit > 0 ? 2 : 1.2;
        ctx.strokeStyle = lit > 0
          ? `rgba(255,255,255,${0.35 + 0.5 * lit + flash * 0.3})`
          : `rgba(20,40,30,${0.12 - 0.12 * lit})`;
        ctx.stroke();
      }

      ctx.save();
      shardPath(ctx, s);
      ctx.clip();
      const a2 = p.sparkle + s.angle;
      const hx = Math.cos(a2) * p.size, hy = Math.sin(a2) * p.size;
      const hl = ctx.createLinearGradient(c.x - hx, c.y - hy, c.x + hx, c.y + hy);
      hl.addColorStop(0, 'rgba(255,255,255,0)');
      hl.addColorStop(0.42, `rgba(255,255,255,${0.3 + flash * 0.5})`);
      hl.addColorStop(0.55, 'rgba(255,255,255,0)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(c.x - p.size * 1.6, c.y - p.size * 1.6, p.size * 3.2, p.size * 3.2);
      ctx.restore();

      if (flash > 0.02) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        shardPath(ctx, s);
        ctx.fillStyle = `rgba(255,255,255,${flash * 0.3})`;
        ctx.fill();
        ctx.restore();
      }
    }

    function drawGrain(ctx, cx, cy, radius, alpha) {
      if (!alpha) return;
      if (!grain) {
        grain = [];
        for (let k = 0; k < 4; k++) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 96;
          const g2 = cv.getContext('2d');
          const img = g2.createImageData(96, 96);
          for (let i = 0; i < img.data.length; i += 4) {
            const v = 120 + Math.random() * 135;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
            img.data[i + 3] = 255;
          }
          g2.putImageData(img, 0, 0);
          grain.push(cv);
        }
      }
      grainIndex = (grainIndex + 1) % grain.length;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ctx.createPattern(grain[grainIndex], 'repeat');
      ctx.translate(cx - radius, cy - radius);
      ctx.fillRect(0, 0, radius * 2, radius * 2);
      ctx.restore();
    }

    return inst;
  };

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // amount > 0 lightens towards white, < 0 darkens towards black
  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (ch) => {
      const t = amount > 0 ? 255 : 0;
      return Math.round(ch + (t - ch) * Math.abs(amount));
    };
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }
})();
