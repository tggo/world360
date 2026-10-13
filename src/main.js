import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { geocode, fetchCity, fetchTilesCached, parseLocation, placeName } from './osm.js';
import { buildCity, makeProjector } from './city.js';
import { MangaRenderer } from './render.js';
import { t, lang, setLang, applyI18n } from './i18n.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const view = $('view');

// ------------------------------------------------------------------ state
const state = {
  center: { lat: 49.8419, lon: 24.0315, name: lang === 'uk' ? 'Львів, площа Ринок' : 'Lviv, Market Square' },
  radius: 350, season: 'summer', traffic: 'few', treeDetail: 1, leafRough: 0.3, salt: 0,
  mode: 3, lens: 28, twoPoint: false,
};

// ------------------------------------------------------------------ three setup
const manga = new MangaRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
const renderCam = camera.clone();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.499;
controls.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight(0xf2f5ff, 0x8a8170, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
scene.add(sun, sun.target);
scene.background = new THREE.Color('#dfe8ef');

let city = null;

const lensToFov = (mm) => (2 * Math.atan(12 / mm) * 180) / Math.PI; // 35mm full-frame, vertical

// ------------------------------------------------------------------ sun
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const la = lat * rad;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { az: (az / rad + 360) % 360, el: el / rad };
}

function updateSun() {
  let az = +$('sunAz').value, el = +$('sunEl').value;
  if ($('realSun').checked) {
    const t = $('sunTime').value ? new Date($('sunTime').value) : new Date();
    const p = sunPosition(t, state.center.lat, state.center.lon);
    az = p.az; el = p.el;
  }
  const lit = el > 0;
  el = Math.max(2, el);
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const R = state.radius * 2.5;
  // azimuth from north, clockwise; north = -z, east = +x
  sun.position.set(Math.sin(a) * Math.cos(e) * R, Math.sin(e) * R, -Math.cos(a) * Math.cos(e) * R);
  sun.intensity = lit ? 2.2 : 0.25;
  hemi.intensity = lit ? 1.1 : 0.5;
  const s = sun.shadow.camera, ext = state.radius * 1.25;
  s.left = -ext; s.right = ext; s.top = ext; s.bottom = -ext; s.near = 1; s.far = R * 2.5;
  s.updateProjectionMatrix();
  sun.castShadow = $('shadows').checked;
  manga.r.shadowMap.needsUpdate = true;
}

// ------------------------------------------------------------------ city loading
const status = (msg, err = false) => { $('status').textContent = msg; $('status').className = 'status' + (err ? ' err' : ''); };
const busy = (msg) => { $('busy').hidden = !msg; $('busyText').textContent = msg || ''; };

let osmData = null;
let loadSeq = 0;
// Fast path: OpenFreeMap vector tiles (CDN). Then, in the background, try Overpass for the full
// OSM detail (building types, individual trees) and rebuild in place if it answers.
async function loadCity({ keepCamera = false } = {}) {
  const seq = ++loadSeq;
  const { lat, lon } = state.center, radius = state.radius;
  busy(t('loadingMap'));
  status('');
  try {
    osmData = await fetchTilesCached(lat, lon, radius);
    if (seq !== loadSeq) return;
    await rebuild(keepCamera);
    status((state.center.name || '') + ' · ' + t('srcTiles'));
  } catch (e) {
    status(t('failed') + e.message, true);
    busy('');
    return;
  } finally { busy(''); }
  fetchCity(lat, lon, radius).then(async (full) => {
    if (seq !== loadSeq || !full?.elements?.length) return;
    // Overpass covers the radius; keep the tile features beyond it as the far zone,
    // otherwise the city visibly shrinks when the detailed data arrives
    const tiles = osmData;
    const P = makeProjector(lat, lon);
    const outside = (tiles.elements || []).filter((e) => {
      const g = e.geometry || e.members?.[0]?.geometry;
      if (!g?.length) return false;
      const [x, y] = P.toXY(g[0].lat, g[0].lon);
      return Math.hypot(x, y) > radius;
    });
    osmData = { elements: full.elements.concat(outside) };
    await rebuild(true);
    status((state.center.name || '') + ' · ' + t('srcOsm'));
  }).catch(() => {
    if (seq === loadSeq) status((state.center.name || '') + ' · ' + t('srcTilesOnly'));
  });
}

