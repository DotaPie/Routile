/* Direction arrows and waypoint dots, drawn on one canvas.

   Both used to be one DOM node each - a divIcon marker per arrow, an SVG path
   per dot - and a city-sized route makes thousands of them. The browser then
   positions and composites every one on every pan, on the main thread, which
   is why a fast machine helped no more than a slow one: none of that work is
   parallel and none of it is on the GPU. Here they are a few hundred draw
   calls into a single element, and the arrow's halo comes free as a wider
   stroke underneath rather than as a per-element CSS drop-shadow.

   The canvas covers the viewport plus a margin and is redrawn when a gesture
   ends, so a drag always has something drawn under it; Leaflet moves the whole
   pane in the meantime, which keeps what is drawn registered to the map. */

// Of the viewport, on each side. Leaflet's own canvas renderer uses 0.1; a
// little more buys a longer drag before the edge shows.
const PAD = 0.2;

/* Ceilings per redraw, across all sessions. Canvas would happily draw ten
   times these, but past a few hundred they stop being marks you can read and
   become texture - and the ceiling is what stops a 400 km route at high zoom
   from being a different experience than a 4 km one. Beyond the cap the marks
   are thinned by an even stride rather than truncated, so they stay spread
   over the whole view instead of filling one corner. */
const ARROW_MAX = 400;
const DOT_MAX = 2000;

// The arrow, centred on the origin and pointing east: the same shaft and
// chevron as the tool bar's icons, at the 14px size they were drawn for.
const ARROW_PATH = new Path2D('M-4 0 h7 M0.5 -3 l3 3 l-3 3');
const ARROW_INK = 2.2;
const ARROW_HALO = 4.2;

const DOT_R = 3.5;
const DOT_RING = 1.5;

/* Options:
     arrowZoom, pointZoom  the zoom each kind starts being drawn at
     halo                  colour drawn under the arrows and around the dots
     dot                   fill colour for the waypoint dots */
