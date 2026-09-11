/* Routile frontend: drag out zones, drop a start pin, compute, then drive. */

import * as config from './config.js';
import { Area } from './area.js';
import { DetailLayer } from './detail.js';
import { gpxZip, fileStamp } from './gpx.js';

const $ = (id) => document.getElementById(id);

// The three ways to draw. Each one is a full drag gesture: press, move, release.
const SHAPES = ['rect', 'circle', 'freehand'];

// Which basemap is showing, and so which route palette reads on it. Not a page
// theme: the panel is dark whichever map is picked.
const BASEMAP_KEY = 'routile-basemap';
let basemap = config.BASEMAPS[0];

const palette = () =>
  (basemap.dark ? config.ROUTE_PALETTE_DARK : config.ROUTE_PALETTE_LIGHT);

const sessionColor = (i) => palette()[i % palette().length];

const ROUTE_WEIGHT = 3;

// Half a carriageway: each pass is drawn this far right of its own direction of
// travel, so a street driven both ways shows as two lines rather than one.
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
  pinned: null,        // clicked in the legend; null is the whole route
  shown: null,         // the highlight on the map, pin or pointer preview
  mode: 'rect',        // rect | circle | freehand | pan | pin
  lastShape: 'rect',   // which tool a shift+drag uses while panning
  jobId: 0,
  result: null,
  checkTimer: null,
  searching: false,
  progress: null,      // {phase, message, fraction} of the running job
  started: 0,
  ticker: null,
  confirm: null,       // what the map alert's Accept button runs, if it has one
};

/* ------------------------------------------------------------------ map */
// boxZoom off: it binds shift+drag, which shift+drag drawing needs. zoomControl
// off: the wheel, the keyboard and a pinch all zoom already.
const map = L.map('map', { zoomControl: false, boxZoom: false })
  .setView([48.148, 17.107], 14);

// Asked of the input the device has, not the window width, so a narrow desktop
// window keeps its mouse affordances and a large tablet loses them.
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('is-touch', coarsePointer);

// The default prefix carries a title tooltip; this one is the same credit without it.
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// interactive:false throughout: a zone is a backdrop, not a control, and would
// otherwise swallow hovers while you draw the next one over it.
const AREA_STYLE = () => ({
  color: cssVar('--zone'), weight: 2, fillOpacity: 0.08, interactive: false,
});
// Green joins, red crops: a draft says which before it is let go of.
const opColor = (op) => cssVar(op === 'subtract' ? '--cut' : '--zone');
const DRAFT_STYLE = (op) => ({
  color: opColor(op), weight: 2, fillOpacity: 0.1, dashArray: '5,4',
  interactive: false,
});

// Same glyph as the Start button and the cursor that places it.
const START_ICON = L.divIcon({
  className: 'start-pin',
  html: '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z"/>'
      + '<circle cx="12" cy="10" r="2.6"/></svg>',
  iconSize: [60, 60],
  iconAnchor: [30, 54],      // the pin's tip, not its centre, marks the spot
});

// Inside the map container, so Leaflet must not read clicks and drags on them
// as map gestures.
for (const id of ['topbar', 'search', 'legend']) {
  L.DomEvent.disableClickPropagation($(id));
  L.DomEvent.disableScrollPropagation($(id));
}
// Leaflet's keyboard handler is on the map container, which the search box sits
// inside; without this, arrow keys pan the map mid-word.
for (const type of ['keydown', 'keyup', 'keypress']) {
  L.DomEvent.on($('search-input'), type, L.DomEvent.stopPropagation);
}

// Arrows and waypoint dots on their own canvas, redrawn for the visible area,
// so their cost is set by the screen rather than the route's length.
state.detail = new DetailLayer({
  arrowZoom: ARROW_ZOOM,
  pointZoom: POINT_ZOOM,
  halo: cssVar('--map-bg'),
  dot: cssVar('--map-ink'),
}).addTo(map);

// The docked top bar and session list take real height from the map. Lay out
// first, then tell Leaflet, or it keeps drawing for the size it had.
new ResizeObserver(() => {
  layoutOverlays();
  map.invalidateSize({ animate: false });
}).observe($('stage'));

/* ------------------------------------------------------------- basemap */
// Declared in config.js. The CARTO ones need a key and drop out without one.
const BASEMAP_CHOICES = config.BASEMAPS.filter(
  (m) => !m.needsKey || config.CARTO_API_KEY);

let tileLayer = null;

// {r} in a URL is Leaflet's retina placeholder: '@2x' on a hidpi screen, empty
// elsewhere. OSM serves no @2x, so only CARTO's URLs carry it.
function addTiles(spec) {
  const url = spec.needsKey
    ? `${spec.url}?key=${encodeURIComponent(config.CARTO_API_KEY)}`
    : spec.url;
  const next = L.tileLayer(url, {
    maxZoom: spec.maxZoom,
    // CORS, so the cached tiles can be drawn onto the exported image's canvas.
    crossOrigin: 'anonymous',
    attribution: spec.attribution,
  });
  // New tiles go under what is drawn, and the old layer only goes once they
  // load, or the switch flashes the empty container colour.
  next.addTo(map);
  next.getContainer().style.zIndex = 1;
  const old = tileLayer;
  tileLayer = next;
  if (old) next.once('load', () => map.removeLayer(old));

  // A keyed basemap fails wholesale, not tile by tile: CARTO binds a key to one
  // origin and a spent quota looks the same, and either way it is a blank map.
  // Fall back to the keyless one. Counted, not tripped on the first error,
  // since a single tile can fail for reasons that are nobody's fault.
  if (!spec.needsKey) return;
  let bad = 0;
  next.on('tileerror', () => {
    if (++bad < 3 || tileLayer !== next) return;
    next.off('tileerror');
    const plain = BASEMAP_CHOICES.find((m) => !m.needsKey);
    if (plain) setBasemap(plain.id, { save: false });
  });
}