function rebuild(keepCamera = true) {
  if (!osmData) return;
  busy(t('buildingCity'));
  // let the overlay paint first
  return new Promise((res) => setTimeout(() => {
    if (city) {
      scene.remove(city.group);
      city.group.traverse((o) => o.geometry?.dispose());
    }
    city = buildCity(osmData, state.center, {
      radius: state.radius, season: state.season, traffic: state.traffic, trees: true,
      treeDetail: state.treeDetail, leafRough: state.leafRough, treeDensity: 1, salt: state.salt,
    });
    scene.add(city.group);
    const i = city.info;
    $('cityInfo').textContent = t('cityInfo', i);
    scene.background.set(state.season === 'winter' ? '#e4e9ee' : '#dfe8ef');
    updateSun();
    if (!keepCamera) preset('bird');
    dirty = true;
    busy('');
    writeHash();
    res();
  }, 30));
}

// ------------------------------------------------------------------ camera presets
function roadGraph() {
  const count = new Map();
  for (const r of city?.roadLines || []) {
    if (['track'].includes(r.t)) continue;
    for (const p of r.pts) { const k = p[0].toFixed(1) + ',' + p[1].toFixed(1); count.set(k, (count.get(k) || 0) + 1); }
  }
  return count;
}
function nearestIntersection() {
  let best = null, bd = Infinity;
  for (const [k, c] of roadGraph()) {
    if (c < 2) continue;
    const [x, y] = k.split(',').map(Number);
    const d = Math.hypot(x, y);
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}
function roadDirAt(p) {
  for (const r of city?.roadLines || []) {
    const i = r.pts.findIndex((q) => Math.abs(q[0] - p[0]) < 0.05 && Math.abs(q[1] - p[1]) < 0.05);
    if (i < 0) continue;
    const j = i < r.pts.length - 1 ? i + 1 : i - 1;
    const dx = r.pts[j][0] - p[0], dy = r.pts[j][1] - p[1];
    const L = Math.hypot(dx, dy) || 1;
    return { dir: [dx / L, dy / L], w: r.w, len: L };
  }
  return { dir: [1, 0], w: 6, len: 30 };
}

// Walk mode: OrbitControls off, mouse turns the head (drag, or pointer lock after a click),
// WASD moves at eye height. Outside walk mode WASD slides camera and target together.
const look = { yaw: 0, pitch: 0 };
function setStand(on) {
  $('stand').checked = on;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  if (on) {
    controls.enabled = false;
    if (camera.position.y > 30) camera.position.y = 1.6;
    look.yaw = Math.atan2(dir.x, -dir.z);
    look.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    applyLook();
    $('walkHint').hidden = false;
  } else {
    if (document.pointerLockElement) document.exitPointerLock();
    controls.enabled = true;
    controls.target.copy(camera.position).addScaledVector(dir, 60);
    if (controls.target.y < 0) controls.target.y = 0;
    controls.update();
    $('walkHint').hidden = true;
  }
  redraw();
}
function applyLook() {
  look.pitch = THREE.MathUtils.clamp(look.pitch, -1.45, 1.45);
  camera.rotation.set(look.pitch, -look.yaw, 0, 'YXZ');
  controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation).multiplyScalar(0.1));
  redraw(); writeHashSoon();
}
const walking = () => $('stand').checked;
{
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (walking() && !document.pointerLockElement) drag = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('click', (e) => { if (walking() && !e.shiftKey && e.detail === 1) canvas.requestPointerLock?.(); });
  window.addEventListener('pointermove', (e) => {
    if (!walking()) return;
    let dx, dy;
    if (document.pointerLockElement === canvas) { dx = e.movementX; dy = e.movementY; }
    else if (drag) { dx = e.clientX - drag.x; dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; }
    else return;
    const k = 0.0022 * (state.lens / 28) ** -0.5;
    look.yaw += dx * k; look.pitch -= dy * k;
    applyLook();
  });
}
const keys = new Set();
const tapped = new Set(); // keys pressed since the last frame, so a quick tap still moves
window.addEventListener('keydown', (e) => {
  if (e.target?.closest?.('input, select, textarea')) return;
  const k = e.code;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space'].includes(k)) {
    keys.add(k); tapped.add(k); e.preventDefault();
  }
  if (k === 'KeyF') setStand(!walking());
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
function moveByKeys(dt) {
  const held = new Set([...keys, ...tapped]); tapped.clear();
  const keysNow = held;
  const f = (keysNow.has('KeyW') || keysNow.has('ArrowUp') ? 1 : 0) - (keysNow.has('KeyS') || keysNow.has('ArrowDown') ? 1 : 0);
  const r = (keysNow.has('KeyD') || keysNow.has('ArrowRight') ? 1 : 0) - (keysNow.has('KeyA') || keysNow.has('ArrowLeft') ? 1 : 0);
  const u = (keysNow.has('KeyE') || keysNow.has('Space') ? 1 : 0) - (keysNow.has('KeyQ') ? 1 : 0);
  if (!f && !r && !u) return;
  dt = Math.max(dt, 1 / 30);
  const run = keysNow.has('ShiftLeft') || keysNow.has('ShiftRight') ? 4 : 1;
  const speed = (walking() ? 4 : Math.max(8, camera.position.y * 0.8)) * run;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  dir.y = 0; dir.normalize();
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  const d = dir.multiplyScalar(f).add(right.multiplyScalar(r)).multiplyScalar(speed * dt);
  d.y = u * speed * dt;
  camera.position.add(d); controls.target.add(d);
  if (camera.position.y < 0.5) { controls.target.y += 0.5 - camera.position.y; camera.position.y = 0.5; }
  if (!walking()) controls.update();
  redraw(); writeHashSoon();
}

function preset(name) {
  const R = state.radius;
  if ($('stand').checked) setStand(false);
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  let pos, tgt;
  if (name === 'bird') { pos = P(R * 0.55, R * 0.5, R * 0.75); tgt = P(0, 0, 0); }
  else if (name === 'top') { pos = P(0, R * 1.9, 0.01); tgt = P(0, 0, 0); }
  else if (name === 'low') { pos = P(R * 0.22, 14, R * 0.3); tgt = P(0, 8, 0); }
  else {
    const c = nearestIntersection() || [0, 0];
    const { dir, w } = roadDirAt(c);
    if (name === 'cross') {
      // stand on the corner, look across the intersection
      // stand at the road edge a little before the junction, look across it
      const off = Math.max(0, w / 2 - 1);
      pos = P(c[0] - dir[0] * 10 - dir[1] * off, 1.6, -(c[1] - dir[1] * 10 + dir[0] * off));
      tgt = P(c[0] + dir[0] * 30, 1.6, -(c[1] + dir[1] * 30));
    } else {
      // in the middle of the street, looking down it
      pos = P(c[0] + dir[0] * 4, 1.6, -(c[1] + dir[1] * 4));
      tgt = P(c[0] + dir[0] * 80, 1.6, -(c[1] + dir[1] * 80));
    }
  }
  camera.position.copy(pos); controls.target.copy(tgt);
  if (name === 'top') { state.twoPoint = false; $('twoPoint').checked = false; }
  controls.update();
  writeHashSoon();
}

// ------------------------------------------------------------------ render
function syncRenderCam(w, h) {
  const fov = lensToFov(state.lens);
  renderCam.position.copy(camera.position);
  renderCam.quaternion.copy(camera.quaternion);
  renderCam.fov = fov;
  renderCam.aspect = w / h;
  const camH = Math.max(0.5, camera.position.y);
  renderCam.near = Math.min(3, Math.max(0.3, camH * 0.02));
  renderCam.far = state.radius * 8;
  renderCam.clearViewOffset();
  if (state.twoPoint) {
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    if (Math.abs(pitch) < THREE.MathUtils.degToRad(75)) {
      const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      renderCam.up.set(0, 1, 0);
      renderCam.lookAt(renderCam.position.clone().add(flat));
      const shift = Math.tan(pitch) / Math.tan(THREE.MathUtils.degToRad(fov / 2)); // in half-heights
      renderCam.updateProjectionMatrix();
      renderCam.setViewOffset(w, h, 0, (-shift * h) / 2, w, h);
    }
  }
  renderCam.updateProjectionMatrix();
  renderCam.updateMatrixWorld();
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  manga.setSize(w, h);
}
new ResizeObserver(resize).observe(view);

let dirty = true;
controls.addEventListener('change', () => { dirty = true; writeHashSoon(); });
let lastT = performance.now();
function frame(t = performance.now()) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  moveByKeys(dt);
  if (!walking()) controls.update();
  if (!dirty) return;
  dirty = false;
  syncRenderCam(manga.size.x, manga.size.y);
  manga.render(scene, renderCam);
}
const redraw = () => { dirty = true; };

