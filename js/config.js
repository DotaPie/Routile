/* Tunable constants for Routile.

   Several values here are EMPIRICAL: they can only be calibrated by driving a
   generated route and watching what the navigation app actually does. */

// Bump on ANY algorithm change, or the result cache will serve stale routes
// and you will chase phantom bugs.
export const ALGO_VERSION = '12';

// -------------------------------------------------------------------- basemap
// Throw away key for this project - an actual human comment
export const CARTO_API_KEY = 'cb1_3fme_1_eb3991beb7b07217ee922ba3';

/* The basemaps the map picker offers, in the order it lists them. Two families
   with a light and a dark of each, and they are not interchangeable:

   OpenStreetMap's own rendering is the detailed one - parking, shops,
   amenities, the things you actually want on a map you are about to go and
   drive. It publishes no dark tiles, so the dark of that pair is the daylight
   tile inverted in CSS (see `invert`), which keeps every one of those icons.

   CARTO's Positron and Dark Matter are a matched pair drawn for opposite
   grounds, so the map keeps its shape across that switch. They are backdrop
   styles though: deliberately drained of colour and stripped of POI icons, so
   they show far less. They need the key above, and CARTO is retiring raster in
   favour of vector, so treat them as a comfortable stopgap.

   Per entry:
     dark    which route palette and map inks to dress the page in
     invert  render the tiles through the inversion filter in the stylesheet
     needsKey  hidden from the picker when CARTO_API_KEY is empty */
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

// Which one a first-time visitor gets; after that their own choice is
// remembered. Must be one of the ids above.
export const BASEMAP_DEFAULT = 'osm';

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

/* Also download plain service roads - highway=service with no service=* subtag
   - as *connectors*: drivable, so the route may pass along one, but never
   required, so none of them is ever a street you have to cover.

   Not a user setting, because there is nothing to weigh up. Without them, a
   street whose only link to the network is a service road belongs to no
   strongly connected component and is deleted, which reads as missing
   coverage; with them, it is reachable. The cost is a slightly larger download
   and a slightly larger graph, and no extra driving is ever required.

   The one thing it can get wrong: a service road that is gated, one-way or
   signed no-entry in real life and tagged as none of those in OSM. A deadhead
   leg down one of those is a leg the driver cannot take. Turn this off if that
   shows up. Bump QUERY_VERSION in osm.js if you do, or the cached download will
   not match. */
export const INCLUDE_CONNECTORS = true;

/* What driving a connector costs the solver, on top of the time it takes.

   Without this a connector is just a cheap little road, and the solver uses it
   wherever it saves a few seconds. That is exactly wrong. The service crossings
   through the central reservation of a dual carriageway are the clearest case:
   OSM has them as plain service roads, they look like a free U-turn across an
   80 km/h road, and on the ground they are signed no-entry - they are there for
   maintenance and buses. The route was taking one on Panonska cesta.

   Nothing in the data distinguishes that crossing from a legitimate access road,
   so the fix is not a better filter, it is to stop treating connectors as
   shortcuts at all. Priced at ten minutes apiece the solver will only drive one
   where there is no alternative within ten minutes - which is precisely the
   case a connector exists for: a street that cannot be reached any other way.
   Required arcs still force their own coverage, so making this expensive can
   never lose a street; it only stops connectors being used for convenience.

   Measured on that crossing, which saves about a minute against driving on to
   the next junction: at 0 s and 60 s the route takes it, at 150 s and above it
   does not. 600 s is well clear of the changeover and still nowhere near
   UTURN_PENALTY_S, which is the other thing this has to stay clear of. */
export const CONNECTOR_PENALTY_S = 600;

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

// An arc counts as "required" if this much of it lies inside the shape, so a
// motorway clipping a corner is not dragged in.
export const REQUIRED_MIN_INSIDE_M = 30;

// ...or if this much of it *proportionally* lies inside, which is the test that
// matters for a short arc. The metre threshold alone can never be met by an arc
// shorter than it, so on its own it silently drops every short link - and the
// links that stitch a junction together are exactly the short ones. Losing them
// turns a junction into a dead end and the route turns round in the middle of a
// street. Measured over 39 km2 of Bratislava: arcs 30 m and over were driven
// 99-100% of the time, arcs under 30 m only 55%.
export const REQUIRED_MIN_INSIDE_FRACTION = 0.5;

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

/* How far along a street to put its waypoint when the drive turns round at the
   far end of it, instead of the usual halfway.

   Halfway is wrong in that one case for two reasons. The street is about to be
   driven back the other way, and the halfway point of a street is the same
   place whichever way you drive it - so both waypoints land on the same spot,
   and a router handed two identical route points drops one of them and the
   return pass with it. And halfway is as far as it asks the driver to go, so
   the last stretch up to the turning point is never actually required.

   Near the far end fixes both. Not *at* it: a waypoint on the junction itself
   is ambiguous across every branch meeting there, which is the whole reason
   waypoints sit mid-street. */
export const WAYPOINT_TURNAROUND_FRACTION = 0.9;

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