/* The marks answer to the ground they sit on, so palette, zone green and halo
   all move with the tiles. They come from the [data-map] block in the
   stylesheet: stamp the attribute first, refresh everything that reads a
   variable after. */
function setBasemap(id, { save = true } = {}) {
  basemap = BASEMAP_CHOICES.find((m) => m.id === id) || BASEMAP_CHOICES[0];
  const root = document.documentElement;
  root.dataset.map = basemap.dark ? 'dark' : 'light';
  // OSM publishes no dark tiles; its dark option is the daylight tile inverted.
  if (basemap.invert) root.dataset.tiles = 'inverted';
  else delete root.dataset.tiles;
  addTiles(basemap);

  drawRegions();                                  // zones, in the new green
  state.routeLayers.forEach((line, i) => {
    if (line) line.setStyle({ color: sessionColor(i) });
  });
  state.detail.restyle({
    colors: state.routeLayers.map((_, i) => sessionColor(i)),
    halo: cssVar('--map-bg'),
    dot: cssVar('--map-ink'),
  });
  // Not the All sessions row: its stripe is there to hold the column, not to
  // carry a colour.
  for (const stripe of $('legend').querySelectorAll('.legend-item:not(.legend-all) .stripe')) {
    stripe.style.background = sessionColor(sessionOf(stripe.closest('.legend-item')));
  }
  // The restyle above cleared the per-session opacity the highlight sets.
  applyHighlight(state.shown, { scroll: false });

  $('basemap-label').textContent = basemap.label;
  for (const li of $('basemap-list').children) {
    li.setAttribute('aria-selected', String(li.dataset.id === basemap.id));
  }
  if (save) {
    try { localStorage.setItem(BASEMAP_KEY, basemap.id); } catch (err) { /* private mode */ }
  }
}

/* ------------------------------------------------------- the map picker */
$('basemap-list').innerHTML = BASEMAP_CHOICES.map(
  (m) => `<li role="option" aria-selected="false" data-id="${m.id}">`
       + `${escapeHtml(m.label)}</li>`).join('');

// One map on offer is not a choice. That is the keyless case.
const onlyOneMap = BASEMAP_CHOICES.length < 2;
$('basemap-field').classList.toggle('hidden', onlyOneMap);
$('basemap-sep').classList.toggle('hidden', onlyOneMap);

// Open state lives in aria-expanded, so the attribute a screen reader reads is
// the one the stylesheet turns the chevron with. `cursor` is the keyboard's
// position, which is not the selection until Enter.
function pickerOpen() { return $('basemap-button').getAttribute('aria-expanded') === 'true'; }

function openPicker(open) {
  $('basemap-button').setAttribute('aria-expanded', String(open));
  $('basemap-list').classList.toggle('hidden', !open);
  if (open) moveCursor([...$('basemap-list').children]
    .findIndex((li) => li.dataset.id === basemap.id));
  else clearCursor();
}

function clearCursor() {
  for (const li of $('basemap-list').children) li.classList.remove('cursor');
}

function moveCursor(index) {
  const rows = [...$('basemap-list').children];
  if (!rows.length) return;
  const at = (index + rows.length) % rows.length;
  clearCursor();
  rows[at].classList.add('cursor');
  rows[at].scrollIntoView({ block: 'nearest' });
}

function cursorIndex() {
  return [...$('basemap-list').children].findIndex((li) => li.classList.contains('cursor'));
}

$('basemap-button').addEventListener('click', () => openPicker(!pickerOpen()));

$('basemap-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li');
  if (!li) return;
  setBasemap(li.dataset.id);
  openPicker(false);
  $('basemap-button').focus();
});

// Hover and keyboard share one cursor, so the mouse leaves no stale highlight.
$('basemap-list').addEventListener('mousemove', (ev) => {
  const li = ev.target.closest('li');
  if (li) moveCursor([...$('basemap-list').children].indexOf(li));
});

$('basemap-field').addEventListener('keydown', (ev) => {
  const open = pickerOpen();
  if (ev.key === 'Escape' && open) {
    ev.stopPropagation();          // Escape also cancels a half-drawn zone
    openPicker(false);
    $('basemap-button').focus();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!open) openPicker(true);
    else moveCursor(cursorIndex() + (ev.key === 'ArrowDown' ? 1 : -1));
  } else if (open && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    const li = $('basemap-list').children[cursorIndex()];
    if (li) setBasemap(li.dataset.id);
    openPicker(false);
    $('basemap-button').focus();
  } else if (ev.key === 'Home' || ev.key === 'End') {
    if (!open) return;
    ev.preventDefault();
    moveCursor(ev.key === 'Home' ? 0 : $('basemap-list').children.length - 1);
  }
});

// Anywhere else - including the map, and including a tab away.
document.addEventListener('pointerdown', (ev) => {
  if (pickerOpen() && !$('basemap-field').contains(ev.target)) openPicker(false);
});
// Tabbing away closes it, and only tabbing: relatedTarget is null when focus
// lands on something that cannot take it, and a list row is exactly that, so
// without the guard a pointerdown on a row closed the list out from under it.
$('basemap-field').addEventListener('focusout', (ev) => {
  if (!ev.relatedTarget) return;
  if (pickerOpen() && !$('basemap-field').contains(ev.relatedTarget)) openPicker(false);
});

let storedMap = null;
try { storedMap = localStorage.getItem(BASEMAP_KEY); } catch (err) { /* private mode */ }
setBasemap(storedMap || config.BASEMAP_DEFAULT, { save: false });

/* -------------------------------------------------------------- drawing */
/* One gesture, three shapes, one code path for mouse, finger and pen.
   `drag.tool` is fixed at the press, so a key released mid-drag cannot change
   what is being drawn.

   Two ways to draw, and the hand picks without being asked: hold the button and
   the shape follows the drag, or click once and it follows the bare pointer
   until a second click ends it. The second suits a long outline, and costs
   nothing to offer, since a press that goes nowhere was never a drag.
   `drag.sticky` says which is under way.

   The pointer is captured for the held kind, so a drag leaving the map keeps
   reporting. While a shape tool is armed Leaflet's dragging is off (setMode),
   so one finger draws rather than pans; two still pinch. */
