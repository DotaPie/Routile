/* Geometry on lat/lon: distances, bearings, polygons.

   Two coordinate conventions live here and must not be mixed up:

   * A *ring* (the drawn area) is an array of [lon, lat] pairs, not closed.
   * An arc *geometry* is a flat Float64Array [lon0, lat0, lon1, lat1, ...],
     always oriented tail -> head. Flat because there are tens of thousands. */

import { BEARING_RUN_M } from './config.js';

export const EARTH_R = 6_371_008.8;   // mean radius, for buffers and areas
export const OSM_EARTH_R = 6_371_009;  // what OSMnx uses for edge lengths

export const rad = (d) => d * Math.PI / 180;
export const deg = (r) => r * 180 / Math.PI;

export function haversineM(lon1, lat1, lon2, lat2, R = EARTH_R) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Initial compass bearing in degrees [0, 360). */
export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((deg(Math.atan2(y, x)) % 360) + 360) % 360;
}

/* Signed turn in degrees, (-180, 180]. 0 is straight on, +/-180 a U-turn. */
export function turnAngle(incoming, outgoing) {
  return ((((outgoing - incoming + 180) % 360) + 360) % 360) - 180;
}

/* ------------------------------------------------------------ arc geometry */
export function geomLengthM(geom, R = OSM_EARTH_R) {
  let total = 0;
  for (let i = 2; i < geom.length; i += 2) {
    total += haversineM(geom[i - 2], geom[i - 1], geom[i], geom[i + 1], R);
  }
  return total;
}

/* Length in degrees - the unit the inside/outside test is done in. */
export function geomLengthDeg(geom) {
  let total = 0;
  for (let i = 2; i < geom.length; i += 2) {
    total += Math.hypot(geom[i] - geom[i - 2], geom[i + 1] - geom[i - 1]);
  }
  return total;
}

/* [lon, lat] at a normalised distance along the line.

   Used to place waypoints mid-street. A waypoint at an intersection node is
   ambiguous across 3-5 branches when a router snaps it and therefore forces no
   particular street; a mid-street point forces exactly one. */
export function pointAlong(geom, frac = 0.5) {
  const total = geomLengthDeg(geom);
  if (total === 0) return [geom[0], geom[1]];
  let target = Math.min(Math.max(frac, 0), 1) * total;
  for (let i = 2; i < geom.length; i += 2) {
    const seg = Math.hypot(geom[i] - geom[i - 2], geom[i + 1] - geom[i - 1]);
    if (target <= seg) {
      const t = seg === 0 ? 0 : target / seg;
      return [geom[i - 2] + (geom[i] - geom[i - 2]) * t,
              geom[i - 1] + (geom[i + 1] - geom[i - 1]) * t];
    }
    target -= seg;
  }
  const n = geom.length;
  return [geom[n - 2], geom[n - 1]];
}

/* How the road runs at one end of an arc, as [x0, y0, x1, y1] *in the
   direction of travel*: leaving the start vertex, or arriving at the end one.
   Either way it spans about `runM` metres.

   The direction matters and is easy to get backwards. Both ends are walked
   outward from the vertex, because that is where the measurement has to be
   anchored, but the segment for the far end is then handed back reversed, so
   the bearing it yields is the one a car arrives on rather than the one it
   would leave on going the other way. Get that wrong and every turn angle comes
   out 180 degrees off: straight on reads as a U-turn and a U-turn reads as
   straight on.

   Not the first two distinct vertices, which is the obvious reading and the
   wrong one. At a micro-mapped junction the first vertex is often a few metres
   away, on a stub angled into the give-way line rather than along the road, and
   a bearing taken off it is not the bearing a driver turns through. Measured
   over 15 m instead of 5 m the same movement can come out 25 degrees sharper -
   which is the difference between a turn the solver prices and one it does not.

   An arc shorter than `runM` simply uses all of itself. */
function endRun(geom, atStart, runM) {
  const n = geom.length / 2;
  if (n < 2) return null;
  const ax = atStart ? geom[0] : geom[2 * n - 2];
  const ay = atStart ? geom[1] : geom[2 * n - 1];
  const oriented = (bx, by) => (atStart ? [ax, ay, bx, by] : [bx, by, ax, ay]);
  let px = ax, py = ay, run = 0;
  for (let k = 1; k < n; k++) {
    const i = atStart ? k : n - 1 - k;
    const qx = geom[2 * i], qy = geom[2 * i + 1];
    const step = haversineM(px, py, qx, qy);
    if (step === 0) continue;
    if (run + step >= runM) {
      // Interpolate rather than take the vertex beyond: over a long straight
      // first segment those two are different directions, and the interpolated
      // one is the one the road actually leaves the junction on.
      const t = (runM - run) / step;
      return oriented(px + (qx - px) * t, py + (qy - py) * t);
    }
    run += step;
    px = qx; py = qy;
  }
  return run > 0 ? oriented(px, py) : null;
}