// ------------------------------------------------------------------ style uniforms
function applyStyle() {
  const u = manga.u;
  u.mode.value = state.mode;
  u.lineW.value = +$('lineW').value;
  u.normalTh.value = +$('normalTh').value;
  u.pattern.value = +$('pattern').value;
  u.toneSize.value = +$('toneSize').value;
  u.toneStart.value = +$('toneStart').value;
  u.toneOpacity.value = +$('toneOpacity').value;
  u.betaTh.value = +$('betaTh').value;
  u.whiteOut.value = +$('whiteOut').value;
  redraw();
}
for (const id of ['lineW', 'normalTh', 'pattern', 'toneSize', 'toneStart', 'toneOpacity', 'betaTh', 'whiteOut']) $(id).addEventListener('input', () => { applyStyle(); writeHashSoon(); });
$('modes').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.mode = +b.dataset.m;
  for (const x of $('modes').children) x.classList.toggle('on', x === b);
  applyStyle(); writeHashSoon();
});

// ------------------------------------------------------------------ UI wiring
$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  try {
    busy(t('searching'));
    state.center = await geocode(q);
    await loadCity();
  } catch (err) { status(err.message, true); busy(''); }
});
$('radius').addEventListener('change', () => { state.radius = +$('radius').value; loadCity({ keepCamera: false }); });
$('season').addEventListener('change', () => { state.season = $('season').value; rebuild(); });
$('traffic').addEventListener('change', () => { state.traffic = $('traffic').value; rebuild(); });
$('treeDetail').addEventListener('change', () => { state.treeDetail = +$('treeDetail').value; rebuild(); });
$('leafRough').addEventListener('change', () => { state.leafRough = +$('leafRough').value; rebuild(); });
$('reroll').addEventListener('click', () => { state.salt++; rebuild(); });
$('rebuild').addEventListener('click', () => rebuild());
$('presets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) preset(b.dataset.p); });
$('lens').addEventListener('input', () => { state.lens = +$('lens').value; $('lensVal').textContent = state.lens + ' ' + t('mm'); redraw(); writeHashSoon(); });
$('twoPoint').addEventListener('change', () => { state.twoPoint = $('twoPoint').checked; redraw(); writeHashSoon(); });
$('stand').addEventListener('change', () => { setStand($('stand').checked); redraw(); });
$('realSun').addEventListener('change', () => { $('sunManual').hidden = $('realSun').checked; $('sunReal').hidden = !$('realSun').checked; updateSun(); redraw(); });
for (const id of ['sunAz', 'sunEl', 'sunTime', 'shadows']) $(id).addEventListener('input', () => { updateSun(); redraw(); writeHashSoon(); });
$('togglePanel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
{
  const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('sunTime').value = now.toISOString().slice(0, 16);
}

// clicks on the scene: shift = new pin, double = fly closer
const ray = new THREE.Raycaster();
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  syncRenderCam(manga.size.x, manga.size.y);
  ray.setFromCamera(ndc, renderCam);
  const hit = city && ray.intersectObject(city.group, true)[0];
  return hit?.point || null;
}
canvas.addEventListener('click', async (ev) => {
  if (!ev.shiftKey || !city) return;
  const p = pick(ev); if (!p) return;
  const ll = city.projector.toLatLon(p.x, -p.z);
  state.center = { ...ll, name: `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)}` };
  await loadCity();
});
canvas.addEventListener('dblclick', (ev) => {
  const p = pick(ev); if (!p) return;
  if ($('stand').checked) setStand(false);
  const back = camera.position.clone().sub(controls.target).normalize();
  const dist = Math.max(15, camera.position.distanceTo(controls.target) * 0.35);
  controls.target.copy(p);
  camera.position.copy(p).addScaledVector(back, dist);
  if (camera.position.y < 1.6) camera.position.y = 1.6;
  controls.update();
});

// KML / KMZ-less / GeoJSON drop: take the first coordinate
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0]; if (!f) return;
  const txt = await f.text();
  let ll = null;
  try {
    if (/\.(geo)?json$/i.test(f.name)) {
      const flat = JSON.stringify(JSON.parse(txt)).match(/"coordinates":\[*(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (flat) ll = { lat: +flat[2], lon: +flat[1] };
    } else {
      const m = txt.match(/<coordinates>\s*(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (m) ll = { lat: +m[2], lon: +m[1] };
    }
  } catch { /* */ }
  if (!ll) { status(t('noCoords'), true); return; }
  state.center = { ...ll, name: f.name };
  loadCity();
});

// ------------------------------------------------------------------ export
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const slug = () => (state.center.name || 'world360').split(',')[0].replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);

$('savePng').addEventListener('click', async () => {
  const L = +$('pngSize').value;
  const aw = manga.size.x, ah = manga.size.y;
  const w = aw >= ah ? L : Math.round((L * aw) / ah), h = aw >= ah ? Math.round((L * ah) / aw) : L;
  busy(t('rendering', w, h));
  await new Promise((r) => setTimeout(r, 30));
  const transparent = $('pngTransparent').checked && state.mode >= 2;
  const ss = manga.supersample;
  manga.supersample = L <= 2400 ? 2 : 1;
  manga.r.setSize(w, h, false);
  manga.u.transparent.value = transparent ? 1 : 0;
  syncRenderCam(w, h);
  manga.render(scene, renderCam, w, h);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  if ($('pngCredit').checked) {
    const fs = Math.round(h / 90);
    ctx.font = `${fs}px sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = state.mode >= 2 ? '#000' : 'rgba(0,0,0,.7)';
    ctx.fillText('© OpenStreetMap contributors', w - fs, h - fs * 0.6);
  }
  manga.u.transparent.value = 0;
  manga.supersample = ss;
  resize(); redraw();
  out.toBlob((b) => { download(b, `${slug()}-${w}x${h}.png`); busy(''); }, 'image/png');
});

$('saveGlb').addEventListener('click', async () => {
  if (!city) return;
  busy(t('glb'));
  try {
    const glb = await new GLTFExporter().parseAsync(city.group, { binary: true });
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${slug()}.glb`);
  } catch (e) { status('GLB: ' + e.message, true); }
  busy('');
});

$('share').addEventListener('click', async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); status(t('copied')); }
  catch { status(location.href); }
});

