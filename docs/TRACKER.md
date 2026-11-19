# BoomWatch Consolidated Project Tracker
**Compiled 2026-11-19 · v12, offset deploy complete + account-limit discovery · Sources: "Vandenberg Launch Sonic Boom Tracker" chats (sessions 1–5) + Batch 1/2/4/5 build docs, README, architecture package · Live copy: repo `docs/TRACKER.md` (commit pending)**

---

## 1. Project State (verified)

| Component | Status | Evidence |
|---|---|---|
| D1 `boomwatch-db` (id `49a99423-9462-440a-8400-46722e1dc357`) | ✅ Live, schema v1.1; USSF-317 carries manual fix `2026-11-20T02:46:00Z` (awaiting heal-confirm by a successful run) | Batch 1; incident remediation 2026-11-18 |
| Ingest worker `boomwatch-ingest` | ⚠→✅ v`6fc324a9`: production LL2 + pad__ids filter + telemetry + **5 off-round crons deployed**. Successful full run still pending (first attempt 429'd — Incident 18b) | Deploy outputs 2026-11-18 evening |
| API worker `boomwatch-api` | ✅ Live, 8-case suite green; next real report = id 2 | Batch 4 |
| Frontend (Pages) | ✅ Live | Batch 5 |
| README | ⚠ NET line + cron description stale; refresh in next commit | README.md |
| CORS | ⚠ Over-broad allowlist (Item 6, pre-publicity) | Batch 4 |

**Applied schema (Batch 1 authoritative):** `sites`, `profiles`, `launches`, `predictions` (PK `launch_id, boom_seq`), `reports` (`observed_utc`, `magnitude`, `trust`), `verdicts`.

---

## 2. Current Launch Picture

**USSF-317 (Falcon 9 Block 5, LL2 id `76617033-4dc0-4448-b50c-e5b0d5a18539`)** — calibration target.
- **NET: Thu 2026-11-19, 18:46–22:46 PT = 2026-11-20 02:46–06:46 UTC** (240-min window). Spacex.com ↔ production LL2 agree. Slip #6. Poor weather forecast — further slip plausible.
- Overnight-gap caveat (see §3): a slip announced overnight surfaces in D1 at the 10:13 AM run, not sooner — glance at spacex.com Thursday morning before planning.
- Observation anchors regardless of pipeline state: webcast T+0, custom-launch form, wall-clock stamps.

---

## 3. INCIDENT LOG

### 2026-11-18a — lldev staleness reached production display ✅ (diagnosed, remediated)
- lldev missed slip #6 (one slip ≈ 23¾ h behind production). Manual UPDATE applied; awaiting heal-confirm by first successful flipped run.

### 2026-11-18b — First flipped run 429'd: shared-bucket contamination CONFIRMED ✅ (mitigation deployed)
- Tail at 7:00:31 PM PT: `throttle@start: ident=2a06:98c0:3600:: current_use=15` → 429 on page 0, clean death, no partial upserts.
- Root cause: shared Cloudflare egress IPv6 pool metered as one identity by LL2; round-hour cron collided with other tenants' rush.
- **Mitigation deployed: all crons shifted off-round minutes** (§5). Verification pending tonight's 8:59/10:19 PM runs.

### 2026-11-18c — Workers Free tier cron limit: 5 per ACCOUNT (discovered, permanent constraint) ✅
- 6-cron deploy failed with `[code: 10072]`: "Workers Free limit of 5 cron triggers per account." Partial update not rolled back; second deploy with 5 crons converged cleanly (declarative TOML = source of truth; re-deploy is always the recovery).
- **Final schedule (5/5 slots used):** `13 0, 7 3, 59 4, 19 6, 13 18` UTC = **4:13 PM, 7:07 PM, 8:59 PM, 10:19 PM, 10:13 AM PT**. All off-round; max gap 12h overnight (10:19 PM → 10:13 AM).
- **ROADMAP CONSTRAINT:** all 5 cron slots consumed → **verdict-cron-as-hourly is impossible on free tier.** Design options: (a) Workers Paid (~$5/mo — bundle with LL2 Patreon key as one ops-budget decision), (b) verdict evaluation piggybacked on the 5 ingest runs (each run also processes NET+90m/+6h/+24h — coarser but staleness-tolerant), (c) lazy evaluation in API worker on request. Decision needed before verdict-cron build; not urgent.

---

## 4. Egress IP & Shared-Bucket Analysis (validated by Incident 18b)

- Workers share oversubscribed egress IPs (soft-unicast ~31 servers/IPv4; IPv6 range collapsed to one ident by LL2). Contamination confirmed in production: full bucket at run start with zero own-usage.
- Round-hour concentration: every scheduler defaults to minute 0 → rush hour at :00. Off-round minutes = free collision insurance (now deployed).
- Within-run requests share one bucket (single colo per invocation). Home IP bucket (`76.217.177.115`) separate.
- **Pending telemetry answers (tonight's runs):** off-round quietness (start `current_use` at 8:59/10:19 PM vs 7:00's 15); meter-calls-bill-themselves (start/end delta vs fetch count).
- **Durable fix:** LL2 API key (Patreon, ~$5/mo class) — identity moves from shared IP to key. Activated by Incident 18b; bundle decision with Workers Paid question (§3, 18c).

---

## 5. Host Flip Execution Record (Item 5A)

**Deployed (v`6fc324a9`, 2026-11-18 evening):**
- `API_BASE` → `https://ll.thespacedevs.com`; all `/2.2.0/` paths untouched ✅
- `&pad__ids=${SITE.ll2PadId}` appended (kept `search=Vandenberg` as belt-and-braces) ✅
- `readThrottle()` telemetry, try/catch-wrapped, start/end logs ✅ (validated first contact — Incident 18b)
- Crons: 5 off-round entries (§3, 18c) ✅
- Non-ASCII scrub: `index.ts` em-dashes removed, grep now zero-clean ✅ (guardrail: `LC_ALL=C grep -n '[^ -~\t]' wrangler.toml src/index.ts` before every deploy/commit; TOML hits block, .ts comment hits advisory)
- Pre-flight probe: `pad__ids=16` → 40 candidates, pad-as-string, soonest-first ✅

**NOT yet verified (pending tonight's runs):** a complete successful run — candidate line ~40, ingested ~6, D1 heal to `2026-11-20T02:46:00Z`, end-telemetry delta.

**Commit pending:** `index.ts` (flip + filter + telemetry + dash scrub), `wrangler.toml` (5 offset crons), `docs/TRACKER.md` (this file), `docs/TRACKER-session4-archive.md` (session-4 original — holds verbatim lessons 5–11), `docs/probes/*`. Message: flip + pad filter + 5 offset crons + throttle logging + tracker externalization.

---

## 6. Post-Observation Hardening Queue

1. **`actual_launch_utc`** — column + ingest capture on LL2 status→success (preserve original NET) or manual; prerequisite for verdict-cron; custom-launch form is the bridge.
2. **Schedule-change badge** (`net_updated_utc`) — NET-moves-only; recency render. Now trustable with 5×/day cadence.
3. **Countdown format** (`fmtDur`) — `m:ss` <1h, `h:mm:ss` ≥1h.
4. **429-resilience (Item 8, HIGH)** — backoff-retry on 429 (>60s) and/or run-failure alert (webhook/email); tonight's silent failure was tail-only. Softens if API key lands.
5. **Cron-slot / verdict-cron architecture decision** (§3, 18c) — paid tier vs piggyback vs lazy eval. Blocks verdict-cron design.
6. **CORS tightening** — exact origins only; pre-publicity.
7. ~~Stale-source detector~~ — obsolete post-flip; optional post-flip health-check variant.
8. **Characterization de-scope** — after ~a week of clean telemetry, drop end-meter call (save 1 req/run) or remove telemetry entirely.

---

## 7. LL2 Version & Throttle Reference

- Production 2.2.0: `search=Vandenberg` → 53; `pad__ids=16` → 40 (~6 in lookahead); pad-as-string; soonest-first. Per-run ≈ 10 req (2 list + ~6 full + 2 meter).
- `/api-throttle/`: trailing slash required; per-ident 15/hour rolling; worker ident `2a06:98c0:3600::` (shared pool); home `76.217.177.115` separate.
- lldev: unthrottled, one slip behind — exited the pipeline 2026-11-18.
- 2.3.0 migration spec (dormant): `/launches/` rename; `net__gte` verified; server-side `&pad=16` MANDATORY (list mode omits pad); no ordering needed; unfiltered search = 999 all-history trap.

---

## 8. Lessons Log (co-authored)

1. Paste commands into the terminal with the same skepticism as into the database
2. Test artifacts ≠ real data — treat first real run as unknown
3. Reconcile code against the live schema, not the doc
4. lldev staleness demands external cross-checks for classified/USSF missions
5. *(reconstructed)* Fabricated version pins fail; `"latest"`/caret-major + lockfile
6. *(reconstructed)* `wrangler dev` without `--remote` = empty LOCAL D1; `--remote` = real rows
7. *(reconstructed)* Missing `"lib": ["ES2022"]` → 103-error collision
8. *(reconstructed)* Type predicates, not plain booleans, narrow across call boundaries
9. *(reconstructed)* Test fixtures must obey the validator's own rules
10. *(reconstructed)* Pages SPA-fallback 200s; `404.html` fixes
11. *(reconstructed)* SQLite AUTOINCREMENT remembers the deleted max
12. **Assistant memory is not a tracker** — same-session documentation or it doesn't exist
13. Constrain requests per rolling hour, not per day
14. *(reserved — session-4 archive holds originals)*
15. Curl the real endpoint before writing code against remembered shapes
16. "One-line change" claims deserve a grep
17. A 404 proves the path dead, not the resource
18. Suffix allowlists are wildcards in disguise
19. Endpoint renames can hide semantic changes — diff content, not status
20. Bound hung-request retries; telemetry beats Ctrl-C
21. The transient hang closed three gates via bounded retry
22. Multi-hour windows: card T+ anchors to window open, not liftoff — webcast is the only T+0
23. Version bumps can remove fields your filter depends on — assert presence; server-side filters preferred
24. Cross-source agreement checks confirm chains *and* catch divergence
25. A faithful pipeline over a stale source propagates the lie — better source or sentinel, never frequency
26. Manual data fixes are leases, not deeds — fix-after-cron; mind the cron calendar
27. D1 + source agreeing ≠ reality — two-leg probe finds the layer in two commands
28. Two runs in one rolling hour = guaranteed 429 — let the scheduled run verify
29. Server-side filtering is the cheapest request-budget lever
30. **Per-IP rate limits are fiction for serverless egress** — shared IPs carry strangers' usage. VALIDATED (18b): bucket full at first flipped run, 03:00 UTC. Durable fix: key-based identity
31. Check the failure mode's blast radius before engineering — clean page-0 death observed in production; tolerable
32. Top-of-the-hour crons are the most contested real estate on the platform — off-round minutes are free insurance. MITIGATION DEPLOYED
33. Telemetry pays for itself the first time something breaks — one log line, complete diagnosis. Ship diagnostics before you need them; make them degrade-safe
34. *(NEW, 18c)* **Free-tier ceilings shape architecture more than code does** — the 5-crons-per-account limit killed an "add one more schedule" reflex in 30 seconds and forced a verdict-cron redesign decision. Check the platform's plan limits before designing schedules, not after the deploy fails
35. *(NEW, 18c)* Declarative config converges: a partially-applied trigger update self-heals on the next full deploy — the TOML file is the source of truth, and re-deploying it fully is always the recovery
36. *(NEW, guardrail)* Smart-quote corruption has a clipboard vector, not a user fault — a non-ASCII grep before every deploy/commit is the structural fix. TOML hits block; source-comment hits are advisory. `LC_ALL=C grep -n '[^ -~\t]'`

*(Lessons 5–11 reconstructions pending reconciliation vs `docs/TRACKER-session4-archive.md`.)*

---

## 9. Open Items Needing Action

- [ ] **Tonight:** watch 8:59 PM + 10:19 PM runs on the live tail — off-round telemetry readings, candidate ~40, ingest ~6, D1 heal to `2026-11-20T02:46:00Z`. Close the meter-billing question via start/end delta.
- [ ] **Tonight/tomorrow:** commit session (contents in §5) — includes README NET + cron-description refresh.
- [ ] **This week:** LL2 Patreon key + Workers Paid question as one ops-budget decision (unblocks §6 items 4+5 permanently).
- [ ] **Thursday evening: observation protocol** — window 18:46–22:46 PT; webcast T+0; stamps; custom-launch form on liftoff; Santa Barbara cross-check (90–100 s offset); morning spacex.com glance (overnight-gap caveat §2).
- [ ] Friday coffee: D1 USSF-317 `2026-11-20T02:46:00Z` (or post-slip value — flipped pipeline should have it).
- [ ] File first real report (report id 2).
- [ ] Post-observation session: §6 queue; reconcile lessons 5–11 vs archive; pre-publicity pass (CORS, Turnstile, rate limit, Actions deploy, robots/disclaimer, coarsening).
