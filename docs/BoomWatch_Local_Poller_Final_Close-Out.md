# BoomWatch — Local Poller Pipeline (Complete)

**Status as of 2026-11-20: MIGRATION COMPLETE AND FULLY OPERATIONAL.** The Mac mini local poller is the sole ingest path for BoomWatch: four times daily it pulls Vandenberg launches from LL2 (clean home-IP bucket) and pushes through the authenticated `/admin/ingest` route on `boomwatch-api`. The deployed ingest-cron is retired. This document is the full close-out record for the main chat.

---

## Executive summary (for main-chat handoff)

- **Pipeline live and verified end-to-end**: launchd → poll.py → LL2 2.2.0 → transform → authenticated POST → D1. Manual and unattended (launchd-invoked) runs produce identical results.
- **Cadence: 4× daily** — 00:00, 06:00, 12:00, 18:00 local time (PST/PDT). Measured cost ~10 of 15 LL2 requests per full run; 6-hour spacing guarantees the rolling hourly bucket fully resets between runs.
- **Value proven on maiden run (2026-11-19):** first production push captured USSF-317's day-of triple retarget (04:32 → 06:43 → Nov 21 02:32 UTC) ~8 minutes after LL2 recorded the final update — ahead of the old cron's next window and of a scrubbed launch.
- **Ingest-cron retired:** 5 staggered triggers (added during 11-19 LL2 troubleshooting) deleted via Cloudflare dashboard; worker code retained as the canonical TS reference. Local poller is the only ingest writer via the frozen `/admin/ingest` contract.
- **Future hooks designed-for, documented below:** LL2 2.3.0 switch, LL2 API key, remote-ingest revert, Pi Zero port. None require redesign — each has a designated single change-point.

---

## Final state of every component

| Component | State |
|---|---|
| `/admin/ingest` route on `boomwatch-api` | **LIVE** — deployed, Bearer-token auth (`ADMIN_TOKEN` secret), SHA-256 digest comparison, shape-validated, canonical upsert SQL (`excluded.net` typo fixed), `/health` OK |
| `~/boomwatch/local-poller/poll.py` | **COMPLETE** — Python 3.9 stdlib only, argparse, hardened retries, throttle instrumentation, 429 run-abort; production-proven |
| launchd agent `com.boomwatch.poller` | **INSTALLED & VERIFIED** — `StartCalendarInterval` at hours 0, 6, 12, 18; wake-catchup (`StartCalendarIntervalDelay`); reload verified via `launchctl print` (four calendar times listed); kickstart test fire returned Push OK |
| First production push + D1 verification | **DONE** 2026-11-19 ~8:50 pm PST — 7 launches, 7 predictions; D1 SELECTs confirmed exact fingerprint and current data |
| Ingest-cron (`boomwatch-ingest`) | **RETIRED** — triggers deleted via dashboard 2026-11-20; toml crons commented (load-bearing — do not uncomment casually); code stays in repo as reference |
| Token files | `~/.boomwatch/admin_token` (chmod 600) matches `ADMIN_TOKEN` secret on the worker |
| Pi Zero port | PARKED, no urgency — scp + crontab whenever desired |

**Confirmed constants:** account subdomain `cloudflare-sporty919`; push URL `https://boomwatch-api.cloudflare-sporty919.workers.dev/admin/ingest`; database `boomwatch-db` (49a99423-9462-440a-8400-46722e1dc357); home-IP bucket ident `76.217.177.115`.

---

## Active plist (as deployed)

