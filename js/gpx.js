/* The tour as GPX. The file carries the route three ways because apps disagree
   about which they will follow:

   * <trk>  - the exact breadcrumb, for apps that follow a track literally.
   * <rte>  - the waypoints as route points ("go via here"), which is what an
              app routing between points honours.
   * <wpt>  - the same points as places of interest. Drawn, never navigated to.

   One file, one continuous <trkseg>: a navigation app reads a multi-segment
   track as disconnected pieces and will not follow it as one route. Splitting a
   long drive is what the per-session files are for.

   Apps that actually follow this: OsmAnd ("Follow track"), Locus Map, Garmin.
   Organic Maps draws the track but its router has no intermediate stops, so it
   plans its own way to the finish and ignores everything between. */

import { humanDuration } from './stats.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (n, wp) => `${String(n).padStart(4, '0')} ${wp.street || `waypoint ${n}`}`;

// GPX text for the whole route, or for one session of it.
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

// The figures for *this file*, not the whole route: a session file quoting the
// whole drive's distance is the number you would plan your afternoon around.
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

/* YYYYMMDD-HHMMSS for the zip and everything in it, so a second download of the
   same route is a distinct, sortable file rather than "routile-route (1).zip".

   Local clock, not UTC: this is stamped for the person who pressed the button.
   The exact instant is in metadata.json, in ISO. */
export function fileStamp(when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}`
    + `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
}

/* The download: always one zip, so the package is the same shape every time.
   `stamp` is passed in rather than read from the clock, so every file inside
   carries one moment and the caller can name the zip to match.

   metadata.json is what makes the zip loadable back into the page: GPX has
   nowhere to put "two passes, one way, two-hour sessions" or the drawn shape.
   It repeats geometry the GPX already holds, deliberately - reconstructing the
   arc indices gpxDocument() slices sessions with would be worse, and DEFLATE
   makes the copy cheap.

   Needs the JSZip global. */
export async function gpxZip(result, { metadata = null, stamp = fileStamp() } = {}) {
  const sessions = result.sessions || [];
  const zip = new JSZip();
  if (sessions.length <= 1) {
    zip.file(`routile-route-${stamp}.gpx`, gpxDocument(result));
  } else {
    const width = Math.max(String(sessions.length).length, 2);
    sessions.forEach((session) => {
      const number = session.index + 1;
      // The number last, so the session files of one download sort together
      // and in order however they end up mixed with another download's.
      zip.file(
        `routile-session-${stamp}-${String(number).padStart(width, '0')}.gpx`,
        gpxDocument(result, { session, name: `Routile session ${number} of ${sessions.length}` }),
      );
    });
  }
  if (metadata) zip.file('metadata.json', JSON.stringify(metadata));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
