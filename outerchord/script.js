(() => {
  const scene = document.getElementById('scene');
  const world = document.getElementById('world');
  const beamRig = document.getElementById('beamRig');
  const ringRig = document.getElementById('ringRig');
  const biomorphicRig = document.getElementById('biomorphicRig');
  const glyphsRig = document.getElementById('glyphsRig');
  const astronautRig = document.getElementById('astronautRig');
  const sparkleHost = document.getElementById('sparkles');

  // reveal the composition once assets are ready
  window.addEventListener('load', () => {
    requestAnimationFrame(() => scene.classList.add('loaded'));
  });
  // fallback in case 'load' is slow/blocked
  setTimeout(() => scene.classList.add('loaded'), 1200);

  // ---------- synthetic star twinkle ----------
  // one point per star/dot/bubble actually present in 06-scatter-dust.png
  // (baked into STAR_POINTS by a one-off pixel scan — see stars-data.js),
  // each blinking on its own random schedule. The flash is a short spike
  // in a long cycle, so out of 300 points only a handful are ever lit at
  // once. Each star sits at its own fixed random depth (a static
  // translateZ, set once below, never animated) so the field reads as a
  // volume rather than a flat sheet — the blink itself only ever touches
  // opacity, never size. Every point renders at the same small size — a
  // single star's size in the source art — regardless of how big the
  // blob it was detected from was (the big bubbles included).
  const SPARKLE_SIZE_PX = 2.5;

  (function buildSparkles() {
    const points = (typeof STAR_POINTS !== 'undefined') ? STAR_POINTS : [];
    const frag = document.createDocumentFragment();
    points.forEach(([xPct, yPct], i) => {
      const s = document.createElement('div');
      s.className = 'sparkle';
      const dur = 4 + Math.random() * 7;
      const delay = -Math.random() * dur; // stagger so they don't sync on load
      const z = -260 + Math.random() * 420; // fixed depth, spread through the scene

      s.style.left = xPct + '%';
      s.style.top = yPct + '%';
      s.style.transform = `translateZ(${z.toFixed(0)}px)`;
      s.style.setProperty('--size', SPARKLE_SIZE_PX + 'px');
      s.style.setProperty('--dur', dur.toFixed(2) + 's');
      s.style.setProperty('--delay', delay.toFixed(2) + 's');
      frag.appendChild(s);

      // a sparse subset of stars also get a soft chime timed to their
      // visual peak (the keyframe's 50% mark) — every star chiming would
      // be chaotic with 300 of them, so only every 15th one is wired up
      if (window.OuterchordAudio && i % 15 === 0) {
        const localTimeAtLoad = -delay;              // where in its cycle it already is at t=0
        const peakLocal = dur * 0.5;
        let firstPeakIn = peakLocal - localTimeAtLoad;
        if (firstPeakIn < 0) firstPeakIn += dur;
        const freq = window.OuterchordAudio.SCALE_HZ[
          window.OuterchordAudio.noteIndexFromX(xPct / 100)
        ];
        setTimeout(function chime() {
          const A = window.OuterchordAudio;
          if (A && A.ctxReady()) {
            A.playBlip({ freq, type: 'sine', duration: 0.5, peakGain: 0.035, brightness: 0.4 });
            A.logEvent({ type: 'star-twinkle', freq, x: xPct, y: yPct, t: Date.now() });
          }
          setTimeout(chime, dur * 1000);
        }, Math.max(0, firstPeakIn * 1000));
      }
    });
    sparkleHost.appendChild(frag);
  })();

  // ---------- pointer tracking (shared by everything below) ----------
  let targetX = 0, targetY = 0; // -1..1
  let curX = 0, curY = 0;

  function setFromPointer(x, y) {
    const r = scene.getBoundingClientRect();
    targetX = ((x - r.left) / r.width - 0.5) * 2;
    targetY = ((y - r.top) / r.height - 0.5) * 2;
  }

  window.addEventListener('pointermove', (e) => setFromPointer(e.clientX, e.clientY));

  // gentle device-tilt parallax for mobile
  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || e.beta == null) return;
    targetX = Math.max(-1, Math.min(1, e.gamma / 28));
    targetY = Math.max(-1, Math.min(1, (e.beta - 40) / 28));
  });

  // ---------- interactive sound: click-and-hold notes, hover blips ----------
  // click position picks the pitch (x) and brightness (y); how long the
  // button stays down becomes the note's length, exactly like plucking a
  // string and letting it ring for as long as you hold it.
  const Audio = window.OuterchordAudio;
  let heldTone = null;
  let heldStartTime = 0;
  let lastHoverIndex = null;

  function normFromEvent(e) {
    const r = scene.getBoundingClientRect();
    return {
      xNorm: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      yNorm: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }

  window.addEventListener('pointerdown', (e) => {
    if (!Audio) return;
    Audio.ensureStarted();
    Audio.resumeIfNeeded();
    const { xNorm, yNorm } = normFromEvent(e);
    const idx = Audio.noteIndexFromX(xNorm);
    const freq = Audio.SCALE_HZ[idx];
    heldStartTime = performance.now();
    heldTone = Audio.startTone({ freq, type: 'triangle', brightness: 1 - yNorm, peakGain: 0.16 });
    heldTone._freq = freq; heldTone._x = xNorm; heldTone._y = yNorm;
  });

  window.addEventListener('pointerup', () => {
    if (!heldTone) return;
    const heldSeconds = (performance.now() - heldStartTime) / 1000;
    heldTone.release(Math.max(0.1, Math.min(2.5, heldSeconds)));
    Audio.logEvent({
      type: 'click', freq: heldTone._freq, x: heldTone._x, y: heldTone._y,
      duration: Math.max(0.1, Math.min(2.5, heldSeconds)), t: Date.now(),
    });
    heldTone = null;
  });

  // brushing the pointer across the scene plays the note under it, but
  // only when it crosses into a new one — not continuously
  window.addEventListener('pointermove', (e) => {
    if (!Audio || !Audio.ctxReady() || heldTone) return;
    const { xNorm, yNorm } = normFromEvent(e);
    const idx = Audio.noteIndexFromX(xNorm);
    if (idx === lastHoverIndex) return;
    lastHoverIndex = idx;
    const freq = Audio.SCALE_HZ[idx];
    Audio.playBlip({ freq, type: 'sine', duration: 0.16, peakGain: 0.05, brightness: 1 - yNorm });
    Audio.logEvent({ type: 'hover', freq, x: xNorm, y: yNorm, t: Date.now() });
  });

  // ---------- per-frame motion ----------
  const WORLD_TILT_X_DEG = 4.5;   // whole-scene 3D tilt (world only, never the backdrop)
  const WORLD_TILT_Y_DEG = 7;
  const BEAM_SKEW_MAX_DEG = 10;   // beam: apex pinned, base swings sideways

  // ring: spins edge-on around its vertical axis, like a coin standing on
  // a table being spun left/right — a constant idle turn that the pointer
  // speeds up, slows down, or reverses, rather than a push front-to-back
  const RING_SPIN_BASE_DEG = 0.12;   // deg/frame, keeps it turning at rest
  const RING_SPIN_MOUSE_DEG = 0.45;  // deg/frame added at full pointer deflection
  let ringSpinDeg = 0;

  // tremble: every layer gets a small random offset held for a short
  // spell then re-rolled, instead of re-randomized every frame — held
  // steps read as a gentle shiver rather than a smooth wobble or a buzz.
  // Each layer keeps its own independent timer and amount so they never
  // drift in sync with one another.
  function makeJitter(amountPx, intervalMs) {
    let x = 0, y = 0, nextAt = 0;
    return (now) => {
      if (now >= nextAt) {
        // jitter the interval too, so layers desync further over time
        nextAt = now + intervalMs * (0.75 + Math.random() * 0.5);
        x = (Math.random() * 2 - 1) * amountPx;
        y = (Math.random() * 2 - 1) * amountPx;
      }
      return [x, y];
    };
  }

  const jitterBiomorphic = makeJitter(2.2, 90);
  const jitterRing       = makeJitter(1.6, 100);
  const jitterGlyphs     = makeJitter(2.0, 80);
  const jitterAstronaut  = makeJitter(1.3, 140);
  const jitterBeam       = makeJitter(1.4, 95);

  // sound tied to the scene's own motion, not just to clicks: a soft
  // tick every half-turn of the ring, and a soft whoosh whenever the
  // beam's sway reverses direction (with a dead zone around centre so
  // it doesn't chatter on small pointer jitter)
  let lastRingHalfTurn = 0;
  let lastBeamSign = 0;
  const BEAM_WHOOSH_DEADZONE = 0.12;

  function raf(now) {
    curX += (targetX - curX) * 0.07;
    curY += (targetY - curY) * 0.07;

    scene.style.setProperty('--mx', curX.toFixed(4));
    scene.style.setProperty('--my', curY.toFixed(4));

    world.style.transform =
      `rotateX(${(-curY * WORLD_TILT_X_DEG).toFixed(3)}deg) rotateY(${(curX * WORLD_TILT_Y_DEG).toFixed(3)}deg)`;

    const [bjx, bjy] = jitterBeam(now);
    beamRig.style.transform = `translate(${bjx.toFixed(2)}px, ${bjy.toFixed(2)}px) skewX(${(curX * BEAM_SKEW_MAX_DEG).toFixed(3)}deg)`;

    ringSpinDeg += RING_SPIN_BASE_DEG + curX * RING_SPIN_MOUSE_DEG;
    const [rjx, rjy] = jitterRing(now);
    ringRig.style.transform = `translate(${rjx.toFixed(2)}px, ${rjy.toFixed(2)}px) rotateY(${ringSpinDeg.toFixed(2)}deg)`;

    if (Audio && Audio.ctxReady()) {
      const halfTurn = Math.floor(ringSpinDeg / 180);
      if (halfTurn !== lastRingHalfTurn) {
        lastRingHalfTurn = halfTurn;
        Audio.playBlip({ freq: 1200, type: 'square', duration: 0.05, peakGain: 0.02, brightness: 0.3 });
        Audio.logEvent({ type: 'ring-tick', deg: ringSpinDeg, t: Date.now() });
      }
      if (Math.abs(curX) > BEAM_WHOOSH_DEADZONE) {
        const sign = curX > 0 ? 1 : -1;
        if (sign !== lastBeamSign && lastBeamSign !== 0) {
          Audio.playWhoosh({ brightness: (curY + 1) / 2, peakGain: 0.045, duration: 0.3 });
          Audio.logEvent({ type: 'beam-whoosh', x: curX, y: curY, t: Date.now() });
        }
        lastBeamSign = sign;
      }
    }

    const [bix, biy] = jitterBiomorphic(now);
    biomorphicRig.style.transform = `translate(${bix.toFixed(2)}px, ${biy.toFixed(2)}px)`;

    const [gx, gy] = jitterGlyphs(now);
    glyphsRig.style.transform = `translate(${gx.toFixed(2)}px, ${gy.toFixed(2)}px)`;

    const [ax, ay] = jitterAstronaut(now);
    astronautRig.style.transform = `translate(${ax.toFixed(2)}px, ${ay.toFixed(2)}px)`;

    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
})();
