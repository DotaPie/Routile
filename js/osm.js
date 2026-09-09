/* Fetch the drivable network from Overpass, build the road graph, mark which
   arcs must be driven, and account for everything dropped along the way.

   The graph construction follows what OSMnx does for a `drive` network, step
   for step, because the routing behaviour downstream was tuned against it:

   1. Download every drivable way touching the box plus a 500 m margin.
   2. One directed edge per node pair per way; two-way roads get both.
   3. Trim to the margin box, keeping an outside node only if it has a
      neighbour inside, so boundary streets stay in one piece.
   4. Merge interstitial nodes - a junction of exactly two roads with matching
      directions is just a bend - so an arc is a whole street between two
      real junctions, with its geometry kept.
   5. Trim to the box proper. Simplifying *before* this trim is what keeps a
      junction just outside the box a junction, rather than a bend.
   6. Impute a speed for every arc from its maxspeed tag, else the mean of its
      road type, else the mean over all types.

   The accounting is a feature, not diagnostics. A one-way street clipped by
   the fetch boundary can belong to no strongly connected component at all, so
   it is *deleted* rather than balanced. Without reporting that delta a user
   drives the route, finds missing streets and concludes the tool is broken. So
   we measure it and say so. */

import * as config from './config.js';
import { geomLengthDeg, geomLengthM, haversineM, insideLengthDeg, pointInPolygon, ringBounds } from './geo.js';
import { Graph, stronglyConnectedComponents, weakComponents } from './graph.js';

export class FetchError extends Error {}
export class NoRoadsError extends Error {}

/* Which ways to ask OpenStreetMap for: OSMnx's "drive" filter, the public
   streets a car may use.

   `includePrivate` relaxes the access rules. Left off, the query skips ways
   tagged access=private and the service roads that are nearly always the same
   thing: driveways, alleys, parking aisles and yards. Turned on, all of those
   come back, which is what you want for an industrial estate or a gated
   development and not what you want for a sweep of the public streets. */
const HIGHWAY_NOT_DRIVEN =
  'abandoned|bridleway|bus_guideway|busway|construction|corridor|cycleway|elevator|'
  + 'escalator|footway|path|pedestrian|planned|platform|proposed|raceway|razed|steps|track';
const SERVICE_PRIVATE = 'alley|driveway|emergency_access|parking|parking_aisle|private';

export function roadFilter({ includePrivate = false } = {}) {
  const parts = ['["highway"]', '["area"!~"yes"]'];
  if (!includePrivate) parts.push('["access"!~"private"]');
  parts.push(`["highway"!~"${includePrivate ? HIGHWAY_NOT_DRIVEN : HIGHWAY_NOT_DRIVEN + '|service'}"]`);
  parts.push('["motor_vehicle"!~"no"]', '["motorcar"!~"no"]');
  if (!includePrivate) parts.push(`["service"!~"${SERVICE_PRIVATE}"]`);
  return parts.join('');
}

/* Two queries asking for different roads must not share one cached download. */
export const profileKey = ({ includePrivate = false } = {}) =>
  (includePrivate ? 'drive+private' : 'drive');

