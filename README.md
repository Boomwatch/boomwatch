# BoomWatch

Crowdsourced sonic-boom tracking for orbital launches from Vandenberg SFB.
Predicts when and where launch-associated sonic booms will be heard, collects
ground-truth observations from listeners, and aggregates them into verdicts.

**Status: live and self-updating as of 2026-11-20. Pipeline migrated from a Cloudflare cron worker to a local poller — first unattended run caught a launch slip 8 minutes after the source updated.**

- Calculator: **https://boomwatch.pages.dev**
- API: **https://boomwatch-api.cloudflare-sporty919.workers.dev** (`/health`, `/launches`, `/report`, `POST /admin/ingest` — auth'd)
- Ingest: local poller (`local-poller/poll.py`) on the builder's Mac mini, **4× daily** via launchd (00:00/06:00/12:00/18:00 local — cadence is a plist edit away if freshness demands more)
- DB: Cloudflare D1 (`boomwatch-db`)

## How it works

Three tiers on Cloudflare's free tier, no build step, one SQLite database:

1. **Ingest (4× daily, local).** `poll.py` fetches upcoming Vandenberg
   (SLC-4E) launches from the Launch Library 2 API — **production host**
   (`ll.thespacedevs.com`, v2.2.0) from the home IP's clean 15 req/hr bucket —
   transforms them to the D1 contract, and pushes them through the
   authenticated `POST /admin/ingest` route on the API worker. Scheduled by
   launchd (`com.boomwatch.poller`, plist tracked in
   `local-poller/`), verified unattended. If the Mac was asleep at poll
   time, launchd runs the job once on wake.
   - The former `boomwatch-ingest` cron worker is **retired**: its triggers
     were deleted via the Cloudflare dashboard and its `wrangler.toml` cron
     lines are commented out. The code stays as the canonical TypeScript
     reference for the transform contract. **Do not casually uncomment those
     cron lines** — the comment is load-bearing; a deploy would resurrect a
     pipeline that now fights the LL2 rate limit (see below).
2. **API (on-demand).** `boomwatch-api` serves public reads (launch list with
   predictions, launch detail) and accepts crowdsourced boom reports
   (heard yes/no/unsure, loudness 1-5, wall-clock `observed_utc` stamped at
   the moment of hearing, reporter lat/lon). Strict field validation; `trust`
   defaults to 0.5 until the verdict engine refines it.
3. **Frontend (static).** Single-file calculator at `frontend/index.html`:
   predicted boom windows per launch per city (peak = crossover + sound-speed
   propagation), live fetch from the API with embedded-snapshot fallback,
   custom-location/GPS support, and the report form ("Stamp time NOW" captures
   the wall-clock datum). Model math mirrors `shared/sites.ts`.

## The physics model (v0)

Surface sound speed 343 m/s. Ascent boom sourced at SLC-4E, with a profile
slack window (−60/+180 s) around a fitted Mach-crossover (currently T+60 s).
A descent/return boom profile (crossover T+600 s, sourced at LZ-4) exists but
is conditioned on an RTLS recovery — **droneship launches have no descent
boom**, so check the mission profile before setting expectations. Windows are
expectations, not appointments: refraction and winds shift arrivals by tens
of seconds. First calibration anchor: Ventura, ~133 km from the pad, observed
boom ≈ T+8 min after liftoff on droneship-profile launches.

The falsification protocol: on the first observed launch, wall-clock boom
timestamps vs. webcast T+0 discriminate the ascent hypothesis (early peak
~T+8½ min at Ventura) from the descent hypothesis (late, ~T+16-17 min, RTLS
only). Two cities reporting (Ventura + Santa Barbara, ~90-100 s propagation
offset) turn one observation into a corroborated measurement.

## Why the ingest is local (a short war story)

Cloudflare Workers egress presents to LL2 as effectively **one shared client
identity** for the entire platform (`2a06:98c0:3600::`) — every Discord
launch bot and hobby notifier included. The unauthenticated 15 req/hr bucket
was measured **full before our first request**, at unrelated hours. No cron
schedule dodges that. The fix wasn't spending money or tuning minutes — it
was changing identity: the home IP has its own clean bucket (measured 10/15
per poller run; ~40 of a possible ~360 requests/day at 4× daily, enormous
headroom to raise cadence). The API-key route (LL2 Patreon) remains the
documented escalation if the home bucket ever tightens.

## Local development

```bash
# Frontend — must be served over http (file:// breaks fetch/CORS):
cd frontend && python3 -m http.server 8000

# API worker against remote D1:
cd workers/api && npx wrangler dev --remote

# Ingest poller (manual run — consumes ~10 requests from the home LL2 bucket):
python3 local-poller/poll.py
```

Database operations go through `wrangler d1 execute boomwatch-db --remote
--command "..."`. `wrangler dev` without `--remote` uses an empty LOCAL D1.

## Repository layout

```
shared/           schema.sql, sites.ts (site registry + boom model constants)
frontend/         index.html (calculator + report form), 404.html
workers/api/      public reads, report intake, admin ingest route
workers/ingest-cron/  RETIRED — canonical TS reference for the transform contract
local-poller/     poll.py (sole ingest path) + com.boomwatch.poller.plist
docs/             TRACKER.md (full project log), session archives, probe artifacts
```

## Tracking

The full project log — incidents, decisions, specs, and ~49 co-authored
lessons — lives in `docs/TRACKER.md` and is updated every session. Past
highlights: the lldev staleness incident (source lag reached the live site),
the LL2 shared-egress discovery, the 5-cron free-tier ceiling, and the local
poller migration that resolved them all architecturally.

## Known v0 limitations (deliberate)

- No Turnstile/captcha and no rate limiting on `/report` yet — required
  before publicizing.
- CORS allowlist is broader than intended (`*.pages.dev` suffix match) —
  tightening queued.
- `reports.distance_km` unpopulated (verdict-cron's job).
- Verdict-cron (Bayesian aggregation) not yet built — awaits first real data.
- Recovery type is not auto-ingested for national-security missions (LL2
  data is sparse); cross-check the provider's page and update manually —
  exactly how the USSF-317 droneship profile was resolved.
- City presets are coarse (city centers); custom coordinates / GPS cover the
  rest.
- Single site (Vandenberg) in v1; Cape Canaveral and Starbase are v2; the
  schema already supports them.

## License

Personal/hobby project. Data from Launch Library 2 (The Space Devs) —
respect their rate limits and terms.
