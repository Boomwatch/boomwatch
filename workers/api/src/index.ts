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
}

const HEARD_VALUES = new Set(["yes", "no", "unsure"]);
/* const NOTE_MAX = 280; should be deleted

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

/* ---------------------- handlers ---------------------- */

async function getLaunches(env: Env, origin: string | null): Promise<Response> {
  // Upcoming = from 2h ago forward (covers launches in progress/reports)
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.mission, l.net_utc, l.recovery_type,
            p.boom_seq, p.profile_id, p.crossover_s, p.confidence
     FROM launches l
     LEFT JOIN predictions p ON p.launch_id = l.id
     WHERE l.net_utc >= datetime('now', '-2 hours')
     ORDER BY l.net_utc ASC, p.boom_seq ASC
     LIMIT 100`
  ).all();

  return json(200, { ok: true, launches: results ?? [] }, origin);
}

async function getLaunchDetail(env: Env, id: string, origin: string | null): Promise<Response> {
  const launch = await env.DB.prepare(
    `SELECT id, mission, net_utc, recovery_type
     FROM launches WHERE id = ?`
  ).bind(id).first();

  if (!launch) return json(404, { ok: false, error: "launch not found" }, origin);

  const { results: preds } = await env.DB.prepare(
    `SELECT boom_seq, profile_id, crossover_s, prop_delay_s, confidence
     FROM predictions WHERE launch_id = ? ORDER BY boom_seq`
  ).bind(id).all();

  return json(200, { ok: true, launch, predictions: preds ?? [] }, origin);
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

  // Wall-clock time the user heard it — optional but strongly preferred.
  // Validates parseable ISO 8601 and roughly current (±48h) to catch garbage.
  let observed: string | null = null;
  if (body.observed_utc !== undefined && body.observed_utc !== null) {
    if (typeof body.observed_utc !== "string")
      return badRequest("observed_utc must be an ISO 8601 string", origin);
    const t = Date.parse(body.observed_utc);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 48 * 3600 * 1000)
      return badRequest("observed_utc is not a plausible timestamp", origin);
    observed = body.observed_utc;
  }

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

  /* --- insert; trust uses schema default 0.5, verdict-cron refines later --- */

  const info = await env.DB.prepare(
    `INSERT INTO reports
       (launch_id, boom_seq, heard, magnitude, observed_utc, lat, lon, created_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(body.launch_id, seqNum, heard, magnitude, observed, lat, lon,
         new Date().toISOString()).run();

  return json(201, {
    ok: true,
    report_id: info.meta?.last_row_id ?? null,
    received: "logged — thank you",
  }, origin);
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

    return json(404, { ok: false, error: "no such route" }, origin);
  },
};