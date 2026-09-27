// Record: rotation, coordinate transforms, lanes/steps, and the vinyl artwork.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const mod = (a, n) => ((a % n) + n) % n;

  const R = (DG.record = {
    cx: 0, cy: 0, radius: 200, dpr: 1,
    rot: 0,     // radians, clockwise on screen, unbounded
    omega: 0,   // rad/s
    target: 0,
    base: null, // offscreen vinyl artwork
  });

  R.targetSpeed = () => (cfg.rpm / 60) * TAU * cfg.speedMultiplier;

  R.layout = function (cx, cy, radius, dpr) {
    R.cx = cx; R.cy = cy; R.radius = radius; R.dpr = dpr;
    R.renderBase();
  };

  // ---- lanes & steps ----
  R.laneWidth = () => (cfg.geometry.drawMax - cfg.geometry.drawMin) / cfg.lanes;
  R.laneOf = (rn) =>
    Math.max(0, Math.min(cfg.lanes - 1, Math.floor((cfg.geometry.drawMax - rn) / R.laneWidth())));
  R.laneFloat = (rn) => (cfg.geometry.drawMax - rn) / R.laneWidth() - 0.5;
  R.laneCenter = (lane) => cfg.geometry.drawMax - (lane + 0.5) * R.laneWidth();
  R.stepAngle = () => TAU / cfg.steps;
  // Step s sits at record angle -s·Δ, so steps pass under a fixed needle in increasing order.
  R.stepOf = (t) => mod(Math.round(-t / R.stepAngle()), cfg.steps);

  // ---- coordinates ----
  R.toRecord = function (x, y) {
    const dx = x - R.cx, dy = y - R.cy;
    return { rn: Math.hypot(dx, dy) / R.radius, t: mod(Math.atan2(dy, dx) - R.rot, TAU) };
  };
  R.inDrawable = function (x, y) {
    const { rn } = R.toRecord(x, y);
    return rn >= cfg.geometry.drawMin && rn <= cfg.geometry.drawMax;
  };

  // ---- motion ----
  R.update = function (dt) {
    const tau = R.target > R.omega ? cfg.spinUpTime : cfg.spinDownTime;
    R.omega += (R.target - R.omega) * (1 - Math.exp(-dt / tau));
    if (R.target === 0 && R.omega < 0.01) R.omega = 0;
    R.rot += R.omega * dt;
  };

  // ---- drawing ----
  R.render = function (ctx, extras) {
    ctx.save();
    ctx.translate(R.cx, R.cy);
    ctx.rotate(R.rot);
    // asked for every frame so the disc follows the bl state; the artwork caches it
    const disc = DG.artwork.images.disc ? DG.artwork.discSprite(R.radius) : R.base;
    const half = DG.artwork.images.disc ? DG.artwork.discHalfSize(R.radius) : R.radius;
    if (disc) ctx.drawImage(disc, -half, -half, half * 2, half * 2);
    DG.artwork.renderWindows(ctx, R.radius);
    if (extras) extras(ctx);
    ctx.restore();
  };

  // The disc itself comes from the artwork; a plain circle stands in until it loads.
  R.renderBase = function () {
    if (DG.artwork.images.disc) {
      R.base = DG.artwork.discSprite(R.radius);
      return;
    }
    const r = R.radius, dpr = R.dpr;
    const size = Math.max(2, Math.ceil(r * 2 * dpr));
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, r * dpr, r * dpr);
    c.beginPath();
    c.arc(0, 0, Math.max(1, r - 0.5), 0, TAU);
    c.fillStyle = DG.artwork.colors.vinyl;
    c.fill();
    R.base = cv;
  };

  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  R.seeded = seeded;
})();
