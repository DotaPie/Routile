/* One-way mode: drive each street once, in whichever direction suits the route.

   Requiring *both* directions makes the problem exactly solvable, because every
   two-way road balances its own endpoints. Requiring only *one* pass means
   choosing a direction per street, and those choices interact globally, because
   every junction still has to end up balanced. That is the Mixed Chinese
   Postman Problem, which is NP-hard. So this module is a heuristic, not an
   optimum.

   It is always *valid*, though: one-way streets are only ever driven legally,
   every street is covered at least once, and the tour closes. Only the total
   distance is approximate.

   Strategy:

   1. Group required arcs into physical streets.
   2. Orient each two-way street greedily, leaving junctions as balanced as
      possible before any deadheading is added.
   3. Solve the resulting *directed* problem exactly, with the min-cost flow.
   4. Improve: flip streets that would reduce junction imbalance, re-solve, and
      keep the change only if the real cost actually dropped.

   Two graphs are in play and they are not interchangeable. Steps 2 and 4 reason
   about *junctions* - how many streets point into one and how many point out -
   so they read the road graph. Step 3 solves for real, so it reads the turn
   graph, where the cost of a route includes what its turns cost. Run the
   junction reasoning on the turn graph instead and it says nothing at all:
   every road arc there runs from its own entry node to its own exit node, so
   the imbalance at both ends is the same for every street and no flip ever
   looks like an improvement. */

import { MCF_TIME_SCALE } from './config.js';
import { balance, nodeDemands } from './cpp.js';
import { liftMask } from './turns.js';

/* Collapse required arcs into streets: a pair when both directions exist and
   either would satisfy it, a single when the direction is forced - a genuine
   one-way, or a two-way road whose other direction fell outside the shape. */
export function groupStreets(g, required) {
  const streets = [];
  const seen = new Uint8Array(g.E);
  for (const a of g.arcsByOrder) {
    if (!required[a] || seen[a]) continue;
    const rev = g.reciprocal[a];
    if (rev >= 0 && required[rev] && !seen[rev]) {
      streets.push([a, rev]);
      seen[a] = seen[rev] = 1;
    } else {
      streets.push([a]);
      seen[a] = 1;
    }
  }
  return streets;
}

/* Pick a direction per street, keeping junctions as balanced as possible.

   Forced directions go first so their imbalance is already counted, then the
   choosable streets are taken longest-first: a long street is the bigger
   lever, so it should choose while the tally is still uncommitted. */
export function orientGreedily(g, streets) {
  const imbalance = new Int32Array(g.N);
  const chosen = new Uint8Array(g.E);
  for (const street of streets) {
    if (street.length !== 1) continue;
    const a = street[0];
    imbalance[g.tail[a]]++; imbalance[g.head[a]]--;
    chosen[a] = 1;
  }
  const choosable = streets.filter((s) => s.length === 2);
  choosable.sort((s, t) => (g.length[t[0]] - g.length[s[0]]) || (g.order[s[0]] - g.order[t[0]]));
  for (const [forward, backward] of choosable) {
    const u = g.tail[forward], v = g.head[forward];
    const keep = Math.abs(imbalance[u] + 1) + Math.abs(imbalance[v] - 1);
    const flip = Math.abs(imbalance[u] - 1) + Math.abs(imbalance[v] + 1);
    const pick = keep <= flip ? forward : backward;
    imbalance[g.tail[pick]]++; imbalance[g.head[pick]]--;
    chosen[pick] = 1;
  }
  return chosen;
}

/* What the local search minimises: driving plus what the turns cost. */
export function totalCost(g, mult) {
  let total = 0;
  for (let a = 0; a < g.E; a++) total += g.cost[a] * mult[a];
  return total;
}

/* The driving alone, for saying out loud. Turn prices steer the search but
   nobody spends them, so quoting them back as minutes would be a lie. */
function drivingCost(exp, mult) {
  const g = exp.roads;
  let total = 0;
  for (let a = 0; a < exp.roadArcs; a++) total += g.cost[a] * mult[a];
  return total;
}

