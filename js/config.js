/* Tunable constants. Values marked EMPIRICAL were calibrated by measuring
   generated routes, not derived. */

// Bump on ANY algorithm change, or the result cache serves stale routes.
export const ALGO_VERSION = '14';

// -------------------------------------------------------------------- basemap
// Throw away key for this project - an actual human comment
export const CARTO_API_KEY = 'cb1_3fme_1_eb3991beb7b07217ee922ba3';

/* Per entry: `dark` picks the route palette and map inks, `invert` renders the
   tiles through the CSS inversion filter (OSM publishes no dark tiles),
   `needsKey` hides the entry when CARTO_API_KEY is empty. */
export const BASEMAPS = [
  {
    id: 'osm',
    label: 'OpenStreetMap (light)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    id: 'osm-dark',
    label: 'OpenStreetMap (dark)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    dark: true,
    invert: true,
  },
  {
    id: 'carto-light',
    label: 'CARTO (light)',
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
               + 'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    needsKey: true,
  },
  {
    id: 'carto-dark',
    label: 'CARTO (dark)',
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
               + 'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    dark: true,
    needsKey: true,
  },
];

// Must be one of the ids above.
export const BASEMAP_DEFAULT = 'osm';

// One palette per basemap. Both avoid green (the drawn zone wears it) and
// orange (road maps paint primary roads orange). Light is also the PNG export.
export const ROUTE_PALETTE_DARK = ['#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#facc15',
                                   '#f87171', '#60a5fa', '#e879f9', '#38bdf8', '#fda4af'];
export const ROUTE_PALETTE_LIGHT = ['#7c3aed', '#0284c7', '#c026d3', '#ea580c', '#e11d48',
                                    '#4f46e5', '#ca8a04', '#be123c', '#0369a1', '#a21caf'];

// ---------------------------------------------------------------- area limits
// Not a product limit - only so a nonsense request fails clearly instead of
// grinding away at Overpass.
export const AREA_CAP_KM2 = 50_000;

// ------------------------------------------------------------ private roads
// See roadFilter() in osm.js for what turning this on admits.
export const INCLUDE_PRIVATE_DEFAULT = false;

/* Download plain service roads (highway=service, no service=* subtag) as
   connectors: drivable, never required. Without them a street whose only link
   to the network is a service road is not strongly connected, gets pruned, and
   reads as missing coverage.

   Turn off if a route sends the driver down a service road that is gated or
   signed no-entry in real life and tagged as neither in OSM. Bump
   QUERY_VERSION in osm.js if you do, or the cached download will not match. */
export const INCLUDE_CONNECTORS = true;

/* Surcharge for driving a connector, so it is a last resort rather than a
   shortcut. The service crossings through the central reservation of a dual
   carriageway are the reason: OSM has them as plain service roads, they look
   like a free U-turn across an 80 km/h road, and they are signed no-entry.
   Nothing in the data distinguishes one from a legitimate access road.

   Required arcs still force their own coverage, so a high price here can never
   lose a street. EMPIRICAL: on that crossing the route takes it at 0 s and
   60 s, and stops at 150 s. Must also stay well below UTURN_PENALTY_S. */
export const CONNECTOR_PENALTY_S = 600;

// ---------------------------------------------------------------- OSM fetching
/* Fetch beyond the drawn shape so deadhead legs may leave it, and so fewer
   required arcs are orphaned by the SCC prune. A one-way street whose way back
   lies outside the box belongs to no strongly connected component and is
   deleted, which shows up directly as missing coverage. EMPIRICAL, on 1.5 km2
   of Petrzalka (long one-way loops, the worst case):

       buffer      500 m   1000 m   2000 m   4000 m
       coverage    70.3%    72.9%    71.3%   100.0%

   The loss is a boundary effect, so the buffer a shape needs is set by the
   street layout, not by the shape's size - but the cost is area downloaded.
   Hence a fixed download budget rather than a fixed distance. */
export const FETCH_BUDGET_KM2 = 90;
export const FETCH_BUFFER_MIN_M = 500;
export const FETCH_BUFFER_MAX_M = 4000;

