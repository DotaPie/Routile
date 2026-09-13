/* The area to cover: one or more drawn zones - rectangles, circles, freehand
   loops, in any mix.

   Two things stay apart here, and that is the point: the zones decide which
   roads must be driven, the bounding box around them decides what to download.
   Roads outside the zones are fetched but never required, so deadheading may
   leave the area as a human driver would.

   Several zones merge into one job: a road is required if it lies in any zone,
   and deadheading between them stitches the single tour together. */

import { EARTH_R, deg, rad, representativePoint, ringBounds, sphericalAreaM2 } from './geo.js';

// A drawn circle becomes a polygon. 64 sides keeps its area within ~0.1% of a
// true circle, far below the accuracy of anything downstream.
const CIRCLE_SEGMENTS = 64;

export class AreaError extends Error {}

// A lat/lon rectangle: left, bottom, right, top (west, south, east, north).
export class BBox {
  constructor(left, bottom, right, top) {
    this.left = left; this.bottom = bottom; this.right = right; this.top = top;
  }

  get center() {
    return [(this.left + this.right) / 2, (this.bottom + this.top) / 2];
  }

  ring() {
    return [[this.left, this.bottom], [this.right, this.bottom],
            [this.right, this.top], [this.left, this.top]];
  }

  areaKm2() { return sphericalAreaM2(this.ring()) / 1e6; }

  contains(x, y) {
    return x >= this.left && x <= this.right && y >= this.bottom && y <= this.top;
  }

  validate(maxAreaKm2) {
    for (const [name, val, lo, hi] of [
      ['bottom', this.bottom, -90, 90], ['top', this.top, -90, 90],
      ['left', this.left, -180, 180], ['right', this.right, -180, 180],
    ]) {
      if (!Number.isFinite(val) || val < lo || val > hi) {
        throw new AreaError(`${name}=${val} out of range [${lo}, ${hi}]`);
      }
    }
    if (this.right <= this.left || this.top <= this.bottom) {
      throw new AreaError('that rectangle has no width or height');
    }
    const area = this.areaKm2();
    if (area > maxAreaKm2) {
      throw new AreaError(`rectangle is ${area.toFixed(2)} km2, over the ${maxAreaKm2.toFixed(2)} km2 cap`);
    }
  }

  // Expand outward to a fixed grid so nearby drags share one Overpass hit.
  snapOut(gridDeg) {
    if (gridDeg <= 0) return this;
    return new BBox(
      Math.floor(this.left / gridDeg) * gridDeg,
      Math.floor(this.bottom / gridDeg) * gridDeg,
      Math.ceil(this.right / gridDeg) * gridDeg,
      Math.ceil(this.top / gridDeg) * gridDeg,
    );
  }

  // Grow by roughly equal distance on all four sides. Longitude degrees shrink
  // with latitude, so the widest latitude edge drives the longitude conversion;
  // that over-buffers slightly, the safe direction for a fetch margin.
  bufferM(metres) {
    if (metres <= 0) return this;
    const dlat = deg(metres / EARTH_R);
    const worstLat = Math.max(Math.abs(this.bottom), Math.abs(this.top));
    const cosLat = Math.max(Math.cos(rad(worstLat)), 1e-6);
    const dlon = deg(metres / (EARTH_R * cosLat));
    return new BBox(
      Math.max(this.left - dlon, -180), Math.max(this.bottom - dlat, -90),
      Math.min(this.right + dlon, 180), Math.min(this.top + dlat, 90),
    );
  }

  key(decimals = 7) {
    return [this.left, this.bottom, this.right, this.top]
      .map((v) => v.toFixed(decimals)).join(',');
  }
}

/* ------------------------------------------------------------ shape parsing */
function num(value, what) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new AreaError(`${what} must be a number`);
  return n;
}

function rectShape(data) {
  const left = num(data.west ?? data.left, 'west');
  const bottom = num(data.south ?? data.bottom, 'south');
  const right = num(data.east ?? data.right, 'east');
  const top = num(data.north ?? data.top, 'north');
  if (right <= left || top <= bottom) throw new AreaError('that rectangle has no width or height');
  return { kind: 'rect', left, bottom, right, top };
}

