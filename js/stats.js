/* Human-facing numbers: how far, how long, and how much of it is a detour.

   The pre-flight estimate matters more than it looks. A 20 km2 rectangle is
   over 400 km of driving, and finding that out *after* the computation is a
   bad experience. The estimate is derived from road density alone, so the UI
   can warn before anyone commits. */

// Calibrated against measured runs on Bratislava at 0.83 / 4.96 / 19.86 km2.
// Only used for the pre-flight guess; the real figures come from the tour.
//
// Centerline density: predicted 13.2 km for the 0.83 km2 case against 13.18
// measured.
const CENTERLINE_KM_PER_KM2 = 16;

// Total distance actually driven per km2, deadheading included: measured 31.2,
// 32.7 and 25.1 across the three cases. Measured directly because deriving it
// as "centerline x 2 plus deadheading" assumes every road is two-way, and in
// central Bratislava only about 27% of centerline km is.
const DRIVE_KM_PER_KM2 = 30;

// One-way mode saves far less than intuition suggests: 4% at 0.83 km2, 8% at
// 5 km2, 10% at 20 km2. Required distance falls a lot but deadheading rises
// almost as much, because a two-way street driven out and back is
// self-returning while a street driven once leaves you to find your own way
// back.
const ONEWAY_DRIVE_FACTOR = 0.92;

// Town driving including stops, junctions and turnarounds. Implied by the
// measured runs: 38.7, 33.8 and 38.3 km/h.
const AVERAGE_KMH = 36;

export function humanDuration(seconds) {
  const total = Math.max(Math.round(seconds), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours && minutes) return `${hours} h ${minutes} min`;
  if (hours) return `${hours} h`;
  return `${minutes} min`;
}

/* Pre-flight guess from road density alone. */
export function estimate(areaKm2, { passes = 1, bothDirections = false, sessionSeconds = 7200 }) {
  const factor = bothDirections ? 1 : ONEWAY_DRIVE_FACTOR;
  const driveKm = areaKm2 * DRIVE_KM_PER_KM2 * factor * passes;
  const seconds = driveKm / AVERAGE_KMH * 3600;
  return {
    area_km2: Math.round(areaKm2 * 100) / 100,
    centerline_km: Math.round(areaKm2 * CENTERLINE_KM_PER_KM2 * 10) / 10,
    drive_km: Math.round(driveKm * 10) / 10,
    seconds: Math.trunc(seconds),
    duration: humanDuration(seconds),
    sessions: sessionSeconds > 0 ? Math.max(1, Math.round(seconds / sessionSeconds + 0.5)) : 1,
  };
}

/* Final figures, once the tour is actually known. */
export function summarise(tour, waypointCount, sessionCount) {
  return {
    ...tour,
    duration: humanDuration(tour.total_seconds || 0),
    waypoints: waypointCount,
    sessions: sessionCount,
  };
}
