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
    points.forEach(([xPct, yPct]) => {
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
