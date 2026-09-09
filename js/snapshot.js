/* A picture of the route for the zip: the map around it, as a PNG.

   Composed on an offscreen canvas from the same OpenStreetMap tiles the page
   shows - the basemap, the drawn zones, one line per session, the start pin,
   a legend and the attribution. It is framed on the route rather than on
   whatever the screen happens to show, at the largest zoom that fits.

   Always the paper-white tile with the light palette, whichever theme the page
   is in: a file in a zip is a document, read later and maybe printed, and one
   look for it beats two. The dark map is a CSS filter on the page, and the
   canvas equivalent is not available in every browser anyway. */

const TILE = 256;
const tileUrl = (z, x, y) =>
  `https://${'abc'[(x + y) % 3]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

// Bounds on the picture. The zoom chosen is the largest at which the whole
// route, plus PAD on every side, still fits inside MAX_W x MAX_H.
const MAX_W = 1600;
const MAX_H = 1100;
const MIN_W = 640;
const MIN_H = 480;
const PAD = 60;
const MAX_ZOOM = 18;
const MIN_ZOOM = 4;
const TILE_TIMEOUT_MS = 12_000;

// The light theme's fixed colours, matching css/style.css.
const ZONE = '#35d29a';
const PIN = '#35d29a';
const PIN_RING = '#ffffff';
const INK = '#10151c';
const INK_2 = '#48525f';
const LINE = '#d6dce4';
const PAPER = 'rgba(255, 255, 255, 0.92)';
const SEA = '#e7ebef';

const PIN_PATH = 'M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif';

/* sessions: [{ points: [[lat, lon], ...], label, meta }], one per session.
   regions:  the drawn area as a MultiPolygon in [lon, lat].
   start:    [lat, lon] of the start pin, or null.
   palette:  line colours, one per session, cycled.
   title:    one line for the legend's head, e.g. "12.3 km · 1 h 5 min".
   Resolves to a PNG Blob; rejects if the map cannot be drawn. */
export async function mapSnapshot({ sessions, regions = [], start = null, palette, title = '' }) {
  // Framed on the routes, the zones and the start together: a route that
  // covers a zone runs right along its edge, and the outline is part of what
  // the picture is for.
  const everything = sessions.flatMap((s) => s.points);
  for (const rings of regions) {
    for (const ring of rings) for (const [lon, lat] of ring) everything.push([lat, lon]);
  }
  if (start) everything.push(start);
  if (everything.length < 2) throw new Error('nothing to picture');

  const f = frame(everything);
  const canvas = document.createElement('canvas');
  canvas.width = f.width;
  canvas.height = f.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, f.width, f.height);

  const drawn = await drawTiles(ctx, f);
  if (!drawn) throw new Error('no map tiles could be loaded');

  const at = (p) => {
    const [x, y] = project(p, f.zoom);
    return [x - f.left, y - f.top];
  };
  drawZones(ctx, regions, at);
  sessions.forEach((s, i) => drawLine(ctx, s.points, palette[i % palette.length], at));
  if (start) drawPin(ctx, at(start));
  drawLegend(ctx, sessions, palette, title);
  drawAttribution(ctx, f);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode the image'))), 'image/png');
  });
}

/* Web Mercator: [lat, lon] to world pixels at a zoom. */
function project([lat, lon], zoom) {
  const scale = TILE * 2 ** zoom;
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return [
    ((lon + 180) / 360) * scale,
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  ];
}

/* The zoom, size and world offset that frame the points with PAD around them. */
function frame(points) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
    const [x0, y0] = project([maxLat, minLon], zoom);
    const [x1, y1] = project([minLat, maxLon], zoom);
    const w = x1 - x0 + 2 * PAD;
    const h = y1 - y0 + 2 * PAD;
    if (w > MAX_W || h > MAX_H) continue;
    const width = Math.round(Math.max(w, MIN_W));
    const height = Math.round(Math.max(h, MIN_H));
    return {
      zoom, width, height,
      left: Math.round((x0 + x1) / 2 - width / 2),
      top: Math.round((y0 + y1) / 2 - height / 2),
    };
  }
  throw new Error('the route is too large to picture');
}

function loadTile(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';    // or the canvas is tainted and cannot be saved
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('tile timed out'));
    }, TILE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('tile failed')); };
    img.src = url;
  });
}

/* Every tile the frame touches, drawn as it arrives. Resolves to how many made
   it; a tile that fails leaves its square as background rather than sinking
   the whole picture. */
async function drawTiles(ctx, f) {
  const n = 2 ** f.zoom;
  const tx0 = Math.floor(f.left / TILE);
  const tx1 = Math.floor((f.left + f.width - 1) / TILE);
  const ty0 = Math.max(Math.floor(f.top / TILE), 0);
  const ty1 = Math.min(Math.floor((f.top + f.height - 1) / TILE), n - 1);
  let drawn = 0;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const x = ((tx % n) + n) % n;     // across the date line
      jobs.push(loadTile(tileUrl(f.zoom, x, ty)).then((img) => {
        ctx.drawImage(img, tx * TILE - f.left, ty * TILE - f.top);
        drawn += 1;
      }, () => {}));
    }
  }
  await Promise.all(jobs);
  return drawn;
}

function drawZones(ctx, regions, at) {
  if (!regions.length) return;
  ctx.beginPath();
  for (const rings of regions) {
    for (const ring of rings) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = at([lat, lon]);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
  }
  ctx.save();
  ctx.fillStyle = ZONE;
  ctx.globalAlpha = 0.08;
  ctx.fill('evenodd');            // outline then holes, as the map draws them
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ZONE;
  ctx.stroke();
  ctx.restore();
}

/* A session line, on a pale halo so it stays legible over the map's own roads. */
function drawLine(ctx, points, color, at) {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = at(p);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.restore();
}

/* The same pin as on the page, tip on the spot. */
function drawPin(ctx, [x, y]) {
  const k = 2;                    // the 24-unit glyph at 48 px
  const pin = new Path2D(PIN_PATH);
  ctx.save();
  ctx.translate(x - 12 * k, y - 21 * k);
  ctx.scale(k, k);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = PIN;
  ctx.fill(pin);
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PIN_RING;
  ctx.stroke(pin);
  ctx.beginPath();
  ctx.arc(12, 10, 2.6, 0, 2 * Math.PI);
  ctx.fillStyle = PIN_RING;
  ctx.fill();
  ctx.restore();
}

const LEGEND_ROWS_MAX = 12;

/* Top left: the head line, then a swatch and a line per session. */
function drawLegend(ctx, sessions, palette, title) {
  const rows = sessions.slice(0, LEGEND_ROWS_MAX);
  const more = sessions.length - rows.length;
  const padX = 14, padY = 12, rowH = 20, headH = title ? 24 : 0;
  const lines = rows.map((s) => `${s.label}  ${s.meta}`);
  if (more > 0) lines.push(`and ${more} more`);

  ctx.save();
  ctx.font = `13px ${FONT}`;
  let width = 0;
  for (const text of lines) width = Math.max(width, ctx.measureText(text).width + 22);
  ctx.font = `600 14px ${FONT}`;
  if (title) width = Math.max(width, ctx.measureText(`Routile  ·  ${title}`).width);
  const boxW = Math.ceil(width + 2 * padX);
  const boxH = padY * 2 + headH + lines.length * rowH;

  panel(ctx, 14, 14, boxW, boxH);
  let y = 14 + padY;
  if (title) {
    ctx.fillStyle = INK;
    ctx.font = `600 14px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(`Routile  ·  ${title}`, 14 + padX, y + headH / 2 - 1);
    y += headH;
  }
  ctx.font = `13px ${FONT}`;
  lines.forEach((text, i) => {
    const cy = y + i * rowH + rowH / 2;
    if (i < rows.length) {
      ctx.fillStyle = palette[i % palette.length];
      roundRect(ctx, 14 + padX, cy - 6, 12, 12, 3);
      ctx.fill();
      ctx.fillStyle = INK;
    } else {
      ctx.fillStyle = INK_2;
    }
    ctx.fillText(text, 14 + padX + 22, cy);
  });
  ctx.restore();
}

/* Bottom right, as the tile usage policy asks of any map picture handed on. */
function drawAttribution(ctx, f) {
  const text = '© OpenStreetMap contributors';
  ctx.save();
  ctx.font = `11px ${FONT}`;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  const h = 20;
  panel(ctx, f.width - w - 8, f.height - h - 8, w, h, 6);
  ctx.fillStyle = INK_2;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, f.width - w, f.height - h / 2 - 8);
  ctx.restore();
}

function panel(ctx, x, y, w, h, r = 10) {
  ctx.save();
  ctx.shadowColor = 'rgba(16, 21, 28, 0.12)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = PAPER;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
