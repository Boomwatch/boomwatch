# BoomWatch Consolidated Project Tracker
**Compiled 2026-11-18 · v6, gate 2 closed · Sources: "Vandenberg Launch Sonic Boom Tracker" chats (sessions 1–5) + Batch 1/2/4/5 build docs, README, architecture package, tutorial, build steps · Supersedes all in-chat trackers (none persisted externally)**

---

## 1. Project State (verified)

| Component | Status | Evidence |
|---|---|---|
| D1 `boomwatch-db` (id `49a99423-9462-440a-8400-46722e1dc357`) | ✅ Live, schema v1.1 applied | Batch 1 `schema.sql`; `sqlite_master` reconciliation 2026-11-15 |
| Ingest worker `boomwatch-ingest` | ✅ Deployed, cron 06:00 UTC daily, verified 2 consecutive nights, count ~6, horizon Nov 30 | Batch 2; chat logs |
| API worker `boomwatch-api` | ✅ Live (cloudflare-sporty919 account), 8-case test suite all green 2026-11-15; test rows cleaned (next real report = id 2) | Batch 4 status log |
| Frontend (Pages) | ✅ Live at boomwatch.pages.dev; live-fetch + fallback, report form, custom launch, 404.html | Batch 5 |
| README | ✅ Live-system status w/ known v0 limitations — **⚠ NET line stale (still says Nov 17 19:14 PT)** | README.md |
| Cross-origin CORS | ⚠ Allowlist broader than intended (see Item 6) | Batch 4 code |

**Standing rule:** no tool changes the night before an observation window.

**Applied schema (Batch 1, reconciled):** `sites`, `profiles`, `launches`, `predictions` (PK `launch_id, boom_seq`; `crossover_s` lives here, fitted per launch — deliberate deviation from the architecture-doc draft), `reports` (`observed_utc`, `magnitude`, `trust`, no `city`/`note`/`tplus_s`), `verdicts`. **Batch 1's `schema.sql` is authoritative where the architecture package §4 differs.**

---

## 2. Current Launch Picture

**USSF-317 (Falcon 9 Block 5, LL2 id `76617033-4dc0-4448-b50c-e5b0d5a18539`)** — the calibration target.
- **NET: Thursday 2026-11-19, 18:46–22:46 PT = 2026-11-20 02:46–06:46 UTC** (240-min window) — per spacex.com, **confirmed identical in production LL2** (`net: 2026-11-20T02:46:00Z`, extracted from `probe-ts.json` 2026-11-18). Slip #6.
- LL2 status: "Go for Launch"
- Expected in D1 after tonight's 06:00 UTC cron: `net_utc = 2026-11-20T02:46:00Z`, `window_min = 240`

**Observation plan: Thursday evening PT.** Critical caveat: **the card's T+ readout anchors to window open (18:46 PT), not liftoff.** With a 4-hour window, a mid-window flight makes the card's elapsed-T+ wrong by the hold. Therefore:
- T+0 comes from the **webcast liftoff instant** exclusively
- Punch the actual liftoff time into the **custom-launch form** the moment it flies (bridge until Item 1)
- Stamp-now wall-clock times remain valid regardless; calibration math subtracts webcast T+0

---

## 3. Post-Observation Hardening Queue

### Item 1 — `actual_launch_utc` column (T+0 ground truth)
- `ALTER TABLE launches ADD COLUMN actual_launch_utc TEXT`
- Populate post-flight: ingest detects LL2 status→success, captures revised time into the *actual* column, **preserves original NET**
- Alternatively manual entry for personally observed launches; custom-launch form is the working bridge until then
- Enables machine-computable T+ = observed_utc − actual_launch_utc
- **Prerequisite for verdict-cron**
- *Validated by the Nov 19 slip: a 4-hour window makes scheduled-NET-anchored T+ actively misleading mid-window*

### Item 2 — Ingest cadence 3×/day
- `crons = ["0 6 * * *", "0 14 * * *", "0 22 * * *"]` (10pm / 6am / 2pm PT, standard time)
- Worst-case staleness 16h → 8h (USSF-317: 6 slips, several caught late by the 10pm-only cron)
- **DST gotcha:** crons are UTC; re-pin twice yearly or accept 1h drift; document in README
- Throttle interaction with Item 5 (see §5); lldev unthrottled so cadence is free pre-flip
- **First action when built:** log actual per-run fetch count (design estimate ~7/run; source analysis: 3–4 list pages + 1 full fetch per surviving candidate ≈ 8–15)

### Item 3 — Schedule-change badge (`net_updated_utc`)
- Add `net_updated_utc`; set on first write (baseline) and only when `net_utc` actually moves
- Worker knows update-vs-insert at write time (`changes`/`last_row_id` or pre-upsert NET compare)
- Expose via `GET /launches`; render recency badge ("⏱ schedule updated 3h ago")
- **Parked decision:** NET moves only (recommended), not every field revision
- Companion to Item 2 — badge honesty depends on ingest density
- *Six slips make the user-facing case: a visitor Thursday afternoon needs to know the 18:46 showing is fresh*

