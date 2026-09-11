/* End-to-end: a drawn shape in, sessions and a GPX-ready breadcrumb out.

   The result is plain JSON holding everything the UI and the GPX writer need,
   so nothing downstream keeps the road graph alive. That makes the worker
   short-lived and the result trivially cacheable. */

import * as config from './config.js';
import { Area } from './area.js';
import * as osm from './osm.js';
import * as cpp from './cpp.js';
import * as oneway from './oneway.js';
import * as turns from './turns.js';
import { eulerianCircuit, verifyCircuit } from './euler.js';
import { reduceTour } from './waypoints.js';
import { chunkWaypoints, groupSessions, verifyChunks } from './sessions.js';
import { summarise } from './stats.js';

// Ordered phases for the progress bar. The min-cost flow has no natural
// granularity, so it gets an indeterminate bar rather than a fake percentage.
export const PHASES = [
  ['fetch', 'Downloading roads'],
  ['mark', 'Finding roads in the drawn area'],
  ['prune', 'Checking reachability'],
  ['balance', 'Planning the shortest covering route'],
  ['tour', 'Ordering the drive'],
  ['waypoints', 'Working out the navigation points'],
  ['sessions', 'Splitting into sessions'],
  ['done', 'Ready'],
];

export class RequestError extends Error {}

function positiveInt(raw, what) {
  if (typeof raw === 'boolean' || !/^\s*\d+\s*$/.test(String(raw))) throw new RequestError(`${what} must be a whole number`);
  const n = parseInt(String(raw), 10);
  if (n < 1) throw new RequestError(`${what} must be 1 or more`);
  return n;
}

function positiveFloat(raw, what) {
  const n = parseFloat(String(raw).trim().replace(',', '.'));
  if (typeof raw === 'boolean' || !Number.isFinite(n)) throw new RequestError(`${what} must be a number`);
  return n;
}

// Validate the UI's payload into a request, with messages a user can act on.
export function parseRequest(payload) {
  if (!payload || typeof payload !== 'object') throw new RequestError('expected a request object');
  const area = Area.fromShape(payload.shape);
  area.validate(config.AREA_CAP_KM2);

  const passes = positiveInt(payload.passes ?? config.PASSES_DEFAULT, 'passes');
  if (passes > config.PASSES_MAX) {
    throw new RequestError(`passes is capped at ${config.PASSES_MAX} - each pass multiplies the whole drive, so more than that is almost certainly a typo`);
  }
  const sessionMinutes = positiveFloat(payload.session_minutes ?? config.SESSION_SECONDS_DEFAULT / 60, 'session length');
  if (!(sessionMinutes >= 1 && sessionMinutes <= config.MAX_SESSION_MINUTES)) {
    throw new RequestError(`session length must be between 1 and ${config.MAX_SESSION_MINUTES} minutes`);
  }
  const start = payload.start || null;
  return {
    area,
    includePrivate: Boolean(payload.include_private ?? config.INCLUDE_PRIVATE_DEFAULT),
    startLon: start && start.lon != null ? Number(start.lon) : null,
    startLat: start && start.lat != null ? Number(start.lat) : null,
    bothDirections: Boolean(payload.both_directions ?? config.BOTH_DIRECTIONS_DEFAULT),
    passes,
    sessionSeconds: sessionMinutes * 60,
    margin: config.WAYPOINT_MARGIN,
    maxLegMetres: config.WAYPOINT_MAX_LEG_M,
    maxLegArcs: config.WAYPOINT_MAX_LEG_ARCS,
  };
}

// How far outside the shape to download. A request may pin `bufferM` for
// experiments; the UI never does.
export const fetchBufferM = (req) => req.bufferM ?? config.fetchBufferM(req.area.areaKm2());