let drag = null;   // { tool, op, pointerId, from, points, layer, ring, closing, sticky }

// Add joins the shape to the area, Subtract crops it back out. Read at the
// press and kept in `drag`, so switching mid-gesture cannot change the answer.
const drawOp = () => ($('op-subtract').checked ? 'subtract' : 'add');

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

// Viewport coordinates in, Leaflet's map-relative ones out.
function pointerLatLng(ev) {
  const box = mapEl.getBoundingClientRect();
  return map.containerPointToLatLng(
    L.point(ev.clientX - box.left, ev.clientY - box.top));
}

mapEl.addEventListener('pointerdown', (ev) => {
  // A mouse draws with the left button; the other two are the pan grip below.
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  // Already following the pointer from an earlier click, so this press starts
  // the click that ends it. Finished at the release, not here, so pressing and
  // dragging from here still adjusts it first.
  if (drag && drag.sticky) {
    ev.preventDefault();
    drag.pointerId = ev.pointerId;
    return;
  }
  // A second finger mid-drag is a pinch, not a second zone.
  if (drag) return;
  if (ev.target.closest('.leaflet-control')) return;
  const tool = activeTool(ev);
  if (!tool) return;

  ev.preventDefault();
  // Captured, so the gesture still arrives here if it wanders off the map.
  try { mapEl.setPointerCapture(ev.pointerId); } catch (err) { /* pointer gone */ }

  const at = pointerLatLng(ev);
  const op = drawOp();
  drag = { tool, op, pointerId: ev.pointerId, from: at, points: [at],
           layer: null, ring: null, closing: false, sticky: false };

  if (tool === 'rect') {
    drag.layer = L.rectangle(L.latLngBounds(at, at), DRAFT_STYLE(op));
  } else if (tool === 'circle') {
    drag.layer = L.circle(at, { radius: 1, ...DRAFT_STYLE(op) });
  } else {
    drag.layer = L.polyline([at], DRAFT_STYLE(op));
    // A ring showing where to finish. Without it the shape closes with a
    // straight line from wherever you stopped - a spike across the map.
    drag.ring = L.circleMarker(at, {
      radius: SNAP_PX, color: opColor(op), weight: 1.5,
      dashArray: '4,3', fillOpacity: 0.06, interactive: false,
    }).addTo(map);
  }
  drag.layer.addTo(map);
});

mapEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  if (tempPan) return;            // frozen under the pan grip; see below
  const at = pointerLatLng(ev);
  if (drag.tool === 'rect') {
    drag.layer.setBounds(L.latLngBounds(drag.from, at));
  } else if (drag.tool === 'circle') {
    drag.layer.setRadius(drag.from.distanceTo(at));
  } else {
    // Sampled: a slow hand emits hundreds of points a second, and the outline
    // is smoothed at the end anyway.
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
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const at = pointerLatLng(ev);
  // Let go having gone nowhere: that was a click, not a drag. Hand the shape to
  // the bare pointer rather than finish it here too small to keep.
  if (!drag.sticky && pixelGap(drag.from, at) < MIN_DRAG_PX) {
    drag.sticky = true;
    return;
  }
  finishDrag(at);
});
// The system took the gesture away: a phone call, a system gesture, a pinch.
mapEl.addEventListener('pointercancel', (ev) => {
  if (drag && ev.pointerId === drag.pointerId) finishDrag(null);
});