// ------------------------------------------------------------------ Krea2 comic render
// The current frame goes to the Go service behind /api, which runs Krea2 img2img on ComfyUI.
function renderFrame(L, baseMode) {
  const aw = manga.size.x, ah = manga.size.y;
  const r16 = (x) => Math.max(256, Math.round(x / 16) * 16);
  const w = r16(aw >= ah ? L : (L * aw) / ah), h = r16(aw >= ah ? (L * ah) / aw : L);
  const ss = manga.supersample;
  // colour + lines carries far more for img2img than white line art: grass, water, asphalt,
  // roofs — a mostly white base lets the model invent whatever the prompt suggests
  const mode = manga.u.mode.value;
  manga.u.mode.value = baseMode;
  manga.r.setSize(w, h, false);
  syncRenderCam(w, h);
  manga.render(scene, renderCam, w, h);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0);
  manga.u.mode.value = mode;
  manga.supersample = ss;
  resize(); redraw();
  return out;
}

const ai = { styles: [], picked: new Set(['manga']) };
function grey(src) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const x = c.getContext('2d'); x.filter = 'grayscale(1) contrast(1.15)'; x.drawImage(src, 0, 0);
  return c;
}
const sname = (st) => (lang === 'en' && st.name_en) || st.name;
// one sentence about the camera, so the model keeps the composition of the frame
function viewSentence() {
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  const pitch = THREE.MathUtils.radToDeg(Math.asin(dir.y));
  const h = camera.position.y;
  const season = { spring: 'in spring', summer: 'in summer', autumn: 'in autumn', winter: 'in winter with snow' }[state.season];
  const where = ai.place ? ` in ${ai.place}, with the characteristic local architecture, building styles and street details of that place` : '';
  const yaw = (THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z)) + 360) % 360;
  const compass = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(yaw / 45) % 8];
  const tilt = Math.round(Math.abs(pitch));
  const cam = ` Camera ${Math.round(h)} m above the ground, tilted ${tilt} degrees ${pitch < 0 ? 'down' : 'up'}, ${state.lens} mm lens, facing ${compass}`
    + (state.lens <= 20 ? ', wide-angle perspective' : state.lens >= 60 ? ', compressed telephoto perspective' : '')
    + (state.twoPoint ? ', vertical lines kept parallel (two-point perspective)' : '') + '.';
  const tail = `${where}, ${season}, the same layout and perspective as the reference.` + cam;
  if (pitch < -65) return 'A top-down overhead view straight down onto the place shown in the reference, map-like' + tail;
  if (h > 40) return 'A high aerial bird\'s-eye view looking down at an oblique angle over exactly the place shown in the reference: keep its parks, open spaces, roads and buildings where they are' + tail;
  if (h > 6) return 'An elevated view over exactly the place shown in the reference: keep its streets, open spaces and buildings where they are' + tail;
  return 'A street-level view at human eye height looking along a city street, building facades with windows and doors on both sides, pavement in the foreground' + tail;
}
async function loadStyles() {
  try {
    ai.styles = await (await fetch('/api/styles')).json();
  } catch { $('aiStatus').textContent = t('aiDown'); return; }
  $('aiStyles').innerHTML = '';
  for (const st of ai.styles) {
    const b = document.createElement('button');
    b.textContent = sname(st); b.dataset.id = st.id;
    if (!st.enabled) { b.disabled = true; b.title = t('soon'); ai.picked.delete(st.id); }
    b.classList.toggle('on', ai.picked.has(st.id));
    b.onclick = () => { ai.picked.has(st.id) ? ai.picked.delete(st.id) : ai.picked.add(st.id); b.classList.toggle('on'); };
    $('aiStyles').append(b);
  }
}
async function showQuota() {
  try {
    const q = await (await fetch('/api/quota')).json();
    ai.quota = q;
    $('aiStatus').textContent = q.unlimited ? t('unlimited') : t('left', Math.max(0, q.limit - q.used), q.limit);
  } catch { /* server down: loadStyles already says so */ }
}
$('denoise').addEventListener('input', () => { $('denoiseVal').textContent = (+$('denoise').value).toFixed(2); });
$('galleryClose').addEventListener('click', () => { $('gallery').hidden = true; });

