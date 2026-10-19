// The room: four score-brush walls (brushes/score/sketch.js) painted on the
// four inward side faces of an open-topped, open-bottomed box, viewed from
// its centre — top and bottom are left out entirely, so there's no ceiling
// or floor canvas to paint on. With a mouse: left-drag paints the wall
// you're facing, right-drag (or the arrow keys) looks around, WASD flies
// you through the room. With touch, since the deployment target has no
// keyboard or mouse: one finger paints, two fingers dragging together look
// around, and pinching (the two fingers' distance changing) flies forward
// or back. This file owns the camera, the raycasting that turns a screen
// point into a point on a wall's canvas, and the keyboard shortcuts (which
// apply to whichever wall is under the cursor).

const FACE_SIZE = 2048;   // resolution of each wall's canvas — power-of-two, see the texture setup below
const CUBE_SIZE = 46;     // edge length of the room, in world units — big enough to walk around in
const MOVE_MARGIN = 3;    // how close the camera may get to a wall before it's stopped — also caps how much
                           // the texture ever has to be magnified, so a closer value trades sharpness for reach
const MOVE_SPEED = 14;    // world units per second, flying with WASD
const PINCH_SPEED = 0.04; // world units moved per CSS pixel of pinch-distance change
const WANDER_SPEED = 5;   // world units per second, the default autonomous drift
const CAMERA_FOV = 100;   // wider FOV = more walls in view at once = a roomier feel
const LOOK_SPEED = 0.0035;
const KEY_LOOK_STEP = 0.06;
const VOID_COLOR = 0xd8e7fc;     // same blank colour as every wall's canvas, used for the open top/bottom too
const MARK_COLOR_A = 0xe84175;   // one end of the top/bottom mark's gradient
const MARK_COLOR_B = 0x341c91;   // the other end
const MARK_THICKNESS = 0.06;     // a thin solid bar, not a 1px GL line (those render too faint to see)
const MARK_INSET = CUBE_SIZE * 0.035; // how far each mark's ends sit from the wall's corners — cosmetic only now,
                                       // see the note on painting's u-clamp below for why it no longer bounds painting

const STAR_COLOR_A = 0xe84175; // every star (and meteor) is one of exactly these two colours, fixed, never blended
const STAR_COLOR_B = 0x341c91;
const SKY_RADIUS = 170;       // the gradient sky dome, just inside the camera's far plane (200)
const SKY_DEEP_COLOR = 0x9abce5; // what the sky fades to away from the horizon
// Two star layers at different distances give the field some depth instead
// of reading as one flat wall of dots: a dense, dim, far layer plus a
// sparser, closer, slightly bigger one. sizeAttenuation (below) already
// makes farther points render smaller on its own — spreading stars across
// two very different radii is what gives it room to actually show.
const STAR_LAYERS = [
  { count: 3200, radius: 140, jitter: 0.15, size: 0.22, opacity: 0.7 },
  { count: 500,  radius: 70,  jitter: 0.12, size: 0.4,  opacity: 0.85 },
];

// Occasional shooting stars: short bright streaks across the sky dome, each
// a brief flash rather than a lingering trail, at random unpredictable
// intervals so the sky doesn't feel like it's on a visible timer.
const METEOR_SLOTS = 2;        // at most this many streaking at once
const METEOR_LENGTH = 0.22;    // fraction of METEOR_RADIUS the streak spans
const METEOR_RADIUS = SKY_RADIUS * 0.9;
const METEOR_DURATION = [500, 900];   // ms, how long one flash takes
const METEOR_GAP = [3000, 11000];     // ms, how long a slot waits before its next one

// The four side walls, in the order our custom geometry's material slots /
// raycast face.materialIndex values use them.
const FACE_NAMES = ['+x', '-x', '+z', '-z'];

let renderer, scene, camera, room;
let starLayers = [];
let meteors = [];
let faces = []; // { brush, texture, material }, indexed like FACE_NAMES
let yaw = Math.PI * 0.75, pitch = -0.2;
let hoverFace = 0;
let activeFace = null;
let looking = false;
let lastX = 0, lastY = 0;
let lastFrameTime = 0;
const heldKeys = new Set(); // lower-cased wasd currently held, for flying around

// touch state: every currently-down touch/pen pointer, by id, plus which
// one (if any) is painting, and the two-finger look/pinch gesture's last
// midpoint + spread, used to turn its frame-to-frame change into motion.
const pointers = new Map();
let drawingPointerId = null;
let twoFinger = null;