// Everything that changes the answer, for the result cache.
export function requestKey(req) {
  return JSON.stringify([
    config.ALGO_VERSION,
    req.area.bounds.bufferM(fetchBufferM(req)).snapOut(config.BBOX_SNAP_DEG).key(),
    req.area.key(),
    round6(req.startLon ?? 0), round6(req.startLat ?? 0),
    req.includePrivate,
    req.bothDirections, req.passes, req.sessionSeconds,
    req.margin, req.maxLegMetres, req.maxLegArcs,
  ]);
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function makeProgress(sink) {
  const order = PHASES.map(([k]) => k);
  const labels = new Map(PHASES);
  return (phase, message = '') => {
    const idx = order.indexOf(phase);
    const fraction = idx >= 0 ? idx / (order.length - 1) : 0;
    const text = message || labels.get(phase) || phase;
    console.info(`[${phase}] ${text}`);
    if (sink) {
      try { sink(phase, text, fraction); } catch (err) { console.warn('progress sink failed', err); }
    }
  };
}

// Run the whole pipeline and return a JSON-able result.
export async function compute(req, { progress = null, cache = null } = {}) {
  const say = makeProgress(progress);

  const net = await osm.prepare(req.area, {
    bufferM: fetchBufferM(req),
    snapDeg: config.BBOX_SNAP_DEG,
    minInsideM: config.REQUIRED_MIN_INSIDE_M,
    includePrivate: req.includePrivate,
    progress: say,
    cache,
  });
  const g = net.graph;

  // Everything to the tour runs on the turn graph, where a junction movement is
  // a priced arc. Results cross back to the road graph as soon as they are made.
  const exp = turns.expandTurns(g, { restricted: net.restricted });

  let mult, driven;
  if (req.bothDirections) {
    say('balance', 'solving the minimum-detour route (exact)');
    mult = cpp.balance(exp.graph, turns.liftMask(exp, net.required), req.passes);
    driven = net.required;
  } else {
    say('balance', 'choosing a direction for each street');
    ({ mult } = oneway.balanceOneway(exp, net.required, {
      passes: req.passes, timeBudgetS: config.ONEWAY_TIME_BUDGET_S, progress: say,
    }));
    // In one-way mode the chosen direction is only knowable from the result.
    driven = oneway.requiredForStats(g, mult, oneway.groupStreets(g, net.required));
  }
  // Turn prices steer the solver but nobody drives them, so the figures quoted
  // to the user are measured on the road graph alone.
  const roadMult = turns.projectMult(exp, mult);
  const tour = cpp.tourStats(g, roadMult, driven, req.passes);

  // Snap the start onto the tour: the nearest node overall is often one the
  // drive never reaches, and starting there would silently move the start.
  const onTour = new Uint8Array(g.N);
  for (let a = 0; a < g.E; a++) if (roadMult[a] > 0) onTour[g.tail[a]] = 1;
  const [lon, lat] = req.startLon !== null && req.startLat !== null
    ? [req.startLon, req.startLat] : req.area.center;
  const start = osm.nearestNode(g, lon, lat, onTour);

  say('tour', 'ordering the drive');
  const walk = eulerianCircuit(exp.graph, mult, turns.entryNode(exp, start, mult));
  const circuit = turns.projectCircuit(exp, walk);
  const audit = turns.turnAudit(exp, walk);
  console.info(`tour turns: ${audit.reversals} reversals onto the same tarmac, `
    + `${audit.sharp} hairpins, ${audit.restricted} forbidden by a restriction, `
    + `${audit.turnarounds} turnarounds at a dead end`);
  verifyCircuit(g, circuit, roadMult, start);

  say('waypoints', 'working out the navigation points');
  const wps = reduceTour(g, circuit, {
    maxLegMetres: req.maxLegMetres, maxLegArcs: req.maxLegArcs,
    cutoffSeconds: config.WAYPOINT_DIJKSTRA_CUTOFF_S, margin: req.margin,
    scale: config.MCF_TIME_SCALE, turnaroundFraction: config.WAYPOINT_TURNAROUND_FRACTION,
    progress: say,
  });

  say('sessions', 'splitting into sessions');
  const chunks = chunkWaypoints(wps, config.CHUNK_WAYPOINTS, config.CHUNK_MAX_SECONDS);
  verifyChunks(chunks, wps);
  const sessions = groupSessions(chunks, wps, req.sessionSeconds);

  const { track, arcStart } = buildTrack(g, circuit);
  const coverage = osm.coverageToDict(net.report);
  const result = {
    request: {
      area: req.area.toJSON(),
      start: req.startLon !== null ? { lon: req.startLon, lat: req.startLat } : null,
      include_private: req.includePrivate,
      both_directions: req.bothDirections,
      passes: req.passes,
      session_minutes: Math.round(req.sessionSeconds / 60),
    },
    coverage,
    stats: summarise(tour, wps.length, sessions.length),
    sessions,
    waypoints: wps.map((w) => ({
      lat: round6(w.lat), lon: round6(w.lon), street: w.street,
      km: Math.round(w.cumMetres) / 1000, arc_index: w.arcIndex,
    })),
    track,
    arc_start: arcStart,
    start: { lat: g.y[start], lon: g.x[start] },
  };
  say('done', coverage.summary);
  return result;
}

/* The breadcrumb as [[lat, lon], ...], plus where each tour arc begins (one
   entry per arc plus a sentinel), so arcs [a, b) are
   track[arc_start[a] .. arc_start[b]]. Shared by the map and the GPX track. */
function buildTrack(g, circuit) {
  const track = [], arcStart = [];
  let px = NaN, py = NaN;
  for (const a of circuit) {
    arcStart.push(Math.max(track.length - 1, 0));
    const geom = g.geom[a];
    for (let i = 0; i < geom.length; i += 2) {
      const x = geom[i], y = geom[i + 1];
      if (Math.abs(x - px) <= 1e-9 && Math.abs(y - py) <= 1e-9) continue;
      track.push([round6(y), round6(x)]);
      px = x; py = y;
    }
  }
  arcStart.push(Math.max(track.length - 1, 0));
  return { track, arcStart };
}
