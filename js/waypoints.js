/* Reduce a tour to the fewest waypoints that still force a router to drive it.

   A navigation app takes its own fastest path between waypoints. Coverage
   routing does the opposite - it backtracks and re-enters - so a leg is only
   safe when the fastest path between its endpoints *is* the stretch we intend:

       leg node_i -> node_j is admissible  iff  cost(our sub-walk) == dist(i, j)

   Comparing costs rather than paths matters. The tour revisits nodes
   constantly, and a sub-walk with a repeat can never equal a simple path, so
   path equality would break at almost every step. With positive weights a walk
   containing a repeat is strictly dearer than dist, so the cost test rejects
   revisits for free. Integer deciseconds throughout, so it is exact.

   It cannot fix equal-cost ties - a short leg and the margin re-check make them
   unlikely, not impossible. Mid-street waypoints limit the damage: even on a
   different approach the router still drives the street the waypoint sits on. */

import { haversineM, pointAlong } from './geo.js';
import { Dijkstra } from './graph.js';
import { circuitNodes } from './euler.js';

/* Waypoints that pin `circuit` down, starting and ending at its origin. One
   Dijkstra per *emitted* waypoint, not per candidate: prefix sums make testing
   a candidate O(1), so a leg costs one search however far it extends. */
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

  // Is our sub-walk nodes[i..j] a shortest path from nodes[i]?
  const admissible = (i, j) => dij.has(nodes[j]) && preCost[j] - preCost[i] <= dij.get(nodes[j]);

  // Does our sub-walk still win when its own arcs are made dearer? Proves it
  // beats alternatives by `margin`, so an equal-cost rival is unlikely to be
  // what a router picks. Costs are bumped in place and restored.
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
    // Progress guarantee: the predicate can fail at j == i + 1, when a parallel
    // arc or two-hop shortcut is cheaper than the arc we intend.
    j = Math.max(j, i + 1);

    // Shrink the leg until it wins by the margin. Bounded, so a stubborn leg
    // costs a few Dijkstras rather than a rescan of the tour.
    for (let k = 0; k < 3; k++) {
      if (j <= i + 1 || winsByMargin(i, j)) break;
      j = i + Math.max(1, Math.floor((j - i) / 2));
    }

    const arc = circuit[j - 1];
    const previous = waypoints[waypoints.length - 1];
    let lon, lat, street;
    if (j === m) {
      // Finish at the tour's end node. A mid-arc point plus a separate closing
      // waypoint would put two waypoints on one arc index, giving a final leg
      // that spans no arcs at all - 0 km and an empty GPX segment.
      lon = g.x[nodes[m]]; lat = g.y[nodes[m]]; street = 'finish';
    } else {
      // Nearly at the far end when the tour is about to drive this street back
      // the other way, halfway otherwise. See WAYPOINT_TURNAROUND_FRACTION.
      const turnsBack = g.reciprocal[arc] === circuit[j];
      [lon, lat] = pointAlong(g.geom[arc], turnsBack ? turnaroundFraction : 0.5);
      // A circular way has no reciprocal to recognise, and driving it twice
      // lands both waypoints on the same spot. Any interior point of an arc
      // forces that arc and no other, so move along it instead.
      if (haversineM(lon, lat, previous.lon, previous.lat) < 1) {
        [lon, lat] = pointAlong(g.geom[arc], turnsBack ? 1 - turnaroundFraction : turnaroundFraction);
      }
      street = g.streetName(arc);
    }
    // cum_* are measured at arc boundaries while the point sits along the arc,
    // so each is up to an arc behind the marker. The offset is similar at both
    // ends of a leg, so leg distances stay close and the total sums exactly.
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