// A press off the map while a shape follows the pointer drops the shape: there
// is nothing out there to finish it with.
document.addEventListener('pointerdown', (ev) => {
  if (drag && drag.sticky && !mapEl.contains(ev.target)) finishDrag(null);
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

function finishDrag(latlng) {
  if (!drag) return;
  const { tool, op, from, points, closing } = drag;
  discardDraft();
  if (!latlng) return;      // cancelled: Escape, or the gesture was taken away

  if (tool === 'rect') {
    const bounds = L.latLngBounds(from, latlng);
    if (pixelGap(bounds.getNorthWest(), bounds.getSouthEast()) < MIN_DRAG_PX) return;
    applyShape({
      type: 'rect',
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    }, op);
  } else if (tool === 'circle') {
    // Half the rectangle's threshold: this is a radius, not a diagonal.
    if (pixelGap(from, latlng) < MIN_DRAG_PX / 2) return;
    applyShape({
      type: 'circle',
      lat: from.lat, lon: from.lng, radius_m: from.distanceTo(latlng),
    }, op);
  } else {
    // Released inside the ring: close on the start point exactly, not on
    // wherever the pointer drifted to inside it.
    const raw = closing ? points : points.concat([latlng]);
    const outline = simplifyOutline(raw);
    if (outline.length < 3) return;
    applyShape({ type: 'freehand', points: outline.map((p) => [p.lat, p.lng]) }, op);
  }
}

function simplifyOutline(latlngs) {
  // In screen pixels, where the wobble is: 3 px drops hand tremor and keeps
  // every deliberate turn, at any zoom.
  const pts = latlngs.map((p) => map.latLngToContainerPoint(p));
  return L.LineUtil.simplify(pts, FREEHAND_SIMPLIFY_PX)
    .map((p) => map.containerPointToLatLng(p));
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') finishDrag(null);
});

// A click on the map places the start pin and nothing else. What the legend has
// picked is let go in the legend, by choosing All sessions.
map.on('click', (ev) => {
  if (state.mode !== 'pin') return;
  setStart(ev.latlng);
  setMode(state.lastShape);
});

/* --------------------------------------------------- temporary pan grip */
/* Middle or right button pans whatever tool is armed and hands it back on
   release, with the Pan button lit while it lasts. Done by hand because
   Leaflet's drag handler answers to the left button only, which the draw tools
   need.

   A half-drawn zone is frozen for the pan rather than thrown away, so a long
   outline can be walked across the map a screenful at a time. It costs nothing
   to hold: the draft is a list of latitudes and longitudes, so it rides along
   under the map on its own. Pointer moves are dropped while the grip is held,
   and a pan drag keeps the same ground under the cursor, so the pen picks up
   exactly where it was put down. */
const PAN_BUTTONS = new Set([1, 2]);
let tempPan = null;

mapEl.addEventListener('mousedown', (ev) => {
  if (tempPan || !PAN_BUTTONS.has(ev.button)) return;
  if (ev.target.closest('.leaflet-control')) return;
  ev.preventDefault();
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
/* Zones merge as they are drawn: overlapping ones become one outline, and one
   drawn across a gap joins both. Zones touching nothing stay separate regions
   of the same area, computed as one job.

   Subtract crops instead: the shape is cut out of what is there, which may open
   a hole, split one region into two, or clear the map entirely.

   `state.regions` is a GeoJSON-style MultiPolygon in [lon, lat]: one entry per
   region, each an outline followed by any holes. */
function applyShape(shape, op) {
  const poly = [shapeRing(shape)];
  let next;
  try {
    if (op === 'subtract') {
      next = state.regions.length
        ? polygonClipping.difference(state.regions, poly) : [];
    } else {
      // Unioning a lone polygon with itself is not a no-op: it also resolves a
      // freehand outline that crossed itself.
      next = state.regions.length
        ? polygonClipping.union(state.regions, poly)
        : polygonClipping.union(poly);
    }
  } catch (err) {
    // Boolean ops can fail on a pathological outline. An unmerged zone beats
    // losing the drag, and everything downstream copes with overlap - but a cut
    // has no such fallback, so it leaves the area exactly as it was.
    console.warn('could not apply that zone', err);
    if (op === 'subtract') return;
    next = state.regions.concat([poly]);
  }
  state.regions = next;
  drawRegions();
  clearRoute();
  syncZones();
}

// Clear means start over: zones, route and start pin all go.
function clearZones() {
  state.regions = [];
  drawRegions();
  clearRoute();
  clearStart();
  hideMapAlert();
  syncZones();
}

function drawRegions() {
  for (const layer of state.regionLayers) map.removeLayer(layer);
  // Leaflet reads rings as outline first then holes, the same order
  // polygon-clipping produces, so a merged hole draws as a hole.
  state.regionLayers = state.regions.map((rings) =>
    L.polygon(rings.map((ring) => ring.map(([x, y]) => [y, x])), AREA_STYLE())
      .addTo(map));
}

// A drawn shape as one closed ring of [lon, lat].
function shapeRing(shape) {
  let ring;
  if (shape.type === 'rect') {
    ring = [[shape.west, shape.south], [shape.east, shape.south],
            [shape.east, shape.north], [shape.west, shape.north]];
  } else if (shape.type === 'circle') {
    // The same ellipse-in-degrees the pipeline builds, so what is merged is
    // what the router treats as required.
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

// Matches area.js, so the circle drawn, merged and covered are one polygon.
const CIRCLE_SEGMENTS = 64;
const EARTH_R = 6_371_008.8;

// The merged area, as the pipeline's payload.
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
  // Now, not on the debounce: the exact figure costs a fraction of a
  // millisecond and a placeholder flickering for 200 ms is worse than none.
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
  // There is nothing to cut into on an empty map, and a red draft that quietly
  // did nothing would read as a bug. Cutting the last zone away hands the
  // selector back to Add on its own, so it is never left armed over nothing.
  const empty = !state.regions.length;
  $('op-subtract').disabled = empty;
  if (empty) $('op-add').checked = true;
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
  // A shape tool owns the drag, which is what lets one finger draw on a touch
  // screen. So does the start pin: with Leaflet's handler live, an unsteady
  // hand panned the map out from under the click instead of dropping the pin.
  // The middle and right buttons still pan and the wheel still zooms.
  const ownsDrag = drawing || mode === 'pin';
  if (ownsDrag) map.dragging.disable(); else map.dragging.enable();
}

for (const [key, id] of Object.entries(TOOL_BUTTONS)) {
  $(id).onclick = () => setMode(key);
}
setMode('rect');

// Clear throws away an outline that took a steady hand and a route that took a
// download and a solve, and nothing here undoes it, so it asks first.
$('clear-zones').onclick = () => {
  showMapAlert('Clear the drawn zones, the start pin and the computed route?',
    { accept: clearZones });
};

// Google's /@lat,lon,zoomz form, so the other map opens on what is on this one.
$('open-gmaps').onclick = () => {
  const { lat, lng } = map.getCenter();
  window.open(
    `https://www.google.com/maps/@${lat.toFixed(6)},${lng.toFixed(6)},${map.getZoom()}z`,
    '_blank', 'noopener',
  );
};

/* ----------------------------------------------------------- place search */
// OpenStreetMap's own geocoder: free, no key, asked once per submit rather than
// per keystroke, which is what its usage policy expects.
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
      showMapAlert(`No place found for "${query}".`);
      return;
    }
    const hit = hits[0];
    const box = hit.boundingbox;    // [south, north, west, east], as strings
    if (box && box.length === 4) {
      // Capped: the box around a single address is metres wide, and zoom 19
      // loses all sense of where you are.
      map.fitBounds([[+box[0], +box[2]], [+box[1], +box[3]]],
        { padding: [24, 24], maxZoom: 16 });
    } else {
      map.setView([+hit.lat, +hit.lon], 15);
    }
    hideMapAlert();
    $('search-input').blur();
  } catch (err) {
    showMapAlert(`Place search failed: ${err.message}`);
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
$('dead-end').max = String(config.DEAD_END_MAX_M);
$('dead-end').value = String(config.DEAD_END_MIN_M);
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

// Whole metres. 0 is meaningful: drive every stub, however short.
function deadEndValue() {
  const raw = $('dead-end').value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n <= config.DEAD_END_MAX_M ? n : null;
}

const NO_SPLIT_HOURS = 24;   // one session: a session is capped at 24 h

function sessionHours() {
  // Splitting off means one session covering the whole route.
  if (!sessionEnabled()) return NO_SPLIT_HOURS;
  // Decimal hours. Comma accepted: it is the norm across much of Europe.
  const raw = $('session').value.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(raw)) return null;
  const h = parseFloat(raw);
  return Number.isFinite(h) && h >= 0.1 && h <= NO_SPLIT_HOURS ? h : null;
}

function markValid(el, ok) { el.classList.toggle('invalid', !ok); }

// Marks the offending fields, and names the first problem for whoever asks.
function validate() {
  const passes = passesValue();
  const deadEnd = deadEndValue();
  const hours = sessionHours();
  markValid($('passes'), passes !== null);
  markValid($('dead-end'), deadEnd !== null);
  markValid($('session'), !sessionEnabled() || hours !== null);
  if (passes === null) return 'Passes must be a whole number of 1 or more.';
  if (deadEnd === null) {
    return 'The shortest dead end must be a whole number of metres, '
      + `from 0 to ${config.DEAD_END_MAX_M}.`;
  }
  if (hours === null) return 'Session length must be a number of hours between 0.1 and 24.';
  return null;
}

// The drawn area, or why it cannot be used.
function areaProblem() {
  try {
    Area.fromShape(shapePayload()).validate(config.AREA_CAP_KM2);
    return null;
  } catch (err) {
    return err.message || 'That area cannot be used.';
  }
}

/* --------------------------------------------------------------- request */
function payload() {
  const body = {
    shape: shapePayload(),
    include_private: includePrivate(),
    dead_end_m: deadEndValue() ?? config.DEAD_END_MIN_M,
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

/* Settings and zones together, with the merged shape's exact geodesic area.
   Nothing is said out loud here - this runs on every keystroke, and a message
   per keystroke is noise. The offending field goes red; Compute says why. */
function runCheck() {
  if (!state.regions.length) return;
  validate();
  let area = null;
  try {
    area = Area.fromShape(shapePayload());
  } catch (err) { /* named on Compute */ }
  $('area-info').textContent = area
    ? areaText(area.areaKm2(), state.regions.length)
    : '--';
  // Not while a job is running, or changing a setting mid-compute would arm the
  // button for a second one.
  $('compute').disabled = state.ticker !== null;
}

['passes', 'dead-end', 'session', 'dir-oneway', 'dir-both', 'session-enabled',
 'private-roads'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (id === 'session-enabled') syncSessionField();
    scheduleCheck();
  });
  $(id).addEventListener('input', scheduleCheck);
});

/* --------------------------------------------------------------- compute */
// In a worker, so the page stays responsive. The version in the URL is load
// bearing: browsers cache a module worker's script graph hard, and Firefox will
// keep running the old pipeline through an ordinary reload without it.
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
    showMapAlert(friendlyError(msg.message));
  }
};

