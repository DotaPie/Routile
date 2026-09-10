/* Tunable constants for Routile.

   Several values here are EMPIRICAL: they can only be calibrated by driving a
   generated route and watching what the navigation app actually does. */

// Bump on ANY algorithm change, or the result cache will serve stale routes
// and you will chase phantom bugs.
export const ALGO_VERSION = '9';

// -------------------------------------------------------------------- basemap
// Throw away key for this project - an actual human comment
export const CARTO_API_KEY = 'cb1_3fme_1_eb3991beb7b07217ee922ba3';

/* The two basemaps the day/night button switches between. Dark Matter and
   Positron are a matched pair - the same cartography, drawn for opposite
   grounds - so the map keeps its shape across the switch and only its ground
   changes.

   Both are backdrop styles: deliberately drained of colour and stripped of
   POI icons, so neither shows parking, shops or amenities the way OSM's own
   rendering does. That is the trade for a keyed, quota-backed tile source.
   'rastertiles/voyager' is the third of the set, a touch warmer than Positron.

   CARTO is retiring raster in favour of vector, so treat these as a
   comfortable stopgap rather than a permanent address. */
export const CARTO_STYLE_DARK = 'dark_all';
export const CARTO_STYLE_LIGHT = 'light_all';

// Which one a first-time visitor gets; after that their own choice is
// remembered. 'dark' or 'light'.
export const MAP_MODE_DEFAULT = 'dark';

/* One route palette per basemap, because the same line cannot read on both.
   Both avoid green, which the drawn zone's outline wears, and both lead with
   violet rather than orange: road maps paint primary roads orange and trunk
   roads salmon, so an orange route is easy to mistake for the map's own
   colouring. */

// Over the dark basemap: bright and saturated, near enough to glowing.
export const ROUTE_PALETTE_DARK = ['#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#facc15',
                                   '#f87171', '#60a5fa', '#e879f9', '#38bdf8', '#fda4af'];

// Over the light basemap, and over the exported PNG, which is paper white and
// may well be printed: the same hues taken darker, so they read as ink rather
// than as highlighter.
export const ROUTE_PALETTE_LIGHT = ['#7c3aed', '#0284c7', '#c026d3', '#ea580c', '#e11d48',
                                    '#4f46e5', '#ca8a04', '#be123c', '#0369a1', '#a21caf'];

// ---------------------------------------------------------------- area limits
// No product-level cap: draw whatever you like. This ceiling is deliberately far
// larger than any country-sized rectangle anyone would drag by hand, and exists
// only so a nonsense request (a whole hemisphere) fails with a clear message
// rather than grinding away at Overpass.
export const AREA_CAP_KM2 = 50_000;

// ------------------------------------------------------------ private roads
// Private roads are off by default: a street sweep means the public streets,
// and the driveways and yards behind a gate are somebody's property. Turning
// it on is a deliberate act - see roadFilter() in osm.js for exactly what it
// admits.
export const INCLUDE_PRIVATE_DEFAULT = false;

// ---------------------------------------------------------------- OSM fetching
// Fetch beyond the drawn shape so deadhead legs may leave it (what a human
// driver would do) and so fewer required arcs get orphaned by the SCC prune.
//
// This is not a cosmetic margin. A one-way street whose way back lies outside
// the fetch box belongs to no strongly connected component and is *deleted*, so
// too small a buffer shows up directly as missing coverage. Measured on 1.5 km2
// of Petrzalka - long one-way loops, the worst case for this:
//
//     buffer      500 m   1000 m   2000 m   4000 m
//     coverage    70.3%    72.9%    71.3%   100.0%
//
// The roads that go missing are a *boundary* effect, so the buffer a shape needs
// is set by the local street layout - kilometres - not by the shape's size. The
// cost, though, is the area downloaded. So instead of a fixed distance we spend
// a fixed download budget: a small shape gets the full 4 km because it can
// afford it, a large one gets less because proportionally it loses less.
export const FETCH_BUDGET_KM2 = 90;
export const FETCH_BUFFER_MIN_M = 500;
export const FETCH_BUFFER_MAX_M = 4000;

export function fetchBufferM(areaKm2) {
  const sideKm = Math.sqrt(Math.max(areaKm2, 0));
  const slackKm = (Math.sqrt(FETCH_BUDGET_KM2) - sideKm) / 2;
  return Math.min(Math.max(slackKm * 1000, FETCH_BUFFER_MIN_M), FETCH_BUFFER_MAX_M);
}

// Download this much beyond the fetch box, then trim back to it after
// simplification. Junctions just outside the box then stay junctions instead
// of being simplified away, which keeps boundary streets connected.
export const DOWNLOAD_MARGIN_M = 500;

// An arc counts as "required" only if this much of it lies inside the shape,
// so a motorway clipping a corner is not dragged in.
export const REQUIRED_MIN_INSIDE_M = 30;

// Snap the queried bbox outward to this grid so nearby drags share one Overpass
// response in the cache.
export const BBOX_SNAP_DEG = 0.005;

// Overpass is a free, shared, frequently-overloaded service, so downloads need
// a bounded wait and a retry. Add mirrors here if you have a fast one.
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter'];
export const OVERPASS_QUERY_TIMEOUT_S = 180;   // server-side budget, in the query
export const OVERPASS_HTTP_TIMEOUT_MS = 150_000;
export const OVERPASS_RETRIES = 4;
export const OVERPASS_RETRY_DELAY_MS = 2000;

// ---------------------------------------------------------- waypoint reduction
// Cap each leg so ties (equal-cost alternative routes a navigation app might
// prefer over ours) stay rare. EMPIRICAL.
export const WAYPOINT_MAX_LEG_M = 1200;
export const WAYPOINT_MAX_LEG_ARCS = 6;

// Keeps each Dijkstra local. Worth 5-20x on the hot loop.
export const WAYPOINT_DIJKSTRA_CUTOFF_S = 900;

// Require our sub-walk to beat alternatives by this margin before trusting that
// a router will pick it. 0 disables the (costly) re-check. EMPIRICAL.
export const WAYPOINT_MARGIN = 0.05;

// ------------------------------------------------------------------- sessions
// Sessions are cut at chunk boundaries. A chunk is a short run of waypoints -
// a few minutes of driving - so a session never ends in the middle of a
// street.
export const CHUNK_WAYPOINTS = 3;
export const CHUNK_MAX_SECONDS = 25 * 60;

export const SESSION_SECONDS_DEFAULT = 2 * 3600;
export const MAX_SESSION_MINUTES = 24 * 60;
export const PASSES_DEFAULT = 1;
// Each pass multiplies the entire drive, so a large number is nearly always a
// typo rather than an intention. Not a capability limit.
export const PASSES_MAX = 50;

// One-way mode is a heuristic with a local search; this is how long it may
// spend trying to improve on its first answer.
export const ONEWAY_TIME_BUDGET_S = 25;

// Drive both directions of every road? Off by default: one pass is half the
// driving. Exact when on, heuristic when off.
export const BOTH_DIRECTIONS_DEFAULT = false;

// --------------------------------------------------------------------- solver
export const MCF_TIME_SCALE = 10;   // travel_time seconds -> integer deciseconds

export const COORD_DECIMALS = 6;    // ~11 cm
