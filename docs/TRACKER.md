# BoomWatch Consolidated Project Tracker
**v19 · 2026-11-20 · Local poller close-out folded in from "Mac Mini API to Cloudflare Setup" chat · Live copy: repo `docs/TRACKER.md` (v12 — sync pending)**

---

## 1. Project State

| Component | Status |
|---|---|
| D1 `boomwatch-db` | ✅ Schema v1.1; current launch data current via local-poller pipeline |
| **Ingest path** | ✅ **LOCAL POLLER — sole ingest path (2026-11-20):** `poll.py` (Python stdlib) twice daily via launchd on Mac mini; fetches LL2 from home-IP bucket → transforms → authenticated `POST /admin/ingest` → D1. Unattended run verified byte-identical to manual; measured cost 10/15 req/run |
| `/admin/ingest` route (API worker) | ✅ Live, auth-verified (bearer token), SQL-fixed — single canonical write path |
| **Ingest-cron worker** | ✅ **RETIRED** — all 5 cron triggers deleted via dashboard (authoritative) + commented in toml. Code retained as canonical TS reference. **LOAD-BEARING COMMENT: do not casually uncomment the cron lines** — any future `wrangler deploy` from `workers/ingest-cron/` with them uncommented would resurrect the triggers |
| API worker | ✅ Live, observability on |
| Frontend | ✅ Live, correct data |
| launchd | ✅ `~/Library/LaunchAgents/com.boomwatch.poller.plist`, kickstart-verified |
| Repo | ⚠ Through `66c0e5b` + close-out commits from the Mac-mini chat. Pending: this tracker's sync, file renames, README refresh |

---

## 2. Current Launch Picture

**USSF-317** — net `2026-11-20T04:32:55Z` (slip #8 verified to the second), droneship (OCISLY). Observation protocol: ascent-only, Ventura ~T+8 min ≈ 20:41 PT, webcast T+0, stamps, custom-launch form on drift, Santa Barbara cross-check ~90–100 s later. Report id 2 pending.

**Pipeline validation, worth savoring:** the poller caught USSF-317's triple slip **8 minutes after the source updated, on its maiden run** — before the launchd install was even finished. The entire week's architecture argument (local clean bucket vs saturated platform identity) paid for itself in the first unattended cycle. That's incident 18e's ladder, climbed: decision option 2 (local machine) chosen and proven; the Patreon key stays parked as escalation-only.

---

## 3. INCIDENT LOG (cumulative)

- 18a ✅ lldev missed slip #6 → flip decision
- 18b ✅ 7:00 PM 429 (bucket full, round hour)
- 18c ⚠ 5-cron/account ceiling — now MOOT for ingest (crons deleted); live only for verdict-cron architecture question
- 18d ✅ phantom "UPDATE applied" → lessons 37/38
- 18e ✅→**RESOLVED** off-round falsified; Workers egress = one platform identity → resolved by CHOOSING THE LADDER (local poller), not by key (yet)
- 19a–19c ✅ slips #7/#8 precision handling; recovery sourced from SpaceX webpage
- **20a ✅ Migration to local poller** — from the Mac-mini chat: Cloudflare UA block discovery, HTTPError-subclassing trap, paste-editing defect pattern (pathname vs path, repeated `BW_API_URL` default bug), auth gate verified, SQL fix, end-to-end verification diff (fingerprints exact)
- **20b ✅ Ingest-cron retirement** — dashboard deletion (authoritative) + commented toml; belt and suspenders; resurrection vector documented (lesson below)

## 4. DECISION LADDER — STATUS
1. ~~Scheduling tweaks~~ dead (18e) · 2. **Local-machine pipeline — CHOSEN & PROVEN (2026-11-20)** · 3. LL2 API key — parked, escalation-only if home bucket ever tightens · 4. Workers Paid — parked alongside key; 18c now applies only to verdict-cron design

## 5. Post-Observation Hardening Queue
1. **`actual_launch_utc`** column + capture (verdict-cron prereq)
2. **Data-freshness display** (`net_updated_utc` + `ingest_run_utc` / pipeline-level "data refreshed" line) — spec in v18; now extra-valuable: the poller's uptime is the Mac mini's uptime, so a visible "last refreshed" tell covers a new failure class (machine asleep at poll time)
3. fmtDur h:mm:ss countdown fix
4. API worker non-ASCII scrub (user-facing strings — deliberate edit, own commit)
5. 429 backoff — **softened to moot for ingest** (poller uses home bucket); retain for any future API-worker fetches; failure-alerting still worth it (poller writes logs to /tmp, cleared on reboot)
6. Verdict-cron architecture (5-slot ceiling now irrelevant to ingest — crons freed; hourly verdict-cron IS possible again if wanted, or piggyback on poller cadence)
7. CORS tightening (exact origins) — pre-publicity
8. **Pi Zero port** — parked, zero urgency, steps documented in Mac-mini chat close-out
9. Frontend badge speaks actual recovery_type (`droneship` renders as generic)
10. **Load-bearing comment compliance** — keep ingest-cron toml crons commented; never casual-uncomment
11. README refresh (NET line, pipeline description — now "local poller via launchd," not "cron 06:00 UTC") + tracker file renames + repo sync of this tracker

## 6. Banked facts
- Home-IP bucket: 10/15 measured per poller run, twice daily — comfortable margin
- Workers egress `2a06:98c0:3600::` = platform identity (saturated ×2) — now bypassed by architecture, not fought
- `/admin/ingest` contract frozen per Mac-mini chat; verification diff method (fingerprints exact) proven
- lldev: one slip perpetually behind; irrelevant now (out of pipeline)
- 2.3.0 migration spec: dormant, and now isolated to `poll.py`'s fetch block when/if ever needed
- Persisted observability logs live on both workers (3-day lookback)
- Remote-ingest revert path documented in close-out

## 7. Lessons Log (abridged)
Core lessons 12, 22, 25–28, 30–34, 36–46 as recorded (full text across v15–v18). New from the migration close-out:
- **47. Dashboard deletion beats deploy-time config for irreversible retirements** — authoritative removal that no cached state or racing deploy can resurrect; pair with a commented config so the file agrees with reality. And when a comment becomes load-bearing (the "don't uncomment casually" toml note), say so in the comment itself
- **48. Validate the pipeline before installing the scheduler** — the maiden manual run caught a live scrub 8 minutes after the source moved, proving the architecture argument (clean local bucket vs saturated platform identity) before the launchd plist even existed. Proof-first, install-second
- **49. An isolated fetch block is the cheapest place to park a dormant migration** — moving the LL2 fetch into one local file made the 2.3.0 spec, the API-key hook, and the remote-revert path all "change one file" items. Containment precedes flexibility

## 8. Open Items
- [ ] **Observe USSF-317 (tonight); file report id 2**
- [ ] Post-observation session: hardening queue (freshness display likely first — it now also serves as poller-up-time tell)
- [ ] Verdict-cron decision — now unconstrained by cron slots for ingest; revisit architecture freely (piggyback vs dedicated trigger vs lazy)
- [ ] Repo sync: this tracker (v19) → `docs/TRACKER.md`; rename legacy tracker files; README pipeline description refresh
- [ ] Pi Zero port — whenever-you-feel-like-it, steps in close-out doc
- [ ] NROL-136 (Sat 4:30 AM PT) backup observation if USSF-317 scrubs a ninth time
