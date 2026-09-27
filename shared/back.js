/* Back to the main index.
   Included at the end of every piece page:
     <script src="../shared/back.js" data-color="#031927"></script>

   - puts a line arrow in the top-left corner, pointing up-left (315° on the
     compass), that leads back to ../index.html
   - marks this browser session as having visited a piece, which is what
     makes the "make chord" record appear on the main page
       data-visit="0"  leaves the mark alone (the chord page itself)
       data-color      stroke colour, picked to read on that page's ground
       data-bg         optional: sits the arrow in a small box of this colour
                       with a hairline border, for grounds too busy to read on */
(function () {
  'use strict';
  const me = document.currentScript;
  const color = (me && me.dataset.color) || '#e8e2d4';
  const boxBg = me && me.dataset.bg;

  if (!me || me.dataset.visit !== '0') {
    try { sessionStorage.setItem('xg.visited', '1'); } catch (e) { /* storage blocked */ }
  }

  const css = document.createElement('style');
  css.textContent = `
    .xg-back{
      position:fixed; left:clamp(16px, 2.2vw, 44px); top:clamp(16px, 2.2vw, 44px);
      z-index:2147483000;
      width:clamp(36px, 3.1vw, 60px); height:clamp(36px, 3.1vw, 60px);
      box-sizing:border-box; padding:0; margin:0; border:0; background:none;
      color:${color}; cursor:pointer; display:block;
      -webkit-tap-highlight-color:transparent;
      transition:transform .2s steps(3, end);
    }
    .xg-back:hover, .xg-back:focus-visible{ transform:translate(-8%, -8%); }
    .xg-back:focus-visible{ outline:2px solid currentColor; outline-offset:6px; }
    .xg-back svg{ display:block; width:100%; height:100%; overflow:visible;
      fill:none; stroke:currentColor; stroke-width:2; vector-effect:non-scaling-stroke; }
    .xg-back svg path{ vector-effect:non-scaling-stroke; }
    .xg-back.boxed{ background:${boxBg || 'transparent'}; border:1px solid currentColor; padding:clamp(7px, .6vw, 11px); }
  `;
  document.head.appendChild(css);

  const a = document.createElement('a');
  a.className = boxBg ? 'xg-back boxed' : 'xg-back';
  a.href = '../index.html';
  a.setAttribute('aria-label', '메인 화면으로 돌아가기');
  a.title = '메인 화면';
  // the detail view's arrow turned to face the other way: shaft from the
  // bottom-right corner, head in the top-left
  a.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M82 82 L18 18 M18 60 L18 18 L60 18"/></svg>';

  // pieces listen for pointer events on the whole window; keep the arrow's
  // own presses from also playing a note or starting a drag underneath it
  ['pointerdown', 'mousedown', 'touchstart'].forEach((t) =>
    a.addEventListener(t, (e) => e.stopPropagation(), { passive: true }));

  const mount = () => document.body.appendChild(a);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
