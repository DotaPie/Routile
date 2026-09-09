/* Routile frontend: drag out zones, drop a start pin, compute, then drive. */

import * as config from './config.js';
import { Area } from './area.js';
import { gpxZip } from './gpx.js';
import { mapSnapshot } from './snapshot.js';

const $ = (id) => document.getElementById(id);

// The three ways to draw. Each one is a full drag gesture: press, move, release.
const SHAPES = ['rect', 'circle', 'freehand'];

/* One route palette per theme, because a route drawn for a paper-white OSM tile
   disappears on a dark one and the other way round. Each palette leaves out its
   own theme's accent hue: the drawn zones wear that, and a session line the
   same colour as the zone outline reads as part of it.

   The dark basemap is the same OSM tile inverted in CSS - see the filter on
   .leaflet-tile-pane. Every keyless dark tile service worth using has since
   grown an API key, and one basemap that needs no account is worth more here
   than a perfectly hand-styled one that does. */
const SESSION_COLORS = {
  // Bright, and no green: green is the dark theme's accent.
  dark: ['#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#facc15',
         '#f87171', '#60a5fa', '#e879f9', '#38bdf8', '#fda4af'],
  // Violet first: OSM Carto paints primary roads orange and trunk roads
  // salmon, so an orange route is easy to mistake for the map's own road
  // colouring. Blue is left out entirely, since the drawn zones are blue.
  light: ['#7c3aed', '#0d9488', '#c026d3', '#ea580c', '#65a30d',
          '#e11d48', '#0284c7', '#ca8a04', '#059669', '#be123c'],
};

const THEME_KEY = 'routile-theme';
const themeName = () =>
  (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const sessionColor = (i) => {
  const palette = SESSION_COLORS[themeName()];
  return palette[i % palette.length];
};

const ROUTE_WEIGHT = 3;

// Half a carriageway. Each pass is drawn this far to the right of its own
// direction of travel, so a street driven both ways shows as two lines rather
// than two identical lines on top of each other.
const OFFSET_M = 4.5;
const ARROW_SPACING_M = 130;
const ARROW_ZOOM = 15;      // below this an arrow is smaller than the junction
const POINT_ZOOM = 16;      // waypoints are dense; they need more room still

const state = {
  regions: [],         // the merged area: a MultiPolygon in [lon, lat]
  regionLayers: [],    // index-aligned with regions
  startLatLng: null,
  startMarker: null,
  routeLayers: [],     // one polyline per session, index-aligned with the legend
  sessionPoints: [],   // the offset points behind each of those polylines
  arrowsBySession: [],
  arrowLayer: null,
  pointLayer: null,
  hovered: null,       // previewed by the pointer
  pinned: null,        // clicked, and stays until dismissed
  mode: 'rect',        // rect | circle | freehand | pan | pin
  lastShape: 'rect',   // which tool a shift+drag uses while panning
  jobId: 0,
  result: null,
  checkTimer: null,
  searching: false,
  progress: null,      // {phase, message, fraction} of the running job
  started: 0,
  ticker: null,
};

/* ------------------------------------------------------------------ map */
// boxZoom off: Leaflet binds shift+drag to box zoom, which would fight
// shift+drag drawing.
const map = L.map('map', { zoomControl: false, boxZoom: false })
  .setView([48.148, 17.107], 14);

// Leaflet's zoom buttons, with the same line icons as the tool bar and no
// hover titles: nothing on this map pops text up under the pointer.
const zoomGlyph = (d) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
L.control.zoom({
  zoomInText: zoomGlyph('M12 5v14M5 12h14'), zoomInTitle: '',
  zoomOutText: zoomGlyph('M5 12h14'), zoomOutTitle: '',
}).addTo(map);
// The default prefix carries a title tooltip; this one is the same credit without it.
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// interactive:false throughout: a drawn zone is a backdrop, not a control.
// Left interactive it would take the pointer cursor and swallow hovers while
// you are trying to draw the next zone on top of it.
const AREA_STYLE = () => ({
  color: cssVar('--accent'), weight: 2, fillOpacity: 0.08, interactive: false,
});
const DRAFT_STYLE = () => ({
  color: cssVar('--accent'), weight: 2, fillOpacity: 0.1, dashArray: '5,4',
  interactive: false,
});

// Same glyph as the Start button in the toolbar and as the cursor that places
// it, so all three read as the same thing.
const START_ICON = L.divIcon({
  className: 'start-pin',
  html: '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z"/>'
      + '<circle cx="12" cy="10" r="2.6"/></svg>',
  iconSize: [60, 60],
  iconAnchor: [30, 54],      // the pin's tip, not its centre, marks the spot
});

// These sit inside the map container, so Leaflet must not treat clicks and
// drags on them as map gestures.
for (const id of ['topbar', 'search', 'legend']) {
  L.DomEvent.disableClickPropagation($(id));
  L.DomEvent.disableScrollPropagation($(id));
}
// Leaflet's keyboard handler listens on the map container, which the search box
// lives inside: without this, arrow keys would pan the map mid-word.
for (const type of ['keydown', 'keyup', 'keypress']) {
  L.DomEvent.on($('search-input'), type, L.DomEvent.stopPropagation);
}

// Arrows and waypoint dots are rebuilt for the visible area on every pan and
// zoom, so their cost is set by the screen rather than by the route's length.
state.arrowLayer = L.layerGroup().addTo(map);
state.pointLayer = L.layerGroup().addTo(map);
map.on('moveend zoomend', () => refreshDetail());

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  // Fetched with CORS, so the same cached tiles may be drawn onto the canvas
  // behind the exported map image. OSM's tile servers allow any origin.
  crossOrigin: 'anonymous',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

/* ---------------------------------------------------------------- theme */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(THEME_KEY, name); } catch (err) { /* private mode */ }

  // Everything already on the map that carries a theme colour. The start pin
  // and the drawn zones take theirs from CSS variables, so the pin needs
  // nothing; the zones are Leaflet paths and do.
  for (const layer of state.regionLayers) layer.setStyle(AREA_STYLE());
  state.routeLayers.forEach((line, i) => {
    if (line) line.setStyle({ color: sessionColor(i) });
  });
  if (state.result) {
    // Rebuilt for the new swatch colours, so the pinned row has to be put back.
    const pinned = state.pinned;
    buildLegend(state.result.sessions);
    pin(pinned);
  }
  refreshDetail();
}

