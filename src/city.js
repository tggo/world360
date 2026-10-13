// OSM elements -> three.js meshes. Every mesh carries an `oid` vertex attribute
// (object id) that the line-art pass uses to find object boundaries.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeBuildingMaterial } from './detail.js';

const M_PER_DEG_LAT = 110540;

export function makeProjector(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    // returns [east, north] in metres
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLatLon: (x, north) => ({ lat: lat0 + north / M_PER_DEG_LAT, lon: lon0 + x / kx }),
  };
}

// deterministic random in [0,1) from an integer seed
function rnd(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
let oidCounter = 0;
function nextOid() { oidCounter++; return 0.05 + rnd(oidCounter * 7.31) * 0.95; }

function setOid(geo, oid) {
  const n = geo.attributes.position.count;
  geo.setAttribute('oid', new THREE.BufferAttribute(new Float32Array(n).fill(oid), 1));
  return geo;
}
function setColor(geo, color) {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = color.r; a[i * 3 + 1] = color.g; a[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}
function clean(geo) {
  // keep only attributes every merged geometry shares
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color', 'oid', 'wall'].includes(k)) geo.deleteAttribute(k);
  if (!geo.attributes.wall) geo.setAttribute('wall', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
  return geo.index ? geo.toNonIndexed() : geo;
}

function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return s / 2; // >0 = clockwise in (east,north)
}
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// join open member ways of a multipolygon into closed rings
function stitch(ways) {
  const rings = [];
  const pool = ways.map((w) => w.slice());
  while (pool.length) {
    let cur = pool.shift();
    let guard = 0;
    while (guard++ < 1000) {
      const a = cur[0], b = cur[cur.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) break;
      const i = pool.findIndex((w) => {
        const s = w[0], e = w[w.length - 1];
        return (s[0] === b[0] && s[1] === b[1]) || (e[0] === b[0] && e[1] === b[1]);
      });
      if (i < 0) break;
      let w = pool.splice(i, 1)[0];
      if (!(w[0][0] === b[0] && w[0][1] === b[1])) w = w.reverse();
      cur = cur.concat(w.slice(1));
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

// element -> [{outer, holes}] in projected metres
function polygons(el, P) {
  const proj = (g) => g.map((n) => P.toXY(n.lat, n.lon));
  if (el.type === 'way' && el.geometry) {
    const r = proj(el.geometry);
    if (r.length < 4) return [];
    return [{ outer: r, holes: [] }];
  }
  if (el.type === 'relation' && el.members) {
    const outers = stitch(el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => proj(m.geometry)));
    const inners = stitch(el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => proj(m.geometry)));
    return outers.map((o) => ({ outer: o, holes: inners.filter((h) => pointInRing(h[0], o)) }));
  }
  return [];
}

function toShape({ outer, holes }) {
  const o = area(outer) > 0 ? outer.slice().reverse() : outer; // shapes want CCW
  const shape = new THREE.Shape(o.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) {
    const hh = area(h) < 0 ? h.slice().reverse() : h;
    shape.holes.push(new THREE.Path(hh.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

// flat polygon at height y
function flatGeo(poly, y) {
  const g = new THREE.ShapeGeometry(toShape(poly));
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// ---------------------------------------------------------------- buildings
const SMALL = new Set(['garage', 'garages', 'shed', 'carport', 'hut', 'kiosk', 'roof', 'toilets', 'cabin', 'greenhouse']);
const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'farm', 'villa', 'terrace']);

function parseLen(v) {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return NaN;
  let x = parseFloat(m[0].replace(',', '.'));
  if (/ft|'/.test(v)) x *= 0.3048;
  return x;
}

export function estimateHeight(tags, footArea, seed) {
  const h = parseLen(tags.height);
  const lv = parseLen(tags['building:levels']);
  const rl = parseLen(tags['roof:levels']) || 0;
  if (!isNaN(h)) return { h, guessed: false };
  if (!isNaN(lv)) return { h: (lv + rl) * 3.1 + 0.6, guessed: false };
  const t = tags.building || tags['building:part'] || 'yes';
  const r = rnd(seed);
  const pick = (a, b) => Math.round(a + r * (b - a));
  let levels;
  if (SMALL.has(t)) levels = 1;
  else if (HOUSE.has(t)) levels = pick(1, 2);
  else if (t === 'apartments' || t === 'residential') levels = footArea > 400 ? pick(5, 10) : pick(3, 5);
  else if (['commercial', 'office', 'retail', 'hotel'].includes(t)) levels = pick(3, 7);
  else if (['industrial', 'warehouse', 'manufacture', 'hangar'].includes(t)) return { h: 7 + r * 6, guessed: true };
  else if (['church', 'cathedral', 'chapel', 'mosque', 'temple', 'synagogue'].includes(t)) return { h: 12 + r * 14, guessed: true };
  else if (['school', 'university', 'hospital', 'college', 'kindergarten', 'public', 'civic'].includes(t)) levels = pick(2, 4);
  else if (footArea < 60) levels = 1;
  else if (footArea < 160) levels = pick(1, 2);
  else if (footArea < 450) levels = pick(2, 4);
  else if (footArea < 1500) levels = pick(3, 7);
  else levels = pick(4, 9);
  return { h: levels * 3.1 + 0.6, guessed: true };
}

// minimum-area oriented rectangle of a ring (edge-aligned search)
function obb(ring) {
  let best = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i + 1][0] - ring[i][0], dy = ring[i + 1][1] - ring[i][1];
    const L = Math.hypot(dx, dy);
    if (L < 0.5) continue;
    const ux = dx / L, uy = dy / L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of ring) {
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const ar = (a1 - a0) * (b1 - b0);
    if (!best || ar < best.area) best = { area: ar, ux, uy, a0, a1, b0, b1 };
  }
  return best;
}

// gabled / hipped roof on the oriented rectangle, base at y0
function roofGeo(box, y0, shape) {
  let { ux, uy, a0, a1, b0, b1 } = box;
  // ridge along the long side
  if (b1 - b0 > a1 - a0) { [ux, uy] = [-uy, ux]; [a0, a1, b0, b1] = [b0, b1, -a1, -a0]; }
  const short = b1 - b0;
  const rh = Math.min(short * 0.38, 6);
  const P = (a, b, y) => new THREE.Vector3(a * ux - b * uy, y, -(a * uy + b * ux));
  const bm = (b0 + b1) / 2;
  const inset = shape === 'hipped' ? Math.min(short / 2, (a1 - a0) / 2 - 0.1) : 0;
  const c = [P(a0, b0, y0), P(a1, b0, y0), P(a1, b1, y0), P(a0, b1, y0)];
  const r0 = P(a0 + inset, bm, y0 + rh), r1 = P(a1 - inset, bm, y0 + rh);
  const tris = [
    [c[0], c[1], r1], [c[0], r1, r0],   // side 1
    [c[2], c[3], r0], [c[2], r0, r1],   // side 2
    [c[1], c[2], r1], [c[3], c[0], r0], // gable ends / hips
  ];
  const pos = [];
  for (const t of tris) for (const v of t) pos.push(v.x, v.y, v.z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // make all faces point outward/upward
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i += 3) {
    if (n.getY(i) < -0.01) {
      const p = g.attributes.position;
      const ax = p.getX(i + 1), ay = p.getY(i + 1), az = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, ax, ay, az);
    }
  }
  g.computeVertexNormals();
  return g;
}

const WALLS = ['#e8e1d3', '#ddd6c8', '#d4d2cc', '#e6dccb', '#cfc8bb', '#ece6dc', '#d9cfc0'].map((c) => new THREE.Color(c));
const ROOFS = ['#8a4b3a', '#6f6a66', '#7a3f33', '#5e5a57', '#946150'].map((c) => new THREE.Color(c));
const FLAT_ROOF = new THREE.Color('#bdb8b0');

function buildBuildings(els, P, opts, info) {
  const geos = [], roofGeos = [];
  const partsOf = new Set();
  const seen = new Set();
  for (const el of els) if (el.tags?.['building:part']) partsOf.add(el.id);
  for (const el of els) {
    const tags = el.tags || {};
    if (!tags.building && !tags['building:part']) continue;
    if (tags.building === 'no') continue;
    // skip outlines that are fully represented by building:part (avoid z-fighting)
    if (el._hasParts) continue;
    for (const poly of polygons(el, P)) {
      const A = Math.abs(area(poly.outer));
      if (A < 4) continue;
      // same footprint twice (outline + part, way + relation, tile overlap): coplanar walls flicker
      let cx = 0, cy = 0;
      for (const [x, y] of poly.outer) { cx += x; cy += y; }
      const fkey = `${Math.round(cx / poly.outer.length)},${Math.round(cy / poly.outer.length)},${Math.round(Math.sqrt(A))},${tags.min_height || tags["building:min_level"] || 0}`;
      if (seen.has(fkey)) continue;
      seen.add(fkey);
      const seed = el.id + opts.salt * 1013;
      const { h, guessed } = estimateHeight(tags, A, seed);
      const minH = parseLen(tags.min_height) || (parseLen(tags['building:min_level']) * 3.1) || 0;
      if (guessed) info.guessed++; else info.tagged++;
      const oid = nextOid();
      const wall = tags['building:colour'] ? safeColor(tags['building:colour'], WALLS[0]) : WALLS[Math.floor(rnd(seed + 3) * WALLS.length)];

      let roofShape = tags['roof:shape'];
      const t = tags.building || '';
      const box = obb(poly.outer);
      const rect = box && box.area > 0 && A / box.area > 0.86;
      if (!roofShape && rect && poly.holes.length === 0 && h < 11 && A < 350 && (HOUSE.has(t) || (t === 'yes' && A < 200) || SMALL.has(t) && A > 25)) {
        roofShape = rnd(seed + 9) < 0.35 ? 'hipped' : 'gabled';
      }
      const pitched = (roofShape === 'gabled' || roofShape === 'hipped') && rect;
      const short = box ? Math.min(box.a1 - box.a0, box.b1 - box.b0) : 0;
      const roofH = pitched ? Math.min(short * 0.38, 6) : 0;
      const wallH = Math.max(1, h - roofH - minH);

      const g = new THREE.ExtrudeGeometry(toShape(poly), { depth: wallH, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, minH, 0);
      setColor(g, wall);
      // colour the top cap like a flat roof
      const nrm = g.attributes.normal, col = g.attributes.color;
      for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) > 0.9) col.setXYZ(i, FLAT_ROOF.r, FLAT_ROOF.g, FLAT_ROOF.b);
      g.setAttribute('wall', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(1), 1));
      geos.push(clean(setOid(g, oid)));
      // Manga+: rooftop clutter on flat roofs (AC units, stair huts, water tanks)
      if (!pitched && A > 90 && wallH > 5) {
        const n = 1 + Math.floor(rnd(seed + 21) * Math.min(5, A / 140));
        const xs = poly.outer.map((q) => q[0]), ys = poly.outer.map((q) => q[1]);
        const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
        for (let k = 0, placed = 0; k < 30 && placed < n; k++) {
          const q = [bx0 + rnd(seed + 40 + k * 2) * (bx1 - bx0), by0 + rnd(seed + 41 + k * 2) * (by1 - by0)];
          if (!pointInRing(q, poly.outer)) continue;
          const r = rnd(seed + 90 + k);
          let ug;
          if (r < 0.18) { ug = new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10); ug.translate(0, 2.6, 0); }
          else if (r < 0.4) { ug = new THREE.BoxGeometry(3.2, 2.6, 2.6); ug.translate(0, 1.3, 0); }
          else { ug = new THREE.BoxGeometry(1.4 + r, 0.9 + r * 0.6, 1.0 + r * 0.5); ug.translate(0, 0.5, 0); }
          ug.rotateY(Math.atan2(box ? box.uy : 0, box ? box.ux : 1));
          ug.translate(q[0], minH + wallH, -q[1]);
          roofGeos.push(clean(setOid(setColor(ug, new THREE.Color('#cfccc6')), nextOid())));
          placed++;
        }
      }
      if (pitched) {
        const r = roofGeo(box, minH + wallH, roofShape);
        const rc = tags['roof:colour'] ? safeColor(tags['roof:colour'], ROOFS[0]) : ROOFS[Math.floor(rnd(seed + 5) * ROOFS.length)];
        geos.push(clean(setOid(setColor(r, rc), oid)));
      }
      info.buildings++;
    }
  }
  return { geos, roofGeos };
}
function safeColor(v, fb) { try { return new THREE.Color(v); } catch { return fb; } }

// ---------------------------------------------------------------- roads
const ROAD_W = {
  motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, unclassified: 6, residential: 6,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 6,
  living_street: 5, service: 3.5, pedestrian: 6, track: 3, footway: 2, path: 1.5, cycleway: 2, steps: 2, bridleway: 2,
};
const FOOT = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'track']);

