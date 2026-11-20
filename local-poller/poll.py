#!/usr/bin/env python3
"""
BoomWatch local poller — fetches upcoming Vandenberg launches from LL2,
transforms them (faithful port of workers/ingest-cron/src/index.ts, Batch 2),
and pushes pre-transformed rows to the boomwatch-api /admin/ingest route.

Target: Mac mini (launchd, twice daily 06:00/18:00 UTC). Pi Zero port:
same file, crontab line instead of launchd.

LL2 requests per run: <= 4 list pages + 1 full fetch per matching launch.
Unauthenticated cap is 15/hr from a residential IP -- comfortable margin.

FUTURE EXPANSION HOOKS (do not hard-code around these):
  * API version is a single constant (BW_LL2_VERSION, default "2.2.0").
    When LL2 ships 2.3.0, change the constant and re-verify response shape
    against the transform below; raw_json archives full payloads, so
    historical launches can be re-derived without re-fetching.
  * If an LL2 API key is adopted, it flows through ll2_headers() ONLY —
    a single injection point. Verify the exact header scheme against LL2's
    key documentation before wiring it in (placeholder below).

Usage:
  poll.py [--dry-run]   # --dry-run prints the payload instead of POSTing

Configuration via environment variables (defaults suit the Mac mini):
  BW_LL2_BASE      default https://ll.thespacedevs.com   (live; use lldev to test)
  BW_LL2_VERSION   default 2.2.0                         (segment bump for 2.3.0)
  BW_LL2_KEY       default unset                          (LL2 API key, when adopted)
  BW_API_URL       default https://boomwatch-api.cloudflare-sporty919.workers.dev/admin/ingest
  BW_TOKEN_FILE    default ~/.boomwatch/admin_token       (chmod 600)
"""

import json
import math
import os
import sys
import urllib.request
import urllib.error
import argparse
import time
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration — the ONLY place LL2 endpoint specifics live.
# 2.3.0 migration = change BW_LL2_VERSION, then audit to_launch_row().
# ---------------------------------------------------------------------------

LL2_BASE = os.environ.get("BW_LL2_BASE", "https://ll.thespacedevs.com")
LL2_DEV_BASE = "https://lldev.thespacedevs.com"
LL2_VERSION = os.environ.get("BW_LL2_VERSION", "2.2.0")

API_URL = os.environ.get("BW_API_URL","https://boomwatch-api.cloudflare-sporty919.workers.dev/admin/ingest",)

# ---------------------------------------------------------------------------
# Site / profile constants -- MUST match shared/sites.ts exactly.
# Transcribed from shared/sites.ts (Batch 1); do not tune independently.
# ---------------------------------------------------------------------------

SITE_ID = "vandenberg"
LL2_PAD_ID = 16                                   # SLC-4E
PAD_LAT, PAD_LON = 34.632, -120.611               # SLC-4E
REF_LAT, REF_LON = 34.633, -120.615               # LZ-4 approx

ASCENT_PROFILE_ID = "f9_rtls_ascent"
ASCENT_CROSSOVER_S = 60
ASCENT_WINDOW_PRE_S = 30
ASCENT_WINDOW_POST_S = 90
ASCENT_PRIOR_CONFIDENCE = 0.55

DESCENT_PROFILE_ID = "f9_rtls_descent"
DESCENT_CROSSOVER_S = 600
DESCENT_WINDOW_PRE_S = 60
DESCENT_WINDOW_POST_S = 120
DESCENT_PRIOR_CONFIDENCE = 0.85

MODEL_VERSION = "v1.0-ascent+descent"
NON_RTLS_CONFIDENCE_FACTOR = 0.7

LOOKAHEAD_DAYS = 14
PAGE_LIMIT = 20
MAX_PAGES = 4

SOUND_SPEED_KMS = 0.343