$('aiGo').addEventListener('click', async () => {
  if (!ai.picked.size) { $('aiStatus').textContent = t('pickStyle'); return; }
  // colour+lines for every style (white line art alone is too empty: the model fills parks with houses);
  // B&W styles get it desaturated so the model keeps tones but adds no colour
  const frames = {};
  const frameFor = (id) => (frames[id === 'manga' ? 'bw' : 'color'] ??= id === 'manga' ? grey(renderFrame(1344, 1)) : renderFrame(1344, 1));
  for (const id of ai.picked) frameFor(id);
  const frame = Object.values(frames)[0];
  ai.place = await placeName(state.center.lat, state.center.lon).catch(() => '');
  const view = viewSentence();
  $('gallery').hidden = false;
  [...ai.picked].forEach(async (id) => {
    const st = ai.styles.find((x) => x.id === id);
    const card = document.createElement('div'); card.className = 'card';
    card.style.setProperty('--ar', `${frame.width}/${frame.height}`);
    card.innerHTML = `<div class="ph"><div class="spinner"></div><span>${sname(st)}: ${t('queued')}…</span></div><div class="meta"><span>${sname(st)}</span><span></span></div>`;
    $('galleryGrid').prepend(card);
    const say = (msg) => { const s = card.querySelector('.ph span'); if (s) s.textContent = `${sname(st)}: ${msg}`; };
    try {
      const r = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: frameFor(id).toDataURL('image/png'), style: id, denoise: +$('denoise').value, extra: $('aiExtra').value.trim(), view }) });
      let j = await r.json();
      if (!r.ok) throw new Error(j.code === 'quota' ? t('errQuota', j.limit) : j.code === 'queue' ? t('errQueue') : j.code === 'style' ? t('errStyle') : (j.error || r.status));
      const t0 = performance.now();
      while (j.status === 'queued' || j.status === 'running') {
        await new Promise((res) => setTimeout(res, 1500));
        j = await (await fetch('/api/job/' + j.id)).json();
        say(`${t(j.status === 'running' ? 'drawing' : 'queued')}… ${Math.round((performance.now() - t0) / 1000)} ${t('sec')}`);
      }
      if (j.status !== 'done') throw new Error(j.error || j.status);
      const src = j.images[0];
      card.querySelector('.ph').outerHTML = `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${sname(st)}"></a>`;
      card.querySelector('.meta span:last-child').innerHTML = `<a href="${src}" download="${slug()}-${id}.png">PNG</a>`;
    } catch (e) {
      say(t('error') + ' — ' + e.message);
      card.querySelector('.spinner')?.remove();
    }
    showQuota();
  });
});
loadStyles().then(showQuota);