async function initWorld() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.touchAction = 'none'; // belt-and-suspenders alongside #world's CSS rule
  document.getElementById('world').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID_COLOR); // fallback fill; the sky dome below covers the view otherwise

  // the gradient backdrop: pale near the horizon, deepening toward a dark
  // indigo straight up or down — rendered first (renderOrder -1) and
  // without writing depth, same reasoning as the walls below, so nothing
  // in front of it is at risk of being hidden by it.
  const sky = buildSkyDome(SKY_RADIUS, VOID_COLOR, SKY_DEEP_COLOR);
  sky.renderOrder = -1;
  scene.add(sky);

  camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, 0, 0);

  const materials = [];
  for (let i = 0; i < FACE_NAMES.length; i++) {
    const brush = createScoreFace(FACE_SIZE);
    await brush.ready;
    const texture = new THREE.CanvasTexture(brush.canvas);
    texture.flipY = false;
    // No mipmaps: this texture is redrawn and re-uploaded every frame, so
    // regenerating a full mip chain each time is wasted work, and on a
    // non-power-of-two size (which this no longer is, but better safe) a
    // stray mipmap chain is a classic cause of a canvas texture rendering
    // broken/blurry in some browsers. Plain linear filtering is all a flat
    // canvas like this needs.
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    // depthWrite: false — otherwise a wall's transparent (unpainted) pixels
    // still write depth, which would hide the stars behind it: Three.js
    // sorts transparent objects by distance, but both the walls and the
    // starfield sit at the same local origin, so that sort alone can't be
    // trusted to draw the stars first (renderOrder below pins it instead).
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    materials.push(material);
    faces.push({ brush, texture, material });
  }

  const geo = buildOpenBoxGeometry(CUBE_SIZE / 2);
  room = new THREE.Mesh(geo, materials);
  room.renderOrder = 1; // after the stars, so their colour is already there to show through
  scene.add(room);

  // a faint mark near the top and bottom of every wall, inset from its
  // corners, so the canvas each one offers reads clearly even before
  // anything is painted on it. Built from thin boxes rather than GL line
  // segments, since 1px lines render too faint to see against a near-white
  // wall at any reasonable opacity.
  scene.add(buildWallMarks(CUBE_SIZE / 2, MARK_THICKNESS, MARK_INSET, MARK_COLOR_A, MARK_COLOR_B));

  // two dense fields of tiny points well outside the room, meant to show
  // through any wall wherever it's transparent (see the comment on
  // `material` above for why renderOrder is set explicitly here too).
  for (const layer of STAR_LAYERS) {
    const points = buildStarfield(layer);
    points.renderOrder = 0;
    scene.add(points);
    starLayers.push(points);
  }

  meteors = buildMeteors();
  for (const m of meteors) {
    m.line.renderOrder = 0;
    scene.add(m.line);
  }

  updateCameraOrientation();
  buildHUD(BRUSH);
  updateHUD();

  const dom = renderer.domElement;
  dom.addEventListener('contextmenu', e => e.preventDefault());
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('pointerleave', onPointerUp);
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  lastFrameTime = performance.now();
  requestAnimationFrame(animate);
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;
  if (!applyMovement(dt)) updateWander(dt);
  // a very slow, small, uniform brightness drift — a hint of a twinkle
  // without any single star changing colour or standing out from the rest.
  const drift = 0.08 * Math.sin(now * 0.00018);
  for (let i = 0; i < starLayers.length; i++) {
    starLayers[i].material.opacity = STAR_LAYERS[i].opacity + drift;
  }
  updateMeteors(now);
  // Re-uploading a texture is not free — at this resolution, doing it for
  // all four walls every single frame regardless of whether anything on
  // them changed was real, needless GPU bandwidth, and very plausibly part
  // of what made input feel unresponsive. Only a wall with a live stroke or
  // a still-growing snippet actually needs it.
  for (const f of faces) {
    if (f.brush.isAnimating()) f.texture.needsUpdate = true;
  }
  renderer.render(scene, camera);
}