def ll2_headers():
    """Single injection point for LL2 request headers.
    FUTURE: when an LL2 API key is adopted, add it here. The exact header
    scheme (e.g. Authorization style, custom X-header) must be taken from
    LL2's key documentation — do NOT guess; a wrong scheme fails silently
    as an unauthenticated request and burns the shared 15/hr bucket."""
    headers = {"User-Agent": "boomwatch-local-poller/1.0"}
    key = os.environ.get("BW_LL2_KEY", "").strip()
    if key:
        raise NotImplementedError(
            "BW_LL2_KEY set but header scheme not yet verified against "
            "LL2 key docs — wire it into this function first")
    return headers


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance, km. Port of haversineKm() in shared/sites.ts."""
    r = 6371.0
    to_rad = lambda d: d * math.pi / 180.0
    d_lat = to_rad(lat2 - lat1)
    d_lon = to_rad(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2))
         * math.sin(d_lon / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def prop_delay_s(source_lat, source_lon):
    """Sound travel time from source to site ref point. Mirrors boomWindow()'s
    delay term; only prop_delay_s is persisted to predictions."""
    return haversine_km(REF_LAT, REF_LON, source_lat, source_lon) / SOUND_SPEED_KMS


# ---------------------------------------------------------------------------
# LL2 fetching
# ---------------------------------------------------------------------------

def http_get_json(url, timeout=30, retries=3):
    last_exc = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=ll2_headers())
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            last_exc = e
            wait = 5 * (attempt + 1)
            print(f"fetch retry {attempt+1}/{retries} for {url.split('?')[0]}: {e}")
            time.sleep(wait)
    raise last_exc


def ll2_list_url(page):
    """mode=list pages, search=Vandenberg. Pad arrives as a string here --
    exact-match on pad id is deferred to the full fetch (see is_vandenberg).
    Version segment comes from LL2_VERSION — the 2.3.0 switch point."""
    return (f"{LL2_BASE}/{LL2_VERSION}/launch/upcoming/"
            f"?mode=list&limit={PAGE_LIMIT}&offset={page * PAGE_LIMIT}"
            f"&search=Vandenberg")


def ll2_detail_url(launch_id):
    """Full mode returns pad as an object with .id -- the reliable filter."""
    return f"{LL2_BASE}/{LL2_VERSION}/launch/{launch_id}/"


def fetch_upcoming_candidates():
    matches = []
    for page in range(MAX_PAGES):
        body = http_get_json(ll2_list_url(page))
        matches.extend(body.get("results", []))
        if not body.get("next"):
            break
    return matches


def fetch_full_launch(launch_id):
    try:
        return http_get_json(ll2_detail_url(launch_id))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise           # let the main() wrapper abort the whole run
        return None          # 404/other: launch vanished, skip is correct


def is_vandenberg(launch):
    pad = launch.get("pad")
    if isinstance(pad, dict):
        return pad.get("id") == LL2_PAD_ID or \
               pad.get("name") == "Space Launch Complex 4E"
    if isinstance(pad, str):
        return pad == "Space Launch Complex 4E"   # list-mode fallback
    return False


# ---------------------------------------------------------------------------
# Transform — faithful port of toLaunchRow() + buildPredictions().
# 2.3.0 AUDIT POINT: if the upstream response shape changes, this is the
# ONLY section to re-verify (plus types.ts equivalence upstream). Defensive
# .get() chains already absorb missing fields; new fields land in raw_json.
# ---------------------------------------------------------------------------

def to_launch_row(l):
    provider = (l.get("launch_service_provider") or {}).get("name") or "Unknown"
    rocket = l.get("rocket") or {}
    vehicle = (rocket.get("configuration") or {}).get("name") or "Unknown"
    mission_obj = l.get("mission") or {}
    mission = mission_obj.get("name")
    if not mission:
        name = l.get("name", "")
        mission = name.split("|")[-1].strip() if "|" in name else name

    ws, we = l.get("window_start"), l.get("window_end")
    window_min = None
    if ws and we:
        window_min = round((_parse_iso_ms(we) - _parse_iso_ms(ws)) / 60000)

    # LL2 sparse-landing heuristic (Batch 2 note 1): do NOT guess RTLS.
    # FUTURE: if 2.3.0 restores landing data, resolve recovery_type HERE
    # and pass is_rtls to build_predictions — nowhere else changes.
    return {
        "id": l["id"],
        "site_id": SITE_ID,
        "provider": provider,
        "vehicle": vehicle,
        "mission": mission,
        "net_utc": l["net"],
        "window_min": window_min,
        "recovery_type": "unknown",
        "landing_site": None,
        "raw_json": json.dumps(l),
    }


def _parse_iso_ms(s):
    """Parse ISO 8601 to epoch ms. Handles 'Z' suffix (JS Date.parse parity
    for LL2 timestamps)."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def build_predictions(launch_id, is_rtls=False):
    """Port of buildPredictions(). recovery_type is stubbed unknown, so
    callers pass is_rtls=False -> confidence 0.55 * 0.7 = 0.385, ascent row
    only, crossover 60, prop delay to site ref point (~0 for pad->LZ)."""
    rows = [{
        "launch_id": launch_id,
        "boom_seq": 1,
        "profile_id": ASCENT_PROFILE_ID,
        "crossover_s": ASCENT_CROSSOVER_S,
        "prop_delay_s": prop_delay_s(PAD_LAT, PAD_LON),
        "confidence": round(
            (ASCENT_PRIOR_CONFIDENCE if is_rtls
             else ASCENT_PRIOR_CONFIDENCE * NON_RTLS_CONFIDENCE_FACTOR), 6),
        "model_version": MODEL_VERSION,
    }]
    if is_rtls:
        rows.append({
            "launch_id": launch_id,
            "boom_seq": 2,
            "profile_id": DESCENT_PROFILE_ID,
            "crossover_s": DESCENT_CROSSOVER_S,
            "prop_delay_s": prop_delay_s(REF_LAT, REF_LON),
            "confidence": DESCENT_PRIOR_CONFIDENCE,
            "model_version": MODEL_VERSION,
        })
    return rows

