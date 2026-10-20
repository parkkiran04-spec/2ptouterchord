/* The index's moving ground, for any other page that wants it.

   Same layers, same intro, same motion as the main page (index.html keeps
   its own copy, tied into its card fan): the cracked-glass plate, then
   stars, bubbles and pixels from the "end" sheet, each moving on a slow,
   uneven stop-motion beat with a little parallax against the pointer.

     XGBackdrop.mount({ root: '../', logo: someImg, paused: () => false });

   root   path to the site root (where main-assets/ lives)
   logo   optional element that stutters now and then, as the index's does
   paused optional function; while it returns true the layers hold still
   Needs GSAP loaded first. */
(function () {
  'use strict';

  function mount(opt) {
    opt = opt || {};
    const root = opt.root || '';
    const css = document.createElement('style');
    css.textContent = `
      .xg-backdrop{ position:fixed; inset:0; z-index:0; background:#191818; overflow:hidden; pointer-events:none; }
      .xg-backdrop .layer{ position:absolute; inset:-12%; background-position:center; background-size:cover;
        background-repeat:no-repeat; will-change:transform, opacity; opacity:0; }
      .xg-backdrop .layer--plate { background-image:url('${root}main-assets/plate.jpg'); }
      .xg-backdrop .layer--star  { background-image:url('${root}main-assets/star.png'); }
      .xg-backdrop .layer--bubble{ background-image:url('${root}main-assets/bubble.png'); }
      .xg-backdrop .layer--pixel { background-image:url('${root}main-assets/pixel.png'); }
      @media (prefers-reduced-motion: reduce){ .xg-backdrop .layer{ opacity:1; } }`;
    document.head.appendChild(css);

    const box = document.createElement('div');
    box.className = 'xg-backdrop';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<div class="layer layer--plate"></div><div class="layer layer--star"></div>' +
                    '<div class="layer layer--bubble"></div><div class="layer layer--pixel"></div>';
    document.body.insertBefore(box, document.body.firstChild);

    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !window.gsap) {
      box.querySelectorAll('.layer').forEach(l => (l.style.opacity = 1));
      return;
    }

    const layer = name => box.querySelector('.layer--' + name);
    const L = { plate: layer('plate'), star: layer('star'), bubble: layer('bubble'), pixel: layer('pixel') };

    // what the intro drives; the loop reads it on every beat
    const intro = { plate: 0, plateScale: 1.07, star: 0, bubble: 0, pixel: 0 };
    gsap.timeline()
      .to(intro, { plate: 1, plateScale: 1, duration: 1.0, ease: 'steps(8)' }, 0)
      .to(intro, { star: 1, duration: 1.2, ease: 'steps(10)' }, .3)
      .to(intro, { bubble: 1, duration: 1.3, ease: 'steps(12)' }, .55)
      .to(intro, { pixel: 1, duration: .45, ease: 'steps(4)' }, 1.35);

    const BG_FPS = 12;
    const jit = a => (Math.random() * 2 - 1) * a;
    const wave = (time, period) => Math.sin(time * 2 * Math.PI / period);
    const par = { x: 0, y: 0, tx: 0, ty: 0 };
    const PARALLAX_X = 2.0;   // in vw
    const PARALLAX_Y = 3.2;   // in vh
    const pixelGlitch = { until: 0, next: 2.8, dx: 0, dy: 0, hide: false };
    const logoGlitch = { until: 0, next: 5 };
    let bgBeat = 0;

    window.addEventListener('pointermove', e => {
      par.tx = e.clientX / window.innerWidth * 2 - 1;
      par.ty = e.clientY / window.innerHeight * 2 - 1;
    }, { passive: true });

    // one pixel square of the artwork in screen px (23px on the 2000px sheet)
    const pixelCell = () => Math.max(L.pixel.offsetWidth, L.pixel.offsetHeight * 16 / 9) * 23 / 2000;

    function draw(time) {
      const vw = window.innerWidth / 100, vh = window.innerHeight / 100;
      const px = depth => -par.x * depth * PARALLAX_X * vw;
      const py = depth => -par.y * depth * PARALLAX_Y * vh;
      par.x += (par.tx - par.x) * .3;
      par.y += (par.ty - par.y) * .3;

      gsap.set(L.plate, { x: px(.35), y: py(.35), scale: intro.plateScale * (1 + .012 * wave(time, 22)), opacity: intro.plate });
      gsap.set(L.star, { x: px(.8) + wave(time, 41) * .9 * vw, y: py(.8) + wave(time + 9, 57) * .5 * vh,
                         opacity: intro.star * (.86 + Math.random() * .14) });
      const b = intro.bubble;
      gsap.set(L.bubble, { x: px(1.4) + jit(1.3), y: py(1.4) + jit(1.3), scale: 1 + .02 * wave(time, 7),
                           rotation: .6 * wave(time, 19), opacity: b > 0 ? 1 : 0,
                           clipPath: b < 1 ? `circle(${(b * 75).toFixed(1)}% at 50% 50%)` : 'none' });

      if (time > pixelGlitch.next) {
        const c = pixelCell();
        pixelGlitch.until = time + .12 + Math.random() * .28;
        pixelGlitch.next = time + 2 + Math.random() * 3.8;
        pixelGlitch.dx = c * Math.round(jit(2.4));
        pixelGlitch.dy = c * Math.round(jit(1.4));
        pixelGlitch.hide = Math.random() < .3;
      }
      const glitching = time < pixelGlitch.until;
      gsap.set(L.pixel, { x: px(2.1) + (glitching ? pixelGlitch.dx : 0), y: py(2.1) + (glitching ? pixelGlitch.dy : 0),
                          opacity: intro.pixel * (glitching && pixelGlitch.hide ? 0 : 1) });

      if (opt.logo) {
        if (time > logoGlitch.next) { logoGlitch.until = time + .1 + Math.random() * .14; logoGlitch.next = time + 4 + Math.random() * 6; }
        const stutter = time < logoGlitch.until;
        gsap.set(opt.logo, { x: stutter ? jit(7) : 0, skewX: stutter ? jit(10) : 0, opacity: stutter && Math.random() < .4 ? .4 : 1 });
      }
    }

    gsap.ticker.add(time => {
      if (time < bgBeat) return;
      bgBeat = time + (1 / BG_FPS) * (1 + jit(.2));
      if (document.hidden || (opt.paused && opt.paused())) return;
      draw(time);
    });
  }

  window.XGBackdrop = { mount };
})();
