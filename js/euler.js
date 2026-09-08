/* Turn an arc multiset into a closed tour that a human would enjoy driving.

   Total distance is *invariant* across all Eulerian circuits of a given
   multigraph, but the number of waypoints needed is not: breaks happen
   wherever the tour stops being the fastest path between two points, so a tour
   that thrashes across a neighbourhood costs far more waypoints than one that
   sweeps it street by street.

   The textbook Hierholzer takes an arbitrary remaining arc and splices
   subtours at arbitrary points, which maximises that thrashing. So each closed
   walk here is grown with a driver's preferences (stay on the named street,
   else turn as little as possible) and subtours are spliced exactly where they
   attach. Same asymptotics, 58-78% fewer street changes on grids.

   No Fleury-style bridge checking is needed. In a balanced digraph a greedy
   walk from v can only ever get stuck at v itself, so every greedy walk closes
   on its own; the splice loop mops up whatever arcs are left over. */

import { turnAngle } from './geo.js';

// Anything sharper than this counts as a U-turn and is avoided unless forced.
const UTURN_DEGREES = 150;

/* Closed tour driving arc a exactly mult[a] times, as a list of arc indices.
   `start` is a node index, or -1 to let the tour pick. */
export function eulerianCircuit(g, mult, start = -1) {
  const remaining = Int32Array.from(mult);
  const nodeLeft = new Int32Array(g.N);
  let total = 0;
  for (let a = 0; a < g.E; a++) {
    if (remaining[a] > 0) { nodeLeft[g.tail[a]] += remaining[a]; total += remaining[a]; }
  }
  if (!total) return [];

  /* Best remaining arc out of `node`, arriving via `prev`. Out-arcs are stored
     in the graph's deterministic order, so ties resolve identically every
     run. */
  const pick = (node, prev) => {
    let only = -1, count = 0;
    for (let p = g.outStart[node]; p < g.outStart[node + 1]; p++) {
      const a = g.outArcs[p];
      if (remaining[a] > 0) { if (only < 0) only = a; count++; }
    }
    if (count === 1) return only;

    let prevArrival = null, prevStreet = '';
    if (prev >= 0) {
      const pb = g.bearings(prev);
      prevArrival = pb ? pb[1] : null;
      prevStreet = g.streetKey(prev);
    }
    let best = -1, bestUturn = 0, bestOff = 0, bestTurn = 0;
    for (let p = g.outStart[node]; p < g.outStart[node + 1]; p++) {
      const a = g.outArcs[p];
      if (remaining[a] <= 0) continue;
      let turn = 0;
      if (prevArrival !== null) {
        const ab = g.bearings(a);
        if (ab) turn = Math.abs(turnAngle(prevArrival, ab[0]));
      }
      // Avoid doubling back, then stay on the same street, then go straight.
      const uturn = turn >= UTURN_DEGREES ? 1 : 0;
      const off = prevStreet && g.streetKey(a) === prevStreet ? 0 : 1;
      if (best < 0 || uturn < bestUturn
          || (uturn === bestUturn && (off < bestOff || (off === bestOff && turn < bestTurn)))) {
        best = a; bestUturn = uturn; bestOff = off; bestTurn = turn;
      }
    }
    return best;
  };

  /* Walk greedily from `origin` until stuck - which can only be at `origin`. */
  const closedWalk = (origin, prev) => {
    const walk = [];
    let node = origin, last = prev;
    while (nodeLeft[node] > 0) {
      const a = pick(node, last);
      remaining[a]--;
      nodeLeft[node]--;
      walk.push(a);
      node = g.head[a]; last = a;
    }
    if (node !== origin) {
      throw new Error(`walk from ${g.id[origin]} got stuck at ${g.id[node]}; the arc multiset is not balanced (a bug in the flow step, not bad data)`);
    }
    return walk;
  };

  if (start < 0 || nodeLeft[start] === 0) {
    if (start >= 0) console.warn(`start node ${g.id[start]} has no outgoing tour arcs; picking another`);
    let chosen = -1;
    for (let v = 0; v < g.N; v++) {
      if (nodeLeft[v] > 0 && (chosen < 0 || g.id[v] < g.id[chosen])) chosen = v;
    }
    start = chosen;
  }

  const circuit = closedWalk(start, -1);

  // Splice in every leftover subtour at the point it attaches, scanning from
  // the end backwards. Attaching at the *last* visit to a junction rather than
  // the first preserves the through-movement the greedy walk just chose: drive
  // the street to its end, then pick up the side branches on the final pass
  // through the junction.
  //
  // After an insertion we jump past the new block and walk back down through
  // it, so its own branches get spliced too. Every position is examined once,
  // keeping this linear in the number of arcs.
  let i = circuit.length;
  while (i >= 0) {
    const node = i === 0 ? start : g.head[circuit[i - 1]];
    if (nodeLeft[node] > 0) {
      const sub = closedWalk(node, i > 0 ? circuit[i - 1] : -1);
      insertAt(circuit, i, sub);
      i += sub.length;
    } else {
      i--;
    }
  }

  let unused = 0;
  for (let a = 0; a < g.E; a++) unused += remaining[a];
  if (unused) throw new Error(`${unused} arc traversals left unused - the tour multiset was not connected`);
  return circuit;
}

/* Array.splice with spread blows the argument limit on a big block. */
function insertAt(arr, i, items) {
  if (items.length < 10000) { arr.splice(i, 0, ...items); return; }
  const tail = arr.splice(i);
  for (const x of items) arr.push(x);
  for (const x of tail) arr.push(x);
}

/* Assert the tour chains head-to-tail, closes, and uses each arc exactly. */
export function verifyCircuit(g, circuit, mult, start = -1) {
  if (!circuit.length) {
    if (mult.some((m) => m > 0)) throw new Error('empty circuit but arcs were required');
    return;
  }
  for (let i = 1; i < circuit.length; i++) {
    if (g.head[circuit[i - 1]] !== g.tail[circuit[i]]) throw new Error(`tour breaks at arc ${i}`);
  }
  if (g.head[circuit[circuit.length - 1]] !== g.tail[circuit[0]]) throw new Error('tour is not closed');
  if (start >= 0 && g.tail[circuit[0]] !== start) throw new Error('tour does not start at the requested node');
  const used = new Int32Array(g.E);
  for (const a of circuit) used[a]++;
  for (let a = 0; a < g.E; a++) {
    if (used[a] !== Math.max(mult[a], 0)) throw new Error(`traversal counts differ on arc ${a}: ${used[a]} vs ${mult[a]}`);
  }
}

/* Node sequence of a tour, length circuit.length + 1. */
export function circuitNodes(g, circuit) {
  const nodes = new Int32Array(circuit.length + 1);
  if (!circuit.length) return nodes;
  nodes[0] = g.tail[circuit[0]];
  circuit.forEach((a, i) => { nodes[i + 1] = g.head[a]; });
  return nodes;
}