/* Streets whose reversal would reduce junction imbalance, best first.

   Imbalance ignores how far the deadhead would actually have to travel, so it
   is only used to *rank* candidates. The re-solved cost makes the decision. */
function flipCandidates(g, choosable, chosen, demands, passes) {
  const ranked = [];
  for (const street of choosable) {
    const current = chosen[street[0]] ? street[0] : street[1];
    const du = demands[g.tail[current]], dv = demands[g.head[current]];
    const before = Math.abs(du) + Math.abs(dv);
    const after = Math.abs(du - 2 * passes) + Math.abs(dv + 2 * passes);
    if (after < before) ranked.push({ gain: after - before, street });
  }
  ranked.sort((a, b) => (a.gain - b.gain) || (g.order[a.street[0]] - g.order[b.street[0]]));
  return ranked;
}

export function verifyCoversEveryStreet(streets, mult) {
  const missed = streets.filter((s) => !s.some((a) => mult[a] > 0)).length;
  if (missed) throw new Error(`${missed} streets are never driven`);
}

/* Traversal counts for driving every street once, direction free. `exp` is the
   turn graph from turns.expandTurns(); `required` is a mask over road arcs.
   Returns { mult, info } with mult over the *turn* graph's arcs; `info` records
   what the local search managed. */
export function balanceOneway(exp, required, { passes, timeBudgetS, maxRounds = 60, progress = null }) {
  if (passes < 1) throw new Error('passes must be at least 1');
  const say = progress || (() => {});
  const g = exp.roads, t = exp.graph;
  const streets = groupStreets(g, required);
  const choosable = streets.filter((s) => s.length === 2);

  let chosen = orientGreedily(g, streets);
  let mult = balance(t, liftMask(exp, chosen), passes);
  let cost = totalCost(t, mult);
  const initialCost = cost;

  const started = performance.now();
  let rounds = 0, accepted = 0;
  let batch = Math.max(1, Math.floor(choosable.length / 20));

  while (choosable.length && rounds < maxRounds && batch >= 1) {
    if ((performance.now() - started) / 1000 > timeBudgetS) {
      console.info('one-way local search hit its time budget');
      break;
    }
    rounds++;
    const ranked = flipCandidates(g, choosable, chosen, nodeDemands(g, chosen, passes), passes);
    if (!ranked.length) break;

    const trial = chosen.slice();
    for (const { street } of ranked.slice(0, batch)) {
      const [forward, backward] = street;
      if (trial[forward]) { trial[forward] = 0; trial[backward] = 1; }
      else { trial[backward] = 0; trial[forward] = 1; }
    }

    let trialMult;
    try {
      trialMult = balance(t, liftMask(exp, trial), passes);
    } catch (err) {
      batch = Math.floor(batch / 2);
      continue;
    }
    const trialCost = totalCost(t, trialMult);
    if (trialCost < cost) {
      chosen = trial; mult = trialMult; cost = trialCost;
      accepted++;
      say('balance', `one-way route down to ${Math.round(drivingCost(exp, mult) / (MCF_TIME_SCALE * 60))} min`);
    } else {
      // Overshot. A smaller batch can still find a gain this one buried.
      batch = Math.floor(batch / 2);
    }
  }

  const info = {
    streets: streets.length,
    choosable_streets: choosable.length,
    forced_streets: streets.length - choosable.length,
    search_rounds: rounds,
    improvements: accepted,
    improvement_pct: initialCost ? Math.round(1000 * (initialCost - cost) / initialCost) / 10 : 0,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
  console.info('one-way:', info);
  verifyCoversEveryStreet(streets, mult);
  return { mult, info };
}

/* The arcs that count as 'required driving' rather than deadheading. In one-way
   mode the chosen direction is whichever one the solution actually drives, so
   it can only be read back off the result. */
export function requiredForStats(g, mult, streets) {
  const chosen = new Uint8Array(g.E);
  for (const street of streets) {
    let pick = -1;
    for (const a of street) {
      if (mult[a] > 0 && (pick < 0 || g.order[a] < g.order[pick])) pick = a;
    }
    if (pick >= 0) chosen[pick] = 1;
  }
  return chosen;
}
