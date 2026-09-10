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

import { MCF_TIME_SCALE, RESTRICTED_TURN_PENALTY_S, UTURN_DEGREES, UTURN_PENALTY_S } from './config.js';
import { turnAngle } from './geo.js';
import { Graph } from './graph.js';

/* Does leaving on `b` undo arriving on `a`?

   The reciprocal test catches the ordinary case - the same strip of tarmac the
   other way - and the angle catches the rest: a hairpin between two separately
   mapped ways, or the far carriageway of a dual road, which are U-turns to
   drive even though no single arc is being reversed. */
function doublesBack(g, a, b, arrival) {
  if (g.reciprocal[a] === b) return true;
  if (!arrival) return false;
  const departure = g.bearings(b);
  return departure ? Math.abs(turnAngle(arrival[1], departure[0])) >= UTURN_DEGREES : false;
}

/* The first two distinct points of an arc, so a turn onto it can be given a
   bearing and a name without being given a length. */
function stub(geom) {
  const n = geom.length / 2;
  for (let i = 1; i < n; i++) {
    if (geom[2 * i] !== geom[0] || geom[2 * i + 1] !== geom[1]) {
      return Float64Array.of(geom[0], geom[1], geom[2 * i], geom[2 * i + 1]);
    }
  }
  return Float64Array.of(geom[0], geom[1], geom[0], geom[1]);
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
      cost: g.cost[a],
    };
  }

  // One stub per road, not one per turn onto it: a road is departed from once
  // for every road arriving at the same junction.
  const stubs = new Array(E);
  for (let a = 0; a < E; a++) stubs[a] = stub(g.geom[a]);

  let priced = 0;
  for (let v = 0; v < g.N; v++) {
    // A junction with one way out is a dead end, and turning round there is the
    // only thing a driver can do. Charging for it would price a street by how
    // it happens to be mapped rather than by how it drives.
    const forced = g.outDegree(v) === 1;
    for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) {
      const a = g.inArcs[p];
      const arrival = g.bearings(a);
      const banned = restricted ? restricted.get(a) : null;
      for (let q = g.outStart[v]; q < g.outStart[v + 1]; q++) {
        const b = g.outArcs[q];
        let seconds = 0;
        if (!forced && doublesBack(g, a, b, arrival)) seconds += UTURN_PENALTY_S;
        if (banned && banned.has(b)) seconds += RESTRICTED_TURN_PENALTY_S;
        if (seconds) priced++;
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
  // Reciprocity is a fact about roads, not about turns: two turn arcs between
  // the same pair of nodes are not two ways down one street. Graph works it out
  // from way ids and length, which a turn has neither of, so it is restated
  // here from the roads it came from. One-way mode reads this to find the two
  // directions of a street it may choose between.
  const reciprocal = new Int32Array(graph.E).fill(-1);
  reciprocal.set(g.reciprocal, 0);
  graph.reciprocal = reciprocal;

  console.info(`turn graph: ${graph.N} nodes / ${graph.E} arcs `
    + `(${E} roads, ${graph.E - E} turns, ${priced} of them priced)`);
  return { graph, roadArcs: E, roads: g };
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

/* How many turns the tour makes that it would rather not have - for the log,
   and for anyone changing the penalties above. */
export function countPricedTurns(exp, circuit) {
  const t = exp.graph;
  let n = 0;
  for (const a of circuit) if (a >= exp.roadArcs && t.cost[a] > 1) n++;
  return n;
}