// WASD (keyboard) or a two-finger pinch (touch) fly the camera itself
// around inside the room — full 3D, relative to where you're looking, not
// ground-locked — clamped so it can't pass through a wall. This is what
// actually sells the room as big: standing at the centre, no amount of
// resizing the room changes what you see, since a camera fixed at the
// centre of a scaled-up shape sees exactly the same image. Being able to
// walk (or pinch) toward a wall and watch it approach is what does.
function applyMovement(dt) {
  if (!heldKeys.size || dt <= 0) return false;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

  const move = new THREE.Vector3();
  if (heldKeys.has('w')) move.add(forward);
  if (heldKeys.has('s')) move.sub(forward);
  if (heldKeys.has('d')) move.add(right);
  if (heldKeys.has('a')) move.sub(right);
  if (move.lengthSq() === 0) return false;

  move.normalize().multiplyScalar(MOVE_SPEED * dt);
  camera.position.add(move);
  clampCameraPosition();
  return true;
}

function moveForward(amount) {
  if (!amount) return;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  camera.position.addScaledVector(forward, amount);
  clampCameraPosition();
}

// With nobody actually steering (no WASD held, no two-finger pinch, and not
// mid-stroke, which would otherwise make the wall you're painting drift out
// from under you), the camera drifts on its own: pick a random point inside
// the room and fly gently toward it, then pick another once it arrives.
// Where you're looking stays entirely under your own control throughout —
// only position wanders, so you can still paint whatever wall comes into
// view. Reaching for WASD (or pinching) takes over immediately; letting go
// hands it back.
let wanderTarget = null;

function pickWanderTarget() {
  const lim = CUBE_SIZE / 2 - MOVE_MARGIN;
  wanderTarget = new THREE.Vector3(
    (Math.random() * 2 - 1) * lim,
    (Math.random() * 2 - 1) * lim,
    (Math.random() * 2 - 1) * lim,
  );
}

function updateWander(dt) {
  if (dt <= 0 || activeFace !== null || pointers.size >= 2) return;
  if (!wanderTarget) pickWanderTarget();
  const toTarget = wanderTarget.clone().sub(camera.position);
  const dist = toTarget.length();
  if (dist < 0.75) { pickWanderTarget(); return; }
  camera.position.addScaledVector(toTarget.normalize(), Math.min(dist, WANDER_SPEED * dt));
  clampCameraPosition();
}

function clampCameraPosition() {
  const lim = CUBE_SIZE / 2 - MOVE_MARGIN;
  camera.position.x = Math.min(lim, Math.max(-lim, camera.position.x));
  camera.position.y = Math.min(lim, Math.max(-lim, camera.position.y));
  camera.position.z = Math.min(lim, Math.max(-lim, camera.position.z));
}

function updateCameraOrientation() {
  const maxPitch = Math.PI / 2 - 0.02;
  pitch = Math.min(maxPitch, Math.max(-maxPitch, pitch));
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

// The four side walls of a box with no top or bottom: each face's vertices
// are wound so its normal points inward (toward the centre), so the default
// front-facing side — the one the camera, always inside, actually sees —
// needs no special material.side setting. `materialIndex` 0..3 matches
// FACE_NAMES / raycast face.materialIndex order: +x, -x, +z, -z. Each
// face's own uv is listed alongside its corners so that, on every wall, u
// is consistently the horizontal axis (matching the top/bottom marks'
// length) and v the vertical one — needed so MARGIN_FRAC can clamp the
// same coordinate, uv.x, on every wall.
function buildOpenBoxGeometry(h) {
  const faces = [
    { corners: [[h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h]],     uvs: [0, 0, 1, 0, 1, 1, 0, 1] }, // +x
    { corners: [[-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h]], uvs: [0, 0, 1, 0, 1, 1, 0, 1] }, // -x
    { corners: [[-h, -h, h], [-h, h, h], [h, h, h], [h, -h, h]],     uvs: [0, 0, 0, 1, 1, 1, 1, 0] }, // +z
    { corners: [[h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, -h]], uvs: [1, 0, 1, 1, 0, 1, 0, 0] }, // -z
  ];

  const positions = [];
  const uvs = [];
  const indices = [];
  const geo = new THREE.BufferGeometry();

  faces.forEach(({ corners, uvs: faceUvs }, f) => {
    for (const c of corners) positions.push(...c);
    uvs.push(...faceUvs);
    const base = f * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    geo.addGroup(f * 6, 6, f);
  });

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Writes a colorA→colorB gradient, along the geometry's local `axis`
// (0 = x, 2 = z), into its vertex colors.
function gradientAlongAxis(geo, axis, colorA, colorB) {
  const pos = geo.attributes.position;
  const getAt = axis === 0 ? i => pos.getX(i) : axis === 1 ? i => pos.getY(i) : i => pos.getZ(i);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const v = getAt(i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const cA = new THREE.Color(colorA), cB = new THREE.Color(colorB);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (getAt(i) - min) / span;
    const c = cA.clone().lerp(cB, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

// A thin bar near the top and near the bottom of each wall, inset from its
// left and right corners — a minimal stand-in for a full wireframe, each
// one a colorA→colorB gradient along its own length. Built from boxes
// rather than GL line segments, since 1px lines render too faint to read
// at this scale regardless of material settings.
function buildWallMarks(half, thickness, inset, colorA, colorB) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const barLen = half * 2 - inset * 2;
  const inward = half - thickness / 2;

  const alongZ = new THREE.BoxGeometry(thickness, thickness, barLen);
  gradientAlongAxis(alongZ, 2, colorA, colorB);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const mesh = new THREE.Mesh(alongZ, mat);
      mesh.position.set(sx * inward, sy * half, 0);
      group.add(mesh);
    }
  }

  const alongX = new THREE.BoxGeometry(barLen, thickness, thickness);
  gradientAlongAxis(alongX, 0, colorA, colorB);
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const mesh = new THREE.Mesh(alongX, mat);
      mesh.position.set(0, sy * half, sz * inward);
      group.add(mesh);
    }
  }

  return group;
}

