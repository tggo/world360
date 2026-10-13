// OpenFreeMap vector tiles (OpenMapTiles schema, z14) -> pseudo-OSM elements in the
// same shape Overpass returns ("out geom"), so city.js consumes either source.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const Z = 14;
const N = 2 ** Z;
let tileUrl = null;

async function template() {
  if (!tileUrl) {
    const meta = await (await fetch('https://tiles.openfreemap.org/planet')).json();
    tileUrl = meta.tiles[0];
  }
  return tileUrl;
}

const lon2x = (lon) => ((lon + 180) / 360) * N;
const lat2y = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * N;
const x2lon = (x) => (x / N) * 360 - 180;
const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;

function ringArea(r) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i].x * r[i + 1].y - r[i + 1].x * r[i].y;
  return s / 2;
}

// split a (multi)polygon feature into [{outer, holes}] in tile coords
function splitPolygons(rings) {
  const out = [];
  for (const r of rings) {
    if (r.length < 4) continue;
    const a = ringArea(r);
    if (a > 0) out.push({ outer: r, holes: [] });         // MVT: exterior rings have positive area (y down)
    else if (out.length) out[out.length - 1].holes.push(r);
  }
  return out;
}

const ROAD = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  minor: 'residential', service: 'service', track: 'track', raceway: 'service', busway: 'service',
};

export async function fetchTiles(lat, lon, radius) {
  const tpl = await template();
  const dLat = radius / 110540, dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const x0 = Math.floor(lon2x(lon - dLon)), x1 = Math.floor(lon2x(lon + dLon));
  const y0 = Math.floor(lat2y(lat + dLat)), y1 = Math.floor(lat2y(lat - dLat));
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(tpl, x, y));
  const els = (await Promise.all(jobs)).flat();
  return { elements: els, source: 'openfreemap' };
}

let synthId = 1;
async function loadTile(tpl, tx, ty) {
  const r = await fetch(tpl.replace('{z}', Z).replace('{x}', tx).replace('{y}', ty));
  if (!r.ok) throw new Error(`tile ${tx}/${ty}: ${r.status}`);
  const vt = new VectorTile(new PbfReader(await r.arrayBuffer()));
  const els = [];
  const toLL = (p, ext) => ({ lat: y2lat(ty + p.y / ext), lon: x2lon(tx + p.x / ext) });

  const polys = (layer, tagsOf, { wholeOnly = false } = {}) => {
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;
      const tags = tagsOf(f.properties);
      if (!tags) continue;
      const ext = layer.extent;
      for (const poly of splitPolygons(f.loadGeometry())) {
        if (wholeOnly) {
          // a building cut by the tile edge appears in both tiles: keep the copy whose centroid is here
          let cx = 0, cy = 0;
          for (const p of poly.outer) { cx += p.x; cy += p.y; }
          cx /= poly.outer.length; cy /= poly.outer.length;
          if (cx < 0 || cy < 0 || cx >= ext || cy >= ext) continue;
        }
        els.push({
          type: 'relation', id: synthId++, tags,
          members: [
            { role: 'outer', geometry: poly.outer.map((p) => toLL(p, ext)) },
            ...poly.holes.map((h) => ({ role: 'inner', geometry: h.map((p) => toLL(p, ext)) })),
          ],
        });
      }
    }
  };

  polys(vt.layers.building, (p) => ({
    building: 'yes',
    ...(p.render_height ? { height: String(p.render_height) } : {}),
    ...(p.render_min_height ? { min_height: String(p.render_min_height) } : {}),
    ...(p.colour ? { 'building:colour': p.colour } : {}),
    _ofm: '1',
  }), { wholeOnly: true });
  polys(vt.layers.water, (p) => (p.brunnel === 'tunnel' ? null : { natural: 'water' }));
  polys(vt.layers.park, () => ({ leisure: 'park' }));
  polys(vt.layers.landcover, (p) => {
    if (p.class === 'wood') return { natural: 'wood' };
    if (p.class === 'grass') return { landuse: p.subclass === 'park' ? 'grass' : 'grass' };
    return null;
  });
  polys(vt.layers.landuse, (p) => (p.class === 'cemetery' ? { landuse: 'cemetery' } : p.class === 'pitch' ? { leisure: 'pitch' } : null));

  const lines = (layer, tagsOf) => {
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 2) continue;
      const tags = tagsOf(f.properties);
      if (!tags) continue;
      for (const line of f.loadGeometry()) {
        if (line.length < 2) continue;
        els.push({ type: 'way', id: synthId++, tags, geometry: line.map((p) => toLL(p, layer.extent)) });
      }
    }
  };
  lines(vt.layers.transportation, (p) => {
    if (p.brunnel === 'tunnel') return null;
    if (p.class === 'rail' || p.class === 'transit') return p.subclass === 'subway' ? null : { railway: p.subclass === 'tram' ? 'tram' : 'rail' };
    if (p.class === 'path') return { highway: ['pedestrian', 'steps', 'cycleway', 'bridleway'].includes(p.subclass) ? p.subclass : 'footway' };
    const hw = ROAD[p.class];
    return hw ? { highway: hw, ...(p.oneway === 1 ? { oneway: 'yes' } : {}) } : null;
  });
  lines(vt.layers.waterway, (p) => (p.brunnel === 'tunnel' ? null : { waterway: ['river', 'canal'].includes(p.class) ? p.class : 'stream' }));
  return els;
}
