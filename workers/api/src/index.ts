/**
 * boomwatch-api — public reads + report intake.
 *
 * Routes:
 *   GET  /health            — liveness probe
 *   GET  /launches          — upcoming launches with prediction summary
 *   GET  /launches/:id       — one launch, full detail
 *   POST /report            — crowdsourced report intake
 *   OPTIONS *               — CORS preflight
 *
 * v0 posture: validation is strict on shape, lenient on abuse
 * (no Turnstile, no rate limiting — both are pre-publication tasks).
 * Trust weight is stored flat at 0.5; the verdict-cron will do the
 * plausibility down-weighting later, since that's where the Bayesian
 * machinery lives anyway.
 */

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;   // set via: wrangler secret put ADMIN_TOKEN
}

const HEARD_VALUES = new Set(["yes", "no", "unsure"]);

/* ---------------------- CORS ---------------------- */

const allowedOrigin = (origin: string | null): origin is string => {
  if (!origin) return false;
  return (
    origin.startsWith("http://localhost") ||
    origin.endsWith(".pages.dev") ||
    origin.endsWith(".workers.dev")
  );
};

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/* ---------------------- helpers ---------------------- */

const json = (status: number, body: unknown, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });

const badRequest = (msg: string, origin: string | null) =>
  json(400, { ok: false, error: msg }, origin);

// Mirror of PAD_SLC4E in frontend/index.html & shared/sites.ts — KEEP IN SYNC.
const PAD_LAT = 34.632, PAD_LON = -120.611, EARTH_R_M = 6371000;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return (2 * EARTH_R_M * Math.asin(Math.sqrt(a))) / 1000;
}



/* ---------------------- handlers ---------------------- */

async function getLaunches(env: Env, origin: string | null): Promise<Response> {
  // Serve upcoming + recently-flown launches: recent ones stay reportable
  // (dropdown + late calibration reports). 30-day floor keeps the list sane;
  // frontend splits upcoming vs recent on its side.
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.mission, l.net_utc, l.actual_launch_utc, l.window_min,
            l.recovery_type,
            p.boom_seq, p.profile_id, p.crossover_s, p.confidence
     FROM launches l
     LEFT JOIN predictions p ON p.launch_id = l.id
     WHERE l.net_utc >= datetime('now', '-30 days')
     ORDER BY l.net_utc ASC, p.boom_seq ASC
     LIMIT 100`
  ).all();

  return json(200, { ok: true, launches: results ?? [] }, origin);
}

async function getLaunchDetail(env: Env, id: string, origin: string | null): Promise<Response> {
  const launch = await env.DB.prepare(
    `SELECT id, mission, net_utc, actual_launch_utc, window_min, recovery_type
     FROM launches WHERE id = ?`
  ).bind(id).first();

  if (!launch) return json(404, { ok: false, error: "launch not found" }, origin);

  const { results: preds } = await env.DB.prepare(
    `SELECT boom_seq, profile_id, crossover_s, prop_delay_s, confidence
     FROM predictions WHERE launch_id = ? ORDER BY boom_seq`
  ).bind(id).all();

  return json(200, { ok: true, launch, predictions: preds ?? [] }, origin);
}


interface IngestLaunchRow {
  id: string; site_id: string; provider: string; vehicle: string;
  mission: string; net_utc: string; window_min: number | null;
  recovery_type: string; landing_site: string | null; raw_json: string;
}
interface PredictionRow {
  launch_id: string; boom_seq: number; profile_id: string;
  crossover_s: number; prop_delay_s: number | null;
  confidence: number; model_version: string;
}

interface ReportBody {
  launch_id?: unknown;
  heard?: unknown;
  boom_seq?: unknown;
  observed_utc?: unknown;
  magnitude?: unknown;
  lat?: unknown;
  lon?: unknown;
}

async function postReport(env: Env, body: ReportBody, origin: string | null): Promise<Response> {
  /* --- validate every field before touching the DB --- */

  if (typeof body.launch_id !== "string" || body.launch_id.length > 64)
    return badRequest("launch_id must be a string", origin);

  const heard = body.heard;
  if (typeof heard !== "string" || !HEARD_VALUES.has(heard))
    return badRequest(`heard must be one of: ${[...HEARD_VALUES].join(", ")}`, origin);

  const seqNum = body.boom_seq === undefined || body.boom_seq === null
    ? 1 : Number(body.boom_seq);
  if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > 3)
    return badRequest("boom_seq must be an integer 1–3", origin);


  // Wall-clock time the user heard it — REQUIRED (matches frontend guard;
  // unstamped reports are calibration-dead weight). Valid ISO 8601, ±48h.
  if (typeof body.observed_utc !== "string")
    return badRequest("observed_utc is required (ISO 8601) — press STAMP first", origin);
  const t = Date.parse(body.observed_utc);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 48 * 3600 * 1000)
    return badRequest("observed_utc is not a plausible timestamp", origin);
  const observed = body.observed_utc;


  let magnitude: number | null = null;
  if (body.magnitude !== undefined && body.magnitude !== null) {
    magnitude = Number(body.magnitude);
    if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 5)
      return badRequest("magnitude must be an integer 1–5", origin);
  }

  if (body.lat === undefined || body.lon === undefined)
    return badRequest("lat and lon are required", origin);
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
      !Number.isFinite(lon) || Math.abs(lon) > 180)
    return badRequest("lat/lon out of range", origin);

  /* --- launch must exist (clean 404 instead of FK crash) --- */

  const launch = await env.DB.prepare(
    `SELECT id FROM launches WHERE id = ?`
  ).bind(body.launch_id).first();
  if (!launch) return json(404, { ok: false, error: "unknown launch_id" }, origin);

  /* --- insert; distance computed to pad source (KEEP-IN-SYNC mirror),
       trust uses schema default 0.5, verdict-cron refines later --- */

  const distanceKm = haversineKm(lat, lon, PAD_LAT, PAD_LON);

  const info = await env.DB.prepare(
    `INSERT INTO reports
       (launch_id, boom_seq, heard, magnitude, observed_utc, lat, lon,
        distance_km, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(body.launch_id, seqNum, heard, magnitude, observed, lat, lon,
         distanceKm, new Date().toISOString()).run();

  return json(201, {
    ok: true,
    report_id: info.meta?.last_row_id ?? null,
    received: "logged — thank you",
  }, origin);
}

async function requireAdmin(request: Request, env: Env, origin: string | null): Promise<Response | null> {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m) return badRequest("missing bearer token", origin);
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1])),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_TOKEN)),
  ]);
  // Compare digests byte-for-byte; digest equality implies token equality.
  const da = new Uint8Array(a), db = new Uint8Array(b);
  if (da.length !== db.length) return badRequest("bad token", origin);
  let ok = true;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) ok = false;
  if (!ok) return badRequest("bad token", origin);
  return null; // authorized
}

