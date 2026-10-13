// Two UI languages. Static text in index.html carries data-i18n / data-i18n-ph / data-i18n-title keys;
// JS strings go through t(). The choice is remembered per browser; default follows the browser language.
const dict = {
  uk: {
    title: 'World360 — локаційний скаут',
    description: 'Будь-яке місто з OpenStreetMap у 3D, намальоване як фон манґи: лінії, скрінтон, PNG і GLB.',
    collapse: 'Згорнути панель',
    searchPh: 'Місто, адреса, 49.8397, 24.0297 або лінк на мапу',
    build: 'Будувати',
    searchHint: 'Shift+клік по сцені — поставити пін і перебудувати тут. Можна кинути KML/GeoJSON на вікно.',
    city: 'Місто', radius: 'Радіус', season: 'Сезон',
    spring: 'весна', summer: 'літо', autumn: 'осінь', winter: 'зима',
    traffic: 'Люди й авто', none: 'нема', few: 'трохи', many: 'багато',
    trees: 'Дерева', facetedRough: 'гранями (грубо)', faceted: 'гранями', smooth: 'гладко',
    leafEdge: 'Край листя', heights: '🎲 Висоти', heightsTitle: 'Перекинути вгадані висоти будинків', rebuild: 'Перебудувати',
    camera: 'Камера', bird: 'Пташиний', top: 'Згори', cross: 'Перехрестя', street: 'Вулиця', low: 'Низький ракурс',
    lens: "Об'єктив", mm: 'мм', twoPoint: 'Двоточкова перспектива (вертикалі паралельні)',
    walk: 'Ходити (F): WASD + мишка',
    walkHint: 'Клік по сцені захоплює мишку (Esc — відпустити). WASD/стрілки — ходити, Shift — бігти, E/Space — вгору, Q — вниз.',
    camHint: 'WASD рухає камеру й у звичайному режимі. Подвійний клік — наблизитись до точки.',
    style: 'Стиль', color: 'Колір', colorLines: 'Колір+лінії', lines: 'Лінії', linesTone: 'Лінії+тон',
    lineW: 'Товщина ліній', normalTh: 'Деталізація граней', pattern: 'Візерунок тону',
    dots: 'точки', stripes: 'лінії', hatch: 'штрихування', toneSize: 'Розмір тону', toneStart: 'Поріг тону',
    toneOpacity: 'Непрозорість тону', beta: 'Чорна заливка (бета)', whiteOut: 'Біле (вибілювання)',
    light: 'Світло', realSun: 'Справжнє сонце', azimuth: 'Азимут', elevation: 'Висота', dateTime: 'Дата й час', shadows: 'Тіні',
    ai: 'Комікс-рендер (Krea2)', freedom: 'Свобода моделі', extraPh: "Додати до промпту (необов'язково)", generate: 'Згенерувати',
    aiHint: 'Поточний кадр іде основою в img2img. Менша «свобода» — точніше тримає геометрію.',
    export: 'Експорт', pngSize: 'PNG, довга сторона', transparent: 'Прозорий фон (лише лінії/тон)', credit: 'Підпис © OpenStreetMap',
    link: 'Лінк',
    footer: 'Дані © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL). Пошук: Nominatim, Overpass API. Натхнено «どこでもロケハン».',
    gallery: 'Комікс-рендери',
    // runtime
    loadingMap: 'Тягну мапу…', buildingCity: 'Будую місто…', searching: 'Шукаю…', failed: 'Не вдалося: ',
    srcTiles: 'дані: OpenFreeMap, шукаю деталі в Overpass…', srcOsm: 'дані: OpenStreetMap (Overpass)', srcTilesOnly: 'дані: OpenFreeMap (Overpass недоступний)',
    cityInfo: (i) => `${i.buildings} будинків (висоту вгадано для ${i.guessed}), ${i.trees} дерев, ${i.roads} доріг, ${i.cars} авто, ${i.people} людей`,
    noCoords: 'Не знайшов координат у файлі', notFound: 'Місце не знайдено',
    rendering: (w, h) => `Рендер ${w}×${h}…`, glb: 'Збираю GLB…', copied: 'Лінк скопійовано',
    aiDown: 'сервер генерації недоступний', soon: 'Скоро', unlimited: 'без ліміту',
    left: (n, l) => `лишилось ${n} з ${l} на добу`, pickStyle: 'вибери стиль',
    queued: 'у черзі', drawing: 'малюю', sec: 'с', error: 'помилка',
    errQuota: (l) => `ліміт ${l} зображення на добу вичерпано`, errQueue: 'черга повна, спробуй за хвилину', errStyle: 'стиль недоступний',
  },
  en: {
    title: 'World360 — location scout',
    description: 'Any city from OpenStreetMap in 3D, drawn as a manga background: lines, screentone, PNG and GLB.',
    collapse: 'Collapse panel',
    searchPh: 'City, address, 49.8397, 24.0297 or a map link',
    build: 'Build',
    searchHint: 'Shift+click the scene to drop a pin and rebuild there. You can also drop a KML/GeoJSON file on the window.',
    city: 'City', radius: 'Radius', season: 'Season',
    spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter',
    traffic: 'People & cars', none: 'none', few: 'a few', many: 'many',
    trees: 'Trees', facetedRough: 'faceted (rough)', faceted: 'faceted', smooth: 'smooth',
    leafEdge: 'Leaf edge', heights: '🎲 Heights', heightsTitle: 'Re-roll guessed building heights', rebuild: 'Rebuild',
    camera: 'Camera', bird: "Bird's-eye", top: 'Top-down', cross: 'Intersection', street: 'Street', low: 'Low angle',
    lens: 'Lens', mm: 'mm', twoPoint: 'Two-point perspective (parallel verticals)',
    walk: 'Walk (F): WASD + mouse',
    walkHint: 'Click the scene to capture the mouse (Esc releases it). WASD/arrows to walk, Shift to run, E/Space up, Q down.',
    camHint: 'WASD also moves the camera in orbit mode. Double-click to fly to a point.',
    style: 'Style', color: 'Color', colorLines: 'Color+lines', lines: 'Lines', linesTone: 'Lines+tone',
    lineW: 'Line width', normalTh: 'Edge detail', pattern: 'Tone pattern',
    dots: 'dots', stripes: 'lines', hatch: 'cross-hatch', toneSize: 'Tone size', toneStart: 'Tone threshold',
    toneOpacity: 'Tone opacity', beta: 'Solid black fill', whiteOut: 'White-out',
    light: 'Light', realSun: 'Real sun position', azimuth: 'Azimuth', elevation: 'Elevation', dateTime: 'Date & time', shadows: 'Shadows',
    ai: 'Comic render (Krea2)', freedom: 'Model freedom', extraPh: 'Add to the prompt (optional)', generate: 'Generate',
    aiHint: 'The current frame is the img2img base. Less freedom keeps the geometry tighter.',
    export: 'Export', pngSize: 'PNG, long side', transparent: 'Transparent background (lines/tone only)', credit: '© OpenStreetMap credit',
    link: 'Link',
    footer: 'Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL). Search: Nominatim, Overpass API. Inspired by «どこでもロケハン».',
    gallery: 'Comic renders',
    loadingMap: 'Fetching the map…', buildingCity: 'Building the city…', searching: 'Searching…', failed: 'Failed: ',
    srcTiles: 'data: OpenFreeMap, fetching details from Overpass…', srcOsm: 'data: OpenStreetMap (Overpass)', srcTilesOnly: 'data: OpenFreeMap (Overpass unavailable)',
    cityInfo: (i) => `${i.buildings} buildings (height guessed for ${i.guessed}), ${i.trees} trees, ${i.roads} roads, ${i.cars} cars, ${i.people} people`,
    noCoords: 'No coordinates found in the file', notFound: 'Place not found',
    rendering: (w, h) => `Rendering ${w}×${h}…`, glb: 'Building GLB…', copied: 'Link copied',
    aiDown: 'generation server unavailable', soon: 'Coming soon', unlimited: 'unlimited',
    left: (n, l) => `${n} of ${l} left today`, pickStyle: 'pick a style',
    queued: 'queued', drawing: 'drawing', sec: 's', error: 'error',
    errQuota: (l) => `daily limit of ${l} images reached`, errQueue: 'queue is full, try again in a minute', errStyle: 'style unavailable',
  },
};

const pick = () => {
  try { const v = localStorage.getItem('w360-lang'); if (v === 'uk' || v === 'en') return v; } catch { /* storage blocked */ }
  return /^(uk|ru|be)/i.test(navigator.language || '') ? 'uk' : 'en';
};
export let lang = pick();

export function t(key, ...args) {
  const v = dict[lang][key] ?? dict.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelector('meta[name=description]')?.setAttribute('content', t('description'));
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); }
}

export function setLang(l) {
  lang = l;
  try { localStorage.setItem('w360-lang', l); } catch { /* storage blocked */ }
  applyI18n();
}
