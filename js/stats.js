/* Human-facing numbers: how far, how long, how much of it is a detour.

   The pre-flight estimate exists because a 20 km2 rectangle is over 400 km of
   driving, and finding that out after the computation is a bad experience.
   Everything below is calibrated against runs on Bratislava at 0.83 / 4.96 /
   19.86 km2 and only used for that guess - real figures come from the tour. */

// Predicted 13.2 km for the 0.83 km2 case against 13.18 measured.
const CENTERLINE_KM_PER_KM2 = 16;

// Driven per km2, deadheading included: measured 31.2, 32.7, 25.1. Measured
// directly rather than derived as "centerline x 2", which assumes every road is
// two-way; in central Bratislava only ~27% of centerline km is.
const DRIVE_KM_PER_KM2 = 30;

// One-way saves less than intuition suggests - 4% at 0.83 km2, 10% at 20 - as
// required distance falls but deadheading rises almost as much: a two-way
// street driven out and back returns you, a single pass does not.
const ONEWAY_DRIVE_FACTOR = 0.92;

// Town driving with stops and turnarounds. Measured 38.7, 33.8, 38.3 km/h.
const AVERAGE_KMH = 36;

export function humanDuration(seconds) {
  const total = Math.max(Math.round(seconds), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours && minutes) return `${hours} h ${minutes} min`;
  if (hours) return `${hours} h`;
  return `${minutes} min`;
}

// Pre-flight guess from road density alone.
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

// Final figures, once the tour is known.
export function summarise(tour, waypointCount, sessionCount) {
  return {
    ...tour,
    duration: humanDuration(tour.total_seconds || 0),
    waypoints: waypointCount,
    sessions: sessionCount,
  };
}