const ONEWAY_VALUES = new Set(['yes', 'true', '1', '-1', 'reverse', 'T', 'F']);
const REVERSED_VALUES = new Set(['-1', 'reverse', 'T']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- fetching */
export function overpassQuery(box, profile) {
  const bbox = `${box.bottom},${box.left},${box.top},${box.right}`;
  return `[out:json][timeout:${config.OVERPASS_QUERY_TIMEOUT_S}];(way${roadFilter(profile)}(${bbox});>;);out;`;
}

async function postQuery(endpoint, query) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), config.OVERPASS_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: control.signal,
    });
    if (!res.ok) throw new Error(`Overpass answered HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* The raw Overpass elements for a box, cached, retried across endpoints.

   A failure here is by far the most likely way for the whole pipeline to
   fail - Overpass is a free shared service that regularly refuses connections -
   so it gets a message a user can act on. */
export async function fetchOverpass(box, { profile, cache = null, progress = null } = {}) {
  const key = `${box.key()}|${profileKey(profile)}`;
  const hit = cache ? await cache.get('overpass', key) : null;
  if (hit) return hit;

  const query = overpassQuery(box, profile);
  let last = null;
  for (let attempt = 0; attempt < config.OVERPASS_RETRIES; attempt++) {
    const endpoint = config.OVERPASS_ENDPOINTS[attempt % config.OVERPASS_ENDPOINTS.length];
    try {
      const json = await postQuery(endpoint, query);
      if (json.remark && /error/i.test(json.remark)) throw new Error(json.remark);
      const elements = json.elements || [];
      // A genuinely empty area, not a transport problem. Retrying the same
      // query would just waste the user's time.
      if (!elements.length) throw new NoRoadsError('no roads found in this area');
      if (cache) await cache.put('overpass', key, elements);
      return elements;
    } catch (err) {
      if (err instanceof NoRoadsError) throw err;
      last = err;
      console.warn(`Overpass fetch failed on ${endpoint} (attempt ${attempt + 1}/${config.OVERPASS_RETRIES}):`, err.message);
      if (attempt + 1 < config.OVERPASS_RETRIES) {
        if (progress) progress('fetch', 'OpenStreetMap is busy - retrying');
        await sleep(config.OVERPASS_RETRY_DELAY_MS);
      }
    }
  }
  throw new FetchError(
    'Could not reach OpenStreetMap to download the roads. Its public Overpass '
    + 'service is free and often overloaded - wait a moment and try again. '
    + `(${last ? last.message : 'no response'})`,
  );
}

/* ---------------------------------------------------------- the raw graph */
/* Nodes keyed by OSM id, edges as records; only ever a few hundred thousand,
   so plain Maps and arrays are fine here. */
class RawGraph {
  constructor() {
    this.nodes = new Map();   // id -> {x, y}
    this.edges = [];          // {u, v, osmids, names, refs, highway, maxspeed, geom}
    this.out = new Map();     // id -> edge indices
    this.inn = new Map();
  }

  addEdge(edge) {
    const i = this.edges.length;
    this.edges.push(edge);
    push(this.out, edge.u, i);
    push(this.inn, edge.v, i);
  }

  outEdges(v) { return this.out.get(v) || []; }
  inEdges(v) { return this.inn.get(v) || []; }

  successors(v) {
    const seen = new Set();
    for (const e of this.outEdges(v)) seen.add(this.edges[e].v);
    return seen;
  }

  neighbours(v) {
    const seen = this.successors(v);
    for (const e of this.inEdges(v)) seen.add(this.edges[e].u);
    return seen;
  }

  firstEdge(u, v) {
    for (const e of this.outEdges(u)) if (this.edges[e].v === v) return this.edges[e];
    return null;
  }

  removeNodes(doomed) {
    if (!doomed.size) return;
    for (const id of doomed) this.nodes.delete(id);
    const kept = this.edges.filter((e) => !doomed.has(e.u) && !doomed.has(e.v));
    this.edges = [];
    this.out = new Map();
    this.inn = new Map();
    for (const e of kept) this.addEdge(e);
  }

  removeIsolated() {
    const doomed = new Set();
    for (const id of this.nodes.keys()) {
      if (!this.out.has(id) && !this.inn.has(id)) doomed.add(id);
    }
    for (const id of doomed) this.nodes.delete(id);
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

function fromElements(elements) {
  const coords = new Map();
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node') coords.set(el.id, { x: el.lon, y: el.lat });
    else if (el.type === 'way' && el.nodes) ways.push(el);
  }

  const raw = new RawGraph();
  for (const way of ways) {
    const tags = way.tags || {};
    let ids = way.nodes.filter((id) => coords.has(id));
    if (ids.length < 2) continue;
    const oneway = ONEWAY_VALUES.has(tags.oneway) || tags.junction === 'roundabout' || tags.junction === 'circular';
    if (oneway && REVERSED_VALUES.has(tags.oneway)) ids = ids.slice().reverse();
    for (const id of ids) if (!raw.nodes.has(id)) raw.nodes.set(id, coords.get(id));

    const attrs = {
      osmids: [way.id],
      names: tags.name ? [String(tags.name)] : [],
      refs: tags.ref ? [String(tags.ref)] : [],
      highway: tags.highway ?? null,
      maxspeed: tags.maxspeed ?? null,
    };
    for (let i = 1; i < ids.length; i++) raw.addEdge({ u: ids[i - 1], v: ids[i], ...attrs, geom: null });
    if (!oneway) {
      for (let i = 1; i < ids.length; i++) raw.addEdge({ u: ids[i], v: ids[i - 1], ...attrs, geom: null });
    }
  }
  return raw;
}

/* Drop nodes outside the box - unless a neighbour is inside, so a street
   crossing the boundary keeps its far end and stays one arc. */
function truncateToBox(raw, box) {
  const outside = new Set();
  for (const [id, n] of raw.nodes) if (!box.contains(n.x, n.y)) outside.add(id);
  if (outside.size === raw.nodes.size) throw new NoRoadsError('no roads found in this area');
  const doomed = new Set();
  for (const id of outside) {
    let allOutside = true;
    for (const nb of raw.neighbours(id)) if (!outside.has(nb)) { allOutside = false; break; }
    if (allOutside) doomed.add(id);
  }
  raw.removeNodes(doomed);
}

/* --------------------------------------------------------- simplification */
/* A node is a real junction (an endpoint of arcs) unless it merely joins two
   road segments end to end: exactly two neighbours, with either one lane
   through (degree 2) or two-way both sides (degree 4). */
function isEndpoint(raw, v) {
  const outE = raw.outEdges(v), inE = raw.inEdges(v);
  const neigh = raw.neighbours(v);
  if (neigh.has(v)) return true;                       // self-loop
  if (outE.length === 0 || inE.length === 0) return true;
  const d = outE.length + inE.length;
  return !(neigh.size === 2 && (d === 2 || d === 4));
}

function buildPath(raw, endpoint, endpointSuccessor, endpoints) {
  const path = [endpoint, endpointSuccessor];
  for (let successor of raw.successors(endpointSuccessor)) {
    if (path.includes(successor)) continue;
    path.push(successor);
    while (!endpoints.has(successor)) {
      const onward = [...raw.successors(successor)].filter((n) => !path.includes(n));
      if (onward.length === 1) {
        successor = onward[0];
        path.push(successor);
      } else if (onward.length === 0) {
        // The end of a self-looping path, or an OSM digitisation quirk where
        // a one-way turns two-way with duplicate incoming edges.
        if (raw.successors(successor).has(endpoint)) return [...path, endpoint];
        return path;
      } else {
        throw new Error(`impossible simplify pattern near node ${successor}`);
      }
    }
    return path;
  }
  return path;
}

function unionSorted(lists) {
  return [...new Set(lists.flat())].sort();
}

function simplify(raw) {
  const endpoints = new Set();
  for (const id of raw.nodes.keys()) if (isEndpoint(raw, id)) endpoints.add(id);

  const paths = [];
  for (const e of endpoints) {
    for (const s of raw.successors(e)) {
      if (!endpoints.has(s)) paths.push(buildPath(raw, e, s, endpoints));
    }
  }

  const doomed = new Set();
  for (const path of paths) {
    const segs = [];
    for (let i = 1; i < path.length; i++) {
      const edge = raw.firstEdge(path[i - 1], path[i]);
      if (edge) segs.push(edge);
    }
    if (!segs.length) continue;
    const geom = new Float64Array(path.length * 2);
    path.forEach((id, i) => { const n = raw.nodes.get(id); geom[2 * i] = n.x; geom[2 * i + 1] = n.y; });
    const speeds = new Set(segs.map((s) => s.maxspeed));
    raw.addEdge({
      u: path[0], v: path[path.length - 1],
      osmids: unionSorted(segs.map((s) => s.osmids)),
      names: unionSorted(segs.map((s) => s.names)),
      refs: unionSorted(segs.map((s) => s.refs)),
      highway: segs[0].highway,
      // Differing limits along a merged street cannot be trusted either way;
      // let the road type decide, as OSMnx does.
      maxspeed: speeds.size === 1 ? segs[0].maxspeed : null,
      geom,
    });
    for (let i = 1; i < path.length - 1; i++) doomed.add(path[i]);
  }
  raw.removeNodes(doomed);

  // A closed loop with no junction on it - an isolated ring - was never a
  // path and never simplified. Nothing can reach it; drop it.
  const rings = ringNodes(raw, endpoints);
  raw.removeNodes(rings);
}

function ringNodes(raw, endpoints) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const id of raw.nodes.keys()) parent.set(id, id);
  for (const e of raw.edges) {
    const a = find(e.u), b = find(e.v);
    if (a !== b) parent.set(b, a);
  }
  const hasEndpoint = new Set();
  for (const id of raw.nodes.keys()) if (endpoints.has(id)) hasEndpoint.add(find(id));
  const doomed = new Set();
  for (const id of raw.nodes.keys()) if (!hasEndpoint.has(find(id))) doomed.add(id);
  return doomed;
}

/* -------------------------------------------------------------- speeds */
function parseMaxspeed(text) {
  if (!text) return null;
  const values = [];
  for (const part of String(text).split(/[|;]/)) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*(km\/h|kmh|kph|mph|knots)?\s*$/i.exec(part);
    if (!m) return null;
    let v = parseFloat(m[1].replace(',', '.'));
    if (/mph/i.test(text)) v *= 1.60934;
    values.push(v);
  }
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function assignTravelTimes(edges) {
  const parsed = edges.map((e) => parseMaxspeed(e.maxspeed));
  const byType = new Map();
  edges.forEach((e, i) => {
    if (parsed[i] === null) return;
    const acc = byType.get(e.highway) || { sum: 0, n: 0 };
    acc.sum += parsed[i]; acc.n++;
    byType.set(e.highway, acc);
  });
  const typeMean = new Map();
  for (const [h, acc] of byType) typeMean.set(h, acc.sum / acc.n);
  const means = [...typeMean.values()];
  const overall = means.length ? means.reduce((s, v) => s + v, 0) / means.length : 30;
  // Speeds and times to one decimal, as OSMnx stores them.
  edges.forEach((e, i) => {
    const kph = Math.round((parsed[i] ?? typeMean.get(e.highway) ?? overall) * 10) / 10;
    e.travel = Math.round(e.length / (kph / 3.6) * 10) / 10;
  });
}

/* ------------------------------------------------------------- assembly */
export function buildGraph(elements, fetchBox, downloadBox) {
  const raw = fromElements(elements);
  truncateToBox(raw, downloadBox);
  simplify(raw);
  truncateToBox(raw, fetchBox);
  raw.removeIsolated();

  for (const e of raw.edges) {
    if (!e.geom) {
      const a = raw.nodes.get(e.u), b = raw.nodes.get(e.v);
      e.geom = Float64Array.of(a.x, a.y, b.x, b.y);
    }
    e.length = geomLengthM(e.geom);
  }
  assignTravelTimes(raw.edges);

  const ids = [...raw.nodes.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const xs = ids.map((id) => raw.nodes.get(id).x);
  const ys = ids.map((id) => raw.nodes.get(id).y);
  const arcs = raw.edges.map((e) => ({
    u: index.get(e.u), v: index.get(e.v), length: e.length, travel: e.travel,
    geom: e.geom, osmids: e.osmids, names: e.names, refs: e.refs, highway: e.highway,
  }));
  return new Graph(ids, xs, ys, arcs);
}

/* ------------------------------------------------------ required marking */
/* Arcs with at least `minInsideM` of their length inside the drawn shape -
   the shape, not its bounding box: a circle drawn around a village must not
   drag in the roads that merely fall inside the enclosing square.

   The inside *fraction* is measured in degrees then scaled by the arc's metric
   length. Locally the degree-to-metre scale is constant, so this is accurate
   without a projection round trip. */
export function markRequired(g, area, minInsideM) {
  const regions = area.regions;
  const boxes = regions.map((rings) => ringBounds(rings[0]));
  // The box round the lot, for the cheap reject that runs against every arc.
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x0, y0, x1, y1] of boxes) {
    if (x0 < minx) minx = x0; if (x1 > maxx) maxx = x1;
    if (y0 < miny) miny = y0; if (y1 > maxy) maxy = y1;
  }

  const required = new Uint8Array(g.E);
  for (let a = 0; a < g.E; a++) {
    const geom = g.geom[a];
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    for (let i = 0; i < geom.length; i += 2) {
      if (geom[i] < gx0) gx0 = geom[i]; if (geom[i] > gx1) gx1 = geom[i];
      if (geom[i + 1] < gy0) gy0 = geom[i + 1]; if (geom[i + 1] > gy1) gy1 = geom[i + 1];
    }
    if (gx1 < minx || gx0 > maxx || gy1 < miny || gy0 > maxy) continue;

    const degTotal = geomLengthDeg(geom);
    if (degTotal <= 0) {
      if (regions.some((rings) => pointInPolygon(rings, geom[0], geom[1]))) required[a] = 1;
      continue;
    }
    // Summed across zones: the zones are merged before they get here, so they
    // never overlap, and a street running from one into the next is required on
    // the strength of both halves together.
    let degInside = 0;
    for (let k = 0; k < regions.length && degInside < degTotal; k++) {
      const [bx0, by0, bx1, by1] = boxes[k];
      if (gx1 < bx0 || gx0 > bx1 || gy1 < by0 || gy0 > by1) continue;
      degInside += insideLengthDeg(geom, regions[k], boxes[k]);
    }
    degInside = Math.min(degInside, degTotal);
    if (g.length[a] * (degInside / degTotal) >= minInsideM) required[a] = 1;
  }
  return required;
}

/* Physical road length of a set of arcs. A two-way street is two arcs over one
   strip of tarmac, so each such arc counts half. */
export function centerlineKm(g, arcs) {
  let total = 0;
  for (const a of arcs) total += g.length[a] * (g.reciprocal[a] >= 0 ? 0.5 : 1);
  return total / 1000;
}

function arcsOf(mask) {
  const list = [];
  for (let a = 0; a < mask.length; a++) if (mask[a]) list.push(a);
  return list;
}

/* ------------------------------------------------------ coverage report */
export function coverageSummary(r) {
  const pct = r.centerline_km_in_area > 0 ? 100 * r.centerline_km_covered / r.centerline_km_in_area : 0;
  let text = `covers ${pct.toFixed(1)}% of roads in the drawn area `
    + `(${r.centerline_km_covered.toFixed(1)} of ${r.centerline_km_in_area.toFixed(1)} km)`;
  if (r.km_dropped_not_strongly_connected > 0.05) {
    const fragments = Math.max(r.strong_components - 1, 0);
    text += ` - ${r.km_dropped_not_strongly_connected.toFixed(1)} km unreachable `
      + `(one-ways leaving the area, ${fragments} disconnected fragments)`;
  }
  return text;
}

export function coverageToDict(r) {
  const pct = r.centerline_km_in_area > 0 ? 100 * r.centerline_km_covered / r.centerline_km_in_area : 0;
  return {
    area_km2: round(r.area_km2, 3),
    centerline_km_in_area: round(r.centerline_km_in_area, 2),
    centerline_km_covered: round(r.centerline_km_covered, 2),
    coverage_pct: round(pct, 1),
    km_dropped_not_strongly_connected: round(r.km_dropped_not_strongly_connected, 2),
    required_arcs: r.required_arcs,
    dropped_arcs: r.dropped_arcs,
    weak_components: r.weak_components,
    strong_components: r.strong_components,
    summary: coverageSummary(r),
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/* Fetch, mark required arcs and prune to the largest strongly connected
   component. Returns { graph, required, report }. */
export async function prepare(area, { bufferM, snapDeg, minInsideM,
                                      includePrivate = false, progress = null, cache = null }) {
  const say = progress || (() => {});

  // Download the enclosing box; require only the roads inside the shape.
  const fetchBox = area.bounds.bufferM(bufferM).snapOut(snapDeg);
  const downloadBox = fetchBox.bufferM(config.DOWNLOAD_MARGIN_M);
  say('fetch', `downloading roads for ${fetchBox.areaKm2().toFixed(1)} km2`);
  const profile = { includePrivate };
  const elements = await fetchOverpass(downloadBox, { profile, cache, progress: say });
  const G = buildGraph(elements, fetchBox, downloadBox);
  console.info(`fetched ${G.N} nodes / ${G.E} arcs`);

  const report = {
    area_km2: area.areaKm2(),
    centerline_km_in_area: 0, centerline_km_covered: 0,
    km_dropped_not_strongly_connected: 0,
    required_arcs: 0, dropped_arcs: 0, weak_components: 0, strong_components: 0,
  };

  say('mark', 'identifying roads inside the drawn area');
  const requiredAll = markRequired(G, area, minInsideM);
  report.centerline_km_in_area = centerlineKm(G, arcsOf(requiredAll));
  report.weak_components = weakComponents(G, null, true).count;

  say('prune', 'checking reachability');
  const scc = stronglyConnectedComponents(G);
  report.strong_components = scc.count;
  if (!scc.count) throw new NoRoadsError('no roads found in this area');
  let largest = 0;
  for (let i = 1; i < scc.count; i++) if (scc.sizes[i] > scc.sizes[largest]) largest = i;
  const keep = new Uint8Array(G.N);
  for (let v = 0; v < G.N; v++) if (scc.comp[v] === largest) keep[v] = 1;
  const { graph: H, arcMap } = G.induced(keep);

  const required = new Uint8Array(H.E);
  const dropped = [];
  for (let a = 0; a < G.E; a++) {
    if (!requiredAll[a]) continue;
    if (arcMap[a] >= 0) required[arcMap[a]] = 1; else dropped.push(a);
  }
  const requiredArcs = arcsOf(required);
  report.required_arcs = requiredArcs.length;
  report.dropped_arcs = dropped.length;
  report.km_dropped_not_strongly_connected = centerlineKm(G, dropped);
  report.centerline_km_covered = centerlineKm(H, requiredArcs);

  if (!requiredArcs.length) {
    throw new NoRoadsError('no drivable roads inside the drawn area - try a larger area');
  }
  console.info(`required ${requiredArcs.length} arcs; ${coverageSummary(report)}`);
  return { graph: H, required, report };
}

/* Graph node closest to a point, among `candidates` (a node mask) if given.

   The route's start must be a node the tour actually visits, and plenty of
   nodes in the fetch buffer are never driven - so the caller passes the tour's
   own nodes and the pin snaps onto the drive rather than to a road beside it. */
export function nearestNode(g, lon, lat, candidates = null) {
  let best = -1, bestD = Infinity;
  for (let v = 0; v < g.N; v++) {
    if (candidates && !candidates[v]) continue;
    const d = haversineM(lon, lat, g.x[v], g.y[v]);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (best < 0) throw new Error('no nodes to snap the start point to');
  return best;
}
