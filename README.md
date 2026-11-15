# BoomWatch

Crowdsourced sonic-boom tracking for rocket launches from Vandenberg SFB.
Predicts when and where launch-associated sonic booms will be heard, collects
ground-truth observations from listeners, and aggregates them into verdicts.

**Status: live as of 2026-11-15 (Batches 1–6). Awaiting first real observation data — USSF-317, NET Tue 2026-11-17 19:14 PT.**

- Calculator: **https://boomwatch.pages.dev**
- API: **https://boomwatch-api.cloudflare-sporty919.workers.dev** (`/health`, `/launches`, `/report`)
- Ingest cron: `boomwatch-ingest` worker, fires 06:00 UTC daily

## How it works

Three tiers on Cloudflare's free tier, no build step, one SQLite database:

1. **Ingest (nightly cron).** `boomwatch-ingest` pulls upcoming Vandenberg
   launches from the Launch Library 2 API and upserts them into D1
   (`boomwatch-db`) with one boom prediction per launch per boom event
   (`predictions` rows: fitted Mach-crossover time, propagation delay to the
   site reference point, prior confidence). Currently uses the unthrottled
   `lldev` endpoint; production host flip is queued (see Limitations).
2. **API (on-demand).** `boomwatch-api` serves public reads (launch list with
   predictions, launch detail) and accepts crowdsourced boom reports
   (heard yes/no/unsure, loudness 1–5, wall-clock `observed_utc` stamped at the
   moment of hearing, reporter lat/lon). Strict field validation; `trust`
   defaults to 0.5 until the verdict engine refines it.
3. **Frontend (static).** Single-file calculator at `frontend/index.html`:
   predicted boom windows per launch per city (peak = crossover + sound-speed
   propagation), live `fetch` from the API with embedded-snapshot fallback,
   custom-location/GPS support, and the report form ("Stamp time NOW" captures
   the wall-clock datum). Model math mirrors `shared/sites.ts`.

Deployed via `wrangler pages deploy frontend/` (direct upload, production
branch `main`).

## The physics model (v0)

Surface sound speed 343 m/s. Ascent boom sourced at SLC-4E, with a profile
slack window (−60/+180 s) around a fitted Mach-crossover (currently T+60 s).
A descent/return boom profile (crossover T+600 s, sourced at LZ-4) exists but
is conditioned on an RTLS recovery, unconfirmed for most missions — predicted
windows show dashed/"conditional" until a launch is known RTLS. Windows are
expectations, not appointments: refraction and winds shift arrivals by tens
of seconds. First calibration anchor: Ventura, ~133 km from the pad, observed
boom ≈ T+8 min after liftoff on droneship-profile launches.

The falsification protocol: on the first confirmed RTLS launch, wall-clock
boom timestamps vs. webcast T+0 discriminate between the ascent hypothesis
(early peak ~T+8½ min at Ventura) and the descent hypothesis (late, ~T+16–17
min). Two booms confirm both profiles.

## Local development

```bash
# Frontend — must be served over http (file:// breaks fetch/CORS):
cd frontend && python3 -m http.server 8000

# API worker against remote D1:
cd workers/api && npx wrangler dev --remote

# Manual ingest test-fire:
cd workers/ingest-cron && npx wrangler deploy   # cron-only worker
```

Database operations go through `wrangler d1 execute boomwatch-db --remote
--command "..."`. Schema and seed live in `shared/schema.sql` /
`shared/seed.sql`; `wrangler dev` without `--remote` uses an empty LOCAL D1.

## Repository layout

```
shared/           schema.sql, seed.sql, sites.ts, boommodel.ts, bayes.ts
frontend/         index.html (calculator + report form), 404.html
workers/ingest-cron/   nightly LL2 → D1 pipeline
workers/api/           public reads + report intake
```

## Known v0 limitations (deliberate)

- No Turnstile/captcha and no rate limiting on `/report` yet — fine while
  audience is the builder's porch; required before publicizing.
- Ingest still uses `lldev.thespacedevs.com` (unthrottled, occasionally
  stale). Flip `API_BASE` to `ll.thespacedevs.com` before relying on the
  pipeline alone for observation planning; always cross-check NET dates
  against a live schedule — USSF-317 slipped four times in two weeks.
- `reports.distance_km` unpopulated (verdict-cron's job).
- Verdict-cron (Bayesian aggregation) not yet built — waits for real data.
- City presets are coarse (city centers, ±km-level error → tens of seconds
  of propagation). Custom coordinates / GPS cover the rest.
- Single site (Vandenberg) in v1; Cape Canaveral and Starbase (multi-boom
  Starship events) are v2; Wallops v3.