applyTheme(themeName());
$('theme-toggle').onclick = () =>
  applyTheme(themeName() === 'dark' ? 'light' : 'dark');

/* -------------------------------------------------------------- drawing */
// One drag gesture, three shapes. `drag.tool` is fixed at mousedown so a key
// released mid-drag cannot change what is being drawn.
let drag = null;   // { tool, from, points, layer, ring, closing }

const MIN_DRAG_PX = 12;        // below this, a drag is an accidental click
const FREEHAND_STEP_PX = 5;    // sampling distance while drawing by hand
const FREEHAND_SIMPLIFY_PX = 3;
const SNAP_PX = 22;            // radius of the "release here to close" ring
const SNAP_MIN_POINTS = 6;     // don't offer to close before a loop exists

function activeTool(ev) {
  if (SHAPES.includes(state.mode)) return state.mode;
  // Shift+drag draws without leaving pan mode, using the last shape picked.
  if (state.mode === 'pan' && ev && ev.originalEvent && ev.originalEvent.shiftKey) {
    return state.lastShape;
  }
  return null;
}

map.on('mousedown', (ev) => {
  // Left button only: the other two are the temporary pan grip below.
  if (ev.originalEvent && ev.originalEvent.button !== 0) return;
  const tool = activeTool(ev);
  if (!tool) return;
  if (drag) discardDraft();

  map.dragging.disable();
  drag = { tool, from: ev.latlng, points: [ev.latlng], layer: null,
           ring: null, closing: false };

  if (tool === 'rect') {
    drag.layer = L.rectangle(L.latLngBounds(ev.latlng, ev.latlng), DRAFT_STYLE());
  } else if (tool === 'circle') {
    drag.layer = L.circle(ev.latlng, { radius: 1, ...DRAFT_STYLE() });
  } else {
    drag.layer = L.polyline([ev.latlng], DRAFT_STYLE());
    // A ring at the start showing where to finish. Without it the shape closes
    // with a straight line from wherever you happened to stop, which is how a
    // careful outline ends up with a spike across the map.
    drag.ring = L.circleMarker(ev.latlng, {
      radius: SNAP_PX, color: cssVar('--accent'), weight: 1.5,
      dashArray: '4,3', fillOpacity: 0.06, interactive: false,
    }).addTo(map);
  }
  drag.layer.addTo(map);
});

map.on('mousemove', (ev) => {
  if (!drag) return;
  if (drag.tool === 'rect') {
    drag.layer.setBounds(L.latLngBounds(drag.from, ev.latlng));
  } else if (drag.tool === 'circle') {
    drag.layer.setRadius(drag.from.distanceTo(ev.latlng));
  } else {
    // Sampled rather than recording every mousemove: a slow hand emits
    // hundreds of points a second, and the outline is smoothed at the end.
    const last = drag.points[drag.points.length - 1];
    if (pixelGap(last, ev.latlng) >= FREEHAND_STEP_PX) drag.points.push(ev.latlng);
    setClosing(withinSnap(ev.latlng));
    drag.layer.setLatLngs(
      drag.closing ? drag.points.concat([drag.from]) : drag.points
    );
  }
});

function withinSnap(latlng) {
  return drag.points.length >= SNAP_MIN_POINTS
    && pixelGap(drag.from, latlng) <= SNAP_PX;
}

function setClosing(closing) {
  if (drag.closing === closing) return;
  drag.closing = closing;
  drag.ring.setStyle(closing
    ? { fillOpacity: 0.28, weight: 2.5, dashArray: null }
    : { fillOpacity: 0.06, weight: 1.5, dashArray: '4,3' });
}

function pixelGap(a, b) {
  return map.latLngToContainerPoint(a).distanceTo(map.latLngToContainerPoint(b));
}