### Item 4 — Countdown format (`fmtDur`)
- `fmtDur()` in frontend uses `m:ss` unconditionally → "1480:23" absurdities for distant launches
- Fix: conditional format — `m:ss` under 1 hour, `h:mm:ss` at ≥1 hour
- One function, one condition; affects all countdown/elapsed instances

### Item 5 — Production LL2 host/version flip (**REVISED 2026-11-18, full probe results §5**)
**Confirmed from Batch 2 source:** `API_BASE = "https://lldev.thespacedevs.com"` and the version segment is hardcoded in **two fetch sites** in `workers/ingest-cron/src/index.ts`:
- `fetchUpcomingVandenberg()`: `` `${API_BASE}/2.2.0/launch/upcoming/?mode=list...` ``
- `fetchFullLaunch()`: `` `${API_BASE}/2.2.0/launch/${id}/` ``

Refactor spec:
```typescript
const API_BASE = "https://ll.thespacedevs.com";
const API_VER  = "2.2.0";
```
**Filter dependency (2.2.0):** list-mode returns pad as a *string*; the fallback name check `"Space Launch Complex 4E"` depends on it. **Note: this is 2.2.0-only behavior — in 2.3.0 list mode, `pad` is absent entirely (see §5, gate 2).**

### Item 6 — CORS allowlist tightening (found in Batch 4 code review)
- `allowedOrigin()` accepts ANY origin ending `.pages.dev`, `.workers.dev`, or starting `http://localhost` — i.e., **every Cloudflare Pages site** can script `POST /report` against the API
- Harmless today; defeats the CORS gate for report poisoning once public. Turnstile (the real defense) is also unbuilt
- Fix at the pre-publicity pass: allowlist exact origins (`https://boomwatch.pages.dev`, localhost dev) — one-line predicate change
- Pairs with Turnstile and rate limiting

---

## 4. Parked / Later (pre-publicity & v2)

- **Verdict-cron** — blocked on real reports AND Item 1. **Full spec (architecture pkg §6 + build steps Pt 2):**
  - Cron hourly; evaluate launches at NET +90 min / +6 h / +24 h
  - Prior from `predictions.confidence` (ascent 0.55, RTLS descent 0.85, otherwise 0.10)
  - Per-report LRs, matched to nearest predicted window (±180 s): in-window yes→LR⁺=6, in-window no→LR⁻=0.25; outside window yes→2, no→0.6; unsure→1
  - Trust 0.5 default; reduce for impossible observed times (>300 s deviation) and geohash duplicate clusters
  - Update: logit(P′) = logit(P) + Σ wᵢ·lrᵢ, per `boom_seq`, rolled up to launch level
  - Classes: ≥0.9 confirmed · 0.5–0.9 probable · <0.5 w/ ≥3 in-window no = no_boom · <3 reports insufficient_data · else unconfirmed
  - Also owns `distance_km` population (api worker deliberately leaves NULL)
  - *4-hour-window note: with NET +90 min evaluation, a mid-window liftoff's reports could pre-date the first verdict pass — the +6h/+24h passes catch everything regardless*
- **Turnstile** on report form — before publicity
- **KV per-IP rate limit** on `/report` (~5/hr/IP) — before publicity; pairs with Item 6
- **From old build-steps checklist, never completed:**
  - `robots.txt`, favicon, weather disclaimer
  - **GitHub Actions auto-deploy** — push to `main` → `wrangler deploy` for all workers + Pages build. Currently ALL deploys are manual
  - **lat/lon coarsening (~0.01°) on report ingest** — arch doc specified it; Batch 4 worker stores raw coordinates. Decide: coarsen (privacy) or document
- **README NET line refresh** — one-line edit; add to next repo-touching commit
- **v2 sites:** Cape Canaveral + `fh_sideboosters` (highest priority), Starbase multi-boom `starship_boostback`/`starship_ship_return`, Wallops `neutron_rtls` v3; schema/registry already accommodate
- **v3:** Open-Meteo wind refinement, push alerts, report heat-map
- **Open calibration questions (MODEL.md):** does Ventura get BOTH ascent (~T+8 min) and return (~T+16–17 min) booms or only one (falsification protocol resolves); far-standoff under-reporting of the louder return boom — examine at ≥10 verified events

---

## 5. LL2 Version & Throttle Findings (2026-11-18) — PROBE CAMPAIGN COMPLETE