worker.onerror = (ev) => {
  finishJob();
  showMapAlert('The compute worker failed to start. Serve this folder over http(s): '
    + 'browsers refuse to run workers from a file:// page.');
  console.error(ev);
};

$('compute').onclick = () => {
  if (!state.regions.length) return;
  const problem = validate() || areaProblem();
  if (problem) { showMapAlert(problem); return; }

  hideMapAlert();
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
  // No natural granularity for these two, so a moving bar rather than a lie.
  const indeterminate = p.phase === 'balance' || p.phase === 'fetch';
  fill.classList.toggle('indeterminate', indeterminate);
  fill.style.width = indeterminate ? '' : `${Math.round((p.fraction || 0) * 100)}%`;
  const elapsed = (performance.now() - state.started) / 1000;
  const secs = elapsed >= 1 ? ` · ${elapsed.toFixed(0)}s` : '';
  box.querySelector('.progress-text').textContent = `${p.message || p.phase}${secs}`;
}

function hideProgress() { $('progress').classList.add('hidden'); }

/* ------------------------------------------------------ save and reload */
/* What goes in the zip's metadata.json. Three blocks, one per restore step:
   drawn geometry, form, computed route. Kept apart from the worker's request
   payload, which is shaped for the solver - reversing those conversions on the
   way back in is a second chance to get them wrong.

   `format` is checked on load and refused if unknown, so a later change cannot
   half-load into a page that looks right and is not. */
const METADATA_FORMAT = 1;

function routeMetadata(res) {
  return {
    format: METADATA_FORMAT,
    generator: 'Routile',
    saved: new Date().toISOString(),
    // Not enforced on load - an old route still draws as it drew then.
    // Recorded so a puzzling old file can be placed.
    algoVersion: config.ALGO_VERSION,
    view: {
      regions: state.regions,
      start: state.startLatLng
        ? { lat: state.startLatLng.lat, lon: state.startLatLng.lng }
        : null,
    },
    form: {
      bothDirections: bothDirections(),
      includePrivate: includePrivate(),
      deadEndM: deadEndValue() ?? config.DEAD_END_MIN_M,
      passes: passesValue() || 1,
      splitSessions: sessionEnabled(),
      sessionHours: sessionHours() || NO_SPLIT_HOURS,
    },
    result: res,
  };
}

// Enough that a wrong or damaged file is refused with a sentence rather than
// half-applied. Not a schema: this reads files this page wrote, so it catches
// honest mistakes, not hostile ones.
function checkMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('metadata.json is not readable.');
  if (meta.format !== METADATA_FORMAT) {
    throw new Error(`This file is in format ${meta.format ?? '?'}, and this `
      + `version of Routile reads format ${METADATA_FORMAT}.`);
  }
  const res = meta.result;
  if (!res || !Array.isArray(res.sessions) || !Array.isArray(res.track)) {
    throw new Error('metadata.json has no route in it.');
  }
  if (!res.sessions.length || res.track.length < 2) {
    throw new Error('The route in this file is empty.');
  }
  if (!Array.isArray(meta.view?.regions)) throw new Error('The drawn area is missing.');
  return meta;
}