function discardDraft() {
  if (!drag) return;
  if (drag.layer) map.removeLayer(drag.layer);
  if (drag.ring) map.removeLayer(drag.ring);
  drag = null;
  map.dragging.enable();
}

function finishDrag(latlng) {
  if (!drag) return;
  const { tool, from, points, closing } = drag;
  discardDraft();
  if (!latlng) return;      // cancelled: Escape, or released off the map

  if (tool === 'rect') {
    const bounds = L.latLngBounds(from, latlng);
    if (pixelGap(bounds.getNorthWest(), bounds.getSouthEast()) < MIN_DRAG_PX) return;
    addShape({
      type: 'rect',
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    });
  } else if (tool === 'circle') {
    // Half the rectangle's threshold: this is a radius, not a diagonal.
    if (pixelGap(from, latlng) < MIN_DRAG_PX / 2) return;
    addShape({
      type: 'circle',
      lat: from.lat, lon: from.lng, radius_m: from.distanceTo(latlng),
    });
  } else {
    // Released inside the ring: close on the start point exactly, rather than
    // on wherever the pointer drifted to inside it.
    const raw = closing ? points : points.concat([latlng]);
    const outline = simplifyOutline(raw);
    if (outline.length < 3) return;
    addShape({ type: 'freehand', points: outline.map((p) => [p.lat, p.lng]) });
  }
}

function simplifyOutline(latlngs) {
  // Simplified in screen pixels, which is where the wobble actually is: a 3 px
  // tolerance drops the hand tremor and keeps every deliberate turn, at any
  // zoom level.
  const pts = latlngs.map((p) => map.latLngToContainerPoint(p));
  return L.LineUtil.simplify(pts, FREEHAND_SIMPLIFY_PX)
    .map((p) => map.containerPointToLatLng(p));
}

map.on('mouseup', (ev) => finishDrag(ev.latlng));

// A release outside the map never reaches Leaflet, which would leave the drag
// stuck and panning disabled. Cancel on the document instead.
document.addEventListener('mouseup', (ev) => {
  if (!drag) return;
  if (ev.target.closest && ev.target.closest('#map')) return;
  finishDrag(null);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') finishDrag(null);
});

map.on('click', (ev) => {
  if (state.mode === 'pin') {
    setStart(ev.latlng);
    setMode(state.lastShape);
    return;
  }
  // Nothing on the map catches a click, so any click here is "clicked the
  // map": let go of whatever the legend has pinned.
  if (state.pinned !== null) pin(null);
});

/* --------------------------------------------------- temporary pan grip */
/* Holding the middle or the right mouse button pans from wherever the pointer
   is, whatever tool is armed, and hands that tool back on release. The Pan
   button lights up while it lasts, so the map never changes behaviour without
   the toolbar saying so.

   Leaflet's own drag handler answers to the left button only - which the draw
   tools need - so the panning here is done by hand. */
const PAN_BUTTONS = new Set([1, 2]);
const mapEl = $('map');
let tempPan = null;

mapEl.addEventListener('mousedown', (ev) => {
  if (tempPan || !PAN_BUTTONS.has(ev.button)) return;
  if (ev.target.closest('#topbar, #search, .legend, .leaflet-control')) return;
  ev.preventDefault();
  if (drag) finishDrag(null);     // a half-drawn zone is abandoned, not kept
  tempPan = { mode: state.mode, x: ev.clientX, y: ev.clientY };
  setMode('pan');
  mapEl.classList.add('grabbing');
});

document.addEventListener('mousemove', (ev) => {
  if (!tempPan) return;
  const dx = ev.clientX - tempPan.x;
  const dy = ev.clientY - tempPan.y;
  tempPan.x = ev.clientX;
  tempPan.y = ev.clientY;
  if (dx || dy) map.panBy([-dx, -dy], { animate: false });
});

document.addEventListener('mouseup', (ev) => {
  if (!tempPan || !PAN_BUTTONS.has(ev.button)) return;
  setMode(tempPan.mode);          // stays on Pan if that is where it started
  tempPan = null;
  mapEl.classList.remove('grabbing');
});

// The right button is a pan grip here, so its menu would fire on every release
// - except over the search box, where a paste menu is the whole point.
mapEl.addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('#search')) return;
  ev.preventDefault();
});

/* ------------------------------------------------------- the drawn zones */
/* Every zone drawn is merged into the area straight away: two that overlap
   become one shape with one outline, and one drawn over a gap between two
   others joins all three. Zones that touch nothing stay separate regions of
   the same area, computed as a single job. Clear starts over.

   `state.regions` is a GeoJSON-style MultiPolygon in [lon, lat]: one entry per
   separate region, each an outline followed by any holes. */