def throttle_report():
    """Log LL2 throttle state after a run. Reads the meter for THIS IP's
    bucket. Failure here is non-fatal — diagnostics, not gating."""
    try:
        state = http_get_json(f"{LL2_BASE}/{LL2_VERSION}/api-throttle/")
        print(f"LL2 throttle: {state['current_use']}/{state['your_request_limit']} "
              f"used, reset in {state['next_use_secs']}s")
    except Exception as e:
        print(f"throttle check skipped ({e})")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    throttle_report()
    ap = argparse.ArgumentParser(description="BoomWatch LL2 poller")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the payload instead of POSTing")
    ap.add_argument("--dev", action="store_true",
                    help="use the LL2 dev host (lldev) - stale data, do not use for real ingest")
    args = ap.parse_args()

    if args.dev and not args.dry_run:
        ap.error("--dev requires --dry-run (dev data is stale; never push it)")
    
    global LL2_BASE
    if args.dev:
        LL2_BASE = LL2_DEV_BASE

    api_url = API_URL
    token_file = Path(os.environ.get(
        "BW_TOKEN_FILE",
        str(Path.home() / ".boomwatch" / "admin_token"),
    ))

    cutoff_ms = (datetime.now(timezone.utc)
                 + timedelta(days=LOOKAHEAD_DAYS)).timestamp() * 1000

    try:
        candidates = fetch_upcoming_candidates()
        print(f"LL2 {LL2_VERSION} search returned {len(candidates)} candidates")

        launches, predictions = [], []
        for cand in candidates:
            net_ms = _parse_iso_ms(cand.get("net", ""))
            if net_ms > cutoff_ms:
                continue
            if not is_vandenberg(cand):
                continue
            full = fetch_full_launch(cand["id"])
            if not full or not is_vandenberg(full):
                continue
            row = to_launch_row(full)
            launches.append(row)
            predictions.extend(build_predictions(row["id"], is_rtls=False))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            sys.exit("LL2 rate-limited (429) mid-run — nothing pushed; "
                    "wait for the hourly window and rerun")
        raise
     
    print(f"Transformed {len(launches)} Vandenberg launches "
          f"({len(predictions)} prediction rows)")

    if args.dry_run:
        print(json.dumps({"launches": launches,
                          "predictions": predictions}, indent=2))
        throttle_report()
        return

    token = token_file.read_text().strip()
    payload = json.dumps({"launches": launches,
                          "predictions": predictions}).encode()

    req = urllib.request.Request(
        api_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "boomwatch-local-poller/1.0",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
            print(f"Push OK: {result}")
            throttle_report()
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"Push FAILED: HTTP {e.code}: {body}")


if __name__ == "__main__":
    main()