/* The area to cover: one drawn shape - a rectangle, a circle or a freehand loop.

   Two things come apart here and keeping them apart is the point:

   * the **shape** decides which roads must be driven;
   * the **bounding box of that shape** decides what to download.

   Draw a ring road as a circle and the roads outside it are downloaded
   (deadheading is allowed to leave the area, as a human would) but never
   required. */

import { EARTH_R, deg, rad, representativePoint, ringBounds, sphericalAreaM2 } from './geo.js';

// A drawn circle becomes a polygon. 64 sides keeps its area within ~0.1% of a
// true circle, far below the accuracy of anything downstream.
const CIRCLE_SEGMENTS = 64;

export class AreaError extends Error {}

/* A lat/lon rectangle: left, bottom, right, top (west, south, east, north). */
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

  /* Expand outward to a fixed grid so nearby drags share one Overpass hit. */
  snapOut(gridDeg) {
    if (gridDeg <= 0) return this;
    return new BBox(
      Math.floor(this.left / gridDeg) * gridDeg,
      Math.floor(this.bottom / gridDeg) * gridDeg,
      Math.ceil(this.right / gridDeg) * gridDeg,
      Math.ceil(this.top / gridDeg) * gridDeg,
    );
  }

  /* Grow by an approximately equal distance on all four sides.

     Longitude degrees shrink with latitude, so the widest latitude edge is
     used for the longitude conversion - that over-buffers slightly, which is
     the safe direction for a fetch margin. */
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

function polygonShape(data) {
  const raw = data.points || [];
  const points = [];
  for (const item of raw) {
    let lat, lon;
    if (Array.isArray(item)) { lat = num(item[0], 'lat'); lon = num(item[1], 'lon'); }
    else if (item && typeof item === 'object') { lat = num(item.lat, 'lat'); lon = num(item.lon ?? item.lng, 'lon'); }
    else throw new AreaError('that outline has a malformed point');
    // Freehand drawing emits repeats whenever the pointer pauses; drop them.
    const last = points[points.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) points.push([lon, lat]);
  }
  if (points.length > 1) {
    const [a, b] = [points[0], points[points.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) points.pop();
  }
  if (points.length < 3) throw new AreaError('that outline needs at least three points');
  return { kind: 'polygon', points };
}

/* A metric circle as a lat/lon ring.

   Longitude degrees shrink with latitude, so a circle of fixed radius is an
   ellipse in degrees. Building it that way keeps the circle drawn on the map
   and the roads picked as required in agreement. */
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

export class Area {
  constructor(shape) {
    this.shape = shape;
    this.kind = shape.kind;
    if (shape.kind === 'rect') {
      this.ring = new BBox(shape.left, shape.bottom, shape.right, shape.top).ring();
    } else if (shape.kind === 'circle') {
      this.ring = circleRing(shape.lon, shape.lat, shape.radius);
    } else {
      this.ring = shape.points;
    }
    const [l, b, r, t] = ringBounds(this.ring);
    this.bounds = new BBox(l, b, r, t);   // what to download, not what to cover
  }

  /* From the UI's payload: {type: 'rect' | 'circle' | 'freehand', ...}. */
  static fromShape(data) {
    if (!data || typeof data !== 'object') throw new AreaError('nothing drawn yet');
    const kind = String(data.type || 'rect').toLowerCase();
    if (kind === 'rect' || kind === 'rectangle') return new Area(rectShape(data));
    if (kind === 'circle') return new Area(circleShape(data));
    if (kind === 'polygon' || kind === 'freehand') return new Area(polygonShape(data));
    throw new AreaError(`unknown shape type '${kind}'`);
  }

  /* A point inside the shape, for the default start. */
  get center() {
    if (this.kind === 'rect') return this.bounds.center;
    if (this.kind === 'circle') return [this.shape.lon, this.shape.lat];
    return representativePoint(this.ring);
  }

  areaKm2() { return sphericalAreaM2(this.ring) / 1e6; }

  validate(maxAreaKm2) {
    // The box is checked for sane coordinates only, never against the cap: a
    // circle's bounding box is 27% larger than the circle, so capping on the
    // box would refuse an area that is in fact within the limit.
    this.bounds.validate(Infinity);
    const area = this.areaKm2();
    if (!(area > 0)) throw new AreaError('the drawn area has no size');
    if (area > maxAreaKm2) {
      throw new AreaError(`the drawn area is ${area.toFixed(2)} km2, over the ${maxAreaKm2.toFixed(2)} km2 limit`);
    }
  }

  /* A stable text form, for cache keys. */
  key(decimals = 6) {
    const s = this.shape;
    if (s.kind === 'rect') return ['rect', s.left, s.bottom, s.right, s.top].map(fix(decimals)).join(':');
    if (s.kind === 'circle') return ['circle', s.lon, s.lat, s.radius].map(fix(decimals)).join(':');
    return 'polygon:' + s.points.map(([x, y]) => `${x.toFixed(decimals)},${y.toFixed(decimals)}`).join(';');
  }

  toJSON() {
    const s = this.shape;
    let shape;
    if (s.kind === 'rect') shape = { type: 'rect', left: s.left, bottom: s.bottom, right: s.right, top: s.top };
    else if (s.kind === 'circle') shape = { type: 'circle', lon: s.lon, lat: s.lat, radius_m: Math.round(s.radius * 10) / 10 };
    else shape = { type: 'polygon', points: s.points.map(([x, y]) => [y, x]) };
    return { shape, area_km2: Math.round(this.areaKm2() * 1000) / 1000 };
  }
}

const fix = (decimals) => (v) => (typeof v === 'number' ? v.toFixed(decimals) : String(v));