`~/Library/LaunchAgents/com.boomwatch.poller.plist` — four fire times, all local time (launchd has no UTC mode; ±1h DST drift accepted as immaterial. The eventual Pi crontab will be true UTC):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.boomwatch.poller</string>

    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key><integer>0</integer>
            <key>Minute</key><integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>6</integer>
            <key>Minute</key><integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>12</integer>
            <key>Minute</key><integer>0</integer>
        </dict>
        <dict>
            <key>Hour</key><integer>18</integer>
            <key>Minute</key><integer>0</integer>
        </dict>
    </array>

    <!-- If the Mac was asleep at fire time, run once on wake. -->
    <key>StartCalendarIntervalDelay</key>
    <true/>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/billy/boomwatch/local-poller/poll.py</string>
    </array>

    <!-- FUTURE KEYS (add when adopted): BW_LL2_VERSION=2.3.0; BW_LL2_KEY=<LL2 key>. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>BW_LL2_BASE</key>
        <string>https://ll.thespacedevs.com</string>
        <key>BW_API_URL</key>
        <string>https://boomwatch-api.cloudflare-sporty919.workers.dev/admin/ingest</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/tmp/boomwatch-poller.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/boomwatch-poller.err.log</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
```

**Management:** edit plist → `launchctl bootout gui/$(id -u)/com.boomwatch.poller` → `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boomwatch.poller.plist` → verify with `launchctl print gui/$(id -u)/com.boomwatch.poller | grep -A8 "calendar"`. Manual fire: `launchctl kickstart`. Logs: `/tmp/boomwatch-poller.out.log` (cleared on reboot — acceptable; redirect to a home-dir file for persistence).

**Post-install check-in done:** kickstart test fired cleanly through the full chain (`0/15 → 54 candidates → 7 transformed → Push OK → 10/15`). Watch the first fully-automatic runs to confirm identical behavior.

---

## poll.py — feature inventory (validated in production)

**Config block (top of file, env-overridable):** `LL2_BASE` (default prod), `LL2_DEV_BASE` (hardcoded `https://lldev.thespacedevs.com`), `LL2_VERSION` (default `2.2.0` — the single change-point for the 2.3.0 switch), `API_URL` (default includes `/admin/ingest`).

**CLI (argparse):** `--dry-run` (print payload, no push); `--dev` (lldev; **requires `--dry-run`** — dev data is stale and must never be pushed to D1). Known asymmetry: the pre-run throttle report fires before the `--dev` switch, so dev runs open with a prod-bucket reading and close with the dev one.

**Fetch hardening:** `http_get_json` retries 3× (5/10/15s backoff) on *network* failures only; explicitly re-raises `HTTPError` (server refusals like 429 are never retried — HTTPError subclasses URLError in Python, and a broad except silently amplifies 429s). `fetch_full_launch` re-raises 429 (triggers run-abort) and swallows other HTTPErrors (404 = skip launch is correct).

**Throttle instrumentation:** `throttle_report()` at pre-run, post-dry-run, and post-Push-OK; non-fatal on failure. Schema: `{your_request_limit:15, limit_frequency_secs:3600, current_use, next_use_secs, ident}`. `current_use` includes the check itself; negative `next_use_secs` observed while the bucket drains. lldev has its own separate counter (dev dry-runs effectively free).

