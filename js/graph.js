/* The road graph as flat typed arrays, plus the searches everything runs on.

   A directed multigraph: nodes are 0..N-1, arcs are 0..E-1, and an arc is
   identified by its index alone. Parallel arcs (two distinct ways between the
   same pair of junctions) and self-loops (circular ways) are ordinary arcs, so
   nothing downstream ever has to disambiguate a node pair.

   Arcs are stored twice in CSR form - by tail and by head - so forward and
   reverse searches are both a contiguous scan. */

import { MCF_TIME_SCALE } from './config.js';
import { arcBearings } from './geo.js';

export class Graph {
  /* `arcs` is an array of records:
       { u, v, length, travel, geom, osmids, names, refs, highway }
     with u, v node indices, geom a flat [lon, lat, ...] Float64Array oriented
     u -> v, osmids a sorted list of OSM way ids, names/refs sorted unique. */
  constructor(ids, xs, ys, arcs) {
    const N = ids.length, E = arcs.length;
    this.N = N; this.E = E;
    this.id = Float64Array.from(ids);   // OSM ids exceed int32
    this.x = Float64Array.from(xs);
    this.y = Float64Array.from(ys);

    this.tail = new Int32Array(E);
    this.head = new Int32Array(E);
    this.length = new Float64Array(E);
    this.travel = new Float64Array(E);
    this.cost = new Int32Array(E);
    this.geom = new Array(E);
    this.osmKey = new Array(E);
    this.names = new Array(E);
    this.refs = new Array(E);
    this.highway = new Array(E);
    for (let a = 0; a < E; a++) {
      const r = arcs[a];
      this.tail[a] = r.u; this.head[a] = r.v;
      this.length[a] = r.length; this.travel[a] = r.travel;
      this.geom[a] = r.geom;
      this.osmKey[a] = r.osmids.join(',');
      this.names[a] = r.names; this.refs[a] = r.refs; this.highway[a] = r.highway;
      // Integer costs, so shortest-path comparisons are exact rather than
      // epsilon-dependent. Travel-time seconds become deciseconds.
      this.cost[a] = Math.max(Math.round(r.travel * MCF_TIME_SCALE), 1);
    }

    // A deterministic arc order - by tail id, head id, then insertion - so
    // identical input gives an identical tour. Every tie-break uses it.
    const byOrder = Array.from({ length: E }, (_, a) => a);
    byOrder.sort((a, b) =>
      (this.id[this.tail[a]] - this.id[this.tail[b]])
      || (this.id[this.head[a]] - this.id[this.head[b]])
      || (a - b));
    this.arcsByOrder = Int32Array.from(byOrder);
    this.order = new Int32Array(E);
    byOrder.forEach((a, rank) => { this.order[a] = rank; });

    // CSR by tail (arcs within a node in `order`) and by head.
    this.outStart = new Int32Array(N + 1);
    this.inStart = new Int32Array(N + 1);
    for (let a = 0; a < E; a++) { this.outStart[this.tail[a] + 1]++; this.inStart[this.head[a] + 1]++; }
    for (let v = 0; v < N; v++) { this.outStart[v + 1] += this.outStart[v]; this.inStart[v + 1] += this.inStart[v]; }
    this.outArcs = new Int32Array(E);
    this.inArcs = new Int32Array(E);
    const outFill = this.outStart.slice(0, N), inFill = this.inStart.slice(0, N);
    for (const a of this.arcsByOrder) {
      this.outArcs[outFill[this.tail[a]]++] = a;
      this.inArcs[inFill[this.head[a]]++] = a;
    }

    this.reciprocal = this._reciprocals();
    this._bearings = null;
  }

  outDegree(v) { return this.outStart[v + 1] - this.outStart[v]; }
  inDegree(v) { return this.inStart[v + 1] - this.inStart[v]; }

  /* The same strip of tarmac driven the other way, if the graph has it.

     Matched on way ids and length rather than node pair, because two genuinely
     different ways can join the same pair of junctions. */
  _reciprocals() {
    const rec = new Int32Array(this.E).fill(-1);
    for (let a = 0; a < this.E; a++) {
      const u = this.tail[a], v = this.head[a];
      if (u === v) continue;
      for (let p = this.outStart[v]; p < this.outStart[v + 1]; p++) {
        const b = this.outArcs[p];
        if (this.head[b] === u && this.osmKey[b] === this.osmKey[a]
            && Math.abs(this.length[b] - this.length[a]) < 0.5) {
          rec[a] = b;
          break;
        }
      }
    }
    return rec;
  }