// PointsMaterial draws plain squares unless given a sprite texture to
// stamp instead — a small soft-edged circle, generated once on a scratch
// 2D canvas rather than loaded from a file, reused by every star layer.
let starSpriteTexture = null;
function getStarSprite() {
  if (starSpriteTexture) return starSpriteTexture;
  const size = 64, r = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  starSpriteTexture = new THREE.CanvasTexture(canvas);
  return starSpriteTexture;
}

// One layer of tiny points scattered over a sphere. Each star is one of
// exactly two fixed colours — STAR_COLOR_A or STAR_COLOR_B, picked at
// random, never a blend of the two — and never touched again; the only
// motion anywhere in the field is the slow shared opacity drift (see
// animate()), never a per-star colour change.
function buildStarfield({ count, radius, jitter, size, opacity }) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const cA = new THREE.Color(STAR_COLOR_A), cB = new THREE.Color(STAR_COLOR_B);
  for (let i = 0; i < count; i++) {
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (1 - jitter + Math.random() * jitter);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    const c = Math.random() < 0.5 ? cA : cB;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    vertexColors: true, map: getStarSprite(), size, sizeAttenuation: true,
    transparent: true, opacity, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

// A pool of brief, bright streaks across the sky dome — shooting stars.
// Each slot waits out its own randomized gap, then flashes along a short
// straight chord and goes back to waiting; see updateMeteors() in animate().
function buildMeteors() {
  const slots = [];
  for (let i = 0; i < METEOR_SLOTS; i++) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: STAR_COLOR_A, transparent: true, opacity: 0, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    slots.push({ line, active: false, t0: 0, duration: 0, nextSpawn: performance.now() + randRange(METEOR_GAP) });
  }
  return slots;
}

function randRange([lo, hi]) { return lo + Math.random() * (hi - lo); }

// A random point on a sphere of this radius, and a random direction roughly
// tangential to it there — used to lay out one meteor's start/end points so
// it reads as a streak skimming across the sky rather than radiating from
// (or diving straight at) the centre.
function randomTangentChord(radius, length) {
  const n = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
  const start = n.clone().multiplyScalar(radius);
  const arbitrary = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(n, arbitrary).normalize();
  const end = start.clone().addScaledVector(tangent, length);
  return [start, end];
}

function updateMeteors(now) {
  for (const m of meteors) {
    if (!m.active) {
      if (now >= m.nextSpawn) {
        const [start, end] = randomTangentChord(METEOR_RADIUS, METEOR_RADIUS * METEOR_LENGTH);
        m.line.geometry.setFromPoints([start, end]);
        m.line.material.color.set(Math.random() < 0.5 ? STAR_COLOR_A : STAR_COLOR_B);
        m.t0 = now;
        m.duration = randRange(METEOR_DURATION);
        m.active = true;
        m.line.visible = true;
      }
      continue;
    }
    const t = (now - m.t0) / m.duration;
    if (t >= 1) {
      m.active = false;
      m.line.visible = false;
      m.nextSpawn = now + randRange(METEOR_GAP);
      continue;
    }
    // a quick bright flash rather than a steady glow: up fast, down slower
    m.line.material.opacity = Math.sin(Math.PI * Math.min(1, t * 1.6)) * 0.9;
  }
}

