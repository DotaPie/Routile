/* Minimum-cost flow on the road graph itself.

   Successive shortest paths with node potentials: send flow along the cheapest
   path from a super-source to a super-sink, Dijkstra on reduced costs so
   negative residual arcs never appear. Each search stops as soon as the sink
   settles; the partial-potential update keeps reduced costs non-negative.

   Graph arcs are uncapacitated, so every augmentation saturates a supply or a
   demand and the number of searches is bounded by the imbalanced junctions.

   demand > 0 means the node must receive that much, < 0 that it must send it.
   Demands must sum to zero.

   The residual network is built once per graph and only capacities are reset
   per solve, because one-way mode calls this dozens of times. */

import { MinHeap } from './graph.js';

const INF_CAP = 0x3fffffff;

export class MinCostFlow {
  constructor(g) {
    const N = g.N, E = g.E;
    this.g = g;
    this.N = N; this.E = E;
    this.s = N; this.t = N + 1;
    const nodes = N + 2;

    // Residual arcs come in pairs (2i, 2i+1). Graph arc a is pair a; the
    // supply arc of node v is pair E + v; its demand arc is pair E + N + v.
    const R = 2 * (E + 2 * N);
    this.to = new Int32Array(R);
    this.from = new Int32Array(R);
    this.cap = new Int32Array(R);
    this.cost = new Float64Array(R);
    const set = (i, u, v, c) => {
      this.from[i] = u; this.to[i] = v; this.cost[i] = c;
      this.from[i + 1] = v; this.to[i + 1] = u; this.cost[i + 1] = -c;
    };
    for (let a = 0; a < E; a++) set(2 * a, g.tail[a], g.head[a], g.cost[a]);
    for (let v = 0; v < N; v++) {
      set(2 * (E + v), this.s, v, 0);
      set(2 * (E + N + v), v, this.t, 0);
    }

    this.adjStart = new Int32Array(nodes + 1);
    for (let i = 0; i < R; i++) this.adjStart[this.from[i] + 1]++;
    for (let v = 0; v < nodes; v++) this.adjStart[v + 1] += this.adjStart[v];
    this.adj = new Int32Array(R);
    const fill = this.adjStart.slice(0, nodes);
    for (let i = 0; i < R; i++) this.adj[fill[this.from[i]]++] = i;

    this.pi = new Float64Array(nodes);
    this.dist = new Float64Array(nodes);
    this.parentArc = new Int32Array(nodes);
    this.reached = new Int32Array(nodes);
    this.settled = new Int32Array(nodes);
    this.run = 0;
    this.heap = new MinHeap();
  }

  // Extra traversals per graph arc that balance every node. Throwing here means
  // the demands were computed wrongly, given a strongly connected graph.
  solve(demands) {
    const { N, E, s, t, cap } = this;
    let need = 0;
    for (let a = 0; a < E; a++) { cap[2 * a] = INF_CAP; cap[2 * a + 1] = 0; }
    for (let v = 0; v < N; v++) {
      const d = demands[v];
      cap[2 * (E + v)] = d < 0 ? -d : 0; cap[2 * (E + v) + 1] = 0;
      cap[2 * (E + N + v)] = d > 0 ? d : 0; cap[2 * (E + N + v) + 1] = 0;
      if (d > 0) need += d;
    }
    this.pi.fill(0);

    let sent = 0;
    while (sent < need) {
      if (!this._dijkstra(s, t)) {
        throw new Error('min-cost flow found no feasible solution - the road graph is not strongly connected');
      }
      const D = this.dist[t];
      for (let v = 0; v < N + 2; v++) {
        this.pi[v] += this.reached[v] === this.run && this.dist[v] < D ? this.dist[v] : D;
      }
      let bottleneck = need - sent;
      for (let v = t; v !== s; v = this.from[this.parentArc[v]]) {
        const c = cap[this.parentArc[v]];
        if (c < bottleneck) bottleneck = c;
      }
      for (let v = t; v !== s; v = this.from[this.parentArc[v]]) {
        const i = this.parentArc[v];
        cap[i] -= bottleneck; cap[i ^ 1] += bottleneck;
      }
      sent += bottleneck;
    }

    const flow = new Int32Array(E);
    for (let a = 0; a < E; a++) flow[a] = cap[2 * a + 1];
    return flow;
  }

  _dijkstra(s, t) {
    const run = ++this.run, heap = this.heap;
    const { adjStart, adj, to, cap, cost, pi, dist } = this;
    heap.clear();
    dist[s] = 0; this.reached[s] = run; this.parentArc[s] = -1;
    heap.push(0, s);
    while (heap.pop()) {
      const v = heap.topVal, d = heap.topKey;
      if (this.settled[v] === run || d !== dist[v]) continue;
      this.settled[v] = run;
      if (v === t) return true;
      for (let p = adjStart[v]; p < adjStart[v + 1]; p++) {
        const i = adj[p];
        if (cap[i] <= 0) continue;
        const w = to[i];
        const nd = d + cost[i] + pi[v] - pi[w];
        if (this.reached[w] !== run || nd < dist[w]) {
          dist[w] = nd; this.parentArc[w] = i; this.reached[w] = run;
          heap.push(nd, w);
        }
      }
    }
    return false;
  }
}