/* Put the page back as it was when the zip was made. Deliberately no compute:
   the result travelled with the file, so this is instant, works offline, and
   gives exactly the route that was downloaded rather than what the same
   request would produce from today's map data. */
function restoreRoute(meta) {
  const { view, form, result } = meta;

  clearRoute();
  state.regions = view.regions;
  drawRegions();

  if (view.start) setStart(L.latLng(view.start.lat, view.start.lon));
  else clearStart();

  $(form.bothDirections ? 'dir-both' : 'dir-oneway').checked = true;
  $('private-roads').checked = !!form.includePrivate;
  // Clamped: a hand-edited file must not put the form into a state its own
  // validation would reject.
  $('passes').value = String(
    Math.min(Math.max(Math.round(form.passes) || 1, 1), config.PASSES_MAX));
  // Absent in files written before the setting existed, so fall back to today's
  // default rather than leaving whatever the form happened to be showing.
  const deadEnd = Math.round(Number(form.deadEndM));
  $('dead-end').value = String(Number.isFinite(deadEnd) && deadEnd >= 0
    ? Math.min(deadEnd, config.DEAD_END_MAX_M)
    : config.DEAD_END_MIN_M);
  $('session-enabled').checked = !!form.splitSessions;
  const hours = Number(form.sessionHours);
  if (Number.isFinite(hours) && hours >= 0.1 && hours <= NO_SPLIT_HOURS) {
    $('session').value = String(hours);
  }
  syncSessionField();

  syncZones();                 // area figure, and the Compute button
  state.result = result;
  renderResult(result);
  drawSessions(result, result.track || []);
  hideMapAlert();
}

// The zip this page downloads, read back in.
async function loadRouteZip(file) {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error(/\.gpx$/i.test(file.name)
      ? 'A .gpx file holds the track but none of the settings behind it. '
        + 'Drop the whole .zip instead.'
      : 'That is not a Routile .zip.');
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    throw new Error('That file could not be opened as a zip.');
  }
  const entry = zip.file('metadata.json');
  if (!entry) throw new Error('No metadata.json in this zip.');
  let meta;
  try {
    meta = JSON.parse(await entry.async('string'));
  } catch (err) {
    throw new Error('The metadata.json in this zip is damaged.');
  }
  restoreRoute(checkMetadata(meta));
}

const dropzone = $('dropzone');

async function acceptFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  // One route per zip, so a multiple selection takes the first zip in it.
  const file = list.find((f) => /\.zip$/i.test(f.name)) || list[0];
  dropzone.classList.add('busy');
  try {
    await loadRouteZip(file);
  } catch (err) {
    showMapAlert(err.message);
  } finally {
    dropzone.classList.remove('busy');
  }
}

// Refusing a file is worth interrupting for: you dropped something and nothing
// happened, and a line at the foot of the panel is easy to miss.
//
// The same box asks before anything destructive: pass `accept` and it grows a
// Cancel button, renames the other one, and runs the callback only if that one
// is pressed. Cancel takes the focus, so a stray Enter backs out rather than
// going through with it.
function showMapAlert(msg, { accept = null } = {}) {
  $('map-alert-text').textContent = msg;
  state.confirm = accept;
  $('map-alert-close').textContent = accept ? 'Accept' : 'Dismiss';
  $('map-alert-cancel').classList.toggle('hidden', !accept);
  $('map-scrim').classList.remove('hidden');
  $('map-alert').classList.remove('hidden');
  $(accept ? 'map-alert-cancel' : 'map-alert-close').focus();
}

// Dismissing, cancelling, clicking the dark and Escape are the same answer: no.
function hideMapAlert() {
  state.confirm = null;
  $('map-alert').classList.add('hidden');
  $('map-scrim').classList.add('hidden');
}

$('map-alert-close').addEventListener('click', () => {
  const accept = state.confirm;
  hideMapAlert();
  if (accept) accept();
});
$('map-alert-cancel').addEventListener('click', hideMapAlert);
$('map-scrim').addEventListener('click', hideMapAlert);
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  hideMapAlert();
  hideTip();
});

/* --------------------------------------------------------------- info tips */
/* One bubble, moved to whichever marker is asking. Fixed and clamped to the
   window, because the panel is 388px wide and a bubble anchored inside it would
   otherwise run off the edge. Delegated, because the summary tiles - and the
   marker in one of them - are rebuilt on every result. */
const tipBubble = $('tip');
let tipFor = null;

function showTip(marker) {
  if (tipFor === marker) return;      // moving within the marker, not onto it
  hideTip();
  tipFor = marker;
  // The bubble is the label's description only while it is the one showing.
  marker.setAttribute('aria-describedby', 'tip');
  tipBubble.textContent = marker.dataset.tip || '';
  tipBubble.classList.remove('hidden');
  const at = marker.getBoundingClientRect();
  const box = tipBubble.getBoundingClientRect();
  const gap = 8, edge = 10;
  const left = Math.min(Math.max(at.left + at.width / 2 - box.width / 2, edge),
                        window.innerWidth - box.width - edge);
  // Below unless that would go off the bottom, in which case above.
  const below = at.bottom + gap;
  const top = below + box.height + edge > window.innerHeight
    ? Math.max(at.top - box.height - gap, edge)
    : below;
  tipBubble.style.left = `${Math.round(left)}px`;
  tipBubble.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (tipFor) tipFor.removeAttribute('aria-describedby');
  tipFor = null;
  tipBubble.classList.add('hidden');
}

const markerAt = (target) =>
  (target instanceof Element ? target.closest('.info') : null);

// Left the marker, rather than crossed from its padding onto its own glyph.
const leaving = (ev) => {
  const marker = markerAt(ev.target);
  return marker && !marker.contains(ev.relatedTarget);
};

