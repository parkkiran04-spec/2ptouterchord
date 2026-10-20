// Main: layout, pointer routing, the frame loop, and wiring between modules.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const rec = DG.record, D = DG.drawing, T = DG.tonearm, S = DG.sequencer, A = DG.audio, St = DG.storage, UI = DG.ui, art = DG.artwork;

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('stageWrap');

  let W = 0, H = 0, dpr = 1;
  let stage = null;
  let ripples = [];
  let visuals = [];
  let needlePulse = 0;
  let bandAlpha = 0;
  let activePointer = null;
  let pointerMode = null;
  let lastNoise = -1;
  let frameHold = 0;
  let nextHold = 0;
  let blClock = 0;
  DG.stats = { frames: 0, renders: 0 }; // frames run the music, renders draw the picture
  let lastFrame = performance.now();
  let stageDirty = false;

  // Quality, stepped down by shared/perf.js on screens that can't keep up
  // (TVs, kiosk tablets): the canvas resolution, and from level 2 the wide
  // outer glow on lines that have just sounded.
  const QUALITY = [
    { scale: 1,   wideGlow: true },
    { scale: .85, wideGlow: true },
    { scale: .7,  wideGlow: false },
    { scale: .55, wideGlow: false },
  ];
  DG.quality = QUALITY[0];

  // ---------- layout ----------
  function resize() {
    const r = wrap.getBoundingClientRect();
    // The stage can measure zero while the page is still laying out (or while hidden);
    // a ResizeObserver calls back once it has a real size.
    if (r.width < 8 || r.height < 8) return;
    W = r.width;
    H = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5) * DG.quality.scale;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    const view = art.setView(W, H, dpr);
    rec.layout(view.cx, view.cy, view.radius, dpr);
    T.layout();
    D.resize();
    stage = renderStage();
  }

  // background + pan, cached because they never move
  function renderStage() {
    const cv = document.createElement('canvas');
    cv.width = canvas.width;
    cv.height = canvas.height;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    art.drawStage(c, W, H);
    return cv;
  }

  // ---------- pointer ----------
  const localPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Every pointer event stirs the inner windows, wherever it lands on the stage.
  let lastMove = null;
  function stir(p, click) {
    const q = rec.toRecord(p.x, p.y);
    let strength = click ? 1 : 0.06;
    if (!click && lastMove) {
      const moved = Math.hypot(p.x - lastMove.x, p.y - lastMove.y);
      strength = Math.max(0.05, Math.min(1, moved / (0.12 * rec.radius)));
    }
    lastMove = p;
    art.react(q.rn, q.t, strength, click);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (activePointer !== null || e.button > 0) return;
    A.init().then(startGlassAudio);
    UI.closePanel();
    const p = localPoint(e);
    stir(p, true);
    if (T.hitTest(p.x, p.y)) {
      pointerMode = 'arm';
      T.startDrag(p.x, p.y);
      canvas.style.cursor = 'grabbing';
    } else if (rec.inDrawable(p.x, p.y)) {
      pointerMode = 'draw';
      D.begin(p.x, p.y);
    } else {
      return;
    }
    activePointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e);
    stir(p, false);
    if (e.pointerId !== activePointer) {
      if (activePointer === null && e.pointerType === 'mouse') {
        canvas.style.cursor = T.hitTest(p.x, p.y) ? 'grab' : rec.inDrawable(p.x, p.y) ? 'crosshair' : '';
      }
      return;
    }
    if (pointerMode === 'arm') {
      T.drag(p.x, p.y);
    } else if (pointerMode === 'draw') {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (list.length) for (const ce of list) { const q = localPoint(ce); D.move(q.x, q.y); }
      else D.move(p.x, p.y);
    }
  });

  const endPointer = (e) => {
    if (e.pointerId !== activePointer) return;
    if (pointerMode === 'arm') T.endDrag();
    else if (pointerMode === 'draw') D.end();
    activePointer = null;
    pointerMode = null;
    canvas.style.cursor = '';
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);

  // ---------- tonearm events ----------
  T.onLand = () => {
    A.thump();
    A.setCrackle(true);
    needlePulse = 1;
    DG.memory.add('needle', { down: true, radius: Math.round(T.needleR() * 100) / 100 });
    // dropping the needle also breaks the glass, struck from the needle's side
    const n = T.needlePolar();
    const w = art.windows[2];
    const hit = rec.toRecord(n.x, n.y);
    const x = (hit.rn * Math.cos(hit.t) - w.ox) / w.r;
    const y = (hit.rn * Math.sin(hit.t) - w.oy) / w.r;
    art.shatterGlass(x, y);
  };
  T.onLift = () => {
    A.dust();
    A.setCrackle(false);
    DG.memory.add('needle', { down: false });
  };

  art.onBeat = (strong, intensity) => {
    A.heartbeat(strong, intensity);
    DG.memory.add('heart', { strong, intensity: Math.round(intensity * 100) / 100 });
  };

  // The glass shards synthesise their own collisions; they share Tone's audio context.
  function startGlassAudio() {
    if (!DG.glass || !DG.glass.available || !window.Tone) return;
    const raw = Tone.getContext().rawContext;
    if (!raw) return;
    DG.glass.audio.init(raw._nativeAudioContext || raw._context || raw);
    DG.glass.audio.setLevel(cfg.audio.glass);
  }

  // ---------- notes ----------
  function onNote(e, step, time, dur, play) {
    if (play) {
      const inst = cfg.brushes[e.brush].instrument;
      const midi = S.midiFor(e.lane, e.brush);
      A.play(inst, midi, time, dur, e.vel);
      DG.memory.note({ inst, midi, lane: e.lane, step, vel: e.vel, dur });
    }
    visuals.push({ time, e, step, play });
  }

  function flushVisuals() {
    if (!visuals.length) return;
    const now = A.currentTime();
    const rest = [];
    for (const v of visuals) {
      if (v.time > now + 0.01) { rest.push(v); continue; }
      const s = D.byId(v.e.sid);
      if (s) s.glow = 1;
      if (v.play) {
        ripples.push({ rn: rec.laneCenter(v.e.lane), t: -v.step * rec.stepAngle(), color: cfg.brushes[v.e.brush].color, age: 0, life: 1.1 });
        needlePulse = Math.min(1, needlePulse + 0.5);
      }
    }
    visuals = rest;
    if (ripples.length > 80) ripples.splice(0, ripples.length - 80);
  }

  function updateEffects(dt) {
    D.updateEffects(dt);
    art.update(dt);
    // the frame lines run out while the record turns, and draw back in when it stops
    const target = T.isReading() ? 1 : 0;
    const tau = target > art.lineGrowth ? cfg.background.growTime : cfg.background.shrinkTime;
    const next = art.lineGrowth + (target - art.lineGrowth) * (1 - Math.exp(-dt / tau));
    if (Math.abs(next - art.lineGrowth) > 0.002) {
      art.lineGrowth = next;
      stageDirty = true;   // redrawn with the next picture, not on every frame in between
    }
    for (const r of ripples) r.age += dt;
    ripples = ripples.filter((r) => r.age < r.life);
    needlePulse *= Math.exp(-dt * 5);
    const bandTarget = T.isOnRecord() && T.lift < 0.5 ? 1 : 0;
    bandAlpha += (bandTarget - bandAlpha) * (1 - Math.exp(-dt / 0.2));
  }

  // ---------- rendering ----------
  function renderRipples(c) {
    const R = rec.radius;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const r of ripples) {
      const k = r.age / r.life;
      const ease = 1 - Math.pow(1 - k, 3);
      const x = r.rn * R * Math.cos(r.t), y = r.rn * R * Math.sin(r.t);
      const rad = (0.015 + 0.085 * ease) * R;
      c.strokeStyle = art.mono ? '#ffffff' : r.color;
      c.globalAlpha = (1 - k) * 0.75;
      c.lineWidth = 0.5 + 2 * (1 - k);
      c.beginPath();
      c.arc(x, y, rad, 0, TAU);
      c.stroke();
      c.globalAlpha = (1 - k) * 0.4;
      c.beginPath();
      c.arc(x, y, rad * 0.58, 0, TAU);
      c.stroke();
    }
    c.restore();
  }

  function renderBand(c) {
    if (bandAlpha < 0.01) return;
    const { lo, hi } = S.readRange(T.needleR());
    const R = rec.radius;
    const outer = (cfg.geometry.drawMax - lo * rec.laneWidth()) * R;
    const inner = (cfg.geometry.drawMax - (hi + 1) * rec.laneWidth()) * R;
    const n = T.needlePolar();
    c.save();
    c.globalAlpha = bandAlpha;
    c.strokeStyle = 'rgba(115,186,156,0.45)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(rec.cx, rec.cy, outer, 0, TAU);
    c.stroke();
    c.beginPath();
    c.arc(rec.cx, rec.cy, inner, 0, TAU);
    c.stroke();
    // Brighter window at the needle, fading away to both sides along the groove.
    const peak = 0.1 + needlePulse * 0.11;
    const spread = 0.5; // radians to each side
    c.beginPath();
    c.arc(rec.cx, rec.cy, outer, n.angle - spread, n.angle + spread);
    c.arc(rec.cx, rec.cy, inner, n.angle + spread, n.angle - spread, true);
    c.closePath();
    if (c.createConicGradient) {
      const g = c.createConicGradient(n.angle - spread, rec.cx, rec.cy);
      const f = (spread * 2) / TAU; // share of the circle the window covers
      g.addColorStop(0, 'rgba(115,186,156,0)');
      g.addColorStop(f * 0.3, `rgba(115,186,156,${peak * 0.45})`);
      g.addColorStop(f * 0.5, `rgba(115,186,156,${peak})`);
      g.addColorStop(f * 0.7, `rgba(115,186,156,${peak * 0.45})`);
      g.addColorStop(f, 'rgba(115,186,156,0)');
      g.addColorStop(1, 'rgba(115,186,156,0)');
      c.fillStyle = g;
    } else {
      c.fillStyle = `rgba(115,186,156,${peak * 0.7})`;
    }
    c.fill();
    c.restore();
  }

  // Ring that fills while holding, showing when a dot turns into a line.
  function renderPressRing(c) {
    const pr = D.pressProgress();
    if (!pr || pr.elapsed < 250) return;
    const R = rec.radius;
    const rad = Math.max(14, 0.06 * R);
    c.save();
    c.globalAlpha = Math.min(1, (pr.elapsed - 250) / 250);
    c.lineCap = 'round';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.beginPath();
    c.arc(pr.x, pr.y, rad, 0, TAU);
    c.stroke();
    c.strokeStyle = art.mono ? '#ffffff' : cfg.brushes[D.brushIndex].color;
    c.beginPath();
    c.arc(pr.x, pr.y, rad, -Math.PI / 2, -Math.PI / 2 + pr.k * TAU);
    c.stroke();
    c.restore();
  }

  function render() {
    if (W < 8 || H < 8) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (stageDirty) { stage = renderStage(); stageDirty = false; }
    if (stage) ctx.drawImage(stage, 0, 0, W, H);
    rec.render(ctx, (c) => {
      D.render(c);
      renderRipples(c);
    });
    renderBand(ctx);
    renderPressRing(ctx);
    T.draw(ctx, needlePulse);
    art.drawGraphs(ctx, A.waveform());
  }

  // ---------- hint ----------
  function updateHint() {
    const crowded = S.occupancy > cfg.crowdedRatio || S.totalPoints > cfg.maxPoints;
    if (art.missing.length) UI.setHint('artwork missing: ' + art.missing[0], true);
    else if (!A.available) UI.setHint('Tone.js could not load — check your internet connection', true);
    else if (crowded) UI.setHint('The record is too crowded — leave some room to breathe', true);
    else if (T.state === 'dragging') UI.setHint('let go over the record to drop the needle');
    else if (T.isOnRecord()) UI.setHint('lift the needle to stop · keep drawing while it spins');
    else if (D.current) UI.setHint('drawing a line — let go to finish');
    else if (!D.strokes.length) UI.setHint('tap for a dot · hold 1s to draw a line');
    else UI.setHint('drag the needle onto the record');
  }

  // ---------- loop ----------
  // Every few seconds the picture drops to the "bl" state — black ground, white line
  // art — for a couple of seconds. Everything keeps running underneath.
  function updateBlState(dt) {
    blClock += dt;
    const period = cfg.bl.every + cfg.bl.hold;
    const active = cfg.bl.enabled && (blClock % period) >= cfg.bl.every;
    if (active === art.mono) return;
    art.mono = active;
    D.mono = active;
    D.layerDirty = true;       // the cached ink is a different colour now
    stageDirty = true;
    document.body.classList.toggle('bl', active);
  }

  function frame(now) {
    perf.tick(now);
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    updateBlState(dt);

    const target = rec.targetSpeed();
    const sweepSpeed = cfg.sweepLanesPerRev * rec.laneWidth() * (rec.omega / TAU);
    T.update(dt, sweepSpeed);
    // nothing turns until the glass has broken; then the record eases into its turn
    rec.target = T.isOnRecord() && !art.glassHoldsRecord() ? target : 0;

    const rotPrev = rec.rot;
    rec.update(dt);
    D.tick();
    if (S.dirty) S.rebuild(D.strokes);

    // the inner windows as a background layer of the music
    art.ambient = T.isReading();
    const noiseLevel = T.isReading() ? 0.3 + 0.7 * art.noiseEnergy() : 0;
    if (A.ready && Math.abs(noiseLevel - lastNoise) > 0.02) {
      A.setNoiseBed(noiseLevel);
      lastNoise = noiseLevel;
    }

    const ratio = target > 0 ? rec.omega / target : 0;
    if (A.ready && T.isReading() && ratio >= cfg.minReadSpeed) {
      A.setDetune(Math.max(-650, 1200 * Math.log2(Math.min(1, ratio))));
      S.process(rotPrev, rec.rot, dt, T.needlePolar(), rec.omega, A.now() + cfg.audio.lookahead, onNote);
    }

    flushVisuals();
    updateEffects(dt);
    DG.memory.tick();
    // Everything above runs every frame — only the picture is held, so the music keeps
    // its timing while the turntable moves in stop-motion steps.
    frameHold += dt;
    DG.stats.frames++;
    if (cfg.motion !== 'stop' || frameHold >= nextHold) {
      frameHold = 0;
      DG.stats.renders++;
      const j = cfg.stopMotionJitter;
      nextHold = (1 / cfg.stopMotionFps) * (1 - j / 2 + Math.random() * j);
      render();
    }
    updateHint();
    requestAnimationFrame(frame);
  }

  // ---------- UI wiring ----------
  function applyLoaded(data) {
    if (data.key && cfg.keys.includes(data.key)) cfg.key = data.key;
    if (data.scale && cfg.scales[data.scale]) cfg.scale = data.scale;
    D.setStrokes(data.strokes);
    UI.syncSettings();
  }

  // No pickers any more: every record gets a random key and scale.
  function randomizeMusic() {
    const names = Object.keys(cfg.scales);
    cfg.key = cfg.keys[Math.floor(Math.random() * cfg.keys.length)];
    cfg.scale = names[Math.floor(Math.random() * names.length)];
  }
  randomizeMusic();

  UI.init({
    onMode: (m) => { cfg.mode = m; T.syncSweep(); },
    onBand: (b) => { cfg.band = b; },
    onTempo: (v) => { cfg.speedMultiplier = v; },
    onMotion: (m) => { cfg.motion = m; frameHold = nextHold; },
    onSteps: (n) => { cfg.steps = n; S.invalidateAll(D.strokes); },
    onUndo: () => D.undo(),
    onClear: () => { D.clear(); ripples = []; art.resetGlass(); randomizeMusic(); },
    onPreset: (name) => {
      D.setStrokes(St.presets[name]());
      UI.toast(`Preset: ${name}`);
    },
    onSave: () => UI.toast(St.save(D.strokes) ? 'Saved to this browser' : 'Could not save'),
    onLoad: () => {
      const data = St.load();
      if (!data) return UI.toast('Nothing saved yet');
      applyLoaded(data);
      UI.toast('Loaded');
    },
    onShare: async () => {
      const hash = await St.makeShareHash(D.strokes);
      history.replaceState(null, '', hash);
      try {
        await navigator.clipboard.writeText(location.href);
        UI.toast('Link copied');
      } catch (err) {
        UI.toast('Link is in the address bar');
      }
    },
    onRecord: async () => {
      const res = await A.toggleRecording();
      if (!res) return;
      if (res.error) return UI.toast(res.error);
      UI.setRecording(res.recording);
      if (res.blob) {
        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'drawn-groove.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        UI.toast('Recording saved');
      } else {
        UI.toast('Recording… press again to save');
      }
    },
  });

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(wrap);

  // picks the starting quality (remembered per device) and sizes the canvas
  const perf = window.XGPerf
    ? XGPerf.create({ key: 'e', onLevel: (lv) => { DG.quality = QUALITY[lv]; resize(); } })
    : { tick() {}, level: 0 };
  DG.perf = perf;
  resize();
  art.load().then(() => {
    resize();
    if (art.missing.length) console.warn('[artwork] missing files', art.missing);
  });
  if (location.hash.startsWith('#g=')) {
    St.readShareHash(location.hash)
      .then((data) => { if (data) { applyLoaded(data); UI.toast('Shared record loaded'); } })
      .catch(() => UI.toast('Could not read the shared link'));
  }
  requestAnimationFrame(frame);
})();