### Confirmed by terminal curl (raw JSON):
- `ll.thespacedevs.com/2.2.0/launch/upcoming/?mode=list&search=Vandenberg` → HTTP 200, `count: 53`. **Production 2.2.0 fully alive.**
- `ll.thespacedevs.com/2.2.0/api-throttle/` → HTTP 200. Trailing slash **required**. Meter real, **per-IP** (`ident: 76.217.177.115`), 15/hour rolling. Worker post-flip metered by Cloudflare egress IP — authoritative for the pipeline
- `ll.thespacedevs.com/2.3.0/api-throttle/` → also live; same 15/hour structure. Readings 2026-11-18: 8/15, later 4/15 (bucket rolled)
- lldev counter vacuous (`current_use: 0`) — effectively unthrottled; browsing LL2's own site burns the same 15/hour production budget

### 2.3.0 probe campaign — ALL GATES CLOSED:

**History:** earlier 404 was a wrong-path artifact — 2.3.0 renamed `/launch/upcoming/` (singular) → `/launches/` (plural). Both hosts 200 at `/2.3.0/launches/`.

**Probe 1 — unfiltered:** `?mode=list&limit=1&format=json&search=Vandenberg` → `count: 999`, first result **Thor Agena A | Discoverer 1 (1959)**.
- 2.3.0 `search=Vandenberg` matches every Vandenberg launch ever flown, oldest-first; built-in "upcoming" scope **gone**
- Silent-failure consequence for naive port: `MAX_PAGES=4 × 20` = 80 records vs 999 oldest-first → never reaches a 2026 launch, no error

**Probe 2 — `net__gte` (first attempt hung transiently; bounded retry resolved):**
- Date-only → HTTP 200 · 1.10s; full timestamp → HTTP 200 · 0.74s. Bodies saved `probe-date.json`, `probe-ts.json`
- **Filtered `count: 53`** — "upcoming" semantics ARE reproducible; original hang was transient
- First filtered result: USSF-317, status "Go for Launch" — soonest-first, so **`ordering` NOT needed**

**Probe 2 body analysis (local extraction, 2026-11-18) — gates 2 and 3 both closed:**
- **`net: 2026-11-20T02:46:00Z`** — LL2 agrees with spacex.com exactly (Nov 19, 18:46 PT). Production LL2 carries the slip; filter boundary behavior correct
- **`pad: None`** — in 2.3.0 list mode, pad is **absent entirely** (2.2.0 returns it as a string). Consequences:
  - The ingest's list-mode name-matching fallback (`"Space Launch Complex 4E"`) **cannot survive a 2.3.0 port**
  - List-stage pad filtering must move **server-side**: 2.3.0 supports `pad` / `pad__location` filter params (`&pad__location=11` or `&pad=16`)
  - Silver lining: server-side pad filtering replaces the broad `search=Vandenberg` net (53 candidates → per-launch re-verifications) and directly serves the ≤10-requests-per-run throttle target (§5 pre-flip gate 4)
  - Structural note: filtering on an absent field would silently pass everything through — the inverse cousin of probe 1's empty-ingest failure; both argue for asserting pad presence in any ported filter

### Migration spec, as measured (if 2.3.0 is ever adopted):
1. Path rename `/launch/upcoming/` → `/launches/` (both fetch sites)
2. Append `&net__gte=<ISO now>` to the list query (date-only and timestamp both work; ~1s)
3. Replace list-stage pad name-match with server-side `&pad=16` (or `pad__location=11`); drop `search=Vandenberg` from the list query (keep it only if desired for redundancy)
4. NO `ordering` param needed — ascending default + filter = soonest-first
5. Pagination: filtered set is ~tens of records; `MAX_PAGES=4` ample
6. `api-throttle/` live under both versions

### Flip recommendation (final):
**Stay on 2.2.0; flip host only (`API_BASE: lldev → ll`), version untouched.** 2.2.0 confirmed working end-to-end (53-record search, pad-as-string filter, throttle meter). 2.3.0 fully mapped and viable if ever needed (spec above) — and its server-side pad filtering would even help the throttle budget — but it buys nothing urgent while 2.2.0 is supported. Host and version flip separately, never both at once.

### Pre-flip gates (host flip on 2.2.0):
1. ~~Raw-JSON verify probes~~ ✅
2. ~~2.3.0 pad shape~~ ✅ absent in list mode; migration spec updated
3. ~~2.3.0 "upcoming" semantics~~ ✅ reproducible via `net__gte`
4. Cut per-run requests to ≤10 — at ~15/run a single run consumes the whole 15/hour budget, zero retry headroom (lever: trim re-verification breadth; on 2.3.0, server-side pad filter)
5. Deploy host flip alone; watch one run's logs for 429s; verify via worker's own `/api-throttle/` readings
6. Resolve whether `/api-throttle/` calls consume allowance (start/end delta vs fetch count)

---

## 6. Lessons Log (co-authored)