function circleShape(data) {
  const lat = num(data.lat, 'lat');
  const lon = num(data.lon ?? data.lng, 'lon');
  const radius = num(data.radius_m ?? data.radius, 'radius_m');
  if (radius <= 0) throw new AreaError('that circle has no radius');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new AreaError('the circle centre is outside the world');
  }
  return { kind: 'circle', lon, lat, radius };
}

// [lat, lon] pairs in, an unclosed ring of [lon, lat] out.
function parseRing(raw, what) {
  const points = [];
  for (const item of raw || []) {
    let lat, lon;
    if (Array.isArray(item)) { lat = num(item[0], 'lat'); lon = num(item[1], 'lon'); }
    else if (item && typeof item === 'object') { lat = num(item.lat, 'lat'); lon = num(item.lon ?? item.lng, 'lon'); }
    else throw new AreaError(`that ${what} has a malformed point`);
    // Freehand emits repeats when the pointer pauses, and a merged ring arrives
    // closed; either way, drop the duplicate.
    const last = points[points.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) points.push([lon, lat]);
  }
  if (points.length > 1) {
    const [a, b] = [points[0], points[points.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) points.pop();
  }
  if (points.length < 3) throw new AreaError(`that ${what} needs at least three points`);
  return points;
}

function polygonShape(data) {
  const points = parseRing(data.points, 'outline');
  // Merging zones can leave a hole; anything inside one is not covered.
  const holes = (data.holes || []).map((ring) => parseRing(ring, 'hole'));
  return { kind: 'polygon', points, holes };
}

// Several zones as one area. Nested multis are flattened, so a payload built
// by appending to an existing one cannot grow a tree.
function multiShape(data) {
  const raw = data.shapes || data.parts || [];
  if (!Array.isArray(raw) || raw.length === 0) throw new AreaError('no zones drawn yet');
  const parts = [];
  for (const item of raw) {
    const part = parseShape(item);
    if (part.kind === 'multi') parts.push(...part.parts);
    else parts.push(part);
  }
  // One zone is not a multi: it keeps the plain shape's cache key, so drawing a
  // second zone and undoing it does not force a recompute of the first.
  return parts.length === 1 ? parts[0] : { kind: 'multi', parts };
}

// A metric circle as a lat/lon ring. Longitude degrees shrink with latitude, so
// a fixed-radius circle is an ellipse in degrees; building it that way keeps
// the drawn circle and the roads picked as required in agreement.
function circleRing(lon, lat, radiusM) {
  const dlat = deg(radiusM / EARTH_R);
  const cosLat = Math.max(Math.cos(rad(lat)), 1e-6);
  const dlon = deg(radiusM / (EARTH_R * cosLat));
  const ring = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = 2 * Math.PI * i / CIRCLE_SEGMENTS;
    ring.push([lon + dlon * Math.cos(a), lat + dlat * Math.sin(a)]);
  }
  return ring;
}

// One zone as a polygon: outline first, then any holes.
function ringsOfShape(shape) {
  if (shape.kind === 'rect') {
    return [new BBox(shape.left, shape.bottom, shape.right, shape.top).ring()];
  }
  if (shape.kind === 'circle') return [circleRing(shape.lon, shape.lat, shape.radius)];
  return [shape.points, ...(shape.holes || [])];
}

function parseShape(data) {
  if (!data || typeof data !== 'object') throw new AreaError('nothing drawn yet');
  const kind = String(data.type || data.kind || 'rect').toLowerCase();
  if (kind === 'rect' || kind === 'rectangle') return rectShape(data);
  if (kind === 'circle') return circleShape(data);
  if (kind === 'polygon' || kind === 'freehand') return polygonShape(data);
  if (kind === 'multi') return multiShape(data);
  throw new AreaError(`unknown shape type '${kind}'`);
}

