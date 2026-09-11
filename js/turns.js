/* The road graph re-expressed so that a turn is an arc in its own right.

   A graph whose nodes are junctions cannot say anything about turning: every
   pairing of arrivals and departures there costs the same, nothing, so doubling
   back and banned left turns are free. Splitting each arc in two puts the
   junction between the arcs instead of under them:

       arc a          a_in --------- a_out          the road itself
       turn a->b            a_out ----> b_in        one movement at the junction

   The result is an ordinary Graph, so the flow, the connectivity repair and
   Hierholzer run on it unchanged - and all of them now choose turns as well as
   arcs. The flow in particular pairs arrivals to departures at every junction
   optimally, which a greedy walk cannot.

   Two invariants:
   * Road arc `a` keeps index `a`, since road arcs are added first and in order.
     Masks, traversal counts and the reciprocal table cross between the graphs
     by a plain array slice.
   * Every turn exists, however dearly priced. Deleting one could strand the
     street behind it and break strong connectivity, so the flow would fail or
     the prune would drop drivable roads. */

import {
  CONNECTOR_PENALTY_S, MCF_TIME_SCALE, RESTRICTED_TURN_PENALTY_S, SHARP_TURN_PENALTY_S,
  UTURN_DEGREES, UTURN_PENALTY_S, UTURN_TAPER_DEGREES,
} from './config.js';
import { startRun, turnAngle } from './geo.js';
import { Graph } from './graph.js';

// Bit flags, for reporting. TURN_TURNAROUND is the one that is not a complaint:
// doubling back where there is nothing else to do.
export const TURN_SHARP = 1;
export const TURN_REVERSAL = 2;
export const TURN_RESTRICTED = 4;
export const TURN_TURNAROUND = 8;

/* Is `b` the arc `a` came in on, driven back the other way?

   Not "is b the reciprocal of a": Graph.reciprocal picks one partner per arc,
   so where a street is mapped twice the second copy is the same tarmac and not
   the one it picked - 20 arcs' worth over 39 km2. `a !== b` is for circular
   ways, which simplify to a self-loop: going round twice is not doubling back. */
const reverses = (g, a, b) =>
  a !== b
  && g.head[b] === g.tail[a]
  && g.osmKey[b] === g.osmKey[a]
  && Math.abs(g.length[b] - g.length[a]) < 0.5;

/* Seconds charged for turning from `a` onto `b`, and what kind of manoeuvre it
   is. Coming back out on the same tarmac is the illegal U-turn whatever the
   geometry says; anything else sharp is a turn onto different tarmac, which is
   how you legally reverse direction through a slip lane or a hairpin.

   `escape` says whether the driver has anywhere else to go - charging for an
   unavoidable manoeuvre distorts every route leading to it. */
function turnPrice(g, a, b, arrival, escape) {
  if (reverses(g, a, b)) {
    return escape.other ? { seconds: UTURN_PENALTY_S, kind: TURN_REVERSAL }
                        : { seconds: 0, kind: TURN_TURNAROUND };
  }
  if (!arrival) return { seconds: 0, kind: 0 };
  const departure = g.bearings(b);
  if (!departure) return { seconds: 0, kind: 0 };
  const angle = Math.abs(turnAngle(arrival[1], departure[0]));
  if (angle <= UTURN_TAPER_DEGREES) return { seconds: 0, kind: 0 };
  const sharp = angle >= UTURN_DEGREES;
  if (!escape.any) return { seconds: 0, kind: sharp ? TURN_TURNAROUND : 0 };
  const t = Math.min((angle - UTURN_TAPER_DEGREES) / (180 - UTURN_TAPER_DEGREES), 1);
  return { seconds: SHARP_TURN_PENALTY_S * t, kind: sharp ? TURN_SHARP : 0 };
}

