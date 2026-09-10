/* Routile frontend: drag out zones, drop a start pin, compute, then drive. */

import * as config from './config.js';
import { Area } from './area.js';
import { DetailLayer } from './detail.js';
import { gpxZip } from './gpx.js';
import { mapSnapshot } from './snapshot.js';

const $ = (id) => document.getElementById(id);

// The three ways to draw. Each one is a full drag gesture: press, move, release.
const SHAPES = ['rect', 'circle', 'freehand'];

/* One palette for the screen and for the exported picture, now that both are
   drawn on a pale map. See ROUTE_PALETTE in config.js for how it was chosen. */
const SESSION_COLORS = config.ROUTE_PALETTE;

const sessionColor = (i) => SESSION_COLORS[i % SESSION_COLORS.length];

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
  detail: null,        // the canvas of arrows and waypoint dots
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
// shift+drag drawing. zoomControl off for good: the wheel, the keyboard and a
// pinch all zoom already, so two buttons for it would only be map you cannot
// see.
const map = L.map('map', { zoomControl: false, boxZoom: false })
  .setView([48.148, 17.107], 14);

/* Is the thing pointing at this page a finger? Asked of the input the device
   actually has rather than of the window's width, so a narrow desktop window
   keeps its mouse affordances and a large tablet loses them. */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('is-touch', coarsePointer);