function ribbon(pts, w, y) {
  const pos = [];
  const half = w / 2;
  const off = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    // miter, clamped
    let k = 1;
    if (i > 0 && i < pts.length - 1) {
      const d1x = p[0] - pts[i - 1][0], d1y = p[1] - pts[i - 1][1];
      const l1 = Math.hypot(d1x, d1y) || 1;
      const cos = (d1x / l1) * dx + (d1y / l1) * dy;
      k = Math.min(2.5, 1 / Math.max(0.4, cos));
    }
    return [-dy * half * k, dx * half * k];
  });
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const [ox0, oy0] = off[i], [ox1, oy1] = off[i + 1];
    const L0 = [x0 + ox0, y0 + oy0], R0 = [x0 - ox0, y0 - oy0];
    const L1 = [x1 + ox1, y1 + oy1], R1 = [x1 - ox1, y1 - oy1];
    for (const [x, n] of [L0, R0, L1, R0, R1, L1]) pos.push(x, y, -n);
  }
  // round-ish joints: small disc at each vertex hides gaps
  for (const [x, n] of pts) {
    const seg = 8;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      pos.push(x, y, -n, x + Math.cos(a1) * half, y, -(n + Math.sin(a1) * half), x + Math.cos(a0) * half, y, -(n + Math.sin(a0) * half));
    }
  }
  // every triangle must face up: a down-facing one is lit as its back side (dark) and
  // fights with the up-facing ribbon at the same height
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], bz = pos[i + 8] - pos[i + 2];
    if (az * bx - ax * bz < 0) {
      for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nn = new Float32Array(pos.length);
  for (let i = 1; i < nn.length; i += 3) nn[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
  return g;
}

// ---------------------------------------------------------------- trees
const SEASON = {
  spring: { leaf: ['#9ccc65', '#aed581', '#f8bbd0'], ground: '#ecece4', grass: '#c3dc9c' },
  summer: { leaf: ['#5f8f3e', '#6c9a45', '#4f7d36'], ground: '#ebe8e0', grass: '#b9d494' },
  autumn: { leaf: ['#d9822b', '#c2512f', '#e0b03a', '#8d6e3a'], ground: '#ebe6dc', grass: '#d2c48c' },
  winter: { leaf: null, ground: '#eef1f4', grass: '#e6eaee' },
};
export { SEASON };

function treeGeo(x, n, seed, opts) {
  const s = SEASON[opts.season];
  const r = rnd(seed);
  const conifer = r < opts.coniferShare;
  const h = 5 + rnd(seed + 1) * 9;
  const out = [];
  const trunk = new THREE.CylinderGeometry(0.12 + h * 0.012, 0.18 + h * 0.016, h * 0.45, 6, 1);
  trunk.translate(0, h * 0.225, 0);
  out.push(setColor(trunk, new THREE.Color('#6d5240')));
  if (conifer) {
    const c = new THREE.ConeGeometry(h * 0.22, h * 0.8, 7, 2);
    c.translate(0, h * 0.58, 0);
    out.push(setColor(c, new THREE.Color(opts.season === 'winter' ? '#3d5a45' : '#3f6b45')));
  } else if (s.leaf) {
    const rad = h * (0.26 + rnd(seed + 2) * 0.1);
    const c = new THREE.IcosahedronGeometry(rad, opts.treeDetail);
    const p = c.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // jitter vertices (shared verts move together because they share position)
      const k = 1 + (rnd(Math.round(p.getX(i) * 97 + p.getY(i) * 131 + p.getZ(i) * 173) + seed) - 0.5) * opts.leafRough;
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.85, p.getZ(i) * k);
    }
    c.translate(0, h * 0.62, 0);
    c.computeVertexNormals();
    out.push(setColor(c, new THREE.Color(s.leaf[Math.floor(rnd(seed + 4) * s.leaf.length)])));
  } else {
    // winter deciduous: a few bare branches
    for (let b = 0; b < 4; b++) {
      const br = new THREE.CylinderGeometry(0.05, 0.1, h * 0.45, 4);
      br.translate(0, h * 0.225, 0);
      br.rotateZ(0.5 + rnd(seed + b) * 0.3);
      br.rotateY((b / 4) * Math.PI * 2 + rnd(seed + 7));
      br.translate(0, h * 0.4, 0);
      out.push(setColor(br, new THREE.Color('#5d4637')));
    }
  }
  const oid = nextOid();
  return out.map((g) => { g.translate(x, 0, -n); return clean(setOid(g, oid)); });
}