document.addEventListener('mouseover', (ev) => {
  const marker = markerAt(ev.target);
  if (marker) showTip(marker);
});
document.addEventListener('mouseout', (ev) => {
  if (leaving(ev)) hideTip();
});
// Keyboard, and a tap on a touch screen: the marker takes focus either way.
document.addEventListener('focusin', (ev) => {
  const marker = markerAt(ev.target);
  if (marker) showTip(marker);
});
document.addEventListener('focusout', (ev) => {
  if (leaving(ev)) hideTip();
});
/* A touch screen has no hover, so the tap itself shows the note and the next
   tap anywhere dismisses it. Defaulted away because the marker sits inside its
   <label>, which would otherwise take the tap into the field. */
document.addEventListener('click', (ev) => {
  const marker = markerAt(ev.target);
  if (!marker) { hideTip(); return; }
  ev.preventDefault();
  showTip(marker);
});
// The bubble is fixed, so anything that moves the page leaves it behind.
window.addEventListener('scroll', hideTip, true);
window.addEventListener('resize', hideTip);

dropzone.addEventListener('click', () => $('load-file').click());
dropzone.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    $('load-file').click();
  }
});
$('load-file').addEventListener('change', (ev) => {
  acceptFiles(ev.target.files);
  ev.target.value = '';        // so the same file can be picked twice running
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'dragend']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dropzone.classList.remove('over');
  acceptFiles(ev.dataTransfer.files);
});

// A file dropped elsewhere would be opened by the browser, navigating away from
// a page that may have a route in it.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (ev) => {
    if (!dropzone.contains(ev.target)) ev.preventDefault();
  });
}

/* ---------------------------------------------------------------- render */
const DRIVING_TIP = 'Estimated from speed limits; the real drive takes longer.';

// The same marker index.html writes by hand, for the tiles built here.
const infoMarker = (tip) =>
  '<button type="button" class="info" aria-label="What this estimate means"'
  + ` data-tip="${escapeHtml(tip)}"><svg viewBox="0 0 24 24" aria-hidden="true">`
  + '<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 1 0 0-19z'
  + 'M12 6.9a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 1 0 0-2.6z'
  + 'M10.85 12.35a1.15 1.15 0 0 1 2.3 0v3.5a1.15 1.15 0 0 1-2.3 0z"/></svg></button>';

function renderResult(res) {
  $('stats-card').classList.remove('hidden');

  const st = res.stats;
  const cov = res.coverage;
  const sessions = res.sessions;
  $('summary').innerHTML = [
    ['Distance', `${st.total_km} km`],
    ['Driving', st.duration, DRIVING_TIP],
    ['Sessions', sessions.length],
    ['Roads covered', `${cov.centerline_km_covered} km`],
    ['Coverage', `${cov.coverage_pct}%`],
    ['Roads in area', `${cov.centerline_km_in_area} km`],
    ['Unreachable', `${cov.km_dropped_not_strongly_connected} km`],
    ['Fragments', Math.max(cov.strong_components - 1, 0)],
  ].map(([label, value, tip]) =>
    `<div class="tile"><span class="tile-label">${label}${tip ? infoMarker(tip) : ''}</span>`
    + `<span class="tile-value">${escapeHtml(String(value))}</span></div>`
  ).join('');

  // One button, one zip. GPX one per session, because an 80,000-point track is
  // more than most nav apps take, plus metadata.json either way.
  const many = sessions.length > 1;
  $('download').textContent = many
    ? `Download ${sessions.length} sessions (.zip)`
    : 'Download route (.zip)';
  $('download-note').textContent =
    'Open the downloaded .gpx file(s) in OsmAnd or any other similar mobile app. '
    + 'Downloaded ZIP file also contains metadata.json, which is necessary to '
    + 'load this export back to Routile.';
}

