import {
  SITES, PROFILES, boomWindow, SOUND_SPEED_KMS,
} from "../../../shared/sites";
import type { LL2Launch } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SITE = SITES["vandenberg"];
const ASCENT = PROFILES["f9_rtls_ascent"];
const DESCENT = PROFILES["f9_rtls_descent"];

// Use lldev (stale, unthrottled) in development; ll (live, 15 req/hr) in prod.
// Override at deploy time: `--var` or wrangler.toml [vars].
const API_BASE = "https://lldev.thespacedevs.com";

// How far ahead to ingest.
const LOOKAHEAD_DAYS = 14;
const PAGE_LIMIT = 20;          // LL2 max page size
const MAX_PAGES = 4;            // 80 Vandenberg-matching records is plenty

export interface Env {
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// LL2 fetching
// ---------------------------------------------------------------------------

async function fetchUpcomingVandenberg(): Promise<LL2Launch[]> {
  const matches: LL2Launch[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${API_BASE}/2.2.0/launch/upcoming/?mode=list&limit=${PAGE_LIMIT}` +
      `&offset=${page * PAGE_LIMIT}&search=Vandenberg`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`LL2 ${res.status} on page ${page}`);
    }
    const body = (await res.json()) as {
      results: LL2Launch[];
      next: string | null;
    };
    for (const launch of body.results) {
      // NOTE: mode=list returns pad as a STRING name, not an object.
      // Client-side filtering on pad id requires mode=default, so we
      // filter on name substring here and re-verify in full mode below.
      matches.push(launch);
    }
    if (!body.next) break;
  }
  return matches;
}

// Fetch a single launch in full mode (richer pad object with ids).
async function fetchFullLaunch(id: string): Promise<LL2Launch | null> {
  const res = await fetch(`${API_BASE}/2.2.0/launch/${id}/`);
  if (!res.ok) return null;
  return (await res.json()) as LL2Launch;
}

// ---------------------------------------------------------------------------
// Mapping / resolution
// ---------------------------------------------------------------------------

function isVandenberg(launch: LL2Launch): boolean {
  return launch.pad?.id === SITE.ll2PadId ||
         launch.pad?.name === "Space Launch Complex 4E";
}

function toLaunchRow(l: LL2Launch): {
  id: string; site_id: string; provider: string; vehicle: string;
  mission: string; net_utc: string; window_min: number | null;
  recovery_type: "rtls" | "droneship" | "expendable" | "catch" | "unknown";
  landing_site: string | null; raw_json: string;
} {
  const provider = l.launch_service_provider?.name ?? "Unknown";
  const vehicle = l.rocket?.configuration?.name ?? "Unknown";
  const mission = l.mission?.name ?? l.name.split("|").pop()?.trim() ?? l.name;
  const net = l.net;
  const windowMin = (l.window_start && l.window_end)
    ? Math.round((Date.parse(l.window_end) - Date.parse(l.window_start)) / 60000)
    : null;

  // LL2 sparse-landing heuristic: national-security missions often carry
  // no landing info. Do not guess RTLS — default to unknown.
  const recoveryType = "unknown" as const;
  const landingSite = null as string | null;

  return {
    id: l.id, site_id: SITE.site_id, provider, vehicle, mission,
    net_utc: net, window_min: windowMin,
    recovery_type: recoveryType, landing_site: landingSite,
    raw_json: JSON.stringify(l),
  };
}

// ---------------------------------------------------------------------------
// Boom prediction
// ---------------------------------------------------------------------------

interface PredictionRow {
  launch_id: string; boom_seq: number; profile_id: string;
  crossover_s: number; prop_delay_s: number; confidence: number;
  model_version: string;
}

function buildPredictions(launchId: string, isRTLS: boolean): PredictionRow[] {
  const MODEL_VERSION = "v1.0-ascent+descent";
  const rows: PredictionRow[] = [];

  // Ascent boom: predicted for every launch (supersonic ascent happens
  // regardless of recovery type). Source: the pad itself (conservative).
  const asc = boomWindow(
    ASCENT.defaultCrossoverS,
    SITE.refLat, SITE.refLon,     // prop delay measured to site ref point
    SITE.padLat, SITE.padLon,
    ASCENT.windowPreS, ASCENT.windowPostS,
  );
  rows.push({
    launch_id: launchId, boom_seq: 1, profile_id: ASCENT.profile_id,
    crossover_s: ASCENT.defaultCrossoverS,
    prop_delay_s: asc.propDelayS,
    confidence: isRTLS ? ASCENT.priorConfidence : ASCENT.priorConfidence * 0.7,
    model_version: MODEL_VERSION,
  });

  // Descent boom: only when RTLS is confirmed. Pad/LZ distance is small
  // (~500 m); we use LZ-4 as source.
  if (isRTLS) {
    const desc = boomWindow(
      DESCENT.defaultCrossoverS,
      SITE.refLat, SITE.refLon,
      SITE.refLat, SITE.refLon,   // source = recovery point itself
      DESCENT.windowPreS, DESCENT.windowPostS,
    );
    rows.push({
      launch_id: launchId, boom_seq: 2, profile_id: DESCENT.profile_id,
      crossover_s: DESCENT.defaultCrossoverS,
      prop_delay_s: desc.propDelayS,
      confidence: DESCENT.priorConfidence,
      model_version: MODEL_VERSION,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// D1 upserts
// ---------------------------------------------------------------------------

async function upsertLaunch(db: D1Database, row: ReturnType<typeof toLaunchRow>) {
  await db
    .prepare(
      `INSERT INTO launches
         (id, site_id, provider, vehicle, mission, net_utc, window_min,
          recovery_type, landing_site, raw_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
       ON CONFLICT(id) DO UPDATE SET
         provider=excluded.provider, vehicle=excluded.vehicle,
         mission=excluded.mission, net_utc=excluded.net_utc,
         window_min=excluded.window_min,
         recovery_type=excluded.recovery_type,
         landing_site=excluded.landing_site,
         raw_json=excluded.raw_json`,
    )
    .bind(row.id, row.site_id, row.provider, row.vehicle, row.mission,
          row.net_utc, row.window_min, row.recovery_type,
          row.landing_site, row.raw_json)
    .run();
}

async function upsertPrediction(db: D1Database, row: PredictionRow) {
  await db
    .prepare(
      `INSERT INTO predictions
         (launch_id, boom_seq, profile_id, crossover_s, prop_delay_s,
          confidence, model_version)
       VALUES (?1,?2,?3,?4,?5,?6,?7)
       ON CONFLICT(launch_id, boom_seq) DO UPDATE SET
         profile_id=excluded.profile_id,
         crossover_s=excluded.crossover_s,
         prop_delay_s=excluded.prop_delay_s,
         confidence=excluded.confidence,
         model_version=excluded.model_version`,
    )
    .bind(row.launch_id, row.boom_seq, row.profile_id, row.crossover_s,
          row.prop_delay_s, row.confidence, row.model_version)
    .run();
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default {

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext)   {
    const db = env.DB;

    // 1. Fetch candidate list (mode=list, broad search match)
    const candidates = await fetchUpcomingVandenberg();
    console.log(`LL2 search returned ${candidates.length} candidate launches`);

    // 2. Cut to the lookahead window
    const cutoff = Date.now() + LOOKAHEAD_DAYS * 86400 * 1000;
    const inWindow = candidates.filter((l) => {
    // Date gate applies to everything — no exceptions
    const t = Date.parse(l.net);
    if (!Number.isFinite(t) || t > cutoff) return false;

    // Vandenberg check: pad ID (full mode) or pad name (list mode)
    if (isVandenberg(l) === true) return true;
    if (typeof (l as any).pad === "string" && (l as any).pad === "Space Launch Complex 4E") return true;
    return false;
    });

    // 3. For each, fetch full mode to get pad.id (reliable filter + archive)
    const processed: string[] = [];
    for (const candidate of inWindow) {
      const full = await fetchFullLaunch(candidate.id);
      if (!full || !isVandenberg(full)) continue;

      const row = toLaunchRow(full);
      await upsertLaunch(db, row);

      // recovery_type unknown for now — RTLS confirmation is manual/cross-
      // source (deferred to Batch 3's enhancement or manual admin action).
      const preds = buildPredictions(row.id, /* isRTLS */ false);
      for (const p of preds) {
        await upsertPrediction(db, p);
      }
      processed.push(row.id);
    }

    console.log(`Ingested ${processed.length} Vandenberg launches:`);
    console.log(processed.join("\n"));
  },
};