function addShape(shape) {
  const poly = [shapeRing(shape)];
  let merged;
  try {
    // Unioning a lone polygon with itself is not a no-op: it also resolves a
    // freehand outline that crossed itself, which would otherwise be ambiguous.
    merged = state.regions.length
      ? polygonClipping.union(state.regions, poly)
      : polygonClipping.union(poly);
  } catch (err) {
    // Boolean ops can fail on a pathological outline. An unmerged zone is a
    // poor second best, but it is far better than losing the drag entirely,
    // and everything downstream copes with regions that overlap.
    console.warn('could not merge that zone, keeping it separate', err);
    merged = state.regions.concat([poly]);
  }
  state.regions = merged;
  drawRegions();
  clearRoute();
  syncZones();
}

/* Clear means start over: the zones, the route and the start pin all go. */
function clearZones() {
  state.regions = [];
  drawRegions();
  clearRoute();
  clearStart();
  showError(null);
  syncZones();
}

function drawRegions() {
  for (const layer of state.regionLayers) map.removeLayer(layer);
  // Leaflet reads a polygon's rings as outline first, then holes - the same
  // order polygon-clipping produces - so a merged hole draws as a hole.
  state.regionLayers = state.regions.map((rings) =>
    L.polygon(rings.map((ring) => ring.map(([x, y]) => [y, x])), AREA_STYLE())
      .addTo(map));
}

/* A drawn shape as one closed ring of [lon, lat]. */
function shapeRing(shape) {
  let ring;
  if (shape.type === 'rect') {
    ring = [[shape.west, shape.south], [shape.east, shape.south],
            [shape.east, shape.north], [shape.west, shape.north]];
  } else if (shape.type === 'circle') {
    // The same ellipse-in-degrees the pipeline builds for a circle, so what is
    // merged is what the router will treat as required.
    const dlat = (shape.radius_m / EARTH_R) * 180 / Math.PI;
    const cosLat = Math.max(Math.cos(rad(shape.lat)), 1e-6);
    const dlon = (shape.radius_m / (EARTH_R * cosLat)) * 180 / Math.PI;
    ring = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = 2 * Math.PI * i / CIRCLE_SEGMENTS;
      ring.push([shape.lon + dlon * Math.cos(a), shape.lat + dlat * Math.sin(a)]);
    }
  } else {
    ring = shape.points.map(([lat, lng]) => [lng, lat]);
  }
  return ring.concat([ring[0]]);    // polygon-clipping wants closed rings
}

// Matches area.js, so the circle drawn, the circle merged and the circle the
// router covers are the same 64-sided polygon.
const CIRCLE_SEGMENTS = 64;
const EARTH_R = 6_371_008.8;

/* The merged area, as the pipeline's payload. */
function shapePayload() {
  if (!state.regions.length) return null;
  const shapes = state.regions.map((rings) => {
    const out = { type: 'polygon', points: rings[0].map(([x, y]) => [y, x]) };
    if (rings.length > 1) {
      out.holes = rings.slice(1).map((ring) => ring.map(([x, y]) => [y, x]));
    }
    return out;
  });
  return shapes.length === 1 ? shapes[0] : { type: 'multi', shapes };
}

function syncZones() {
  const n = state.regions.length;
  syncClear();
  $('compute').disabled = n === 0;

  const info = $('area-info');
  info.classList.toggle('muted', n === 0);
  if (!n) {
    info.textContent = '--';
    return;
  }
  // Run now rather than on the debounce: the exact geodesic figure costs a
  // fraction of a millisecond, and a placeholder that flickers for 200 ms is
  // worse than no placeholder at all.
  runCheck();
}

function areaText(km2, zones) {
  return `${km2.toFixed(2)} km²${zones > 1 ? ` · ${zones} zones` : ''}`;
}

const KM_PER_DEG = 111.32;

function rad(deg) { return deg * Math.PI / 180; }

