// BoomWatch site registry and profile constants (single source of truth).
// Seeded from LL2 API discovery, 2026-11-14:
//   SLC-4E pad id 16, Vandenberg location id 11, pad at 34.632, -120.611.

export interface SiteConfig {
  site_id: string;
  name: string;
  ll2PadId: number;        // filter LL2 results on this
  ll2LocationId: number;
  padLat: number;          // launch pad (ascent reference)
  padLon: number;
  refLat: number;          // recovery point / LZ (descent reference)
  refLon: number;
  audibilityKm: number;   // max observer distance for boom plausibility
}

export interface ProfileConfig {
  profile_id: string;
  site_id: string;
  description: string;
  defaultCrossoverS: number;  // nominal; fitted per-launch in predictions
  windowPreS: number;
  windowPostS: number;
  priorConfidence: number;    // default P(boom audible) before any reports
  boomEvents: number;
}

export const SITES: Record<string, SiteConfig> = {
  vandenberg: {
    site_id: "vandenberg",
    name: "Vandenberg SFB, CA",
    ll2PadId: 16,
    ll2LocationId: 11,
    padLat: 34.632,   // SLC-4E per LL2
    padLon: -120.611,
    refLat: 34.633,   // LZ-4 (approx; refine when surveyed)
    refLon: -120.615,
    audibilityKm: 250,
  },
  // v2 sites (canaveral, starbase) — add here when activated. Schema already
  // accommodates them; the ingest worker filters on ll2PadId per site.
};

export const PROFILES: Record<string, ProfileConfig> = {
  f9_rtls_ascent: {
    profile_id: "f9_rtls_ascent",
    site_id: "vandenberg",
    description: "Supersonic ascent boom carpet (Mach 1 at ~T+60s, southbound coastal track)",
    defaultCrossoverS: 60,
    windowPreS: 30,
    windowPostS: 90,
    priorConfidence: 0.55,
    boomEvents: 1,
  },
  f9_rtls_descent: {
    profile_id: "f9_rtls_descent",
    site_id: "vandenberg",
    description: "RTLS booster return: transonic descent inbound to LZ-4, double boom",
    defaultCrossoverS: 600,
    windowPreS: 60,
    windowPostS: 120,
    priorConfidence: 0.85,
    boomEvents: 1,
  },
};

// Calibration anchor (VENTURA, CA): observer at 34.275N, 119.232W reports
// audible boom ~T+480s after liftoff. Round-off vs. modeled events:
//   ascent  (~T+60s crossover + ~115-135km slant) -> arrival ~T+448-500s  MATCH
//   descent (~T+600s crossover + ~133km to LZ-4)  -> arrival ~T+988s     NO MATCH
// Falsification protocol pending first instrumented observation.
// Fitted crossovers are written to predictions.crossover_s, NOT here —
// these defaults are the starting point for the smoothing recursion.

export const SOUND_SPEED_KMS = 0.343; // surface sound speed, km/s

/** Great-circle distance between two lat/lon points, km (haversine). */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371; // Earth radius, km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Predicted audible boom window at an observer, in T+ seconds. */
export function boomWindow(
  crossoverS: number,
  observerLat: number,
  observerLon: number,
  sourceLat: number,
  sourceLon: number,
  windowPreS: number,
  windowPostS: number,
): { startS: number; endS: number; propDelayS: number } {
  const d = haversineKm(observerLat, observerLon, sourceLat, sourceLon);
  const propDelayS = d / SOUND_SPEED_KMS;
  return {
    startS: crossoverS - windowPreS + propDelayS,
    endS: crossoverS + windowPostS + propDelayS,
    propDelayS,
  };
}