function scatterInPoly(poly, density, seed, cb) {
  const xs = poly.outer.map((p) => p[0]), ys = poly.outer.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const A = Math.abs(area(poly.outer));
  const count = Math.min(4000, Math.floor(A * density));
  for (let i = 0; i < count * 2 && i < 12000; i++) {
    const p = [x0 + rnd(seed + i * 2) * (x1 - x0), y0 + rnd(seed + i * 2 + 1) * (y1 - y0)];
    if (pointInRing(p, poly.outer) && !poly.holes.some((h) => pointInRing(p, h))) cb(p, seed + i);
  }
}

// ---------------------------------------------------------------- traffic
function carGeo(x, n, ang, seed) {
  const colors = ['#d8d8d8', '#2b2b2b', '#a33', '#345', '#e0e0e0', '#777', '#2a4d7a'];
  const body = new THREE.BoxGeometry(4.2, 0.9, 1.8); body.translate(0, 0.65, 0);
  const cab = new THREE.BoxGeometry(2.2, 0.65, 1.6); cab.translate(-0.2, 1.4, 0);
  const c = new THREE.Color(colors[Math.floor(rnd(seed) * colors.length)]);
  const oid = nextOid();
  return [body, cab].map((g) => {
    setColor(g, c); g.rotateY(ang); g.translate(x, 0, -n); return clean(setOid(g, oid));
  });
}
function personGeo(x, n, seed) {
  const h = 1.6 + rnd(seed) * 0.25;
  const b = new THREE.CylinderGeometry(0.2, 0.17, h * 0.82, 6); b.translate(0, h * 0.41, 0);
  const head = new THREE.SphereGeometry(0.12, 6, 4); head.translate(0, h * 0.9, 0);
  const cols = ['#445', '#833', '#346', '#aa8', '#555'];
  const oid = nextOid();
  return [setColor(b, new THREE.Color(cols[Math.floor(rnd(seed + 1) * cols.length)])), setColor(head, new THREE.Color('#d9b99b'))]
    .map((g) => { g.translate(x, 0, -n); return clean(setOid(g, oid)); });
}