export function fetchBufferM(areaKm2) {
  const sideKm = Math.sqrt(Math.max(areaKm2, 0));
  const slackKm = (Math.sqrt(FETCH_BUDGET_KM2) - sideKm) / 2;
  return Math.min(Math.max(slackKm * 1000, FETCH_BUFFER_MIN_M), FETCH_BUFFER_MAX_M);
}

// Download this much beyond the fetch box, then trim back after simplification,
// so a junction just outside the box stays a junction.
export const DOWNLOAD_MARGIN_M = 500;

// An arc is "required" if this much of it is inside the shape, so a motorway
// clipping a corner is not dragged in...
export const REQUIRED_MIN_INSIDE_M = 30;

/* ...or if this much of it proportionally is. The metre test alone can never be
   met by a shorter arc, and the links stitching a junction together are exactly
   the short ones; losing them turns junctions into dead ends. EMPIRICAL over
   39 km2: arcs 30 m and over were driven 99-100% of the time, under 30 m 55%. */
export const REQUIRED_MIN_INSIDE_FRACTION = 0.5;

/* A dead end shorter than this is not required: drive in, and the only way out
   is back the way you came, for a few metres you can see from the junction. At
   this length it is usually not a street at all but the stub left where a new
   development is half mapped - the name is drawn from the main road and the
   rest of the street is not there yet.

   Measured over the whole arc, which after simplify() runs from the dead end
   back to the last real junction - not over the pointed tip the route draws.
   Coverage is junction to junction; there is no way to require half an arc.

   Still drivable, just never required. EMPIRICAL over 39 km2 (one way / both
   ways), against 237 dead ends that could be required:

       cut at        0 m    7 m   15 m   20 m   30 m
       roads cut       0      1     17     28     37
       turnarounds   273    273    255    243    231
       total km    535.0  538.1  535.5  533.6  531.5
       both ways   597.2      -      -  592.8      -

   7 m cuts one road in a whole city district - not worth having. 20 m clears
   the spikes that hang off a roundabout, drops 30 turnarounds and shortens the
   drive; the 0.4 km it gives up is stubs nobody would drive into. Past 30 m
   real cul-de-sacs start going. */
export const DEAD_END_MIN_M = 20;

// A typo guard on the field, not a capability limit.
export const DEAD_END_MAX_M = 200;

// Snap the queried bbox outward to this grid so nearby drags share a cache entry.
export const BBOX_SNAP_DEG = 0.005;

// Overpass is free, shared and often overloaded. Add mirrors if you have one.
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter'];
export const OVERPASS_QUERY_TIMEOUT_S = 180;   // server-side budget, in the query
export const OVERPASS_HTTP_TIMEOUT_MS = 150_000;
export const OVERPASS_RETRIES = 4;
export const OVERPASS_RETRY_DELAY_MS = 2000;

// ---------------------------------------------------------- waypoint reduction
// Cap each leg so ties - equal-cost alternatives a navigation app might prefer
// over ours - stay rare. EMPIRICAL.
export const WAYPOINT_MAX_LEG_M = 1200;
export const WAYPOINT_MAX_LEG_ARCS = 6;

// Keeps each Dijkstra local. Worth 5-20x on the hot loop.
export const WAYPOINT_DIJKSTRA_CUTOFF_S = 900;

// Margin our sub-walk must beat alternatives by before we trust a router to
// pick it. 0 disables the costly re-check. EMPIRICAL.
export const WAYPOINT_MARGIN = 0.05;

/* Where to put a street's waypoint when the drive turns round at its far end.
   Halfway fails twice over: the halfway point is the same place in both
   directions, so a router drops one of the two identical points and the return
   pass with it, and the stretch beyond it is never actually required. Not *at*
   the end either - a waypoint on a junction is ambiguous across its branches. */
export const WAYPOINT_TURNAROUND_FRACTION = 0.9;

