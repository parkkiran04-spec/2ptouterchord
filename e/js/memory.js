// Memory: a quiet record of everything this piece has sounded — notes the visitor drew,
// the heartbeat under them, the glass, the needle. Nothing is ever drawn from it; it is
// kept so the session can be read back, exported, or used later.
//
// From the console:
//   DG.memory.summary()        what has been heard so far
//   DG.memory.list('note')     every note event
//   DG.memory.export()         download it as JSON
//   DG.memory.clear()          forget everything
(function () {
  'use strict';
  const cfg = DG.config;
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const M = (DG.memory = {
    events: [],
    session: new Date().toISOString(),
    limit: 4000,      // events held in memory
    keep: 1500,       // events written to storage
    saveEvery: 6000,  // ms between saves
    past: [],         // sessions restored from storage
  });

  const storageKey = (cfg.storageKey || 'drawn-groove/v1') + ':memory';
  const t0 = performance.now();
  let dirty = false;
  let lastSave = 0;

  M.noteName = (midi) => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

  M.add = function (type, data) {
    const e = Object.assign({ t: Math.round(performance.now() - t0), type }, data);
    M.events.push(e);
    if (M.events.length > M.limit) M.events.splice(0, M.events.length - M.limit);
    outbox.push(e);
    if (outbox.length > 20000) outbox.splice(0, outbox.length - 20000);
    dirty = true;
    return e;
  };

  // ---- server copy ----
  // When the folder is served by server.ps1, every event is also sent to
  // POST api/sounds (-> e/sound-data/sounds.jsonl), where "make chord" reads
  // it back. Opened as a plain file or on static hosting the requests just
  // fail and the events wait in the outbox; the localStorage copy above is
  // untouched either way.
  const API = 'api/sounds';
  const outbox = [];
  const canUpload = location.protocol.startsWith('http');
  let sending = false;
  const payload = (evs) => JSON.stringify({ session: M.session, events: evs });

  async function sync() {
    if (!canUpload || sending || !outbox.length) return;
    sending = true;
    const batch = outbox.splice(0, 400);
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload(batch) });
      if (!r.ok) throw new Error(r.status);
    } catch (err) {
      outbox.unshift(...batch);
    }
    sending = false;
  }
  function beacon() {
    if (!canUpload || !outbox.length || !navigator.sendBeacon) return;
    if (navigator.sendBeacon(API, new Blob([payload(outbox.slice(0, 400))], { type: 'application/json' }))) outbox.splice(0, 400);
  }
  setInterval(sync, 3000);
  M.flush = sync;

  // a note the record played, with the musical context it was played in
  M.note = function (info) {
    return M.add('note', {
      inst: info.inst,
      midi: info.midi,
      name: M.noteName(info.midi),
      lane: info.lane,
      step: info.step,
      vel: Math.round(info.vel * 100) / 100,
      dur: Math.round(info.dur * 1000),
      key: cfg.key,
      scale: cfg.scale,
    });
  };

  M.list = (type) => (type ? M.events.filter((e) => e.type === type) : M.events.slice());
  M.last = (n) => M.events.slice(-(n || 20));

  M.summary = function () {
    const byType = {}, byInstrument = {}, byNote = {}, byScale = {};
    for (const e of M.events) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.type !== 'note') continue;
      byInstrument[e.inst] = (byInstrument[e.inst] || 0) + 1;
      byNote[e.name] = (byNote[e.name] || 0) + 1;
      const k = e.key + ' ' + e.scale;
      byScale[k] = (byScale[k] || 0) + 1;
    }
    const notes = M.list('note');
    const span = M.events.length ? (M.events[M.events.length - 1].t - M.events[0].t) / 1000 : 0;
    return {
      session: M.session,
      events: M.events.length,
      seconds: Math.round(span),
      byType,
      notes: notes.length,
      byInstrument,
      byScale,
      topNotes: Object.entries(byNote).sort((a, b) => b[1] - a[1]).slice(0, 8),
      pastSessions: M.past.length,
    };
  };

  M.clear = function () {
    M.events.length = 0;
    M.past.length = 0;
    try { localStorage.removeItem(storageKey); } catch (err) { /* ignore */ }
    dirty = false;
  };

  // ---- storage ----
  M.save = function () {
    try {
      const sessions = M.past.concat([{ session: M.session, events: M.events.slice(-M.keep) }]).slice(-6);
      localStorage.setItem(storageKey, JSON.stringify(sessions));
      dirty = false;
      return true;
    } catch (err) {
      return false;
    }
  };

  M.load = function () {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(raw)) M.past = raw.filter((s) => s && s.session !== M.session);
    } catch (err) { /* nothing remembered yet */ }
    return M.past.length;
  };

  // called every frame; writes to storage now and then
  M.tick = function () {
    if (!dirty) return;
    const now = performance.now();
    if (now - lastSave < M.saveEvery) return;
    lastSave = now;
    M.save();
  };

  M.toJSON = () => ({ session: M.session, events: M.events, past: M.past });

  M.export = function (filename) {
    const blob = new Blob([JSON.stringify(M.toJSON(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'drawn-groove-memory.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return M.events.length;
  };

  M.load();
  window.addEventListener('pagehide', () => { if (dirty) M.save(); beacon(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (dirty) M.save(); beacon(); } });
})();
