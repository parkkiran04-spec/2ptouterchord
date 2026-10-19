// Page chrome for the brush: a brush declares `const BRUSH = { name, swatch,
// help }` where `help` is a list of [keys, effect] pairs, and calls
// buildHUD() once. It then writes its live state into #status with
// setStatus(), and may colour #swatch if it declared `swatch: true`.

function buildHUD(brush) {
  const help = document.getElementById('help');
  const swatch = document.getElementById('swatch');
  if (!help) return;
  help.innerHTML = '';
  for (const [keys, effect] of brush.help) {
    const row = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = keys;
    row.appendChild(b);
    row.appendChild(document.createTextNode(effect));
    help.appendChild(row);
  }
  document.title = `${brush.name} — p5.js`;
  if (swatch) swatch.classList.toggle('hidden', !brush.swatch);
}

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function toggleHUD() {
  document.getElementById('hud').classList.toggle('hidden');
}