// ---------------------------------------------------------------- main
export function buildCity(data, center, opts) {
  oidCounter = 0;
  const P = makeProjector(center.lat, center.lon);
  const R = opts.radius;
  const info = { buildings: 0, guessed: 0, tagged: 0, trees: 0, roads: 0, cars: 0, people: 0 };
  const els = data.elements || [];
  const season = SEASON[opts.season];

  // building outlines that have parts: drop them, parts carry the shape
  const parts = els.filter((e) => e.tags?.['building:part']);
  if (parts.length) {
    for (const e of els) {
      if (!e.tags?.building || e.tags['building:part'] || e.type !== 'way' || !e.geometry) continue;
      const ring = e.geometry.map((p) => P.toXY(p.lat, p.lon));
      // test the part's centroid: its first node usually sits exactly on the outline
      e._hasParts = parts.some((pp) => {
        if (!pp.geometry || pp.geometry.length < 3) return false;
        let cx = 0, cy = 0;
        for (const g of pp.geometry) { const [x, y] = P.toXY(g.lat, g.lon); cx += x; cy += y; }
        return pointInRing([cx / pp.geometry.length, cy / pp.geometry.length], ring);
      });
    }
  }

  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const bmat = makeBuildingMaterial();
  const add = (geos, name, { shadow = true, receive = true, material = mat } = {}) => {
    if (!geos.length) return;
    const m = new THREE.Mesh(mergeGeometries(geos, false), material);
    m.name = name; m.castShadow = shadow; m.receiveShadow = receive;
    group.add(m);
  };

  // ground
  const gsize = R * 6;
  const ground = new THREE.PlaneGeometry(gsize, gsize); ground.rotateX(-Math.PI / 2);
  add([clean(setOid(setColor(ground, new THREE.Color(season.ground)), 0.001))], 'ground', { shadow: false });

  // landcover
  const grass = [], water = [], treeGeos = [];
  const roads = [], foot = [], rail = [], carGeos = [], peopleGeos = [];
  const roadLines = [];
  for (const el of els) {
    const t = el.tags || {};
    const isGreen = /^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard)$/.test(t.landuse || '')
      || /^(park|garden|pitch|playground)$/.test(t.leisure || '') || /^(wood|scrub|grassland)$/.test(t.natural || '');
    if (isGreen) {
      for (const poly of polygons(el, P)) {
        try { grass.push(clean(setOid(setColor(flatGeo(poly, 0.05), new THREE.Color(t.leisure === 'pitch' ? '#9cbf7a' : season.grass)), 0.003))); } catch { /* bad ring */ }
        const dens = t.landuse === 'forest' || t.natural === 'wood' ? 0.012 : t.leisure === 'park' || t.landuse === 'cemetery' ? 0.004 : 0;
        if (dens && opts.trees) {
          scatterInPoly(poly, dens * opts.treeDensity, el.id, (p, s) => {
            if (Math.hypot(p[0], p[1]) > R * 1.05) return;
            treeGeos.push(...treeGeo(p[0], p[1], s, { ...opts, coniferShare: t.leaf_type === 'needleleaved' ? 0.9 : 0.2 }));
            info.trees++;
          });
        }
      }
    }
    if (t.natural === 'water' || t.waterway === 'riverbank') {
      for (const poly of polygons(el, P)) {
        try { water.push(clean(setOid(setColor(flatGeo(poly, 0.1), new THREE.Color(opts.season === 'winter' ? '#c9d6e0' : '#8fb4cf')), 0.004))); } catch { /* */ }
      }
    }
    if (t.waterway && el.geometry) {
      const pts = el.geometry.map((g) => P.toXY(g.lat, g.lon));
      const w = t.waterway === 'river' ? 20 : t.waterway === 'canal' ? 10 : 3;
      water.push(clean(setOid(setColor(ribbon(pts, w, 0.1), new THREE.Color('#8fb4cf')), 0.004)));
    }
    if (t.highway && el.type === 'way' && el.geometry && !t.area) {
      const pts = el.geometry.map((g) => P.toXY(g.lat, g.lon));
      const lanes = parseLen(t.lanes);
      const w = !isNaN(lanes) && !FOOT.has(t.highway) ? lanes * 3.3 : (ROAD_W[t.highway] ?? 0);
      if (!w || pts.length < 2) continue;
      if (t.tunnel && t.tunnel !== 'no') continue;
      if (FOOT.has(t.highway)) { if (t.highway === 'pedestrian') roadLines.push({ pts, w, t: t.highway, oneway: false }); foot.push(clean(setOid(setColor(ribbon(pts, w, 0.15), new THREE.Color(opts.season === 'winter' ? '#dfe3e6' : '#e6e0d4')), 0.006))); }
      else { roads.push(clean(setOid(setColor(ribbon(pts, w, 0.2), new THREE.Color(opts.season === 'winter' ? '#b9bcc0' : '#ababab')), 0.002))); roadLines.push({ pts, w, t: t.highway, oneway: t.oneway === 'yes' }); }
      info.roads++;
    }
    if (t.railway && el.geometry) {
      const pts = el.geometry.map((g) => P.toXY(g.lat, g.lon));
      // two thin rails at standard gauge, not one dark band
      for (const side of [-0.72, 0.72]) {
        const off = pts.map((p, i) => {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
          return [p[0] - (dy / L) * side, p[1] + (dx / L) * side];
        });
        rail.push(clean(setOid(setColor(ribbon(off, 0.12, 0.22), new THREE.Color('#8a8580')), 0.007)));
      }
    }
    if (opts.trees && el.type === 'node' && t.natural === 'tree') {
      const [x, n] = P.toXY(el.lat, el.lon);
      treeGeos.push(...treeGeo(x, n, el.id, { ...opts, coniferShare: t.leaf_type === 'needleleaved' ? 1 : 0.05 }));
      info.trees++;
    }
    if (opts.trees && t.natural === 'tree_row' && el.geometry) {
      const pts = el.geometry.map((g) => P.toXY(g.lat, g.lon));
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        for (let d = 0; d < L; d += 8) {
          const k = d / L;
          treeGeos.push(...treeGeo(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, el.id + i * 100 + d, { ...opts, coniferShare: 0.05 }));
          info.trees++;
        }
      }
    }
  }

  // cars & people
  const density = { none: 0, few: 1, many: 3 }[opts.traffic] || 0;
  if (density) {
    let s = 1;
    for (const r of roadLines) {
      if (['service', 'track'].includes(r.t)) continue;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [x0, y0] = r.pts[i], [x1, y1] = r.pts[i + 1];
        const L = Math.hypot(x1 - x0, y1 - y0);
        const ang = Math.atan2(y1 - y0, x1 - x0);
        const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
        for (let d = 6; d < L - 6; d += 9) {
          s++;
          if (Math.hypot(x0, y0) > R) continue;
          const k = d / L;
          const cx = x0 + (x1 - x0) * k, cy = y0 + (y1 - y0) * k;
          if (r.t !== 'pedestrian' && rnd(s) < 0.06 * density) {
            const side = r.oneway ? 0 : (rnd(s + 1) < 0.5 ? 1 : -1);
            const off = side * r.w * 0.25;
            carGeos.push(...carGeo(cx - uy * off, cy + ux * off, ang + (side < 0 ? Math.PI : 0), s));
            info.cars++;
          }
          if (rnd(s + 2) < 0.05 * density) {
            const side = rnd(s + 3) < 0.5 ? 1 : -1;
            const off = side * (r.w / 2 + 1.2);
            peopleGeos.push(...personGeo(cx - uy * off, cy + ux * off, s));
            info.people++;
          }
        }
      }
    }
  }

  add(grass, 'landcover', { shadow: false });
  add(water, 'water', { shadow: false });
  add(foot, 'footways', { shadow: false });
  add(roads, 'roads', { shadow: false });
  add(rail, 'rail', { shadow: false });
  const bb = buildBuildings(els, P, opts, info);
  add(bb.geos, 'buildings', { material: bmat });
  add(bb.roofGeos, 'detail-rooftop');
  addPoles(group, roadLines, R);
  add(treeGeos, 'trees');
  add(carGeos, 'cars', { shadow: false });
  add(peopleGeos, 'people', { shadow: false });
  return { group, info, projector: P, roadLines };
}