**429 run-abort:** the whole fetch/transform phase is wrapped; 429 → clean exit "nothing pushed." Verified live 2026-11-19: at 15/15 the run spent exactly one request and aborted. Prevents partial payloads (lesson #10).

**UA headers:** `boomwatch-local-poller/1.0` on LL2 fetches *and* the POST — Cloudflare's edge blocks default `Python-urllib/*` UA with error 1010.

**Prediction fingerprint (for eyeballing output):** boom_seq 1, profile `f9_rtls_ascent`, crossover_s 60, prop_delay_s ≈1.115, confidence 0.385 (= 0.55 × 0.7), model `v1.0-ascent+descent`. `recovery_type` always `unknown` — LL2 landing data is sparse/unreliable for NRO/USSF; never guess RTLS (Batch 2 design decision, still correct).

**Response contract (frozen):** `{launches:[...], predictions:[...]}` with exact field shapes enforced worker-side. This is the single D1 write path for ingest regardless of which host fetches — Mac mini, Pi Zero, or a future remote-ingest worker. Never re-grow upsert SQL anywhere else.

---

## Lessons learned (all closed; each earned by a real incident, 2026-11-19)

1. **CF edge blocks default Python UA (error 1010).** Three green dry-runs missed it because dry-runs never POST. Fix: distinctive UA on the push. Lesson: test the whole path, not the happy fetch path.
2. **`HTTPError` subclasses `URLError`.** A retry loop catching URLError silently retries 429s, amplifying rate-limit refusals into quota exhaustion (~9 wasted requests in a loop). Fix: re-raise HTTPError *before* the URLError catch; order matters. Lesson: check exception hierarchies before broad excepts.
3. **Failed runs consume LL2 quota.** Evening total ~35+ requests against a rolling 15/hr. The meter counts attempts, not successes. Lesson: budget for worst-case runs; a 1010-bounced push still spends its fetches.
4. **Throttle-abort verified in production.** 15/15 → single 429 → clean one-request abort, zero waste. The instrumentation paid for itself the same night it was installed.
5. **lldev is separately metered, not unthrottled.** Its own counter read 0/15 while prod was drained. Supersedes the earlier "lldev unthrottled" assumption. Dev-host dry-runs are effectively free smoke tests.
6. **Rolling-window knife-edges work but shouldn't be relied on.** A run starting at 14/15 can succeed if old entries age out mid-run. With 4×/day at 6-hour spacing, buckets are guaranteed clean — by design, not luck.
7. **Paste-editing is the top defect class.** Missing URL path (×2), duplicated fetch loop, misplaced `cutoff_ms`, misspelled dev hostname — all from manual patching. Countermeasures: full-file re-review after every paste; `grep -n` enumeration for mechanical fixes; dry-run on dev host before touching prod.
8. **LL2 source data has its own bugs.** USSF-317 booster B1100 vs B1101 conflict inside one payload; NROL-136/-195 records carrying NROL-146 mission patches. Lesson: suspect upstream first when coverage disagrees with archived `raw_json`; structured columns are immune.
9. **SQL typo was authored in the port, not inherited.** `excluded.net` (no such column — column is `net_utc`) broke only the upsert UPDATE path, so it was masked by fresh-insert tests and surfaced only on existing rows (every real push). Diagnosed via `wrangler tail` (500/1101, "no such column: excluded.net at offset 346"). Lesson: validate `excluded.*` references against the schema during transcription, and exercise the UPDATE path in verification, not just INSERT. (Ingest-cron source was clean — verified by grep before blaming it.)
10. **Partial-payload hazard.** 429s intercepted inside `fetch_full_launch` bypassed the run-abort, producing a legitimate-looking 2-launch stump payload. Partial ingests are worse than failed ones — they look successful. Fix: re-raise 429 at the fetch layer.
11. **Maiden-run value proof.** First production ingest captured USSF-317's day-of triple retarget (three slips in one evening: 04:32:55 → 06:43 → Nov 21 02:32 UTC) within ~8 minutes of the final LL2 update — the old cron would have served stale data for hours. Local-poller thesis validated on day zero.

---

## Locked decisions

- **Python stdlib only.** No dependencies to install on the Mac mini or a future Pi Zero.
- **4× daily, 00:00/06:00/12:00/18:00 local.** Spacing guarantees a clean bucket every run; ~10/15 measured cost leaves headroom for manual debugging.
- **`/admin/ingest` contract frozen.** Single D1 write path for ingest, permanently, whichever host fetches.
- **Search-then-verify pad filtering.** List mode returns pad as a string (name check: "Space Launch Complex 4E"); full mode returns pad object (id 16 = SLC-4E). Both checks preserved.
- **Ingest-cron toml comments are load-bearing.** The `[triggers]`/`crons` lines stay commented; uncommenting would resurrect schedules that share the CF egress bucket for zero benefit.

## Parked / future (each has a single designated change-point)

- **LL2 2.3.0 switch:** set `BW_LL2_VERSION=2.3.0` (plist env or constant); audit URL builders + `to_launch_row()` only; `raw_json` archives enable offline re-derivation of historical rows. Current status: 2.3.0 404s on both hosts; 2.2.0 canonical (verified 2026-11-18).
- **LL2 API key (Patreon tier):** inject via `ll2_headers()` only. The code deliberately raises `NotImplementedError` if `BW_LL2_KEY` is set but the header scheme isn't verified from LL2's docs — a wrong scheme fails silently as unauthenticated and burns the bucket. Key benefits: dedicated bucket, higher cadence, unlocks the remote-ingest revert.
- **Pre-flight throttle gating:** compare `current_use` vs expected run cost (~12, reserving manual-debug headroom) before/within runs; abort if insufficient. The *abort* half is already in production; the *gate* half is parked until cadence increases beyond 4×/day or the bucket is shared.
- **Remote-ingest revert (requires API key):** rebuild a cron worker to fetch+transform and POST to `/admin/ingest`; `launchctl bootout` the plist. Order is the exact reverse of this migration. SQL never duplicates.
- **Pi Zero migration:** `scp poll.py pi@<host>:~/boomwatch/`, copy token file (chmod 600), crontab `0 0,6,12,18 * * * python3 /home/pi/boomwatch/poll.py >> /home/pi/boomwatch/poll.log 2>&1` (true UTC, no DST games), `launchctl bootout` on the Mac. Raspberry Pi OS ships Python 3; the Pi-hole host runs 24/7, eliminating the Mac-asleep failure mode. Zero urgency — the Mac mini is a fully functioning primary.
- **Log persistence (optional):** redirect plist log paths from /tmp to `~/boomwatch/local-poller/` if retention across reboots is ever wanted.

---

## Tracking-log entries (append to the external tracking doc)

> **2026-11-19/20 — LOCAL POLLER MIGRATION COMPLETE.** `/admin/ingest` route live on boomwatch-api (Bearer auth via ADMIN_TOKEN secret, SHA-256 digest compare, shape validation, canonical upsert SQL). Local Python poller is the sole ingest path. First production push 11-19 ~8:50 pm PST: 7 launches, 7 predictions, verified in D1, exact fingerprint (0.385/60/1.115). Maiden run captured USSF-317's day-of triple retarget ~8 min after the final LL2 update — value proven on day zero.
>
> **2026-11-20 — Ingest-cron retired.** 5 staggered cron triggers (added 11-19 during LL2 troubleshooting: 13 0, 7 3, 59 4, 19 6, 13 18 UTC) deleted via Cloudflare dashboard. Worker code retained as canonical TS reference; toml crons commented (load-bearing). CF shared-bucket pressure from BoomWatch eliminated.
>
> **2026-11-20 — launchd installed, 4× daily.** com.boomwatch.poller, StartCalendarInterval hours 0/6/12/18 local, wake-catchup enabled, reload verified via launchctl print. Kickstart test: full clean chain, Push OK, 10/15 measured. Cadence decision: 6-hour spacing guarantees clean buckets; countdown-day extra runs available via manual `launchctl kickstart`.
>
> **Lessons 1–11 closed** (full text in pipeline doc): CF edge UA block; HTTPError⊂URLError retry amplification; failed runs consume quota; throttle-abort verified live; lldev separately metered; rolling-window edges; paste-edit defect class; LL2 source-data bugs; SQL typo authored-in-port (excluded.net, UPDATE-path-only, found via wrangler tail); partial-payload 429 hazard; maiden-run scrub catch.
>
> **Data-quality note.** LL2 upstream inconsistencies observed in raw_json: USSF-317 booster B1100/B1101 conflict within one payload; NROL missions carrying NROL-146 mission patches. Structured columns unaffected; raw_json preserves evidence. Suspect upstream first when coverage disagrees.

## Reference: throttle response schema

```json
{"your_request_limit":15,"limit_frequency_secs":3600,"current_use":0,"next_use_secs":0,"ident":"76.217.177.115"}
```
Endpoint `GET {host}/{version}/api-throttle/`; IP-keyed (home bucket ident 76.217.177.115); lldev has a separate counter. Measured full-run cost: ~10 of 15 including both throttle checks.