import { lang } from './i18n.js';
// Geocoding (Nominatim) + map data (Overpass), cached in the browser for 7 days.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CACHE = 'world360-osm-v1';
const TTL = 7 * 24 * 3600 * 1000;

async function cachedJSON(key, fetcher) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache API (file://, private mode) */ }
  const req = new Request('https://cache.local/' + encodeURIComponent(key));
  if (cache) {
    const hit = await cache.match(req);
    if (hit && Date.now() - Number(hit.headers.get('x-time')) < TTL) return hit.json();
  }
  const data = await fetcher();
  if (cache) {
    await cache.put(req, new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'x-time': String(Date.now()) },
    })).catch(() => {});
  }
  return data;
}

// Parse coordinates / map links. Returns {lat, lon} or null.
export function parseLocation(text) {
  const s = text.trim();
  let m;
  // Google Maps: /@lat,lon,  or  !3dlat!4dlon  or  q=lat,lon / ll=
  if ((m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))) return { lat: +m[1], lon: +m[2] };
  if ((m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) return { lat: +m[1], lon: +m[2] };
  if ((m = s.match(/[?&](?:q|ll|query|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i))) return { lat: +m[1], lon: +m[2] };
  // OpenStreetMap: #map=z/lat/lon or mlat=..&mlon=..
  if ((m = s.match(/map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/))) return { lat: +m[1], lon: +m[2] };
  if ((m = s.match(/mlat=(-?\d+\.\d+).*mlon=(-?\d+\.\d+)/))) return { lat: +m[1], lon: +m[2] };
  // Google Earth: @lat,lon,alt
  // Decimal pair "49.84, 24.03"
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/))) return { lat: +m[1], lon: +m[2] };
  // DMS: 49°50'32"N 24°01'53"E
  const dms = [...s.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEWПнПдСхЗх]?)/gi)];
  if (dms.length >= 2) {
    const v = dms.slice(0, 2).map((d) => {
      let x = +d[1] + (+d[2] || 0) / 60 + (+d[3] || 0) / 3600;
      if (/[SW]/i.test(d[4])) x = -x;
      return x;
    });
    return { lat: v[0], lon: v[1] };
  }
  return null;
}

export async function geocode(query) {
  const loc = parseLocation(query);
  if (loc) return { ...loc, name: `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` };
  return cachedJSON('geo:' + query, async () => {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);
    const r = await fetch(url, { headers: { 'Accept-Language': lang === 'uk' ? 'uk,en' : 'en' } });
    if (!r.ok) throw new Error('Nominatim ' + r.status);
    const j = await r.json();
    if (!j.length) throw new Error(lang === 'uk' ? 'Місце не знайдено' : 'Place not found');
    return { lat: +j[0].lat, lon: +j[0].lon, name: j[0].display_name };
  });
}

export async function fetchCity(lat, lon, radius) {
  const a = `(around:${radius},${lat.toFixed(6)},${lon.toFixed(6)})`;
  const q = `[out:json][timeout:90];
(
  way["building"]${a};
  relation["building"]["type"="multipolygon"]${a};
  way["building:part"]${a};
  way["highway"]${a};
  way["railway"~"^(rail|tram|light_rail)$"]${a};
  way["natural"~"^(water|wood|scrub|grassland)$"]${a};
  relation["natural"="water"]${a};
  way["waterway"~"^(river|canal|stream)$"]${a};
  way["landuse"~"^(grass|forest|meadow|village_green|recreation_ground|cemetery|orchard)$"]${a};
  way["leisure"~"^(park|garden|pitch|playground)$"]${a};
  node["natural"="tree"]${a};
  way["natural"="tree_row"]${a};
);
out geom qt;`;
  const key = `city:${lat.toFixed(5)},${lon.toFixed(5)},${radius}`;
  return cachedJSON(key, async () => {
    let lastErr;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error(`${new URL(ep).host} ${r.status}`);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  });
}

export async function fetchTilesCached(lat, lon, radius) {
  const { fetchTiles } = await import('./tiles.js');
  return cachedJSON(`ofm:${lat.toFixed(5)},${lon.toFixed(5)},${radius}`, () => fetchTiles(lat, lon, radius));
}

// "Lviv, Ukraine" for the generation prompt, so the model draws the local architecture
export async function placeName(lat, lon) {
  return cachedJSON(`rev:${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=en&lat=${lat}&lon=${lon}`);
    if (!r.ok) throw new Error('reverse ' + r.status);
    const a = (await r.json()).address || {};
    const city = a.city || a.town || a.village || a.municipality || a.county || '';
    return [city, a.country].filter(Boolean).join(', ');
  });
}
