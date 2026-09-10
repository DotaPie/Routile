/* The tour as GPX - the one output that reproduces the route exactly.

   The file carries the route three ways, because apps disagree about which
   one they will follow:

   * <trk>  - the exact breadcrumb, for apps that follow a track literally.
   * <rte>  - the waypoints as *route points*: the element that means
              "go via here", which is what an app routing between points will
              actually honour.
   * <wpt>  - the same points as places of interest. Drawn, never navigated to.

   One file holds one continuous <trkseg>. A navigation app reads a
   multi-segment track as several disconnected pieces and will not follow it as
   one route. Splitting a long drive is what the per-session files are for -
   each is one outing, small enough for any device.

   Which apps actually *follow* this: OsmAnd ("Follow track"), Locus Map and
   Garmin units. Organic Maps will draw the track but its router is
   point-to-point with no intermediate stops, so it plans its own way to the
   finish and ignores everything between. */

import { humanDuration } from './stats.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (n, wp) => `${String(n).padStart(4, '0')} ${wp.street || `waypoint ${n}`}`;

/* GPX text for the whole route, or for one session of it. */
export function gpxDocument(result, { session = null, name = 'Routile route' } = {}) {
  const track = result.track || [];
  const arcStart = result.arc_start || [];
  const loArc = session ? session.arc_span[0] : 0;
  const hiArc = session ? session.arc_span[1] : (arcStart.length ? arcStart.length - 1 : 0);

  // Only the waypoints inside the exported stretch.
  const included = [];
  (result.waypoints || []).forEach((wp, n) => {
    if (!session || (loArc <= wp.arc_index && wp.arc_index <= hiArc)) included.push([n, wp]);
  });

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(`<gpx version="1.1" creator="Routile" xmlns="${GPX_NS}">\n`);
  out.push(`  <metadata><name>${esc(name)}</name><desc>${esc(describe(result, included.length, session))}</desc></metadata>\n`);

  for (const [n, wp] of included) {
    out.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}"><name>${esc(label(n, wp))}</name></wpt>\n`);
  }
  if (included.length) {
    out.push(`  <rte>\n    <name>${esc(name)}</name>\n`);
    for (const [n, wp] of included) {
      out.push(`    <rtept lat="${wp.lat}" lon="${wp.lon}"><name>${esc(label(n, wp))}</name></rtept>\n`);
    }
    out.push('  </rte>\n');
  }

  // One continuous segment. `arc_start` maps a tour arc to where it begins in
  // the breadcrumb, so a session is one exact slice of it.
  let lo = 0, hi = track.length - 1;
  if (arcStart.length) {
    lo = arcStart[Math.min(loArc, arcStart.length - 1)];
    hi = arcStart[Math.min(hiArc, arcStart.length - 1)];
  }
  const points = track.slice(lo, hi + 1);
  out.push(`  <trk>\n    <name>${esc(name)}</name>\n`);
  if (points.length >= 2) {
    out.push('    <trkseg>\n');
    for (const [lat, lon] of points) out.push(`      <trkpt lat="${lat}" lon="${lon}"/>\n`);
    out.push('    </trkseg>\n');
  }
  out.push('  </trk>\n</gpx>\n');
  return out.join('');
}

/* The figures for *this file*, not for the whole route. A session file that
   quotes the whole drive's distance is the number you would plan your
   afternoon around. */
function describe(result, waypointCount, session) {
  const st = result.stats || {};
  const summary = (result.coverage || {}).summary || '';
  if (!session) return `${st.total_km ?? 0} km, ${st.duration ?? '?'}, ${waypointCount} waypoints. ${summary}`;
  // Rounded to whole minutes first: humanDuration floors, while the UI
  // rounds, and 18.6 minutes must not read as 18 here and 19 there.
  const seconds = Math.round(session.minutes || 0) * 60;
  return `${session.km} km, ${humanDuration(seconds)}, ${waypointCount} waypoints. `
    + `Part of a ${st.total_km ?? 0} km route that ${summary}.`;
}

/* The download: always one zip, whatever the session count, so what comes
   out is the same package every time - the GPX (one file for a single
   session, one per session otherwise) and metadata.json.

   That last one is what makes the zip loadable back into the page. GPX has
   nowhere to put "two passes, one way, split into two-hour sessions", nor the
   shape that was drawn to ask for it, so none of that survives a round trip
   through the track alone. The JSON carries the request, the drawn zones and
   the computed result together, which is enough to put the page back exactly
   as it was without going near Overpass or the solver again.

   It does repeat geometry the GPX already holds. That is deliberate: reading
   the track back out of the GPX would leave the arc indices that
   gpxDocument() slices sessions with to be reconstructed, and the zip is
   DEFLATE'd, so the copy costs far less than it looks.

   Needs the JSZip global. */
export async function gpxZip(result, { metadata = null } = {}) {
  const sessions = result.sessions || [];
  const zip = new JSZip();
  if (sessions.length <= 1) {
    zip.file('routile-route.gpx', gpxDocument(result));
  } else {
    const width = Math.max(String(sessions.length).length, 2);
    sessions.forEach((session) => {
      const number = session.index + 1;
      zip.file(
        `routile-session-${String(number).padStart(width, '0')}.gpx`,
        gpxDocument(result, { session, name: `Routile session ${number} of ${sessions.length}` }),
      );
    });
  }
  if (metadata) zip.file('metadata.json', JSON.stringify(metadata));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
