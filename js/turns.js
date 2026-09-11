/* The road graph re-expressed so that a *turn* is an arc in its own right.

   A graph whose nodes are junctions cannot say anything about turning. Arriving
   at a junction on one street and leaving on another is a single node in the
   middle of a walk, and every pair of arrivals and departures there is worth
   the same: nothing. So doubling back costs nothing, a banned left turn costs
   nothing, and both the flow step and the tour step take them freely. That is
   what produces a route which turns round in the middle of a street.

   The fix is to split each arc in two and put the junction *between* the arcs
   rather than under them:

       arc a          a_in --------- a_out          the road itself
       turn a->b            a_out ----> b_in        one movement at the junction

   Every road arc becomes one arc from its own entry node to its own exit node,
   carrying that road's length, time and geometry. Every legal movement at a
   junction becomes a zero-length arc from the exit node of the arriving road to
   the entry node of the departing one, carrying nothing but a price.

   Nothing downstream needs to know. The expanded graph is an ordinary Graph, so
   the min-cost flow, the connectivity repair and Hierholzer all run on it
   unchanged - and now every one of them is choosing turns, not just arcs. The
   flow in particular decides the whole pairing of arrivals to departures at
   every junction at once, and does it optimally, which is the thing a greedy
   walk down the tour cannot do however carefully it looks at the next step.

   Two properties this relies on:

   * Road arc `a` keeps index `a` in the expanded graph, because the road arcs
     are added first and in order. That is what lets a required-arc mask, a
     traversal count and a reciprocal table cross between the two graphs by a
     plain array slice.
   * Every turn exists, however dearly priced. Deleting one could strand the
     street behind it, and the expansion of a strongly connected graph is then
     no longer strongly connected - the flow would fail outright, or the prune
     would drop roads that are perfectly drivable. Pricing keeps the guarantee
     that a route exists and merely makes the bad ones last resorts. */

import {
  CONNECTOR_PENALTY_S, MCF_TIME_SCALE, RESTRICTED_TURN_PENALTY_S, SHARP_TURN_PENALTY_S,
  UTURN_DEGREES, UTURN_PENALTY_S, UTURN_TAPER_DEGREES,
} from './config.js';
import { startRun, turnAngle } from './geo.js';
import { Graph } from './graph.js';

/* What kind of manoeuvre a turn arc is, for reporting. Bit flags: a restricted
   turn can also be a reversal.

   TURN_TURNAROUND is the one that is *not* a complaint - doubling back where
   there is nothing else to do. Counting those in with the rest is what makes a
   report of a clean route look like a report of a broken one. */
export const TURN_SHARP = 1;
export const TURN_REVERSAL = 2;
export const TURN_RESTRICTED = 4;
export const TURN_TURNAROUND = 8;

/* Is `b` the arc `a` came in on, driven back the other way?

   Not "is b the reciprocal of a": Graph.reciprocal picks one partner per arc,
   and where a street is mapped twice - two identical parallel ways, which OSM
   has plenty of - the second copy is the same strip of tarmac and is not the
   one it picked. Measured over 39 km2 that let 20 arcs' worth of genuine
   reversal through priced as though it were a hairpin. So ask the question
   directly, on the same terms Graph.reciprocal asks it.

   `a !== b` is for circular ways, which simplify to a self-loop and so are their
   own predecessor and successor. Driving a loop twice the same way round is not
   doubling back; driving the other direction of it is, and that is a different
   arc. */
const reverses = (g, a, b) =>
  a !== b
  && g.head[b] === g.tail[a]
  && g.osmKey[b] === g.osmKey[a]
  && Math.abs(g.length[b] - g.length[a]) < 0.5;