function setStart(latlng) {
  state.startLatLng = latlng;
  if (state.startMarker) map.removeLayer(state.startMarker);
  state.startMarker = L.marker(latlng, { icon: START_ICON, keyboard: false })
    .addTo(map);
  $('pin-info').classList.remove('muted');
  $('pin-info').textContent =
    `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  $('mode-pin').classList.add('has-start');
  syncClear();
}

function clearStart() {
  state.startLatLng = null;
  if (state.startMarker) map.removeLayer(state.startMarker);
  state.startMarker = null;
  $('pin-info').classList.add('muted');
  $('pin-info').textContent = 'area centre';
  $('mode-pin').classList.remove('has-start');
  syncClear();
}

// Clear has work to do as long as there is a zone or a pin on the map.
function syncClear() {
  $('clear-zones').disabled = !state.regions.length && !state.startLatLng;
}

const TOOL_BUTTONS = {
  pan: 'mode-pan', rect: 'mode-rect', circle: 'mode-circle',
  freehand: 'mode-freehand', pin: 'mode-pin',
};

function setMode(mode) {
  state.mode = mode;
  if (SHAPES.includes(mode)) state.lastShape = mode;
  for (const [key, id] of Object.entries(TOOL_BUTTONS)) {
    $(id).classList.toggle('active', mode === key);
  }
  const el = $('map');
  el.classList.toggle('drawing', SHAPES.includes(mode));
  el.classList.toggle('pinning', mode === 'pin');
}

for (const [key, id] of Object.entries(TOOL_BUTTONS)) {
  $(id).onclick = () => setMode(key);
}
setMode('rect');

$('clear-zones').onclick = () => clearZones();

/* ----------------------------------------------------------- place search */
/* Nominatim is OpenStreetMap's own geocoder: free, no key, and asked for once
   per submit rather than on every keystroke - which is both what its usage
   policy expects and what "type, then press Enter" already implies. */
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

$('search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const query = $('search-input').value.trim();
  if (!query || state.searching) return;

  const card = $('search');
  state.searching = true;
  card.classList.add('searching');
  card.classList.remove('missed');
  try {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`the geocoder answered ${res.status}`);
    const hits = await res.json();
    if (!hits.length) {
      card.classList.add('missed');
      showError(`No place found for "${query}".`);
      return;
    }
    const hit = hits[0];
    const box = hit.boundingbox;    // [south, north, west, east], as strings
    if (box && box.length === 4) {
      // Zoom capped: the box around a single address is metres wide, and
      // flying to zoom 19 for it loses all sense of where you are.
      map.fitBounds([[+box[0], +box[2]], [+box[1], +box[3]]],
        { padding: [24, 24], maxZoom: 16 });
    } else {
      map.setView([+hit.lat, +hit.lon], 15);
    }
    showError(null);
    $('search-input').blur();
  } catch (err) {
    showError(`Place search failed: ${err.message}`);
  } finally {
    state.searching = false;
    card.classList.remove('searching');
  }
});

$('search-input').addEventListener('input', () => {
  $('search').classList.remove('missed');
});

/* ---------------------------------------------------------------- config */
$('passes').max = String(config.PASSES_MAX);
$(config.BOTH_DIRECTIONS_DEFAULT ? 'dir-both' : 'dir-oneway').checked = true;
$('session').value = String(Math.round((config.SESSION_SECONDS_DEFAULT / 3600) * 100) / 100);

function bothDirections() { return $('dir-both').checked; }

function sessionEnabled() { return $('session-enabled').checked; }

function syncSessionField() {
  $('session-field').classList.toggle('hidden', !sessionEnabled());
}
syncSessionField();

/* ------------------------------------------------------------ validation */
function passesValue() {
  const raw = $('passes').value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : null;
}

const NO_SPLIT_HOURS = 24;   // one session: a session is capped at 24 h

function sessionHours() {
  // Splitting off means one session covering the whole route.
  if (!sessionEnabled()) return NO_SPLIT_HOURS;
  // A positive decimal number of hours: "1.5", "0.75", "2". Comma accepted too,
  // since a decimal comma is the norm across much of Europe.
  const raw = $('session').value.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(raw)) return null;
  const h = parseFloat(raw);
  return Number.isFinite(h) && h >= 0.1 && h <= NO_SPLIT_HOURS ? h : null;
}

function markValid(el, ok) { el.classList.toggle('invalid', !ok); }

function validate() {
  const passes = passesValue();
  const hours = sessionHours();
  markValid($('passes'), passes !== null);
  markValid($('session'), !sessionEnabled() || hours !== null);
  if (passes === null) return 'Passes must be a whole number of 1 or more.';
  if (hours === null) return 'Session length must be a number of hours between 0.1 and 24.';
  return null;
}

/* --------------------------------------------------------------- request */
function payload() {
  const body = {
    shape: shapePayload(),
    both_directions: bothDirections(),
    passes: passesValue() || 1,
    session_minutes: (sessionHours() || NO_SPLIT_HOURS) * 60,
  };
  if (state.startLatLng) {
    body.start = { lat: state.startLatLng.lat, lon: state.startLatLng.lng };
  }
  return body;
}

function scheduleCheck() {
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(runCheck, 200);
}

/* Settings and zones checked together, and the exact geodesic area of the
   merged shape worked out while we are here. */
function runCheck() {
  if (!state.regions.length) return;

  const problem = validate();
  if (problem) {
    showError(problem);
    $('compute').disabled = true;
    return;
  }

  let area;
  try {
    area = Area.fromShape(shapePayload());
    area.validate(config.AREA_CAP_KM2);
  } catch (err) {
    showError(err.message || 'That area cannot be used.');
    $('compute').disabled = true;
    return;
  }
  showError(null);
  $('compute').disabled = false;
  $('area-info').textContent = areaText(area.areaKm2(), state.regions.length);
}

['passes', 'session', 'dir-oneway', 'dir-both', 'session-enabled'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (id === 'session-enabled') syncSessionField();
    scheduleCheck();
  });
  $(id).addEventListener('input', scheduleCheck);
});

/* --------------------------------------------------------------- compute */
/* The pipeline runs in a worker so the page stays responsive while it works.

   The version in the URL is not decoration. Browsers cache a module worker's
   script graph hard - Firefox keeps serving the old one through an ordinary
   reload - so without it a changed pipeline can go on running the previous
   code, which looks exactly like a bug in the new code. */
const worker = new Worker(
  new URL(`./worker.js?v=${config.ALGO_VERSION}`, import.meta.url),
  { type: 'module' },
);

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.id !== state.jobId) return;   // a job the user has since superseded
  if (msg.type === 'progress') {
    state.progress = msg;
    renderProgress();
  } else if (msg.type === 'done') {
    finishJob();
    state.result = msg.result;
    renderResult(msg.result);
    drawSessions(msg.result, msg.result.track || []);
    if (msg.result.start) setStart(L.latLng(msg.result.start.lat, msg.result.start.lon));
  } else if (msg.type === 'error') {
    finishJob();
    showError(friendlyError(msg.message));
  }
};

worker.onerror = (ev) => {
  finishJob();
  showError('The compute worker failed to start. Serve this folder over http(s): '
    + 'browsers refuse to run workers from a file:// page.');
  console.error(ev);
};

$('compute').onclick = () => {
  if (!state.regions.length) return;
  const problem = validate();
  if (problem) { showError(problem); return; }

  showError(null);
  clearRoute();
  $('compute').disabled = true;
  state.jobId += 1;
  state.started = performance.now();
  state.progress = { phase: 'queued', message: 'Starting...', fraction: 0 };
  renderProgress();
  clearInterval(state.ticker);
  state.ticker = setInterval(renderProgress, 500);
  worker.postMessage({ id: state.jobId, payload: payload() });
};

function finishJob() {
  clearInterval(state.ticker);
  state.ticker = null;
  hideProgress();
  $('compute').disabled = state.regions.length === 0;
}

function friendlyError(message) {
  // Errors may arrive as "ErrorType: text"; the text is the useful part.
  const m = String(message || '');
  const colon = m.indexOf(': ');
  return colon > 0 && colon < 40 ? m.slice(colon + 2) : m;
}

function renderProgress() {
  const p = state.progress;
  if (!p) return;
  const box = $('progress');
  box.classList.remove('hidden');
  const fill = box.querySelector('.fill');
  // Downloading and route-solving have no natural granularity, so they get a
  // moving bar rather than a fake percentage.
  const indeterminate = p.phase === 'balance' || p.phase === 'fetch';
  fill.classList.toggle('indeterminate', indeterminate);
  fill.style.width = indeterminate ? '' : `${Math.round((p.fraction || 0) * 100)}%`;
  const elapsed = (performance.now() - state.started) / 1000;
  const secs = elapsed >= 1 ? ` · ${elapsed.toFixed(0)}s` : '';
  box.querySelector('.progress-text').textContent = `${p.message || p.phase}${secs}`;
}

function hideProgress() { $('progress').classList.add('hidden'); }

function showError(msg) {
  const box = $('error');
  if (!msg) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.textContent = msg;
}

/* ---------------------------------------------------------------- render */
function renderResult(res) {
  $('stats-card').classList.remove('hidden');

  const st = res.stats;
  const cov = res.coverage;
  const sessions = res.sessions;
  $('summary').innerHTML = [
    ['Distance', `${st.total_km} km`],
    ['Driving', st.duration],
    ['Sessions', sessions.length],
    ['Roads covered', `${cov.centerline_km_covered} km`],
    ['Coverage', `${cov.coverage_pct}%`],
    ['Roads in area', `${cov.centerline_km_in_area} km`],
    ['Unreachable', `${cov.km_dropped_not_strongly_connected} km`],
    ['Fragments', Math.max(cov.strong_components - 1, 0)],
  ].map(([label, value]) =>
    `<div class="tile"><span class="tile-label">${label}</span>`
    + `<span class="tile-value">${escapeHtml(String(value))}</span></div>`
  ).join('');

  // One button, one zip: the GPX file(s) - one per session, because one
  // 80,000-point track is more than most nav apps will take - plus a PNG of
  // the map and a README, so a single session gets the same package.
  const many = sessions.length > 1;
  $('download').textContent = many
    ? `Download ${sessions.length} sessions (.zip)`
    : 'Download route (.zip)';
  $('download-note').textContent =
    'Open the downloaded file(s) in OsmAnd mobile app, for example.';
}

$('download').onclick = async () => {
  const res = state.result;
  if (!res) return;
  const button = $('download');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';
  try {
    // The picture is a bonus: if the tiles will not come, the zip still does.
    const image = await snapshotImage().catch((err) => {
      console.warn('map image skipped', err);
      return null;
    });
    const blob = await gpxZip(res, { image });
    saveBlob(blob, res.sessions.length > 1 ? 'routile-sessions.zip' : 'routile-route.zip');
  } catch (err) {
    showError(`Could not build the file: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

/* The map as the route sees it: every session line, the zones and the start,
   framed on the route rather than on wherever the screen is scrolled to. */
function snapshotImage() {
  const sessions = state.result.sessions.map((session, i) => ({
    points: state.sessionPoints[i] || [],
    label: `Session ${i + 1}`,
    meta: `${Number(session.km).toFixed(1)} km · ${humanMinutes(session.minutes)}`,
  }));
  const st = state.result.stats;
  return mapSnapshot({
    sessions,
    regions: state.regions,
    start: state.startLatLng ? [state.startLatLng.lat, state.startLatLng.lng] : null,
    palette: SESSION_COLORS.light,    // the picture is always the paper map
    title: `${st.total_km} km · ${st.duration}`,
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ----------------------------------------------------------------- route */
/* The breadcrumb is one continuous list of points; `arc_start` maps a tour arc
   to where it begins in that list, and each session knows the arcs it covers.
   Slicing there rather than by distance keeps every session's line joined to
   the next one exactly, with no gap and no overlap. */
function sessionSlice(res, track, session) {
  const starts = res.arc_start || [];
  if (!starts.length || !session.arc_span) return null;
  const at = (arc) => starts[Math.min(Math.max(arc, 0), starts.length - 1)];
  const from = at(session.arc_span[0]);
  const to = at(session.arc_span[1]);
  return to > from ? track.slice(from, to + 1) : null;
}

/* Shift every point sideways, to the right of the direction of travel, the way
   a map draws a dual carriageway.

   Without this a street driven in both directions is two lines on top of each
   other, i.e. indistinguishable from a street driven once - so "did it cover
   both ways?" is a question the map cannot answer. Offsetting makes the second
   pass appear beside the first, with its own arrows pointing back. It falls out
   of the geometry, so it needs no extra data and works for three passes as
   readily as two.

   The offset is a fixed distance on the ground, not in pixels, so it stays a
   real half-carriageway: invisible when zoomed out, clear when zoomed in. */
function offsetRight(points, metres) {
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(i - 1, 0)];
    const after = points[Math.min(i + 1, points.length - 1)];
    const lat = points[i][0];
    const kx = Math.cos(rad(lat)) || 1e-6;
    let east = (after[1] - before[1]) * kx;
    let north = after[0] - before[0];
    const len = Math.hypot(east, north);
    if (!len) { out[i] = points[i]; continue; }
    east /= len;
    north /= len;
    // Right of travel is the heading turned 90 degrees clockwise: (north, -east).
    out[i] = [
      lat + (-east * metres) / KM_PER_DEG / 1000,
      points[i][1] + (north * metres) / KM_PER_DEG / 1000 / kx,
    ];
  }
  return out;
}

function bearingAt(points, i) {
  const a = points[Math.max(i - 1, 0)];
  const b = points[Math.min(i + 1, points.length - 1)];
  const kx = Math.cos(rad(points[i][0])) || 1e-6;
  return Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) * 180 / Math.PI;
}

function metresBetween(a, b) {
  const kx = Math.cos(rad(a[0])) || 1e-6;
  return Math.hypot((b[1] - a[1]) * kx, b[0] - a[0]) * KM_PER_DEG * 1000;
}

function drawSessions(res, track) {
  clearRouteLayers();
  const sessions = res.sessions;

  sessions.forEach((session, i) => {
    const raw = sessionSlice(res, track, session) || [];
    if (raw.length < 2) return;
    const points = offsetRight(raw, OFFSET_M);
    // interactive:false: a route line is drawn output, not a control. The
    // legend is where a session is hovered and picked - a line under the
    // pointer must not take the pointer cursor, catch a click meant for the
    // map, or swap the highlight while you are drawing the next zone over it.
    const line = L.polyline(points, {
      color: sessionColor(i), weight: ROUTE_WEIGHT, opacity: 0.85,
      interactive: false,
    }).addTo(map);
    state.routeLayers[i] = line;
    state.sessionPoints[i] = points;
  });

  buildLegend(sessions);
  refreshDetail();

  const drawn = state.routeLayers.filter(Boolean);
  if (drawn.length) {
    const bounds = drawn.reduce(
      (acc, line) => (acc ? acc.extend(line.getBounds()) : line.getBounds()), null
    );
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

/* Arrows and waypoint dots, drawn only for what is on screen and only once the
   map is zoomed in far enough for them to mean anything. A 500 km route has
   thousands of each; rebuilding just the visible ones keeps that irrelevant. */
function refreshDetail() {
  state.arrowLayer.clearLayers();
  state.pointLayer.clearLayers();
  state.arrowsBySession = [];
  if (!state.routeLayers.length) return;

  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.15);

  if (zoom >= ARROW_ZOOM) {
    state.sessionPoints.forEach((points, i) => {
      if (!points) return;
      const mine = [];
      let since = ARROW_SPACING_M;      // one arrow at the very start
      for (let n = 1; n < points.length; n++) {
        since += metresBetween(points[n - 1], points[n]);
        if (since < ARROW_SPACING_M) continue;
        since = 0;
        if (!bounds.contains(points[n])) continue;
        mine.push(arrowAt(points, n, sessionColor(i)));
      }
      state.arrowsBySession[i] = mine;
    });
  }

  if (zoom >= POINT_ZOOM && state.result) {
    // Ringed in the map's own background rather than in white, so the dots
    // stay legible on a dark basemap as well as a pale one.
    const ring = cssVar('--map-bg');
    const fill = cssVar('--ink');
    for (const wp of state.result.waypoints || []) {
      if (!bounds.contains([wp.lat, wp.lon])) continue;
      L.circleMarker([wp.lat, wp.lon], {
        radius: 3.5, weight: 1.5, color: ring, fillColor: fill,
        fillOpacity: 0.9, interactive: false,
      }).addTo(state.pointLayer);
    }
  }
  applyHighlight(state.hovered !== null ? state.hovered : state.pinned);
}

function arrowAt(points, n, color) {
  const marker = L.marker(points[n], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: 'route-arrow',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      // The rotation goes on an inner element: Leaflet owns the marker's own
      // transform for positioning and would overwrite it.
      html: `<i style="transform:rotate(${bearingAt(points, n) - 90}deg);color:${color}">`
          + '<svg viewBox="0 0 14 14" aria-hidden="true">'
          + '<path d="M3 7h7M7.5 4l3 3-3 3"/></svg></i>',
    }),
  });
  marker.addTo(state.arrowLayer);
  return marker;
}

