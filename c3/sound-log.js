/* Passacaglia's sound memory, added for the combined exhibition so make
   chord can count and use the notes painted here.

   shared/audio.js plays every note a visitor paints through pluckNote(freq)
   (the slow background melody uses its own path and is not counted). This
   wraps that one function and changes nothing else in the piece: each
   painted note is queued and sent to the exhibition server's
   POST api/sounds  ->  c3/sound-data/sounds.jsonl
   Opened as a plain file, or with no server behind it, the requests fail
   quietly and the notes are kept in this browser instead. */
(function () {
  'use strict';
  if (typeof window.pluckNote !== 'function') return;

  const API = 'api/sounds';
  const KEY = 'passacaglia.soundmem';
  const canUpload = /^https?:$/.test(location.protocol);
  const session = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outbox = [];
  let sending = false;

  function keepLocal(ev) {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      list.push(ev);
      localStorage.setItem(KEY, JSON.stringify(list.slice(-5000)));
    } catch (e) { /* storage blocked or full */ }
  }

  const play = window.pluckNote;
  window.pluckNote = function (freq) {
    const ev = { t: Date.now(), type: 'note', f: Math.round(freq * 100) / 100, s: session };
    outbox.push(ev);
    keepLocal(ev);
    return play.apply(this, arguments);
  };

  async function sync() {
    if (!canUpload || sending || !outbox.length) return;
    sending = true;
    const batch = outbox.splice(0, 400);
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({ session, events: batch }) });
      if (!r.ok) throw new Error(r.status);
    } catch (e) {
      outbox.unshift(...batch);
    }
    sending = false;
  }
  function beacon() {
    if (!canUpload || !outbox.length || !navigator.sendBeacon) return;
    const body = new Blob([JSON.stringify({ session, events: outbox.slice(0, 400) })], { type: 'application/json' });
    if (navigator.sendBeacon(API, body)) outbox.splice(0, 400);
  }
  setInterval(sync, 3000);
  addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', () => { if (document.hidden) beacon(); });
})();
