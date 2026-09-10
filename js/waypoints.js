/* Reduce a tour to the fewest waypoints that still force a router to drive it.

   A navigation app that routes *between* waypoints takes its own fastest path
   from one to the next. Coverage routing does the opposite - it backtracks and
   re-enters - so a leg is only safe when the fastest path between its endpoints
   happens to *be* the stretch we intend.

   The admissibility test is therefore on cost, not on paths:

       leg node_i -> node_j is admissible  iff  cost(our sub-walk) == dist(i, j)

   Comparing costs rather than paths matters. The tour revisits nodes
   constantly, and a sub-walk with a repeated node can never equal a simple
   path, so path equality would break at almost every step. With strictly
   positive weights any walk containing a repeat is strictly dearer than the
   same walk with the loop excised, hence strictly dearer than dist - so the
   cost test rejects revisits for free, with no cycle detection.

   Costs are integer deciseconds throughout, so the comparison is exact.

   Two things this cannot fix: equal-cost ties (a short leg and the margin
   re-check make them unlikely, not impossible), and turn restrictions, which
   the road data here does not carry. Mid-street waypoints limit the damage:
   even on a different approach, the router still has to drive the street the
   waypoint sits on. */

import { haversineM, pointAlong } from './geo.js';
import { Dijkstra } from './graph.js';
import { circuitNodes } from './euler.js';

/* Waypoints that pin `circuit` down, starting and ending at its origin.

   One single-source Dijkstra per *emitted* waypoint - not per candidate.
   Prefix sums make testing each candidate O(1), so the cost of a leg is one
   Dijkstra regardless of how far it extends. `cutoffSeconds` keeps each search
   local, which is worth 5-20x on this loop. */
export function reduceTour(g, circuit, { maxLegMetres, maxLegArcs, cutoffSeconds, margin, scale,
                                         turnaroundFraction = 0.9, progress = null }) {
  if (!circuit.length) return [];
  const say = progress || (() => {});
  const nodes = circuitNodes(g, circuit);
  const m = circuit.length;

  // Prefix sums over the tour, in the same integer units as the arc costs.
  const preCost = new Float64Array(m + 1);
  const preLen = new Float64Array(m + 1);
  const preSecs = new Float64Array(m + 1);
  for (let t = 0; t < m; t++) {
    const a = circuit[t];
    preCost[t + 1] = preCost[t] + g.cost[a];
    preLen[t + 1] = preLen[t] + g.length[a];
    preSecs[t + 1] = preSecs[t] + g.travel[a];
  }

  const cutoff = cutoffSeconds * scale;
  const dij = new Dijkstra(g);
  const marginDij = new Dijkstra(g);

  /* Is our sub-walk nodes[i..j] a shortest path from nodes[i]? */
  const admissible = (i, j) => dij.has(nodes[j]) && preCost[j] - preCost[i] <= dij.get(nodes[j]);

  /* Does our sub-walk still win when its own arcs are made dearer?

     Inflating the walk's arcs and re-running Dijkstra proves it beats the
     alternatives by at least `margin`, so an equal-cost rival is unlikely to
     be what a router chooses. Costs are bumped in place and restored. */
  const winsByMargin = (i, j) => {
    if (margin <= 0) return true;
    const touched = [];
    try {
      for (let t = i; t < j; t++) {
        const a = circuit[t];
        touched.push(a, g.cost[a]);
        g.cost[a] = Math.round(g.cost[a] * (1 + margin));
      }
      let inflated = 0;
      for (let t = i; t < j; t++) inflated += g.cost[circuit[t]];
      marginDij.search({ sources: [nodes[i]], cutoff: cutoff * (1 + margin) });
      return marginDij.has(nodes[j]) && inflated <= marginDij.get(nodes[j]);
    } finally {
      for (let k = touched.length - 2; k >= 0; k -= 2) g.cost[touched[k]] = touched[k + 1];
    }
  };

  const waypoints = [{
    lon: g.x[nodes[0]], lat: g.y[nodes[0]], node: nodes[0], arc: -1,
    arcIndex: 0, cumSeconds: 0, cumMetres: 0, street: 'start',
  }];

  let i = 0;
  while (i < m) {
    dij.search({ sources: [nodes[i]], cutoff });

    let j = i + 1;
    while (j < m) {
      const nxt = j + 1;
      if (nxt - i > maxLegArcs) break;
      if (preLen[nxt] - preLen[i] > maxLegMetres) break;
      if (!admissible(i, nxt)) break;
      j = nxt;
    }
    // Progress guarantee. The predicate really can fail at j == i + 1 - a
    // parallel arc or a two-hop shortcut can be cheaper than the arc we
    // intend. Without this clamp the loop would never advance.
    j = Math.max(j, i + 1);

    // Shrink the leg until it wins by the required margin. Bounded so a
    // stubborn leg costs a few Dijkstras, not a rescan of the tour.
    for (let k = 0; k < 3; k++) {
      if (j <= i + 1 || winsByMargin(i, j)) break;
      j = i + Math.max(1, Math.floor((j - i) / 2));
    }

    const arc = circuit[j - 1];
    const previous = waypoints[waypoints.length - 1];
    let lon, lat, street;
    if (j === m) {
      // Last leg: finish at the tour's end node, which is where the driver
      // started. A mid-arc point here plus a separate closing waypoint would
      // put two waypoints on the same arc index, producing a final leg that
      // spans no arcs at all - 0 km, and an empty GPX segment.
      lon = g.x[nodes[m]]; lat = g.y[nodes[m]]; street = 'finish';
    } else {
      // Nearly at the far end when the tour is about to drive this same street
      // back the other way, halfway otherwise. See WAYPOINT_TURNAROUND_FRACTION.
      const turnsBack = g.reciprocal[arc] === circuit[j];
      [lon, lat] = pointAlong(g.geom[arc], turnsBack ? turnaroundFraction : 0.5);
      // A circular way - the turning head of a cul-de-sac - starts and ends at
      // the same junction, so it has no reciprocal to recognise and driving it
      // twice lands both waypoints on the same spot anyway. Any interior point
      // of an arc forces that arc and no other, so move along it instead.
      if (haversineM(lon, lat, previous.lon, previous.lat) < 1) {
        [lon, lat] = pointAlong(g.geom[arc], turnsBack ? 1 - turnaroundFraction : turnaroundFraction);
      }
      street = g.streetName(arc);
    }
    // cum_* are measured at arc boundaries while the point sits along the arc,
    // so each is up to an arc behind the marker. The offset is much the same at
    // both ends of a leg, so leg distances stay close and the total sums exactly
    // to the tour length.
    waypoints.push({
      lon, lat, node: nodes[j], arc, arcIndex: j,
      cumSeconds: preSecs[j], cumMetres: preLen[j], street,
    });
    i = j;
    if (waypoints.length % 250 === 0) {
      say('waypoints', `${waypoints.length} waypoints, ${Math.floor(100 * i / m)}% of the tour`);
    }
  }
  console.info(`reduced ${m} arcs to ${waypoints.length} waypoints`);
  return waypoints;
}