1. Paste commands into the terminal with the same skepticism as into the database (trailing-comma SELECT incident)
2. Test artifacts ≠ real data, but the machinery can't tell the difference — treat first real run as unknown
3. Reconcile code against the live schema, not the doc (`sqlite_master` beat the draft schema)
4. lldev staleness demands external cross-checks for classified/USSF missions
5. *(reconstructed)* Fabricated version pins fail (`ETARGET`); use `"latest"`/caret-major, lockfile carries reproducibility
6. *(reconstructed)* `wrangler dev` without `--remote` binds an EMPTY LOCAL D1; `--remote` means every POST is a real production row — cleanup mandatory
7. *(reconstructed)* Missing `"lib": ["ES2022"]` in tsconfig → 103-error DOM/workers-types collision
8. *(reconstructed)* A type predicate (`origin is string`), not a plain boolean, narrows across the call boundary (TS 2322)
9. *(reconstructed)* Test fixtures must obey the validator's own rules — future-dated fixture failed the ±48h gate it was testing
10. *(reconstructed)* Cloudflare Pages serves SPA-fallback 200 for any unknown path; a real `404.html` restores true 404s
11. *(reconstructed)* SQLite AUTOINCREMENT remembers the deleted max — report id 1 died with test cleanup; first real report will be id 2
12. **Assistant memory is not a tracker** — improvements land in the document the same session or they don't exist
13. Constrain requests **per rolling hour**, not per-day, when a "daily" budget hides an hourly cap
14. *(reserved)*
15. **Curl the real endpoint before writing code against remembered shapes**
16. **"One-line change" claims deserve a grep** — a constant's blast radius isn't its line count
17. A 404 proves the *path* dead, not the *resource* — check route renaming (singular→plural) before concluding a version doesn't exist
18. An origin allowlist of suffix matches (`*.pages.dev`) is effectively a wildcard — allowlist exact origins or the CORS gate guards nothing
19. An endpoint rename can hide a **semantic** change — same search string, same status code, but "upcoming" quietly became "all launches ever." Diff probe **content** (first result's date!), not just HTTP status
20. Never retry a hung request blindly — bound it (`--max-time`), split the variables (date-only vs full timestamp), read `-v` to locate the stall. A timeout with telemetry beats a Ctrl-C with none
21. The "hang" behind lesson 20 was transient — but the bounded-retry discipline produced the debug evidence to prove it AND saved the bodies that closed the remaining gates. Cost: one flag. Payoff: three findings
22. With a multi-hour launch window, the NET card's T+ readout anchors to **window open, not liftoff** — mid-window flights make every scheduled-NET-derived elapsed figure a lie. Actual T+0 comes from the webcast; custom-launch form is the bridge until `actual_launch_utc` exists
23. *(NEW, gate 2)* A version bump can **remove** a field your filter depends on (`pad` absent in 2.3.0 list mode vs string in 2.2.0) — and a filter over an absent field silently passes everything, the inverse failure of an empty result. Assert field presence in filters; prefer server-side filtering where the API offers it
24. *(NEW)* Cross-source agreement checks cut both ways: LL2 ↔ spacex.com agreeing on `net` validated the propagation chain end-to-end *before* observation night — the same cheap check that catches divergence early also confirms convergence

*(Lessons 5–11 are reconstructions from the batch documents, not verbatim from the lost session-4 tracker; reconcile wording if the original resurfaces.)*

---

## 7. Open Items Needing Action

- [ ] ~~Run local `net`/`pad` extraction~~ ✅ done 2026-11-18 — LL2/SpaceX agree (`2026-11-20T02:46:00Z`); 2.3.0 pad absent in list mode
- [ ] **Thursday 2026-11-19 evening PT: USSF-317 observation protocol** — window 18:46–22:46 PT; webcast T+0 is the only T+0; stamp wall-clock times for every boom; leading/center/trailing positioning; punch actual liftoff into custom-launch form the moment it flies; Santa Barbara friend on city preset/GPS (two-city cross-check at 90–100 s offset)
- [ ] Friday morning coffee check: `SELECT mission, net_utc, window_min FROM launches` — expect USSF-317 at `2026-11-20T02:46:00Z`, `window_min=240` (confirmation only — LL2 source data verified today)
- [ ] File first real report via live API (will be report id 2)
- [ ] `grep -n "2\.2\.0" workers/ingest-cron/src/index.ts` — expect hits in `fetchUpcomingVandenberg` and `fetchFullLaunch` (Item 5)
- [ ] Add Item 6 (CORS tightening) + GitHub Actions deploy + robots.txt/favicon/disclaimer + lat/lon coarsening decision + README NET refresh to the pre-publicity pass — none were on the old checklist
- [ ] **Commit this tracker into the repo** (suggest `docs/TRACKER.md`) — it lives only in the chat until then