// A large inward-facing sphere, coloured `colorHorizon` at its equator and
// easing toward `colorDeep` at its poles (straight up / straight down) —
// just enough of a gradient that the space outside the room reads as
// having real depth rather than being one flat backdrop colour.
function buildSkyDome(radius, colorHorizon, colorDeep) {
  const geo = new THREE.SphereGeometry(radius, 32, 24);
  const pos = geo.attributes.position;
  const cH = new THREE.Color(colorHorizon), cD = new THREE.Color(colorDeep);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.abs(pos.getY(i)) / radius); // 0 at the equator, 1 at the poles
    const c = cH.clone().lerp(cD, t * t); // eased, so most of the sky stays close to the horizon colour
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false });
  return new THREE.Mesh(geo, mat);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------- pointer

function ndcFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

const raycaster = new THREE.Raycaster();

// Returns { uv, faceIndex } for whichever of the four walls the pointer is
// over, or null if the ray passes through the open top/bottom without
// hitting a wall at all (looking straight up or down, say).
//
// An earlier version clamped uv.x to a margin well inside the wall's edges,
// matching where the top/bottom marks are, so painting couldn't reach past
// them. That margin turned out to be the main reason strokes kept seeming
// to cut off partway through an ordinary drag: once the pointer crossed
// into it, the clamped output stopped moving even though the pointer (and
// the math tracking it) hadn't. Painting now goes all the way to the
// wall's real edge — [0, 1] — and the marks are purely a visual guide.
function castCube(e) {
  raycaster.setFromCamera(ndcFromEvent(e), camera);
  const hits = raycaster.intersectObject(room);
  if (!hits.length) return null;
  const uv = hits[0].uv.clone();
  uv.x = Math.min(1, Math.max(0, uv.x));
  return { uv, faceIndex: hits[0].face.materialIndex };
}

function uvToPixel(uv) {
  return [uv.x * FACE_SIZE, uv.y * FACE_SIZE];
}

// Each wall's plane, as the axis it's perpendicular to and which side of
// that axis it's on — matches FACE_NAMES / materialIndex order.
const FACE_PLANES = [
  { axis: 'x', sign: 1 },  // +x
  { axis: 'x', sign: -1 }, // -x
  { axis: 'z', sign: 1 },  // +z
  { axis: 'z', sign: -1 }, // -z
];

// Raw plane intersection for `faceIndex`'s wall, at a given NDC point — no
// clamping, and null (rather than a garbage value) when the ray genuinely
// doesn't hit the plane going forward (parallel to it, or the plane is
// behind the camera). Shared by the hybrid tracker below and by whatever
// needs the unclamped math.
function uvOnFacePlane(faceIndex, ndcX, ndcY) {
  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const { axis, sign } = FACE_PLANES[faceIndex];
  const h = CUBE_SIZE / 2;
  const planeConst = sign * h;
  const ro = raycaster.ray.origin, rd = raycaster.ray.direction;
  const o = axis === 'x' ? ro.x : ro.z;
  const d = axis === 'x' ? rd.x : rd.z;
  if (Math.abs(d) < 1e-6) return null;
  const t = (planeConst - o) / d;
  if (t < 0) return null;
  const point = ro.clone().addScaledVector(rd, t);
  let u;
  if (faceIndex === 0) u = (point.z + h) / (2 * h);
  else if (faceIndex === 1) u = (h - point.z) / (2 * h);
  else if (faceIndex === 2) u = (point.x + h) / (2 * h);
  else u = (h - point.x) / (2 * h);
  return { u, v: (point.y + h) / (2 * h) };
}

// How much a wall's (u, v) shifts per CSS pixel of pointer movement, right
// now, at `e`'s position — a local linear approximation of the camera's
// projection, good for small movements (i.e. the next pointermove or two).
// Recomputed on every move rather than once per stroke so it stays accurate
// as the pointer travels, since the real relationship is projective, not
// linear, and drifts the further you get from where it was last measured.
function faceJacobianAt(faceIndex, e) {
  const ndc = ndcFromEvent(e);
  const base = uvOnFacePlane(faceIndex, ndc.x, ndc.y);
  if (!base) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const eps = 4; // px
  const ux = uvOnFacePlane(faceIndex, ndc.x + eps * (2 / rect.width), ndc.y);
  const uy = uvOnFacePlane(faceIndex, ndc.x, ndc.y - eps * (2 / rect.height));
  if (!ux || !uy) return null;
  return {
    jXu: (ux.u - base.u) / eps, jXv: (ux.v - base.v) / eps,
    jYu: (uy.u - base.u) / eps, jYv: (uy.v - base.v) / eps,
  };
}