// Manga+: utility poles every ~30 m along ordinary streets, three sagging wires between them
const POLE_ROADS = new Set(['residential', 'tertiary', 'unclassified', 'service', 'living_street', 'secondary']);
function addPoles(group, roadLines, R) {
  const poles = [], wires = [];
  let s = 7;
  for (const r of roadLines) {
    if (!POLE_ROADS.has(r.t)) continue;
    const side = rnd(++s) < 0.5 ? 1 : -1;
    let carry = 12 * rnd(++s), prev = null;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x0, y0] = r.pts[i], [x1, y1] = r.pts[i + 1];
      const L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 0.1) continue;
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      const off = side * (r.w / 2 + 0.8);
      for (let d = carry; d < L; d += 30) {
        const px = x0 + ux * d - uy * off, py = y0 + uy * d + ux * off;
        if (Math.hypot(px, py) > R) { prev = null; continue; }
        const oid = nextOid();
        const pole = new THREE.CylinderGeometry(0.11, 0.15, 8.5, 6); pole.translate(0, 4.25, 0);
        const arm = new THREE.BoxGeometry(1.8, 0.12, 0.12); arm.translate(0, 7.8, 0); arm.rotateY(Math.atan2(uy, ux) + Math.PI / 2);
        for (const g of [pole, arm]) { g.translate(px, 0, -py); poles.push(clean(setOid(setColor(g, new THREE.Color('#7d7872')), oid))); }
        const cur = { x: px, y: py, nx: -uy, ny: ux };
        if (prev && Math.hypot(prev.x - px, prev.y - py) < 45) {
          for (const k of [-0.8, 0, 0.8]) {
            const a = [prev.x + prev.nx * k, 7.8, prev.y + prev.ny * k], b = [px + cur.nx * k, 7.8, py + cur.ny * k];
            for (let j = 0; j < 8; j++) {
              for (const tt of [j / 8, (j + 1) / 8]) {
                const sag = 0.55 * 4 * tt * (1 - tt);
                wires.push(a[0] + (b[0] - a[0]) * tt, a[1] - sag, -(a[2] + (b[2] - a[2]) * tt));
              }
            }
          }
        }
        prev = cur;
      }
      carry = (carry - L) % 30; if (carry < 0) carry += 30;
    }
  }
  if (poles.length) {
    const m = new THREE.Mesh(mergeGeometries(poles, false), new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.name = 'detail-poles';
    group.add(m);
  }
  if (wires.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    const n = wires.length / 3;
    const nn = new Float32Array(n * 3); for (let i = 1; i < nn.length; i += 3) nn[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    g.setAttribute('oid', new THREE.BufferAttribute(new Float32Array(n).fill(0.0123), 1));
    g.setAttribute('wall', new THREE.BufferAttribute(new Float32Array(n), 1));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#1a1a1a' }));
    l.name = 'detail-wires';
    group.add(l);
  }
}