$('download').onclick = async () => {
  const res = state.result;
  if (!res) return;
  const button = $('download');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';
  try {
    // One moment for the whole package: zip name, GPX names and `saved` agree.
    const meta = routeMetadata(res);
    const stamp = fileStamp(new Date(meta.saved));
    const blob = await gpxZip(res, { metadata: meta, stamp });
    const kind = res.sessions.length > 1 ? 'sessions' : 'route';
    saveBlob(blob, `routile-${kind}-${stamp}.zip`);
  } catch (err) {
    showMapAlert(`Could not build the file: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

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
// `arc_start` maps a tour arc to where it begins in the breadcrumb, and each
// session knows its arcs. Slicing there rather than by distance keeps every
// session's line joined to the next exactly.
function sessionSlice(res, track, session) {
  const starts = res.arc_start || [];
  if (!starts.length || !session.arc_span) return null;
  const at = (arc) => starts[Math.min(Math.max(arc, 0), starts.length - 1)];
  const from = at(session.arc_span[0]);
  const to = at(session.arc_span[1]);
  return to > from ? track.slice(from, to + 1) : null;
}

/* Shift every point right of the direction of travel, the way a map draws a
   dual carriageway. Without it a street driven both ways is two lines on top of
   each other, indistinguishable from one driven once. Falls out of the
   geometry, so it needs no extra data and works for three passes as for two.

   A fixed distance on the ground, not in pixels, so it stays a real
   half-carriageway: invisible zoomed out, clear zoomed in. */
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
    // interactive:false: a route line is drawn output, not a control. Sessions
    // are hovered and picked in the legend, so a line under the pointer must
    // not catch a click meant for the map.
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

// Every arrow a session needs, worked out once when its line is drawn: one per
// ARROW_SPACING_M with its heading, after which "on screen?" is a bounds test.
// Spacing does not depend on the viewport, so redoing it per pan - hundreds of
// thousands of distance calculations on a 400 km route - was wasted.
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

// null is the whole route, which is what the All sessions row stands for.
function sessionOf(item) {
  return item.dataset.session === 'all' ? null : Number(item.dataset.session);
}

function legendRow(key, color, name, km, minutes) {
  // The stripe is on every row, colourless on All sessions, so each label in
  // the list starts at the same place.
  return `<button type="button" class="legend-item${color ? '' : ' legend-all'}"`
    + ` data-session="${key}" role="listitem">`
    + `<span class="stripe"${color ? ` style="background:${color}"` : ''}></span>`
    + '<span class="legend-text">'
    + `<span class="legend-name">${name}</span>`
    + `<span class="legend-meta">${Number(km).toFixed(1)} km · ${humanMinutes(minutes)}</span>`
    + '</span></button>';
}

function buildLegend(sessions) {
  const box = $('legend');
  const rows = sessions.map((session, i) =>
    legendRow(i, sessionColor(i), `Session ${i + 1}`, session.km, session.minutes));
  // Totalled from the rows it sits above, so the sums agree with the list. One
  // session is already its own whole route, so the row would only repeat it.
  if (sessions.length > 1) {
    const sum = (field) => sessions.reduce((s, x) => s + (Number(x[field]) || 0), 0);
    rows.unshift(legendRow('all', null, 'All sessions', sum('km'), sum('minutes')));
  }
  box.innerHTML = rows.join('');
  box.classList.toggle('hidden', sessions.length === 0);
  layoutOverlays();

  for (const item of box.querySelectorAll('.legend-item')) {
    const i = sessionOf(item);
    item.addEventListener('mouseenter', () => preview(i));
    item.addEventListener('mouseleave', () => endPreview());
    item.addEventListener('focus', () => preview(i));
    item.addEventListener('blur', () => endPreview());
    item.addEventListener('click', () => pin(i));
  }
  pin(state.pinned);      // a fresh route starts on All sessions
}

/* The top bar floats centred over the map with the session list beside it, and
   gives way in three cumulative steps as the window narrows: tools drop their
   labels, the bar slides left out of the centre, then the panel stacks above
   the map and hands it 388px. Nothing ever leaves the map.

   Measured, not guessed from a breakpoint: room needed depends on the labels,
   room available on whether there are sessions to list. Each step strips the
   classes, measures the bar at its natural width, and re-adds only while it
   still does not fit.

   Cumulative on purpose - a narrower window can only take more away. Undoing a
   step at a narrower width would flicker as the window is dragged. And stacking
   is judged against the *unstacked* width, so it never measures against the
   width its own answer produced. */
const phoneLayout = window.matchMedia('(max-width: 860px)');
phoneLayout.addEventListener('change', () => layoutOverlays());

function layoutOverlays() {
  const stage = $('stage');
  const root = document.documentElement;
  stage.classList.remove('tools-tight', 'tools-left', 'find-above');
  root.classList.remove('app-stacked');
  putFinderInBar();

  // Below the breakpoint the stacked shape is right whatever the bar fits into.
  if (phoneLayout.matches) {
    stage.classList.add('tools-tight', 'tools-left');
    root.classList.add('app-stacked');
  } else {
    if (barIsCrowded()) stage.classList.add('tools-tight');
    if (barIsCrowded()) stage.classList.add('tools-left');
    if (barIsCrowded()) root.classList.add('app-stacked');
  }

  // Last resort, reachable only once stacked: the bar is clamped to the stage
  // by then and the search box has a width floor, so anything left overflows.
  // Picker and search step out above the map; the tools keep the floating bar.
  if (barOverflows()) {
    stage.classList.add('find-above');
    stage.insertBefore($('findbar'), $('map'));
    // What the bar and the sessions, positioned against the stage, clear it by.
    stage.style.setProperty('--find-strip', `${$('findbar').offsetHeight}px`);
  }
}

// The finder's home is the tail of the floating bar. Put back before every
// measurement, so what is measured is always the whole bar.
function putFinderInBar() {
  const bar = $('topbar');
  if ($('findbar').parentElement !== bar) bar.appendChild($('findbar'));
  $('stage').style.removeProperty('--find-strip');
}

// True only of a clamped bar that still wants room: a floating one is sized to
// its content and cannot overflow itself.
function barOverflows() {
  const bar = $('topbar');
  return bar.scrollWidth > bar.clientWidth + 1;
}

// Does the bar, where it currently sits, clear both stage edges and the
// session list on its right?
function barIsCrowded() {
  const stage = $('stage').getBoundingClientRect();
  const bar = $('topbar').getBoundingClientRect();
  const clear = 10;
  if (bar.width > stage.width - 2 * clear) return true;
  const legend = $('legend');
  if (legend.classList.contains('hidden')) return false;
  return bar.right + clear > legend.getBoundingClientRect().left;
}

/* Two layers of one highlight, both driven from the legend. The pointer or the
   keyboard previews a row; a click pins it, so it survives the pointer leaving.
   Only All sessions puts the whole route back. */
const preview = (index) => applyHighlight(index, { scroll: false });

// The pointer left the legend, so whatever is pinned shows again.
const endPreview = () => applyHighlight(state.pinned);

function pin(index) {
  state.pinned = index;
  applyHighlight(index);
  for (const item of $('legend').querySelectorAll('.legend-item')) {
    item.classList.toggle('pinned', sessionOf(item) === index);
  }
}

// Highlighting leaves a session exactly as drawn and takes the others off the
// map, so what is left is that one leg on its own.
function applyHighlight(index, { scroll = true } = {}) {
  state.shown = index;
  state.routeLayers.forEach((line, i) => {
    if (!line) return;
    const hidden = index !== null && i !== index;
    line.setStyle({ opacity: hidden ? 0 : 0.85 });
    if (i === index) line.bringToFront();
  });

  state.detail.setHighlight(index);

  for (const item of $('legend').querySelectorAll('.legend-item')) {
    const hot = sessionOf(item) === index;
    item.classList.toggle('active', hot);
    // Keep the row visible when the legend has scrolled past it.
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
  state.shown = null;
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