// ------------------------------------------------------------------- sessions
// Sessions are cut at chunk boundaries, so one never ends mid-street.
export const CHUNK_WAYPOINTS = 3;
export const CHUNK_MAX_SECONDS = 25 * 60;

export const SESSION_SECONDS_DEFAULT = 2 * 3600;
export const MAX_SESSION_MINUTES = 24 * 60;
export const PASSES_DEFAULT = 1;
// A typo guard, not a capability limit: each pass multiplies the whole drive.
export const PASSES_MAX = 50;

// How long the one-way local search may spend improving its first answer.
export const ONEWAY_TIME_BUDGET_S = 25;

// Exact when on, heuristic when off.
export const BOTH_DIRECTIONS_DEFAULT = false;

// ---------------------------------------------------------------------- turns
/* The solver runs on a graph whose arcs are turns (see turns.js); these are what
   a turn costs. Prices, not prohibitions - deleting a turn can strand the street
   behind it, so the route would fail or silently stop covering it. Priced high
   enough the solver goes round the block wherever that is possible at all.

   Three manoeuvres look alike and drive differently, so they price apart:
   a reversal onto the same tarmac (illegal), a hairpin onto different tarmac
   (awkward, usually legal), and a movement an OSM relation forbids. */

/* How much road either side of a junction a turn is measured over. The obvious
   rule - first two distinct vertices - is wrong at a micro-mapped junction where
   the first vertex is a 5 m stub angled into the give-way line. EMPIRICAL: 2443
   of 10678 arcs give a different end bearing over 15 m, 211 differ by >25 deg. */
export const BEARING_RUN_M = 15;

// Sharper than this counts as doubling back. Used by the tour tie-breaks and as
// the top of the taper below.
export const UTURN_DEGREES = 150;

// Where the hairpin price starts, rising linearly to full value at 180. A hard
// threshold would decide a couple of hundred junctions on measurement noise.
export const UTURN_TAPER_DEGREES = 120;

/* What the solver will spend rather than leave a street on the tarmac it
   arrived on. A dead end pays nothing - there is no alternative there, and
   charging would distort the routes leading up to it.

   EMPIRICAL. Reversals left where somewhere else to go existed, over 39 km2:

       penalty        90 s    300 s    900 s   1800 s   100000 s
       one-way  rev      8        1        1        1          1
       both     rev     16       11       11       11         11

   Flat from 300 s up, including a control at 100000 s: what remains is forced
   by the layout - a junction with one other exit and no way back to it, where
   the arrival can only pair with the reversal.

   18000 rather than 300 because this has to be a ban, and it stops being one as
   soon as anything else is expensive too. At CONNECTOR_PENALTY_S = 600 a
   three-connector detour costs 1800, and the solver starts trading:

       U-turn price      connector price 300 s   600 s   1200 s
       1800 s                                1       5        9
       18000 s                               1       1        1

   At 18000 the two cannot interact. Costs are integer deciseconds in an
   Int32Array, so there is room for two more orders of magnitude. */
export const UTURN_PENALTY_S = 18000;

/* Hairpin onto different tarmac. Legal, so a preference, and nearly free -
   under 1% of the drive across the whole range. EMPIRICAL, hairpins left:

       penalty     0 s     45 s     90 s    240 s
       one-way      10       3        1        0
       both         17       6        1        0

   240 s would clear the rest but four minutes of detour to avoid a legal turn
   looks sensible here and absurd elsewhere. What matters more than the value is
   that it is separate from UTURN_PENALTY_S: with one price for both, it had to
   be low enough not to distort hairpins, which made it too low to stop
   reversals - and at some junctions it preferred the reversal to the legal
   hairpin that would have replaced it. */
export const SHARP_TURN_PENALTY_S = 90;

// A turn an OSM restriction forbids. Above the reversal price: both are
// illegal, but this one is on a sign.
export const RESTRICTED_TURN_PENALTY_S = 3600;

// --------------------------------------------------------------------- solver
export const MCF_TIME_SCALE = 10;   // travel_time seconds -> integer deciseconds

export const COORD_DECIMALS = 6;    // ~11 cm