export class Area {
  constructor(shape) {
    this.shape = shape;
    this.kind = shape.kind;
    this.parts = shape.kind === 'multi' ? shape.parts : [shape];
    // One entry per zone: [outline, ...holes].
    this.regions = this.parts.map(ringsOfShape);
    this.ring = this.regions[0][0];   // single-zone callers still read this
    const outlines = this.regions.map((rings) => rings[0]);
    const [l, b, r, t] = ringBounds(outlines.flat());
    this.bounds = new BBox(l, b, r, t);   // what to download, not what to cover
  }

  // From the UI's payload: {type: 'rect' | 'circle' | 'freehand' | 'multi'}.
  static fromShape(data) {
    return new Area(parseShape(data));
  }

  // A point inside the area, for the default start. With several zones the
  // biggest gets the pin, since the drive spends most of its time there.
  get center() {
    if (this.kind === 'multi') {
      let best = null;
      for (const part of this.parts) {
        const a = new Area(part);
        const km2 = a.areaKm2();
        if (!best || km2 > best.km2) best = { km2, center: a.center };
      }
      return best.center;
    }
    if (this.kind === 'rect') return this.bounds.center;
    if (this.kind === 'circle') return [this.shape.lon, this.shape.lat];
    return representativePoint(this.ring);
  }

  // Zones arrive merged, so they never overlap and this is a plain sum: each
  // outline less whatever its holes take back out.
  areaKm2() {
    let total = 0;
    for (const rings of this.regions) {
      total += sphericalAreaM2(rings[0]);
      for (let i = 1; i < rings.length; i++) total -= sphericalAreaM2(rings[i]);
    }
    return Math.max(total, 0) / 1e6;
  }

  validate(maxAreaKm2) {
    // Coordinates only, never the cap: a circle's bounding box is 27% larger
    // than the circle, so capping on the box would refuse a legal area.
    this.bounds.validate(Infinity);
    const area = this.areaKm2();
    if (!(area > 0)) throw new AreaError('the drawn area has no size');
    if (area > maxAreaKm2) {
      throw new AreaError(`the drawn area is ${area.toFixed(2)} km2, over the ${maxAreaKm2.toFixed(2)} km2 limit`);
    }
  }

  // A stable text form for cache keys. Zones are sorted, so drawing the same
  // two in the other order hits the same cached result.
  key(decimals = 6) {
    return this.parts.map((s) => shapeKey(s, decimals)).sort().join('+');
  }

  toJSON() {
    const shapes = this.parts.map(shapeJSON);
    return {
      shape: shapes.length === 1 ? shapes[0] : { type: 'multi', shapes },
      area_km2: Math.round(this.areaKm2() * 1000) / 1000,
    };
  }
}

const ringKey = (ring, d) =>
  ring.map(([x, y]) => `${x.toFixed(d)},${y.toFixed(d)}`).join(';');

function shapeKey(s, decimals) {
  if (s.kind === 'rect') return ['rect', s.left, s.bottom, s.right, s.top].map(fix(decimals)).join(':');
  if (s.kind === 'circle') return ['circle', s.lon, s.lat, s.radius].map(fix(decimals)).join(':');
  return ['polygon', ringKey(s.points, decimals),
          ...(s.holes || []).map((h) => ringKey(h, decimals))].join('|');
}

const ringJSON = (ring) => ring.map(([x, y]) => [y, x]);

function shapeJSON(s) {
  if (s.kind === 'rect') return { type: 'rect', left: s.left, bottom: s.bottom, right: s.right, top: s.top };
  if (s.kind === 'circle') return { type: 'circle', lon: s.lon, lat: s.lat, radius_m: Math.round(s.radius * 10) / 10 };
  const out = { type: 'polygon', points: ringJSON(s.points) };
  if (s.holes && s.holes.length) out.holes = s.holes.map(ringJSON);
  return out;
}

const fix = (decimals) => (v) => (typeof v === 'number' ? v.toFixed(decimals) : String(v));