/* ---------------------- router ---------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const path = url.pathname.replace(/\/+$/, ""); // trim trailing slash

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (path === "/health")
      return json(200, { ok: true, service: "boomwatch-api", time: new Date().toISOString() }, origin);

    if (request.method === "GET" && path === "/launches")
      return getLaunches(env, origin);

    if (request.method === "GET" && path.startsWith("/launches/"))
      return getLaunchDetail(env, path.slice("/launches/".length), origin);

    if (request.method === "POST" && path === "/report") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return badRequest("body must be valid JSON", origin);
      }
      if (typeof body !== "object" || body === null)
        return badRequest("body must be a JSON object", origin);
      return postReport(env, body as ReportBody, origin);
    }


    // POST /admin/ingest — authenticated bulk upsert of pre-transformed rows.
    // CONTRACT: accepts exactly the canonical launch/prediction row shapes and
    // nothing else. This contract is frozen on purpose — future remote ingest
    // (worker-side fetch+transform) will POST to this same route, so D1 write
    // SQL lives here and only here regardless of where the fetch runs.
    if (request.method === "POST" && path === "/admin/ingest") {
      const denied = await requireAdmin(request, env, origin);
      if (denied) return denied;

      let body: { launches: IngestLaunchRow[]; predictions: PredictionRow[] };
      try {
        body = await request.json();
      } catch {
        return badRequest("invalid JSON body", origin);
      }

      // ---- Shape validation: strict before any DB touch (house style) ----
      if (!body || typeof body !== "object" ||
          !Array.isArray(body.launches) || !Array.isArray(body.predictions)) {
        return badRequest("body must be {launches:[], predictions:[]}", origin);
      }
      if (body.launches.length === 0 && body.predictions.length === 0) {
        return json(200, { ok: true, ingested: 0, note: "nothing to write" }, origin);
      }

      const LAUNCH_FIELDS = ["id","site_id","provider","vehicle","mission",
        "net_utc","window_min","recovery_type","landing_site","raw_json"];
      for (const l of body.launches) {
        if (typeof l !== "object" || l === null) return badRequest("launch row not an object", origin);
        for (const f of LAUNCH_FIELDS) {
          if (!(f in l)) return badRequest(`launch row missing field: ${f}`, origin);
        }
        if (typeof l.id !== "string" || l.id.length === 0 || l.id.length > 64)
          return badRequest("launch id must be a string, 1-64 chars", origin);
        if (typeof l.site_id !== "string") return badRequest("site_id must be a string", origin);
        if (typeof l.provider !== "string" || typeof l.vehicle !== "string" ||
            typeof l.mission !== "string")
          return badRequest("provider/vehicle/mission must be strings", origin);
        if (typeof l.net_utc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(l.net_utc))
          return badRequest("net_utc must be ISO 8601", origin);
        if (l.window_min !== null && !Number.isInteger(l.window_min))
          return badRequest("window_min must be integer or null", origin);
        if (!["rtls","droneship","expendable","catch","unknown"].includes(l.recovery_type))
          return badRequest("recovery_type invalid", origin);
        if (typeof l.raw_json !== "string") return badRequest("raw_json must be a string", origin);
      }

      const PRED_FIELDS = ["launch_id","boom_seq","profile_id","crossover_s",
        "prop_delay_s","confidence","model_version"];
      const payloadIds = new Set(body.launches.map((l: IngestLaunchRow) => l.id));
      for (const p of body.predictions) {
        if (typeof p !== "object" || p === null) return badRequest("prediction row not an object", origin);
        for (const f of PRED_FIELDS) {
          if (!(f in p)) return badRequest(`prediction row missing field: ${f}`, origin);
        }
        if (!payloadIds.has(p.launch_id) &&
            !(await env.DB.prepare("SELECT 1 FROM launches WHERE id = ?").bind(p.launch_id).first())) {
          return badRequest(`prediction references unknown launch: ${p.launch_id}`, origin);
        }
        if (![1,2,3].includes(p.boom_seq)) return badRequest("boom_seq must be 1-3", origin);
        if (typeof p.profile_id !== "string") return badRequest("profile_id must be a string", origin);
        if (typeof p.crossover_s !== "number" || typeof p.confidence !== "number")
          return badRequest("crossover_s/confidence must be numbers", origin);
        if (typeof p.model_version !== "string") return badRequest("model_version must be a string", origin);
      }

      // ---- Upserts: canonical SQL. ingest-cron's copy is retired when its
      // trigger is disabled; if remote ingest is ever rebuilt, it should POST
      // here rather than duplicate this SQL again. ----
      const upsertLaunch = `
        INSERT INTO launches
          (id, site_id, provider, vehicle, mission, net_utc, window_min,
          recovery_type, landing_site, raw_json)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
        ON CONFLICT(id) DO UPDATE SET
          provider=excluded.provider, vehicle=excluded.vehicle,
          mission=excluded.mission, net_utc=excluded.net_utc,
          window_min=excluded.window_min, recovery_type=excluded.recovery_type,
          landing_site=excluded.landing_site, raw_json=excluded.raw_json`;

      const upsertPrediction = `
        INSERT INTO predictions
          (launch_id, boom_seq, profile_id, crossover_s, prop_delay_s,
          confidence, model_version)
        VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(launch_id, boom_seq) DO UPDATE SET
          profile_id=excluded.profile_id, crossover_s=excluded.crossover_s,
          prop_delay_s=excluded.prop_delay_s, confidence=excluded.confidence,
          model_version=excluded.model_version`;

      // Launches first (FK parents), then predictions.
      for (const l of body.launches) {
        await env.DB.prepare(upsertLaunch)
          .bind(l.id, l.site_id, l.provider, l.vehicle, l.mission,
                l.net_utc, l.window_min, l.recovery_type, l.landing_site, l.raw_json)
          .run();
      }
      for (const p of body.predictions) {
        await env.DB.prepare(upsertPrediction)
          .bind(p.launch_id, p.boom_seq, p.profile_id, p.crossover_s,
                p.prop_delay_s, p.confidence, p.model_version)
          .run();
      }

      return json(200, {
        ok: true,
        ingested: body.launches.length,
        predictions_written: body.predictions.length,
      }, origin);
    }


    return json(404, { ok: false, error: "no such route" }, origin);
  },
};