// Per-stroke tracking state: the wall-space position the stroke has
// reached, the screen position it was last updated at, and the most
// recently measured Jacobian between the two (see trackActiveStroke).
let strokeU = 0, strokeV = 0, strokeLastX = 0, strokeLastY = 0, strokeJac = null;

function beginStrokeTracking(e, faceIndex, uv) {
  strokeU = uv.x; strokeV = uv.y;
  strokeLastX = e.clientX; strokeLastY = e.clientY;
  strokeJac = faceJacobianAt(faceIndex, e);
}

// Continuing a stroke uses this instead of castCube: castCube decides what
// a fresh pointer-down landed on by hit-testing the actual bounded wall —
// right for starting a stroke, but once one is running, a drag routinely
// swings the ray past that wall's physical edge (the walls fill most of a
// wide-FOV view, and a fast real drag doesn't track pixel-perfectly), and
// hit-testing the bounded mesh again would just lose track of it right
// there. This re-intersects the wall's own *infinite* plane each move,
// which has no edge to fall off — and on the rare move where even that has
// no forward answer (the drag has swung the ray almost 90° from the wall,
// which takes a genuinely large, fast sweep), it falls back to
// extrapolating from the last known position using the last measured
// Jacobian, so a stroke updates on every single move event no matter what.
function trackActiveStroke(e) {
  const ndc = ndcFromEvent(e);
  const direct = uvOnFacePlane(activeFace, ndc.x, ndc.y);
  if (direct) {
    strokeU = direct.u; strokeV = direct.v;
  } else if (strokeJac) {
    const dx = e.clientX - strokeLastX, dy = e.clientY - strokeLastY;
    strokeU += strokeJac.jXu * dx + strokeJac.jYu * dy;
    strokeV += strokeJac.jXv * dx + strokeJac.jYv * dy;
  } else {
    return null;
  }
  const freshJac = faceJacobianAt(activeFace, e);
  if (freshJac) strokeJac = freshJac;
  strokeLastX = e.clientX; strokeLastY = e.clientY;
  const u = Math.min(1, Math.max(0, strokeU));
  const v = Math.min(1, Math.max(0, strokeV));
  return { x: u, y: v };
}

function startPainting(e) {
  const hit = castCube(e);
  if (!hit) return false;
  activeFace = hit.faceIndex;
  hoverFace = hit.faceIndex;
  beginStrokeTracking(e, activeFace, hit.uv);
  const [px, py] = uvToPixel(hit.uv);
  faces[activeFace].brush.pointerDown(px, py);
  return true;
}

function stopPainting() {
  if (activeFace === null) return;
  faces[activeFace].brush.pointerUp();
  activeFace = null;
}

function twoFingerState() {
  const [a, b] = pointers.values();
  return {
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

function onPointerDown(e) {
  e.preventDefault();
  // Pointer capture pins this pointer's later move/up events to this
  // element regardless of where it physically travels on screen — without
  // it, a fast drag (or a touch, which is imprecise to begin with) that
  // strays off the canvas for even an instant stops being tracked at all,
  // which reads as a stroke that silently quit partway through. Wrapped in
  // a try since a capture failure should never take the rest of the
  // interaction down with it.
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

  if (e.pointerType === 'mouse') {
    if (e.button === 2) {
      looking = true;
      lastX = e.clientX; lastY = e.clientY;
      return;
    }
    if (e.button !== 0) return;
    startPainting(e);
    return;
  }

  // touch / pen: one finger paints; a second finger cancels that and takes
  // over for looking around + pinch-to-move instead.
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    if (startPainting(e)) drawingPointerId = e.pointerId;
  } else if (pointers.size === 2) {
    stopPainting();
    drawingPointerId = null;
    twoFinger = twoFingerState();
  }
}

function onPointerMove(e) {
  if (e.pointerType === 'mouse') {
    if (looking) {
      yaw -= (e.clientX - lastX) * LOOK_SPEED;
      pitch -= (e.clientY - lastY) * LOOK_SPEED;
      lastX = e.clientX; lastY = e.clientY;
      updateCameraOrientation();
      return;
    }
    if (activeFace !== null) {
      const uv = trackActiveStroke(e);
      if (uv) {
        const [px, py] = uvToPixel(uv);
        faces[activeFace].brush.pointerMove(px, py);
      }
      return;
    }
    // idle hover: track which wall keyboard shortcuts should act on
    const hit = castCube(e);
    if (hit) hoverFace = hit.faceIndex;
    return;
  }

  // touch / pen
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    const state = twoFingerState();
    if (twoFinger) {
      yaw -= (state.midX - twoFinger.midX) * LOOK_SPEED;
      pitch -= (state.midY - twoFinger.midY) * LOOK_SPEED;
      updateCameraOrientation();
      moveForward((state.dist - twoFinger.dist) * PINCH_SPEED);
    }
    twoFinger = state;
    return;
  }

  if (activeFace !== null && e.pointerId === drawingPointerId) {
    const uv = trackActiveStroke(e);
    if (uv) {
      const [px, py] = uvToPixel(uv);
      faces[activeFace].brush.pointerMove(px, py);
    }
  }
}