// ---------------------------------------------------------------------- turns
/* A junction is a place where some movements are not allowed, and a route that
   ignores that is a route nobody can drive. The solver therefore runs on a
   graph whose arcs are *turns* (see turns.js), and these are what a turn costs.

   They are prices, not prohibitions. Making an illegal turn impossible would
   mean deleting it from the graph, and a deleted turn can strand a street
   behind it - the route would then either fail outright or quietly stop
   covering that street, which is worse than a route with one awkward turn in
   it. Priced high enough, the solver goes round the block wherever going round
   the block is possible at all, and only takes the turn when there is genuinely
   no other way in.

   Three different manoeuvres look alike on a map and are not alike to drive,
   so they are priced apart:

     reversal   leaving on the same strip of tarmac you arrived on. This is the
                U-turn in the middle of a street. Illegal almost everywhere,
                and there is always a way round it in a connected network.
     sharp      a turn of nearly 180 degrees onto *different* tarmac - a slip
                lane, a hairpin, the far carriageway of a dual road. Awkward,
                usually legal, and sometimes the only sane way to reverse
                direction. Worth avoiding, not worth banning.
     restricted a movement an OSM relation forbids outright. Signposted, so a
                harder no than either of the above.

   Pricing all three the same is what produced the earlier routes: a reversal
   was cheap enough to take, and a legal hairpin was dear enough that the solver
   preferred the reversal to the loop that would have replaced it. */

/* How much of the road either side of a junction a turn is measured over.

   The obvious rule - the first two distinct vertices - is wrong at any
   micro-mapped junction, where the first vertex can be five metres away on a
   stub angled into the give-way line. Over 39 km2, 2443 of 10678 arcs give a
   different end bearing measured over 15 m than measured off that first
   vertex, and 211 of them differ by more than 25 degrees. See endRun(). */
export const BEARING_RUN_M = 15;

// Anything sharper than this counts as doubling back rather than turning. Used
// by the tour step's tie-breaks, and as the top of the taper below.
export const UTURN_DEGREES = 150;

/* Where the sharp-turn price starts, rising linearly to its full value at 180.

   A hard threshold makes the whole thing hostage to how a junction happens to
   be drawn: 149 degrees free, 151 degrees fully charged. Given the measurement
   spread above, a cliff decides a couple of hundred junctions essentially at
   random. A ramp does not. */
export const UTURN_TAPER_DEGREES = 120;

/* What the solver will spend, in seconds of extra driving, rather than leave a
   street on the same tarmac it arrived on. A dead end pays nothing - turning
   round is the only thing you can do there, and charging for it would only
   distort the routes leading up to it.

   Effectively a ban, and the sweep says so. Over 39 km2 of Bratislava, counting
   the reversals left at places with somewhere else to go:

       penalty        90 s    300 s    900 s   1800 s   100000 s
       one-way  rev      8        1        1        1          1
                drive 520 km  533 km   533 km   533 km    532 km
       both     rev     16       11       11       11         11
                drive 574 km  585 km   585 km   585 km    585 km

   Everything from 300 s up gives the identical answer, including a control run
   at 100000 s - 28 hours of detour, which no route would ever pay. What is left
   at that point is forced by the road layout: a street whose junction has one
   other exit and no way back to it, where the arrival can only ever be paired
   with the reversal. No price removes those, and a price high enough to try
   would only make the rest of the route worse.

   So why 18000 and not 300? Because this price has to be a ban rather than a
   preference, and a preference is what it becomes as soon as anything else on
   the graph is expensive too. CONNECTOR_PENALTY_S below is 600, and a detour
   over three connectors therefore costs 1800 - at which point the solver starts
   treating "reverse illegally" and "go the long way" as a genuine trade and
   takes the reversal. Measured, one-way mode, reversals left:

       U-turn price      connector price 300 s   600 s   1200 s
       1800 s                                1       5        9
       18000 s                               1       1        1

   At 18000 the two prices cannot interact: it would take thirty connectors in a
   row to rival one reversal. The answer stops depending on the other constants,
   which is the property worth having - not the number itself. Costs are integer
   deciseconds in an Int32Array, so there is room for another two orders of
   magnitude before this matters. */
export const UTURN_PENALTY_S = 18000;

/* The same for a hairpin onto different tarmac - a slip lane, a tight loop, the
   far carriageway of a dual road. Legal, so this is a preference rather than a
   ban, and it turns out to be nearly free:

       penalty     0 s     45 s     90 s    240 s
       one-way  10 hp    3 hp     1 hp     0 hp     531 / 534 / 533 / 534 km
       both     17 hp    6 hp     1 hp     0 hp     582 / 580 / 585 / 585 km

   Under 1% of the drive across the whole range. 90 s takes out nine in ten of
   them for nothing; 240 s takes out the rest, and is not used because four
   minutes of detour to avoid a legal turn is the kind of thing that looks
   sensible on this network and absurd on another.

   What matters far more than the value is that this is a *separate* price from
   the one above. When there was only one U-turn price, it had to be low enough
   not to distort the hairpins, which made it too low to stop the reversals -
   and at some junctions it actively preferred an illegal reversal to the legal
   hairpin that would have replaced it, because both cost the same and the
   reversal was the shorter way round. */
export const SHARP_TURN_PENALTY_S = 90;

// A turn an OSM restriction forbids (no_left_turn, only_straight_on and
// friends). Above the reversal price: both are illegal, but this one is on a
// sign, so where the solver must break one rule it should break the other one.
export const RESTRICTED_TURN_PENALTY_S = 3600;

// --------------------------------------------------------------------- solver
export const MCF_TIME_SCALE = 10;   // travel_time seconds -> integer deciseconds

export const COORD_DECIMALS = 6;    // ~11 cm