// The default prefix carries a title tooltip; this one is the same credit without it.
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// interactive:false throughout: a drawn zone is a backdrop, not a control.
// Left interactive it would take the pointer cursor and swallow hovers while
// you are trying to draw the next zone on top of it.
const AREA_STYLE = () => ({
  color: cssVar('--zone'), weight: 2, fillOpacity: 0.08, interactive: false,
});
const DRAFT_STYLE = () => ({
  color: cssVar('--zone'), weight: 2, fillOpacity: 0.1, dashArray: '5,4',
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

// Arrows and waypoint dots, on their own canvas. The layer redraws itself for
// the visible area as the map moves, so their cost is set by the screen rather
// than by the route's length.
state.detail = new DetailLayer({
  arrowZoom: ARROW_ZOOM,
  pointZoom: POINT_ZOOM,
  halo: cssVar('--map-bg'),
  dot: cssVar('--map-ink'),
}).addTo(map);

// The map shares the stage with the top bar and the session list, and once
// those dock they take real height from it. Laid out first, then Leaflet is
// told - otherwise it keeps drawing for the size it had.
new ResizeObserver(() => {
  layoutOverlays();
  map.invalidateSize({ animate: false });
}).observe($('stage'));

/* CARTO's pale basemap where a key is configured, OpenStreetMap's own tiles
   where it is not - see CARTO_API_KEY in config.js, which is where the key
   goes. Attribution is a licence condition for both and is set accordingly.

   {r} is Leaflet's retina placeholder: '@2x' on a hidpi screen and empty
   elsewhere, so a sharp screen gets sharp tiles for the same one request per
   tile. OSM serves no @2x, hence only CARTO's URL carries it. */
const basemap = config.CARTO_API_KEY ? {
  url: `https://basemaps.cartocdn.com/${config.CARTO_STYLE}/{z}/{x}/{y}{r}.png`
     + `?key=${encodeURIComponent(config.CARTO_API_KEY)}`,
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
             + 'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
} : {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

L.tileLayer(basemap.url, {
  maxZoom: basemap.maxZoom,
  // Fetched with CORS, so the same cached tiles may be drawn onto the canvas
  // behind the exported map image. Both tile servers allow any origin.
  crossOrigin: 'anonymous',
  attribution: basemap.attribution,
}).addTo(map);

/* -------------------------------------------------------------- drawing */
/* One drag gesture, three shapes, and one code path for a mouse, a finger and
   a pen: pointer events cover all three. `drag.tool` is fixed at the press so
   a key released mid-drag cannot change what is being drawn.

   The pointer is captured, so a drag that leaves the map keeps reporting and
   a release anywhere still finishes the shape. While a shape tool is armed
   Leaflet's own dragging is off (see setMode), so on a touch screen one finger
   draws rather than panning; two fingers still pinch, and the Pan tool hands
   the map back. */
let drag = null;   // { tool, pointerId, from, points, layer, ring, closing }

const MIN_DRAG_PX = 12;        // below this, a drag is an accidental click
const FREEHAND_STEP_PX = 5;    // sampling distance while drawing by hand
const FREEHAND_SIMPLIFY_PX = 3;
const SNAP_PX = 22;            // radius of the "release here to close" ring
const SNAP_MIN_POINTS = 6;     // don't offer to close before a loop exists

const mapEl = $('map');

function activeTool(ev) {
  if (SHAPES.includes(state.mode)) return state.mode;
  // Shift+drag draws without leaving pan mode, using the last shape picked.
  if (state.mode === 'pan' && ev && ev.shiftKey) return state.lastShape;
  return null;
}

// A pointer event carries viewport coordinates; Leaflet wants them measured
// from the map's own top left corner.
function pointerLatLng(ev) {
  const box = mapEl.getBoundingClientRect();
  return map.containerPointToLatLng(
    L.point(ev.clientX - box.left, ev.clientY - box.top));
}

mapEl.addEventListener('pointerdown', (ev) => {
  // A mouse draws with the left button; the other two are the pan grip below.
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  // A second finger mid-drag is a pinch, not a second zone.
  if (drag) return;
  if (ev.target.closest('.leaflet-control')) return;
  const tool = activeTool(ev);
  if (!tool) return;

  ev.preventDefault();
  // Captured, so the rest of the gesture arrives here even if it wanders off
  // the map or ends over the tool bar.
  try { mapEl.setPointerCapture(ev.pointerId); } catch (err) { /* pointer gone */ }

  const at = pointerLatLng(ev);
  drag = { tool, pointerId: ev.pointerId, from: at, points: [at],
           layer: null, ring: null, closing: false };

  if (tool === 'rect') {
    drag.layer = L.rectangle(L.latLngBounds(at, at), DRAFT_STYLE());
  } else if (tool === 'circle') {
    drag.layer = L.circle(at, { radius: 1, ...DRAFT_STYLE() });
  } else {
    drag.layer = L.polyline([at], DRAFT_STYLE());
    // A ring at the start showing where to finish. Without it the shape closes
    // with a straight line from wherever you happened to stop, which is how a
    // careful outline ends up with a spike across the map.
    drag.ring = L.circleMarker(at, {
      radius: SNAP_PX, color: cssVar('--zone'), weight: 1.5,
      dashArray: '4,3', fillOpacity: 0.06, interactive: false,
    }).addTo(map);
  }
  drag.layer.addTo(map);
});

mapEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const at = pointerLatLng(ev);
  if (drag.tool === 'rect') {
    drag.layer.setBounds(L.latLngBounds(drag.from, at));
  } else if (drag.tool === 'circle') {
    drag.layer.setRadius(drag.from.distanceTo(at));
  } else {
    // Sampled rather than recording every move: a slow hand emits hundreds of
    // points a second, and the outline is smoothed at the end anyway.
    const last = drag.points[drag.points.length - 1];
    if (pixelGap(last, at) >= FREEHAND_STEP_PX) drag.points.push(at);
    setClosing(withinSnap(at));
    drag.layer.setLatLngs(
      drag.closing ? drag.points.concat([drag.from]) : drag.points
    );
  }
});

mapEl.addEventListener('pointerup', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  finishDrag(pointerLatLng(ev));
});
// The system took the gesture away: a phone call, a system gesture, a pinch.
mapEl.addEventListener('pointercancel', (ev) => {
  if (drag && ev.pointerId === drag.pointerId) finishDrag(null);
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
  try { mapEl.releasePointerCapture(drag.pointerId); } catch (err) { /* already gone */ }
  if (drag.layer) map.removeLayer(drag.layer);
  if (drag.ring) map.removeLayer(drag.ring);
  drag = null;
}

/* A press that never grew into a drag is a click on the map: it draws nothing
   and lets go of whatever the legend has pinned. The map's own click event
   cannot do this job any more, since a shape tool takes the gesture over at
   the press and the click that would have followed never arrives. */
function tapped() {
  if (state.pinned !== null) pin(null);
}

function finishDrag(latlng) {
  if (!drag) return;
  const { tool, from, points, closing } = drag;
  discardDraft();
  if (!latlng) return;      // cancelled: Escape, or the gesture was taken away

  if (tool === 'rect') {
    const bounds = L.latLngBounds(from, latlng);
    if (pixelGap(bounds.getNorthWest(), bounds.getSouthEast()) < MIN_DRAG_PX) return tapped();
    addShape({
      type: 'rect',
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    });
  } else if (tool === 'circle') {
    // Half the rectangle's threshold: this is a radius, not a diagonal.
    if (pixelGap(from, latlng) < MIN_DRAG_PX / 2) return tapped();
    addShape({
      type: 'circle',
      lat: from.lat, lon: from.lng, radius_m: from.distanceTo(latlng),
    });
  } else {
    // Released inside the ring: close on the start point exactly, rather than
    // on wherever the pointer drifted to inside it.
    const raw = closing ? points : points.concat([latlng]);
    const outline = simplifyOutline(raw);
    if (outline.length < 3) return tapped();
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
let tempPan = null;

mapEl.addEventListener('mousedown', (ev) => {
  if (tempPan || !PAN_BUTTONS.has(ev.button)) return;
  if (ev.target.closest('.leaflet-control')) return;
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
  const drawing = SHAPES.includes(mode);
  mapEl.classList.toggle('drawing', drawing);
  mapEl.classList.toggle('pinning', mode === 'pin');
  // A shape tool owns the drag gesture, so Leaflet must not pan with it as
  // well. This is what lets one finger draw on a touch screen.
  if (drawing) map.dragging.disable(); else map.dragging.enable();
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
$('private-roads').checked = config.INCLUDE_PRIVATE_DEFAULT;
$(config.BOTH_DIRECTIONS_DEFAULT ? 'dir-both' : 'dir-oneway').checked = true;
$('session').value = String(Math.round((config.SESSION_SECONDS_DEFAULT / 3600) * 100) / 100);

function bothDirections() { return $('dir-both').checked; }

function includePrivate() { return $('private-roads').checked; }

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
    include_private: includePrivate(),
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

['passes', 'session', 'dir-oneway', 'dir-both', 'session-enabled',
 'private-roads'].forEach((id) => {
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
  const arrows = [];

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
    arrows[i] = arrowsAlong(points);
  });

  state.detail.setRoute({
    arrows,
    colors: sessions.map((_, i) => sessionColor(i)),
    dots: res.waypoints || [],
  });

  buildLegend(sessions);

  const drawn = state.routeLayers.filter(Boolean);
  if (drawn.length) {
    const bounds = drawn.reduce(
      (acc, line) => (acc ? acc.extend(line.getBounds()) : line.getBounds()), null
    );
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

/* Every arrow a session will ever need, worked out once when its line is
   drawn: one every ARROW_SPACING_M along the leg, with the heading to draw it
   at. Which of them are on screen is then a bounds test each.

   This used to be done per pan, walking every point of the route to re-measure
   the spacing - which on a 400 km route is hundreds of thousands of distance
   calculations before a single mark reaches the screen, on every gesture. The
   spacing does not depend on the viewport, so it never needed redoing. */
function arrowsAlong(points) {
  const out = [];
  let since = ARROW_SPACING_M;      // so the first one lands at the very start
  for (let n = 1; n < points.length; n++) {
    since += metresBetween(points[n - 1], points[n]);
    if (since < ARROW_SPACING_M) continue;
    since = 0;
    out.push({ lat: points[n][0], lon: points[n][1], deg: bearingAt(points, n) });
  }
  return out;
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
  layoutOverlays();

  for (const item of box.querySelectorAll('.legend-item')) {
    const i = Number(item.dataset.session);
    item.addEventListener('mouseenter', () => hover(i, { scroll: false }));
    item.addEventListener('mouseleave', () => hover(null));
    item.addEventListener('focus', () => hover(i, { scroll: false }));
    item.addEventListener('blur', () => hover(null));
    item.addEventListener('click', () => pin(state.pinned === i ? null : i));
  }
}

/* The top bar floats centred over the map with the session list in the corner
   beside it, and gives way in three steps as the window narrows: the tools
   drop their labels, then the bar gives up the centre and slides left to use
   the empty half of the map, and only when even that will not clear the
   sessions does the whole bar - search box and all - come out of the map and
   stack below it with the sessions underneath.

   Measured rather than guessed from a breakpoint, because how much room the
   bar needs depends on its labels and how much is left depends on whether
   there are any sessions to list at all. Each step is decided by trying it:
   the classes come off, the bar is measured at its natural width (see the
   max-content in the stylesheet), and the next step is added only while it
   still does not fit.

   The steps are cumulative, and deliberately so: a narrower window can only
   ever take more away, never hand the labels back. Reaching the bar's dock at
   one width and its labels at a narrower one would have the tools flickering
   in and out as the window is dragged. */
const phoneLayout = window.matchMedia('(max-width: 860px)');
phoneLayout.addEventListener('change', () => layoutOverlays());

function layoutOverlays() {
  const stage = $('stage');
  stage.classList.remove('tools-tight', 'tools-left', 'tools-docked');
  // A phone stacks the panel above the map and everything else below it, so
  // there is nothing left over the map to make room in - it is the last step
  // of the three, arrived at directly.
  if (phoneLayout.matches) {
    stage.classList.add('tools-tight', 'tools-left', 'tools-docked');
    return;
  }
  if (barIsCrowded()) stage.classList.add('tools-tight');
  if (barIsCrowded()) stage.classList.add('tools-left');
  if (barIsCrowded()) stage.classList.add('tools-docked');
}

/* Does the bar, at the width and place it currently has, still clear both
   edges of the stage and the session list on its right? */
function barIsCrowded() {
  const stage = $('stage').getBoundingClientRect();
  const bar = $('topbar').getBoundingClientRect();
  const clear = 10;
  if (bar.width > stage.width - 2 * clear) return true;
  const legend = $('legend');
  if (legend.classList.contains('hidden')) return false;
  return bar.right + clear > legend.getBoundingClientRect().left;
}

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

  state.detail.setHighlight(index);

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
  state.detail.clear();
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
