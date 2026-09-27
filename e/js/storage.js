// Storage: localStorage save/load, compact share links, and example presets.
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const cfg = DG.config;
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const St = (DG.storage = {});

  // ---- localStorage ----
  St.save = function (strokes) {
    try {
      const data = {
        v: 1,
        key: cfg.key,
        scale: cfg.scale,
        strokes: strokes.map((s) => ({
          b: s.brush,
          p: s.points.map((p) => [+p.r.toFixed(4), +p.t.toFixed(4), +p.w.toFixed(4)]),
        })),
      };
      localStorage.setItem(cfg.storageKey, JSON.stringify(data));
      return true;
    } catch (err) {
      return false;
    }
  };

  St.load = function () {
    try {
      const data = JSON.parse(localStorage.getItem(cfg.storageKey));
      if (!data || !Array.isArray(data.strokes)) return null;
      return {
        key: data.key,
        scale: data.scale,
        strokes: data.strokes.map((s) => ({ brush: s.b, points: s.p.map(([r, t, w]) => ({ r, t, w })) })),
      };
    } catch (err) {
      return null;
    }
  };

  // ---- share link: binary → deflate (when available) → base64url in the hash ----
  function encodeBinary(strokes) {
    let size = 5;
    for (const s of strokes) size += 3 + Math.min(65535, s.points.length) * 4;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    const scaleNames = Object.keys(cfg.scales);
    dv.setUint8(0, 1);
    dv.setUint8(1, Math.max(0, cfg.keys.indexOf(cfg.key)));
    dv.setUint8(2, Math.max(0, scaleNames.indexOf(cfg.scale)));
    dv.setUint16(3, Math.min(65535, strokes.length));
    let o = 5;
    for (const s of strokes) {
      const pts = s.points.slice(0, 65535);
      dv.setUint8(o, s.brush); dv.setUint16(o + 1, pts.length); o += 3;
      for (const p of pts) {
        dv.setUint8(o, Math.round(clamp01(p.r) * 255));
        dv.setUint16(o + 1, Math.round((mod(p.t, TAU) / TAU) * 65535) & 0xffff);
        dv.setUint8(o + 3, Math.round(clamp01(p.w / cfg.brush.maxWidth) * 255));
        o += 4;
      }
    }
    return buf;
  }

  function decodeBinary(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint8(0) !== 1) throw new Error('unknown version');
    const scaleNames = Object.keys(cfg.scales);
    const out = { key: cfg.keys[dv.getUint8(1)], scale: scaleNames[dv.getUint8(2)], strokes: [] };
    const count = dv.getUint16(3);
    let o = 5;
    for (let i = 0; i < count; i++) {
      const brush = dv.getUint8(o), n = dv.getUint16(o + 1);
      o += 3;
      const points = [];
      for (let j = 0; j < n; j++) {
        points.push({
          r: dv.getUint8(o) / 255,
          t: (dv.getUint16(o + 1) / 65535) * TAU,
          w: (dv.getUint8(o + 3) / 255) * cfg.brush.maxWidth,
        });
        o += 4;
      }
      out.strokes.push({ brush, points });
    }
    return out;
  }

  async function pipe(bytes, Stream, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new Stream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const toB64 = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (str) => {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  St.makeShareHash = async function (strokes) {
    const raw = encodeBinary(strokes);
    if (typeof CompressionStream !== 'undefined') {
      try {
        return '#g=z' + toB64(await pipe(raw, CompressionStream, 'deflate-raw'));
      } catch (err) { /* fall through */ }
    }
    return '#g=r' + toB64(raw);
  };

  St.readShareHash = async function (hash) {
    const m = /^#g=([zr])([A-Za-z0-9_-]+)$/.exec(hash || '');
    if (!m) return null;
    let bytes = fromB64(m[2]);
    if (m[1] === 'z') bytes = await pipe(bytes, DecompressionStream, 'deflate-raw');
    return decodeBinary(bytes);
  };

  // ---- presets ----
  const W = cfg.brush.maxWidth * 0.8;
  const lw = (cfg.geometry.drawMax - cfg.geometry.drawMin) / cfg.lanes;
  const laneR = (lane) => cfg.geometry.drawMax - (lane + 0.5) * lw;
  const stepT = (s, of = 16) => -(s * TAU) / of;
  const dot = (brush, lane, step, w = W) => ({ brush, points: [{ r: laneR(lane), t: stepT(step), w }] });

  // Presets are sketched as paths, then stamped into evenly spaced dots.
  function toDots(list) {
    const gap = cfg.brush.dotSpacing * 1.15;
    const out = [];
    for (const s of list) {
      let lx = null, ly = null;
      for (const p of s.points) {
        const x = p.r * Math.cos(p.t), y = p.r * Math.sin(p.t);
        if (lx !== null && Math.hypot(x - lx, y - ly) < gap) continue;
        lx = x; ly = y;
        out.push({ brush: s.brush, points: [{ r: p.r, t: p.t, w: cfg.brush.dotWidth }] });
      }
    }
    return out;
  }

  const sketches = {
    Spiral() {
      const out = [];
      const pts = [];
      const turns = 2.5;
      for (let a = 0; a <= turns * TAU; a += 0.035) {
        pts.push({ r: 0.935 - 0.575 * (a / (turns * TAU)), t: -a, w: W * 0.85 });
      }
      out.push({ brush: 0, points: pts });
      for (let s = 0; s < 16; s += 4) out.push(dot(3, 0, s, W * 1.1));
      [2, 6, 10, 14].forEach((s, i) => out.push(dot(1, 4 + (i % 3) * 2, s)));
      return out;
    },
    Constellation() {
      const rand = DG.record.seeded(42);
      const out = [];
      for (let i = 0; i < 18; i++) out.push(dot(2, Math.floor(rand() * 11), Math.floor(rand() * 16), W * (0.6 + rand() * 0.5)));
      const arc = [];
      for (let a = 0; a <= Math.PI * 0.9; a += 0.04) arc.push({ r: laneR(1), t: -a, w: W });
      out.push({ brush: 3, points: arc });
      const arc2 = [];
      for (let a = Math.PI; a <= Math.PI * 1.9; a += 0.04) arc2.push({ r: laneR(3), t: -a, w: W });
      out.push({ brush: 3, points: arc2 });
      [0, 6, 8, 12].forEach((s) => out.push(dot(3, 0, s, W * 1.1)));
      return out;
    },
    Tide() {
      const out = [];
      const wave = [];
      for (let a = 0; a <= TAU + 0.001; a += 0.025) wave.push({ r: 0.64 + 0.2 * Math.sin(a * 3), t: -a, w: W * 0.7 });
      out.push({ brush: 1, points: wave });
      [0, 3, 8, 11].forEach((s) => out.push(dot(3, s % 2 ? 2 : 0, s, W * 1.1)));
      [4, 12].forEach((s) => {
        const dash = [];
        for (let k = 0; k <= 8; k++) dash.push({ r: laneR(8), t: stepT(s) - k * 0.03, w: W * 0.8 });
        out.push({ brush: 0, points: dash });
      });
      [2, 7, 14].forEach((s) => out.push(dot(2, 10, s, W * 0.7)));
      return out;
    },
  };

  St.presets = {};
  for (const name in sketches) St.presets[name] = () => toDots(sketches[name]());
})();