  /* Identity of the street an arc belongs to, for 'stay on this road'. */
  streetKey(a) {
    if (this.names[a].length) return this.names[a].join('|');
    if (this.refs[a].length) return this.refs[a].join('|');
    return '';
  }

  streetName(a) {
    if (this.names[a].length) return this.names[a].join(', ');
    if (this.refs[a].length) return this.refs[a].join(', ');
    return '';
  }

  /* [departure, arrival] bearings of an arc, or null; computed once. */
  bearings(a) {
    if (!this._bearings) {
      this._bearings = new Float64Array(2 * this.E).fill(NaN);
      this._bearingsDone = new Uint8Array(this.E);
    }
    if (!this._bearingsDone[a]) {
      const b = arcBearings(this.geom[a]);
      if (b) { this._bearings[2 * a] = b[0]; this._bearings[2 * a + 1] = b[1]; }
      this._bearingsDone[a] = 1;
    }
    const out = this._bearings[2 * a];
    return Number.isNaN(out) ? null : [out, this._bearings[2 * a + 1]];
  }

  /* The subgraph on the nodes with keep[v] set, renumbered. Returns the graph
     and a map from old arc index to new (or -1 if the arc was dropped). */
  induced(keep) {
    const newIndex = new Int32Array(this.N).fill(-1);
    const ids = [], xs = [], ys = [];
    for (let v = 0; v < this.N; v++) {
      if (!keep[v]) continue;
      newIndex[v] = ids.length;
      ids.push(this.id[v]); xs.push(this.x[v]); ys.push(this.y[v]);
    }
    const arcMap = new Int32Array(this.E).fill(-1);
    const arcs = [];
    for (let a = 0; a < this.E; a++) {
      const u = newIndex[this.tail[a]], v = newIndex[this.head[a]];
      if (u < 0 || v < 0) continue;
      arcMap[a] = arcs.length;
      arcs.push({
        u, v, length: this.length[a], travel: this.travel[a], geom: this.geom[a],
        osmids: this.osmKey[a].split(','), names: this.names[a], refs: this.refs[a],
        highway: this.highway[a],
      });
    }
    return { graph: new Graph(ids, xs, ys, arcs), arcMap };
  }
}

/* ------------------------------------------------------------------- heap */
export class MinHeap {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
    this.topKey = 0; this.topVal = -1;
  }

  clear() { this.size = 0; }

  push(key, val) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2), vals = new Int32Array(this.size * 2);
      keys.set(this.keys); vals.set(this.vals);
      this.keys = keys; this.vals = vals;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent]; this.vals[i] = this.vals[parent];
      i = parent;
    }
    this.keys[i] = key; this.vals[i] = val;
  }

  /* Removes the minimum into topKey/topVal. Returns false when empty. */
  pop() {
    if (this.size === 0) return false;
    this.topKey = this.keys[0]; this.topVal = this.vals[0];
    const n = --this.size;
    if (n === 0) return true;
    const key = this.keys[n], val = this.vals[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child]; this.vals[i] = this.vals[child];
      i = child;
    }
    this.keys[i] = key; this.vals[i] = val;
    return true;
  }
}

/* --------------------------------------------------------------- Dijkstra */
/* Reusable single- or multi-source search. Arrays are allocated once and
   stamped per run, so calling it thousands of times (the waypoint loop does)
   costs no allocation. */
export class Dijkstra {
  constructor(g) {
    this.g = g;
    this.dist = new Float64Array(g.N);
    this.parent = new Int32Array(g.N);
    this.reached = new Int32Array(g.N);
    this.settled = new Int32Array(g.N);
    this.run = 0;
    this.heap = new MinHeap();
  }