function onPointerUp(e) {
  if (e.pointerType === 'mouse') {
    stopPainting();
    looking = false;
    return;
  }

  pointers.delete(e.pointerId);
  if (e.pointerId === drawingPointerId) {
    stopPainting();
    drawingPointerId = null;
  }
  if (pointers.size < 2) twoFinger = null; // require a fresh two-finger-down to resume, avoiding a jump
}

// ---------------------------------------------------------------- keyboard

function lookWithKeys(dYaw, dPitch) {
  yaw += dYaw; pitch += dPitch;
  updateCameraOrientation();
  // no mouse position to raycast from — use the centre of the screen
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hit = raycaster.intersectObject(room);
  if (hit.length) hoverFace = hit[0].face.materialIndex;
  updateHUD();
}

function onKeyDown(e) {
  const key = e.key;
  const lower = key.toLowerCase();
  if (lower === 'w' || lower === 'a' || lower === 's' || lower === 'd') heldKeys.add(lower);

  if (key === 'ArrowLeft') { lookWithKeys(KEY_LOOK_STEP, 0); return; }
  if (key === 'ArrowRight') { lookWithKeys(-KEY_LOOK_STEP, 0); return; }
  if (key === 'ArrowUp') { lookWithKeys(0, KEY_LOOK_STEP); return; }
  if (key === 'ArrowDown') { lookWithKeys(0, -KEY_LOOK_STEP); return; }

  const face = faces[hoverFace] && faces[hoverFace].brush;
  if (key >= '1' && key <= '6') setColorLock(COLOR_KEYS[Number(key) - 1]);
  else if (key === '0') setColorLock(null);
  else if (key === '[') shrinkBrush();
  else if (key === ']') growBrush();
  else if (key === '-') shrinkDensity();
  else if (key === '=' || key === '+') growDensity();
  else if (key === ' ') { if (face) face.autoFill(); e.preventDefault(); }
  else if (key === 'e' || key === 'E') toggleEraser();
  else if (key === 'g' || key === 'G') toggleShowStaff();
  else if (key === 'c' || key === 'C') { if (face) face.clearAll(); }
  else if (key === 'r' || key === 'R') { if (face) face.newStaff(); }
  else if (key === 'p' || key === 'P') { if (face) face.save(`score-wall-${FACE_NAMES[hoverFace]}`); }
  else if (key === 'h' || key === 'H') toggleHUD();
  updateHUD();
}

function onKeyUp(e) {
  heldKeys.delete(e.key.toLowerCase());
}

function updateHUD() {
  const sw = document.getElementById('swatch');
  const { bs, density, colorLock, eraser } = getBrushState();
  if (sw) {
    sw.style.background = colorLock
      ? PALETTE[colorLock]
      : 'conic-gradient(#05012D, #E62662, #1E0685, #8E0420, #8D13B3, #D94DDB, #05012D)';
  }
  setStatus(
    `wall: ${hoverFace + 1}/4  color: ${colorLock || 'random'}  size: ${bs.toFixed(2)}  density: ${density.toFixed(2)}` +
    (eraser ? '  [ERASER]' : ''));
}

if (document.readyState === 'complete') initWorld();
else window.addEventListener('load', initWorld);