export const DetailLayer = L.Layer.extend({
  options: { arrowZoom: 15, pointZoom: 16, halo: '#ffffff', dot: '#10151c' },

  initialize(options) {
    L.setOptions(this, options);
    this._arrows = [];        // per session: [{ lat, lon, deg }]
    this._colors = [];        // per session
    this._dots = [];          // [{ lat, lon }]
    this._only = null;        // highlighted session, or null for all
  },

  /* arrows: one array of { lat, lon, deg } per session, index-aligned with
     colors. dots: a flat list of { lat, lon }. */
  setRoute({ arrows = [], colors = [], dots = [] } = {}) {
    this._arrows = arrows;
    this._colors = colors;
    this._dots = dots;
    this._only = null;
    this._draw();
  },

  clear() {
    this.setRoute();
  },

  /* New colours without new geometry: the day/night button swaps the basemap
     under the marks, so the route hues and the halo they sit on both change
     while the arrows and dots stay exactly where they are. */
  restyle({ colors, halo, dot }) {
    if (colors) this._colors = colors;
    if (halo) this.options.halo = halo;
    if (dot) this.options.dot = dot;
    this._draw();
  },

  /* Show one session's arrows alone, or all of them again with null. The dots
     belong to the whole route, so they are not touched. */
  setHighlight(index) {
    this._only = index;
    this._draw();
  },

  onAdd() {
    const canvas = L.DomUtil.create('canvas', 'route-detail leaflet-layer');
    // Tells Leaflet to carry the canvas along with the map's own zoom
    // animation instead of hiding it and popping it back at the end.
    L.DomUtil.addClass(canvas, 'leaflet-zoom-animated');
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    this.getPane().appendChild(canvas);

    // moveend covers a zoom too - it fires after zoomend - so one handler is
    // enough for both.
    this._map.on('moveend viewreset resize', this._reset, this);
    this._map.on('zoomanim', this._animateZoom, this);
    this._reset();
  },

  onRemove() {
    this._map.off('moveend viewreset resize', this._reset, this);
    this._map.off('zoomanim', this._animateZoom, this);
    L.DomUtil.remove(this._canvas);
    this._canvas = this._ctx = null;
  },

  _reset() {
    const map = this._map;
    const size = map.getSize();
    // Layer coordinates of the canvas' top left corner, a margin out from the
    // viewport's.
    const min = map.containerPointToLayerPoint(size.multiplyBy(-PAD)).round();
    const span = size.multiplyBy(1 + PAD * 2).round();

    // Backing store in device pixels, box in CSS pixels: the marks are hairline
    // strokes and would be mush at 1x on a hidpi screen.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._canvas.width = span.x * dpr;
    this._canvas.height = span.y * dpr;
    this._canvas.style.width = `${span.x}px`;
    this._canvas.style.height = `${span.y}px`;
    L.DomUtil.setPosition(this._canvas, min);

    this._min = min;
    this._span = span;
    // Setting width resets the context, so the scale goes on afterwards. Every
    // coordinate below is then in CSS pixels.
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Where the canvas sits, for the zoom animation to interpolate from.
    this._origin = map.layerPointToLatLng(min);
    this._zoom = map.getZoom();
    this._draw();
  },

  /* Leaflet animates a zoom by transforming panes; the canvas is a bitmap of
     the old zoom, so it is scaled and shifted to match and redrawn for real
     once the animation lands. */
  _animateZoom(e) {
    const scale = this._map.getZoomScale(e.zoom, this._zoom);
    const offset = this._map._latLngToNewLayerPoint(this._origin, e.zoom, e.center);
    L.DomUtil.setTransform(this._canvas, offset, scale);
  },

  _draw() {
    if (!this._ctx || !this._map) return;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._span.x, this._span.y);

    const zoom = this._map.getZoom();
    // The same margin the canvas was sized with, so nothing inside it is left
    // undrawn.
    const view = this._map.getBounds().pad(PAD);
    if (zoom >= this.options.pointZoom) this._drawDots(ctx, view);
    if (zoom >= this.options.arrowZoom) this._drawArrows(ctx, view);
  },

  _drawArrows(ctx, view) {
    // Gathered before any drawing so the cap counts the whole route rather
    // than running out partway through the first session.
    const visible = [];
    this._arrows.forEach((arrows, session) => {
      if (!arrows) return;
      if (this._only !== null && session !== this._only) return;
      for (const a of arrows) {
        if (view.contains([a.lat, a.lon])) visible.push([session, a]);
      }
    });

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [session, a] of stride(visible, ARROW_MAX)) {
      const p = this._at(a.lat, a.lon);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((a.deg - 90) * Math.PI / 180);
      // Halo first, in the map's own background, so an arrow stays readable
      // over a dark building or a road of its own colour.
      ctx.strokeStyle = this.options.halo;
      ctx.lineWidth = ARROW_HALO;
      ctx.stroke(ARROW_PATH);
      ctx.strokeStyle = this._colors[session] || this.options.dot;
      ctx.lineWidth = ARROW_INK;
      ctx.stroke(ARROW_PATH);
      ctx.restore();
    }
  },

  _drawDots(ctx, view) {
    const visible = this._dots.filter((d) => view.contains([d.lat, d.lon]));
    ctx.fillStyle = this.options.dot;
    ctx.strokeStyle = this.options.halo;
    ctx.lineWidth = DOT_RING;
    // One path for every dot: a fill and a stroke in total, rather than two
    // per dot.
    ctx.beginPath();
    for (const d of stride(visible, DOT_MAX)) {
      const p = this._at(d.lat, d.lon);
      ctx.moveTo(p.x + DOT_R, p.y);
      ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  },

  /* Map position to a pixel on the canvas. */
  _at(lat, lon) {
    return this._map.latLngToLayerPoint([lat, lon]).subtract(this._min);
  },
});

/* At most `max` of `list`, spread evenly across it. */
function* stride(list, max) {
  const step = list.length > max ? list.length / max : 1;
  for (let i = 0; i < list.length; i += step) yield list[Math.floor(i)];
}
