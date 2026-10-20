// UI: toolbar, more panel, hint line and toasts.
(function () {
  'use strict';
  const cfg = DG.config;
  const $ = (id) => document.getElementById(id);
  const UI = (DG.ui = {});

  let toastTimer = 0;
  let hintText = null;

  UI.init = function (h) {
    seg($('modeSeg'), 'mode', h.onMode);
    seg($('bandSeg'), 'band', h.onBand);
    seg($('stepsSeg'), 'steps', (v) => h.onSteps(parseInt(v, 10)));
    seg($('motionSeg'), 'motion', h.onMotion);

    const tempo = $('tempo');
    tempo.addEventListener('input', () => {
      const v = parseFloat(tempo.value);
      $('tempoValue').textContent = v.toFixed(2) + '×';
      h.onTempo(v);
    });

    $('undoBtn').addEventListener('click', h.onUndo);
    $('clearBtn').addEventListener('click', h.onClear);
    $('saveBtn').addEventListener('click', h.onSave);
    $('loadBtn').addEventListener('click', h.onLoad);
    $('shareBtn').addEventListener('click', h.onShare);
    $('recBtn').addEventListener('click', h.onRecord);

    const presets = $('presetButtons');
    Object.keys(DG.storage.presets).forEach((name) => {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = name;
      b.addEventListener('click', () => h.onPreset(name));
      presets.appendChild(b);
    });

    // more panel
    const panel = $('morePanel'), moreBtn = $('moreBtn');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      moreBtn.setAttribute('aria-expanded', String(!panel.hidden));
    });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== moreBtn) UI.closePanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') UI.closePanel();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|SELECT/.test(e.target.tagName)) {
        e.preventDefault();
        h.onUndo();
      }
    });

    UI.syncSettings();
  };

  function seg(el, attr, cb) {
    el.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        setSeg(el, attr, b.dataset[attr]);
        cb(b.dataset[attr]);
      });
    });
  }
  function setSeg(el, attr, value) {
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
  }

  UI.syncSettings = function () {
    setSeg($('modeSeg'), 'mode', cfg.mode);
    setSeg($('bandSeg'), 'band', cfg.band);
    setSeg($('stepsSeg'), 'steps', String(cfg.steps));
    setSeg($('motionSeg'), 'motion', cfg.motion);
    $('tempo').value = cfg.speedMultiplier;
    $('tempoValue').textContent = cfg.speedMultiplier.toFixed(2) + '×';
    UI.setRpmLabel(cfg.rpm);
  };


  UI.setRpmLabel = (rpm) => {
    const el = $('rpmLabel'); // the header label is optional
    if (el) el.textContent = (rpm < 40 ? '33⅓' : '45') + ' RPM';
  };

  UI.closePanel = function () {
    $('morePanel').hidden = true;
    $('moreBtn').setAttribute('aria-expanded', 'false');
  };

  UI.setHint = function (text, warn) {
    const key = text + (warn ? '!' : '');
    if (key === hintText) return;
    hintText = key;
    const el = $('hint');
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  };

  UI.toast = function (msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  };

  UI.setRecording = function (on) {
    $('recBtn').classList.toggle('on', on);
    $('recLabel').textContent = on ? 'Stop & save' : 'Record audio';
  };
})();
