// Page chrome for the brush: a brush declares `const BRUSH = { name, swatch,
// help }` and calls buildHUD() once — `help` (a list of [keys, effect]
// pairs) is painted onto a sign inside the 3D room itself (world.js's
// buildHelpSign), not this DOM panel, which only ever shows live status. It
// then writes that live state into #status with setStatus(), and may colour
// #swatch if it declared `swatch: true`.

function buildHUD(brush) {
  document.title = `${brush.name} — p5.js`;
  const swatch = document.getElementById('swatch');
  if (swatch) swatch.classList.toggle('hidden', !brush.swatch);
}

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function toggleHUD() {
  document.getElementById('hud').classList.toggle('hidden');
}