  /* Options: sources (node list), reverse (follow arcs backwards), cutoff
     (nodes beyond it are never reached), weights (per-arc, default cost),
     target (stop once it is settled). */
  search({ sources, reverse = false, cutoff = Infinity, weights = this.g.cost, target = -1 }) {
    const g = this.g, run = ++this.run, heap = this.heap;
    this.lastReverse = reverse;
    const start = reverse ? g.inStart : g.outStart;
    const arcs = reverse ? g.inArcs : g.outArcs;
    const next = reverse ? g.tail : g.head;
    heap.clear();
    for (const s of sources) {
      this.dist[s] = 0; this.parent[s] = -1; this.reached[s] = run;
      heap.push(0, s);
    }
    while (heap.pop()) {
      const v = heap.topVal, d = heap.topKey;
      if (this.settled[v] === run || d !== this.dist[v]) continue;
      this.settled[v] = run;
      if (v === target) break;
      for (let p = start[v]; p < start[v + 1]; p++) {
        const a = arcs[p];
        const w = next[a];
        const nd = d + weights[a];
        if (nd > cutoff) continue;
        if (this.reached[w] !== run || nd < this.dist[w]) {
          this.dist[w] = nd; this.parent[w] = a; this.reached[w] = run;
          heap.push(nd, w);
        }
      }
    }
  }

  has(v) { return this.settled[v] === this.run; }
  get(v) { return this.settled[v] === this.run ? this.dist[v] : Infinity; }

  /* Arcs from the source that reached `v` to `v` (for a reverse search: from
     `v` to the source), in travel order. */
  pathArcs(v) {
    const path = [];
    let node = v;
    while (this.parent[node] !== -1) {
      const a = this.parent[node];
      path.push(a);
      node = this.g.tail[a] === node ? this.g.head[a] : this.g.tail[a];
    }
    return this.lastReverse ? path : path.reverse();
  }

  /* The source a settled node was reached from. */
  rootOf(v) {
    let node = v;
    while (this.parent[node] !== -1) {
      const a = this.parent[node];
      node = this.g.tail[a] === node ? this.g.head[a] : this.g.tail[a];
    }
    return node;
  }
}

/* ------------------------------------------------------------- components */
/* Tarjan, iterative: a 20,000-node graph would blow the call stack. */
export function stronglyConnectedComponents(g) {
  const N = g.N;
  const index = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const comp = new Int32Array(N).fill(-1);
  const stack = [];
  const callNodes = [], callPos = [];
  const sizes = [];
  let counter = 0;

  for (let root = 0; root < N; root++) {
    if (index[root] !== -1) continue;
    index[root] = low[root] = counter++;
    stack.push(root); onStack[root] = 1;
    callNodes.push(root); callPos.push(g.outStart[root]);
    while (callNodes.length) {
      const v = callNodes[callNodes.length - 1];
      const pos = callPos[callPos.length - 1];
      if (pos < g.outStart[v + 1]) {
        callPos[callPos.length - 1] = pos + 1;
        const w = g.head[g.outArcs[pos]];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w); onStack[w] = 1;
          callNodes.push(w); callPos.push(g.outStart[w]);
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
      } else {
        callNodes.pop(); callPos.pop();
        if (low[v] === index[v]) {
          const id = sizes.length;
          let size = 0;
          for (;;) {
            const w = stack.pop();
            onStack[w] = 0; comp[w] = id; size++;
            if (w === v) break;
          }
          sizes.push(size);
        }
        if (callNodes.length) {
          const parent = callNodes[callNodes.length - 1];
          if (low[v] < low[parent]) low[parent] = low[v];
        }
      }
    }
  }
  return { comp, count: sizes.length, sizes };
}

class UnionFind {
  constructor(n) { this.parent = Int32Array.from({ length: n }, (_, i) => i); }
  find(x) {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.parent[b] = a;
  }
}

/* Weakly connected components over the arcs with `mask[a]` set (all arcs when
   mask is null). Nodes touching no such arc get component -1 unless
   `includeIsolated`, in which case each is its own component. */
export function weakComponents(g, mask = null, includeIsolated = false) {
  const uf = new UnionFind(g.N);
  const touched = new Uint8Array(g.N);
  for (let a = 0; a < g.E; a++) {
    if (mask && !mask[a]) continue;
    uf.union(g.tail[a], g.head[a]);
    touched[g.tail[a]] = 1; touched[g.head[a]] = 1;
  }
  const comp = new Int32Array(g.N).fill(-1);
  const rootId = new Map();
  const sizes = [];
  for (let v = 0; v < g.N; v++) {
    if (!touched[v] && !includeIsolated) continue;
    const r = uf.find(v);
    let id = rootId.get(r);
    if (id === undefined) { id = sizes.length; rootId.set(r, id); sizes.push(0); }
    comp[v] = id; sizes[id]++;
  }
  return { comp, count: sizes.length, sizes };
}