function buildLegend(sessions) {
  const box = $('legend');
  box.innerHTML = sessions.map((session, i) => {
    const km = Number(session.km).toFixed(1);
    return `<button type="button" class="legend-item" data-session="${i}" role="listitem">`
      + `<span class="swatch" style="background:${sessionColor(i)}"></span>`
      + '<span class="legend-text">'
      + `<span class="legend-name">Session ${i + 1}</span>`
      + `<span class="legend-meta">${km} km · ${humanMinutes(session.minutes)}</span>`
      + '</span></button>';
  }).join('');
  box.classList.toggle('hidden', sessions.length === 0);
  placeLegend();

  for (const item of box.querySelectorAll('.legend-item')) {
    const i = Number(item.dataset.session);
    item.addEventListener('mouseenter', () => hover(i, { scroll: false }));
    item.addEventListener('mouseleave', () => hover(null));
    item.addEventListener('focus', () => hover(i, { scroll: false }));
    item.addEventListener('blur', () => hover(null));
    item.addEventListener('click', () => pin(state.pinned === i ? null : i));
  }
}

/* The legend sits in the top right corner beside the tool bar while there is
   room for both, and drops below the bar only when their boxes would actually
   overlap - measured, not guessed from a breakpoint. */
function placeLegend() {
  const legend = $('legend');
  if (legend.classList.contains('hidden')) return;
  legend.style.top = '';
  legend.style.maxHeight = '';
  const bar = $('toolbar').getBoundingClientRect();
  const box = legend.getBoundingClientRect();
  const clear = 8;
  if (box.left < bar.right + clear && box.right > bar.left - clear
      && box.top < bar.bottom + clear) {
    const top = bar.bottom - $('map').getBoundingClientRect().top + 10;
    legend.style.top = `${top}px`;
    legend.style.maxHeight = `calc(100% - ${top + 14}px)`;
  }
}
new ResizeObserver(() => placeLegend()).observe($('map'));

