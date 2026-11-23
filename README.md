# BoomWatch

Crowdsourced sonic-boom tracking for orbital launches from Vandenberg SFB.
Predicts when and where launch-associated sonic booms will be heard, collects
ground-truth observations from listeners, and aggregates them into verdicts.

**Status: live, self-updating, and calibration-grade as of 2026-11-23.**
First real observation dataset collected (USSF-317, Nov 20: 7 reports, two
sites, launch-ordered arrival times — ascent-boom hypothesis confirmed).
Pipeline: local poller → authenticated admin ingest → D1; frontend and API
harden continuously against lessons from each launch event (see docs/TRACKER.md).

- Calculator: **https://boomwatch.pages.dev**
- API: **https://boomwatch-api.cloudflare-sporty919.workers.dev** (`/health`, `/launches`, `/report`, `POST /admin/ingest` — auth'd)
- Ingest: local poller (`local-poller/poll.py`) on the builder's Mac mini, **4× daily** via launchd
- DB: Cloudflare D1 (`boomwatch-db`)

## How it works

Three tiers on Cloudflare's free tier, no build step, one SQLite database:

1. **Ingest (4× daily, local).** `poll.py` fetches upcoming Vandenberg
   (SLC-4E) launches from the Launch Library 2 API — **production host**
   (`ll.thespacedevs.com`, v2.2.0) from the home IP's clean 15 req/hr bucket —
   transforms them to the D1 contract, and pushes them through the
   authenticated `POST /admin/ingest` route on the API worker. Scheduled by
   launchd (`com.boomwatch.poller`), verified unattended.
   - The former `boomwatch-ingest` cron worker is **retired**; its code stays
     as the canonical TypeScript reference. **Do not casually uncomment its
     cron lines** — a deploy would resurrect a pipeline that fights the LL2
     rate limit.
   - **Launch-anchor convention:** LL2 rewrites `net_utc` to actual liftoff
     ~2 hours post-flight (confirmed on two consecutive launches). The
     `launches.actual_launch_utc` column records the true T-0 — webcast-
     observed when available (preferred, ±2–3 s human), LL2-derived otherwise
     (flagged). All T+ math uses `actual_launch_utc`; LL2-vs-webcast deltas
     are logged (USSF-317: −20 s, LL2 ahead).
2. **API (on-demand).** `boomwatch-api` serves public reads and report intake:
   - `/launches` covers the **next 30 days + last 30 days** — flown launches
     remain listed and reportable (calibration record), and rows include
     `actual_launch_utc` and `window_min`.
   - `/report` requires a **wall-clock `observed_utc` timestamp** (rejected
     server-side without one — matches the frontend's mandatory STAMP flow),
     computes `distance_km` server-side (haversine to SLC-4E), and accepts
     heard yes/no/unsure, optional loudness 1–5, boom sequence 1–3,
     reporter lat/lon. `trust` defaults to 0.5 until the verdict engine
     refines it; ambiguous provenance is down-weighted, never guess-relabelled.
3. **Frontend (static).** Single-file calculator at `frontend/index.html`:
   predicted boom windows per launch per city, live fetch with embedded-snapshot
   fallback, custom-location/GPS support, and a **stamp-first report form**
   (dominant STAMP button at top; submit blocked until stamped; fresh stamp
   required per boom; loudness explicitly optional). Launches split into
   **Upcoming** and **Recent** sections (anchor-based); the report dropdown
   defaults to the temporally-closest launch; multi-day countdowns format as
   `Nd H:MM:SS`; a NET-change badge flags schedule slips between fetches.
   Model math mirrors `shared/sites.ts`.

## The physics model (v0)

Surface sound speed 343 m/s. Ascent boom sourced at SLC-4E, with a profile
slack window (−60/+180 s) around a fitted Mach-crossover (currently T+60 s).
A descent/return boom profile (crossover T+600 s, sourced at LZ-4) exists but
is conditioned on an RTLS recovery — **droneship launches have no descent
boom**. Windows are expectations, not appointments: refraction and winds
shift arrivals by tens of seconds.

**Calibration status (1 launch, 2 sites):** USSF-317 (droneship, Nov 20)
produced correctly range-ordered arrivals — Santa Barbara T+5:24, Ventura
T+7:30–8:25 — confirming the ascent-carpet hypothesis (H1) at both sites.
Earliest firm Ventura stamp T+7:32 vs nominal window open ~T+7:30. The
original falsification protocol is considered executed for the droneship
case; an RTLS launch remains needed to test the descent-boom profile.

## Why the ingest is local (a short war story)

Cloudflare Workers egress presents to LL2 as effectively **one shared client
identity** for the entire platform — the unauthenticated 15 req/hr bucket was
measured **full before our first request**, at unrelated hours. No cron
schedule dodges that. The fix was changing identity: the home IP has its own
clean bucket (~10/15 per poller run; ~40 of ~360 possible requests/day at 4×
daily — headroom to raise cadence). The API-key route (LL2 Patreon) remains
the documented escalation if the home bucket ever tightens.

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
- Verdict-cron (Bayesian aggregation) not yet built — awaits first real data.
- No status column on launches — LL2's post-flight net_utc rewrite is currently 
  silent until the anchor column is populated manually.
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