// ------------------------------------------------------------------ share link (#hash)
const r2 = (x) => Math.round(x * 100) / 100;
function writeHash() {
  const p = new URLSearchParams();
  p.set('ll', `${state.center.lat.toFixed(6)},${state.center.lon.toFixed(6)}`);
  p.set('r', state.radius); p.set('s', state.season); p.set('t', state.traffic);
  p.set('c', [...camera.position.toArray(), ...controls.target.toArray()].map(r2).join(','));
  p.set('f', state.lens); if (state.twoPoint) p.set('tp', 1);
  p.set('m', state.mode); p.set('v', 2);
  p.set('st', ['lineW', 'normalTh', 'pattern', 'toneSize', 'toneStart', 'toneOpacity', 'betaTh', 'whiteOut', 'sunAz', 'sunEl'].map((id) => $(id).value).join(','));
  if (state.salt) p.set('h', state.salt);
  if (state.center.name) p.set('n', state.center.name.slice(0, 80));
  history.replaceState(null, '', '#' + p.toString());
}
let hashTimer;
function writeHashSoon() { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); }

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('ll')) return null;
  const [lat, lon] = p.get('ll').split(',').map(Number);
  state.center = { lat, lon, name: p.get('n') || '' };
  state.radius = +p.get('r') || state.radius;
  state.season = p.get('s') || state.season;
  state.traffic = p.get('t') || state.traffic;
  state.lens = +p.get('f') || state.lens;
  state.twoPoint = p.get('tp') === '1';
  state.mode = p.has('m') ? +p.get('m') : state.mode;
  state.salt = +p.get('h') || 0;
  const st = p.get('v') === '2' ? (p.get('st') || '').split(',') : []; // v1 links carry the old, too-dense tone
  ['lineW', 'normalTh', 'pattern', 'toneSize', 'toneStart', 'toneOpacity', 'betaTh', 'whiteOut', 'sunAz', 'sunEl'].forEach((id, i) => { if (st[i]) $(id).value = st[i]; });
  return (p.get('c') || '').split(',').map(Number);
}

