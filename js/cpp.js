/* Balance the digraph so an Eulerian circuit exists: the directed Rural
   Postman Problem, solved as a min-cost flow.

   Let x_e >= 0 be the number of *extra* traversals of arc e beyond the
   required ones. For the tour to close, every node must have equal arrivals
   and departures, so for each node v:

       sum(x_e for e into v) - sum(x_e for e out of v)
           = passes * (out_required(v) - in_required(v))

   That is a min-cost flow on the road digraph itself, positive demand meaning
   the node wants to receive. Solving it directly avoids the textbook detour
   through a source/sink transportation matrix, which needs an all-pairs
   Dijkstra plus path recovery and arc re-expansion. The flow *is* the
   extra-traversal count.

   Tractable because requiring both directions of a two-way road contributes
   +1 in and +1 out at each endpoint, so those nodes are already balanced.
   Imbalance comes only where one-way chains meet two-way roads. */

import { Dijkstra, weakComponents } from './graph.js';
import { MinCostFlow } from './mcf.js';

// Required-arc imbalance per node, scaled by passes. Sums to zero.
export function nodeDemands(g, required, passes) {
  const demands = new Int32Array(g.N);
  for (let a = 0; a < g.E; a++) {
    if (!required[a]) continue;
    demands[g.tail[a]] += passes;
    demands[g.head[a]] -= passes;
  }
  return demands;
}

export function solveFlow(g, demands) {
  let sum = 0, any = false;
  for (const d of demands) { sum += d; if (d) any = true; }
  if (sum !== 0) throw new Error(`demands must sum to zero, got ${sum} - the required-arc imbalance was computed wrongly`);
  if (!any) return null;   // already balanced; no deadheading needed
  if (!g._mcf) g._mcf = new MinCostFlow(g);
  return g._mcf.solve(demands);
}

/* Merge disconnected pieces of the traversed sub-network.

   The flow balances every node but may leave the traversed arcs in several
   components - the thing that makes the directed RPP NP-hard. Each pass bolts
   the cheapest round trip out to the nearest stranded component and back.

   Both legs must meet at the *same* main-component node: letting each pick its
   own nearest leaves one node with a spare departure and another with a spare
   arrival, so the repair would itself unbalance the graph. */
export function connectSupport(g, mult) {
  const fwd = new Dijkstra(g), rev = new Dijkstra(g), back = new Dijkstra(g);
  const support = new Uint8Array(g.E);

  for (let iter = 0; iter <= g.N; iter++) {   // bounded; each pass strictly reduces components
    let any = false;
    for (let a = 0; a < g.E; a++) { support[a] = mult[a] > 0 ? 1 : 0; if (support[a]) any = true; }
    if (!any) return mult;
    const { comp, count, sizes } = weakComponents(g, support);
    if (count <= 1) return mult;

    let main = 0;
    for (let i = 1; i < count; i++) if (sizes[i] > sizes[main]) main = i;
    console.info(`support has ${count} components; merging`);

    const mainNodes = [], stranded = [];
    for (let v = 0; v < g.N; v++) {
      if (comp[v] === main) mainNodes.push(v);
      else if (comp[v] >= 0) stranded.push(v);
    }
    // Cost out of the main component, and back into it, in one sweep each.
    fwd.search({ sources: mainNodes });
    rev.search({ sources: mainNodes, reverse: true });

    let target = -1, best = Infinity;
    for (const n of stranded) {
      const c = fwd.get(n) + rev.get(n);
      if (c < best || (c === best && g.id[n] < g.id[target])) { best = c; target = n; }
    }
    if (target < 0) {
      throw new Error('cannot connect all required roads into one tour - the road network around this area is not strongly connected');
    }

    const outbound = fwd.pathArcs(target);
    const anchor = fwd.rootOf(target);   // tie the return leg to this exact node
    back.search({ sources: [target], target: anchor });
    if (!back.has(anchor)) throw new Error(`no way back from node ${g.id[target]} to the main tour`);
    for (const a of outbound) mult[a]++;
    for (const a of back.pathArcs(anchor)) mult[a]++;
  }
  throw new Error('failed to connect the tour after too many merges');
}

// Traversal count per arc for a closed tour covering every required arc.
export function balance(g, required, passes) {
  if (passes < 1) throw new Error('passes must be at least 1');
  const demands = nodeDemands(g, required, passes);
  const flow = solveFlow(g, demands);

  const mult = new Int32Array(g.E);
  for (let a = 0; a < g.E; a++) {
    if (required[a]) mult[a] = passes;
    if (flow) mult[a] += flow[a];
  }
  connectSupport(g, mult);
  verifyBalanced(g, mult);
  return mult;
}

// An unbalanced multiset fails the Euler step, and that is a bug here rather
// than a data problem: adding arc copies cannot destroy Eulerianness.
export function verifyBalanced(g, mult) {
  const net = new Int32Array(g.N);
  for (let a = 0; a < g.E; a++) {
    if (!mult[a]) continue;
    net[g.tail[a]] -= mult[a];
    net[g.head[a]] += mult[a];
  }
  const bad = [];
  for (let v = 0; v < g.N && bad.length < 5; v++) if (net[v]) bad.push(`${g.id[v]}: ${net[v]}`);
  if (bad.length) throw new Error(`unbalanced nodes after flow: ${bad.join(', ')}`);
}

// Distance and time split into required driving versus deadheading.
export function tourStats(g, mult, required, passes) {
  let reqM = 0, deadM = 0, reqS = 0, deadS = 0;
  for (let a = 0; a < g.E; a++) {
    const m = mult[a];
    if (!m) continue;
    const nReq = required[a] ? passes : 0;
    const nDead = Math.max(m - nReq, 0);
    reqM += g.length[a] * Math.min(m, nReq);
    reqS += g.travel[a] * Math.min(m, nReq);
    deadM += g.length[a] * nDead;
    deadS += g.travel[a] * nDead;
  }
  const total = reqM + deadM;
  return {
    required_km: round2(reqM / 1000),
    deadhead_km: round2(deadM / 1000),
    total_km: round2(total / 1000),
    total_seconds: Math.trunc(reqS + deadS),
    deadhead_pct: total ? Math.round(1000 * deadM / total) / 10 : 0,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