/* Two layers of the same highlight, both driven from the legend alone.
   Hovering a row previews that session; clicking it pins it so it survives the
   pointer leaving the legend, which is what you want while reading a leg off
   the map. Clicking the row again, or clicking the map, lets go. With
   something pinned, moving off a hover falls back to it rather than to
   nothing. */
function hover(index, { scroll = true } = {}) {
  state.hovered = index;
  applyHighlight(index !== null ? index : state.pinned, { scroll });
}

function pin(index) {
  state.pinned = index;
  applyHighlight(index);
  for (const item of $('legend').querySelectorAll('.legend-item')) {
    item.classList.toggle('pinned', Number(item.dataset.session) === index);
  }
}

/* Highlighting a session leaves it exactly as drawn and takes every other
   session off the map, so what is left is that one leg on its own. */
function applyHighlight(index, { scroll = true } = {}) {
  state.routeLayers.forEach((line, i) => {
    if (!line) return;
    const hidden = index !== null && i !== index;
    line.setStyle({ opacity: hidden ? 0 : 0.85 });
    if (i === index) line.bringToFront();
  });

  state.arrowsBySession.forEach((arrows, i) => {
    if (!arrows) return;
    const hidden = index !== null && i !== index;
    for (const marker of arrows) {
      if (marker._icon) marker._icon.style.opacity = hidden ? '0' : '1';
    }
  });

  for (const item of $('legend').querySelectorAll('.legend-item')) {
    const hot = Number(item.dataset.session) === index;
    item.classList.toggle('active', hot);
    // Keep the matching row visible when the pointer is out on the map and the
    // legend has scrolled past it.
    if (hot && scroll) item.scrollIntoView({ block: 'nearest' });
  }
}

function humanMinutes(minutes) {
  const total = Math.round(Number(minutes) || 0);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

function clearRouteLayers() {
  for (const line of state.routeLayers) {
    if (line) map.removeLayer(line);
  }
  state.routeLayers = [];
  state.sessionPoints = [];
  state.arrowsBySession = [];
  state.arrowLayer.clearLayers();
  state.pointLayer.clearLayers();
  state.pinned = null;
  state.hovered = null;
}

function clearRoute() {
  clearRouteLayers();
  $('legend').innerHTML = '';
  $('legend').classList.add('hidden');
  state.result = null;
  $('stats-card').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