function syncControls() {
  $('radius').value = state.radius; $('season').value = state.season; $('traffic').value = state.traffic;
  $('lens').value = state.lens; $('lensVal').textContent = state.lens + ' ' + t('mm');
  $('twoPoint').checked = state.twoPoint;
  for (const x of $('modes').children) x.classList.toggle('on', +x.dataset.m === state.mode);
  $('q').value = state.center.name || '';
}

// ------------------------------------------------------------------ language
function markLang() { for (const b of $('langSwitch').children) b.classList.toggle('on', b.dataset.lang === lang); }
$('langSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  setLang(b.dataset.lang); markLang();
  $('lensVal').textContent = state.lens + ' ' + t('mm');
  if (city) $('cityInfo').textContent = t('cityInfo', city.info);
  loadStyles().then(showQuota);
});
applyI18n(); markLang();

// ------------------------------------------------------------------ boot
const cam = readHash();
syncControls();
applyStyle();
resize();
frame();
(async () => {
  await loadCity({ keepCamera: !!(cam && cam.length === 6) });
  if (cam && cam.length === 6 && cam.every(Number.isFinite)) {
    camera.position.set(cam[0], cam[1], cam[2]);
    controls.target.set(cam[3], cam[4], cam[5]);
    controls.update();
  } else if (!city) preset('bird');
  redraw();
})();

// expose for debugging
window.__w360 = { state, scene, camera, controls, manga, preset, get city() { return city; }, parseLocation };