/* Expand `g`. `restricted` is the Map from osm.turnRestrictions(), or null. */
export function expandTurns(g, { restricted = null } = {}) {
  const E = g.E;
  const ids = new Array(2 * E), xs = new Array(2 * E), ys = new Array(2 * E);
  const arcs = new Array(E);
  for (let a = 0; a < E; a++) {
    const u = g.tail[a], v = g.head[a];
    ids[2 * a] = 2 * a; xs[2 * a] = g.x[u]; ys[2 * a] = g.y[u];
    ids[2 * a + 1] = 2 * a + 1; xs[2 * a + 1] = g.x[v]; ys[2 * a + 1] = g.y[v];
    arcs[a] = {
      u: 2 * a, v: 2 * a + 1,
      length: g.length[a], travel: g.travel[a], geom: g.geom[a],
      osmids: g.osmKey[a] ? g.osmKey[a].split(',') : [],
      names: g.names[a], refs: g.refs[a], highway: g.highway[a],
      connector: g.connector[a],
      // Surcharge here rather than on the road graph, so it steers the solver
      // without showing up in the quoted distance and duration.
      cost: g.cost[a] + (g.connector[a] ? CONNECTOR_PENALTY_S * MCF_TIME_SCALE : 0),
    };
  }

  // One stub per road, not one per turn onto it, and long enough to carry the
  // bearing the road actually leaves on.
  const stubs = new Array(E);
  for (let a = 0; a < E; a++) stubs[a] = startRun(g.geom[a]);

  const kinds = new Array(E).fill(0);   // stays index-aligned with `arcs`
  const tally = { reversals: 0, sharp: 0, restricted: 0, turnarounds: 0 };
  for (let v = 0; v < g.N; v++) {
    const anyEscape = g.outDegree(v) > 1;
    for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) {
      const a = g.inArcs[p];
      const arrival = g.bearings(a);
      const banned = restricted ? restricted.get(a) : null;
      // The way back does not count as an alternative to itself.
      let otherEscape = false;
      for (let q = g.outStart[v]; q < g.outStart[v + 1]; q++) {
        if (!reverses(g, a, g.outArcs[q])) { otherEscape = true; break; }
      }
      const escape = { any: anyEscape, other: otherEscape };
      for (let q = g.outStart[v]; q < g.outStart[v + 1]; q++) {
        const b = g.outArcs[q];
        let { seconds, kind } = turnPrice(g, a, b, arrival, escape);
        if (banned && banned.has(b)) { seconds += RESTRICTED_TURN_PENALTY_S; kind |= TURN_RESTRICTED; }
        if (kind & TURN_REVERSAL) tally.reversals++;
        else if (kind & TURN_SHARP) tally.sharp++;
        else if (kind & TURN_TURNAROUND) tally.turnarounds++;
        if (kind & TURN_RESTRICTED) tally.restricted++;
        kinds.push(kind);
        arcs.push({
          u: 2 * a + 1, v: 2 * b,
          length: 0, travel: 0, geom: stubs[b],
          osmids: [],
          // The turn carries the identity of the road it commits to, so the
          // tour step's street and bearing preferences still have something to
          // work with.
          names: g.names[b], refs: g.refs[b], highway: g.highway[b],
          cost: Math.round(seconds * MCF_TIME_SCALE),
        });
      }
    }
  }

  const graph = new Graph(ids, xs, ys, arcs);
  const turnKind = Uint8Array.from(kinds);
  // Reciprocity is a fact about roads, not turns, and Graph derives it from way
  // ids and length, which a turn has neither of. Restate it from the roads.
  const reciprocal = new Int32Array(graph.E).fill(-1);
  reciprocal.set(g.reciprocal, 0);
  graph.reciprocal = reciprocal;

  console.info(`turn graph: ${graph.N} nodes / ${graph.E} arcs `
    + `(${E} roads, ${graph.E - E} turns; ${tally.reversals} priced as reversals, `
    + `${tally.sharp} as hairpins, ${tally.restricted} forbidden, `
    + `${tally.turnarounds} free at a dead end)`);
  return { graph, roadArcs: E, roads: g, turnKind };
}

// Road arcs keep their indices, so masks and counts cross by copy and slice.
export const liftMask = (exp, mask) => {
  const out = new Uint8Array(exp.graph.E);
  out.set(mask, 0);
  return out;
};
export const projectMult = (exp, mult) => mult.slice(0, exp.roadArcs);

// The tour as road arcs. What is left chains head to tail, because a turn only
// ever joins the head of one road to the tail of the next.
export const projectCircuit = (exp, circuit) => circuit.filter((a) => a < exp.roadArcs);

// Where a tour starting at road-graph node `v` starts here: the entry node of
// the first road it drives.
export function entryNode(exp, v, mult) {
  const g = exp.roads;
  for (let p = g.outStart[v]; p < g.outStart[v + 1]; p++) {
    const b = g.outArcs[p];
    if (mult[b] > 0) return 2 * b;
  }
  return -1;
}

// Priced turns the tour actually makes. `reversals` is the number that matters.
export function turnAudit(exp, walk) {
  const kind = exp.turnKind;
  const out = { reversals: 0, sharp: 0, restricted: 0, turnarounds: 0 };
  for (const a of walk) {
    if (a < exp.roadArcs) continue;
    const k = kind[a];
    if (k & TURN_REVERSAL) out.reversals++;
    else if (k & TURN_SHARP) out.sharp++;
    else if (k & TURN_TURNAROUND) out.turnarounds++;
    if (k & TURN_RESTRICTED) out.restricted++;
  }
  return out;
}