/* [departure bearing at the start, arrival bearing at the end], or null. */
export function arcBearings(geom, runM = BEARING_RUN_M) {
  const first = endRun(geom, true, runM);
  const last = endRun(geom, false, runM);
  if (!first || !last) return null;
  return [bearing(...first), bearing(...last)];
}

/* The first `runM` metres of an arc as a two-point line - the geometry a turn
   onto that arc is given, so it carries a bearing without carrying a length. */
export function startRun(geom, runM = BEARING_RUN_M) {
  const s = endRun(geom, true, runM);
  return s ? Float64Array.of(s[0], s[1], s[2], s[3])
           : Float64Array.of(geom[0], geom[1], geom[0], geom[1]);
}

/* ------------------------------------------------------------------- rings */
export function ringBounds(ring) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

/* A *polygon* is an array of rings: the outline first, then any holes. Merging
   zones can punch a hole - four rectangles laid out in a square leave the
   middle uncovered - and a road in that middle is not one you asked for. */
export function pointInPolygon(rings, x, y) {
  if (!pointInRing(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(rings[i], x, y)) return false;
  }
  return true;
}

/* Non-zero winding rule, so a freehand loop that overlaps itself still counts
   everything it went round as inside. */
export function pointInRing(ring, x, y) {
  let wn = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    if (y0 <= y) {
      if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) wn++;
    } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) {
      wn--;
    }
  }
  return wn !== 0;
}

/* Parameter along a->b where it crosses p->q, or -1 if it does not. */
function crossingParam(ax, ay, bx, by, px, py, qx, qy) {
  const rx = bx - ax, ry = by - ay, sx = qx - px, sy = qy - py;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-18) return -1;   // parallel or collinear
  const t = ((px - ax) * sy - (py - ay) * sx) / denom;
  const u = ((px - ax) * ry - (py - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

/* How much of a polyline lies inside the polygon, in degrees.

   Each segment is cut at every crossing with any of the polygon's rings and
   each piece is classified by its midpoint, so a road that dips in and out - or
   that crosses a hole - is measured correctly rather than by its endpoints. */
export function insideLengthDeg(geom, rings, bounds = ringBounds(rings[0])) {
  const [minx, miny, maxx, maxy] = bounds;
  let total = 0;
  const ts = [];
  for (let i = 2; i < geom.length; i += 2) {
    const ax = geom[i - 2], ay = geom[i - 1], bx = geom[i], by = geom[i + 1];
    if (Math.max(ax, bx) < minx || Math.min(ax, bx) > maxx
        || Math.max(ay, by) < miny || Math.min(ay, by) > maxy) continue;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;

    ts.length = 0;
    ts.push(0, 1);
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const [px, py] = ring[k];
        const [qx, qy] = ring[(k + 1) % n];
        const t = crossingParam(ax, ay, bx, by, px, py, qx, qy);
        if (t >= 0) ts.push(t);
      }
    }
    ts.sort((a, b) => a - b);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < 1e-12) continue;
      const tm = (t0 + t1) / 2;
      if (pointInPolygon(rings, ax + (bx - ax) * tm, ay + (by - ay) * tm)) {
        total += (t1 - t0) * segLen;
      }
    }
  }
  return total;
}

/* Area of a ring on the sphere, in square metres. At latitude 48 a degree of
   longitude is 74 km against 111 for latitude, so degrees squared would be
   wrong by half; this formula gets the ellipsoid right to well under 1%. */
export function sphericalAreaM2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return Math.abs(total * EARTH_R * EARTH_R / 2);
}

/* A point guaranteed to lie inside the ring, unlike a centroid.

   A C-shaped freehand loop has its centroid outside itself, which would put
   the default start pin on a road nobody has to drive. Take the horizontal
   line through the middle and the midpoint of its widest run inside. */
export function representativePoint(ring) {
  const [minx, miny, maxx, maxy] = ringBounds(ring);
  const y = (miny + maxy) / 2;
  const xs = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
  }
  xs.sort((a, b) => a - b);
  let best = null;
  for (let i = 1; i < xs.length; i++) {
    const mid = (xs[i - 1] + xs[i]) / 2;
    const width = xs[i] - xs[i - 1];
    if (width > 0 && pointInRing(ring, mid, y) && (!best || width > best.width)) {
      best = { width, x: mid };
    }
  }
  return best ? [best.x, y] : [(minx + maxx) / 2, y];
}