/* Seconds the route is charged for turning from `a` onto `b`, and which kind of
   manoeuvre that is.

   Two tiers, and the distinction between them is the whole point. Coming back
   out on the same strip of tarmac is a U-turn in the middle of a street,
   whatever the geometry says the angle is. Everything else that comes out sharp
   is a turn onto *different* tarmac, which is a different manoeuvre and a much
   smaller problem: it is how you legally reverse direction through a slip lane,
   round a hairpin, or across the gap in a dual carriageway.

   `escape` says whether the driver has anywhere else to go. Charging for a
   manoeuvre nobody can avoid buys nothing and distorts the cost of every route
   that leads to it. */
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
  // Ramp to the full price at 180 rather than switching on at a threshold, so
  // a junction drawn slightly differently is not priced completely differently.
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
      // The connector surcharge lives here rather than on the road graph, so it
      // steers the solver without ever showing up in the distance and duration
      // quoted back to the driver - the same reason turn prices live here.
      cost: g.cost[a] + (g.connector[a] ? CONNECTOR_PENALTY_S * MCF_TIME_SCALE : 0),
    };
  }

  // One stub per road, not one per turn onto it: a road is departed from once
  // for every road arriving at the same junction. The stub runs far enough to
  // carry the bearing the road actually leaves on, not the first vertex.
  const stubs = new Array(E);
  for (let a = 0; a < E; a++) stubs[a] = startRun(g.geom[a]);

  const kinds = new Array(E).fill(0);   // stays index-aligned with `arcs`
  const tally = { reversals: 0, sharp: 0, restricted: 0, turnarounds: 0 };
  for (let v = 0; v < g.N; v++) {
    // Somewhere else to go? A junction with one way out is a dead end, and
    // turning round there is the only thing a driver can do; charging for it
    // would price a street by how it happens to be mapped rather than by how it
    // drives. `other` is the same question for a reversal specifically - the
    // way back does not count as an alternative to itself.
    const anyEscape = g.outDegree(v) > 1;
    for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) {
      const a = g.inArcs[p];
      const arrival = g.bearings(a);
      const banned = restricted ? restricted.get(a) : null;
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
          // tour step's "stay on this street, else turn as little as possible"
          // preference still sees a street and a bearing to work with.
          names: g.names[b], refs: g.refs[b], highway: g.highway[b],
          cost: Math.round(seconds * MCF_TIME_SCALE),
        });
      }
    }
  }

  const graph = new Graph(ids, xs, ys, arcs);
  const turnKind = Uint8Array.from(kinds);
  // Reciprocity is a fact about roads, not about turns: two turn arcs between
  // the same pair of nodes are not two ways down one street. Graph works it out
  // from way ids and length, which a turn has neither of, so it is restated
  // here from the roads it came from. One-way mode reads this to find the two
  // directions of a street it may choose between.
  const reciprocal = new Int32Array(graph.E).fill(-1);
  reciprocal.set(g.reciprocal, 0);
  graph.reciprocal = reciprocal;

  console.info(`turn graph: ${graph.N} nodes / ${graph.E} arcs `
    + `(${E} roads, ${graph.E - E} turns; ${tally.reversals} priced as reversals, `
    + `${tally.sharp} as hairpins, ${tally.restricted} forbidden, `
    + `${tally.turnarounds} free at a dead end)`);
  return { graph, roadArcs: E, roads: g, turnKind };
}

/* A road-arc mask as the expanded graph wants it, and traversal counts back
   again. The road arcs keep their indices, so one direction is a copy into a
   longer array and the other is a slice. */
export const liftMask = (exp, mask) => {
  const out = new Uint8Array(exp.graph.E);
  out.set(mask, 0);
  return out;
};
export const projectMult = (exp, mult) => mult.slice(0, exp.roadArcs);

/* The tour as road arcs: drop the turns, which carry no distance and no
   geometry of their own. What is left chains head to tail in the road graph,
   because a turn only ever joins the head of one road to the tail of the next. */
export const projectCircuit = (exp, circuit) => circuit.filter((a) => a < exp.roadArcs);

/* Where a tour that starts at road-graph node `v` starts in the expanded graph:
   the entry node of the first road it will drive. Out-arcs are stored in the
   graph's own order, so the choice is the same on every run. */
export function entryNode(exp, v, mult) {
  const g = exp.roads;
  for (let p = g.outStart[v]; p < g.outStart[v + 1]; p++) {
    const b = g.outArcs[p];
    if (mult[b] > 0) return 2 * b;
  }
  return -1;
}

/* The turns the tour actually makes that it would rather not have, by kind -
   for the log, and for anyone changing the penalties in config.js.

   `reversals` is the number that matters: a route with any of them at all is
   one where the road layout left the solver no way round, and a route where
   that count is climbing is one where something has regressed. */
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
