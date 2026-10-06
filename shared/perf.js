/* Quality governor for the heavier pieces.

   A piece calls perf.tick(timestamp) once per animation frame. When frames
   keep arriving slower than ~30 a second the quality level goes up a step
   (0 = full, 3 = lightest); when they come back comfortably fast it steps
   back down. What each level means is up to the piece (onLevel).

   The level a device settles on is remembered in localStorage, so a slow
   screen (a TV, a kiosk tablet) starts the next visit already light instead
   of stuttering for the first few seconds again.

   ?lite=0 … ?lite=3 in the address pins a level and turns the automatic
   part off — handy for trying a piece on a particular device.

     const perf = XGPerf.create({ key: 'tenshi', onLevel: lv => { ... } });
     function frame(ts){ perf.tick(ts); ... }
     perf.level  // current level */
(function () {
  'use strict';

  const MAX = 3;
  const SLOW_MS = 34;      // average frame interval that counts as struggling (< ~30fps)
  const FAST_MS = 19;      // … and as comfortably fast (> ~52fps)
  const SETTLE_MS = 2500;  // how long to watch after a change before judging again
  const RECOVER_MS = 9000; // how long it has to stay fast before stepping back up

  function readForced() {
    const m = /[?&]lite=(\d)/.exec(location.search);
    return m ? Math.min(MAX, +m[1]) : null;
  }

  function create(opt) {
    const key = 'xg.perf.' + opt.key;
    const forced = readForced();
    let stored = 0;
    try { stored = Math.min(MAX, Math.max(0, parseInt(localStorage.getItem(key), 10) || 0)); } catch (e) { /* storage blocked */ }

    const self = {
      level: forced != null ? forced : stored,
      auto: forced == null,
      fps: 0,
      tick,
      set,
    };

    let last = 0, ema = 16.7, since = 0, fastSince = 0;

    function set(lv, remember) {
      lv = Math.max(0, Math.min(MAX, lv));
      if (lv === self.level) return;
      self.level = lv;
      if (remember) { try { localStorage.setItem(key, String(lv)); } catch (e) { /* ignore */ } }
      if (opt.onLevel) opt.onLevel(lv);
    }

    function tick(ts) {
      if (!last) { last = ts; since = ts; return; }
      const dt = ts - last;
      last = ts;
      // a hidden tab or a breakpoint is not the device being slow
      if (dt > 250 || dt <= 0) { since = ts; fastSince = 0; return; }
      ema += (dt - ema) * 0.08;
      self.fps = 1000 / ema;
      if (!self.auto || ts - since < SETTLE_MS) return;

      if (ema > SLOW_MS && self.level < MAX) {
        set(self.level + 1, true);
        since = ts; fastSince = 0;
      } else if (ema < FAST_MS && self.level > 0) {
        if (!fastSince) fastSince = ts;
        else if (ts - fastSince > RECOVER_MS) { set(self.level - 1, true); since = ts; fastSince = 0; }
      } else {
        fastSince = 0;
      }
    }

    if (opt.onLevel) opt.onLevel(self.level);
    return self;
  }

  window.XGPerf = { create, MAX };
})();
