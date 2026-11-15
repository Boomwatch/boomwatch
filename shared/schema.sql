-- BoomWatch D1 schema (v1.1)
-- Apply with:
--   wrangler d1 execute boomwatch-db --remote --file=./shared/schema.sql

PRAGMA foreign_keys = ON;

-- Site registry: one row per launch site BoomWatch tracks.
CREATE TABLE IF NOT EXISTS sites (
  site_id        TEXT PRIMARY KEY,        -- e.g. 'vandenberg'
  name           TEXT NOT NULL,
  ll2_pad_id     INTEGER,                -- Launch Library 2 pad id (SLC-4E = 16)
  ll2_location_id INTEGER,               -- LL2 location id (Vandenberg = 11)
  ref_lat        REAL NOT NULL,           -- recovery-point latitude (LZ-4)
  ref_lon        REAL NOT NULL,           -- recovery-point longitude
  active         INTEGER DEFAULT 1,
  audibility_km  REAL NOT NULL DEFAULT 250
);

-- Flight profiles: timing constants per boom-generating event class.
CREATE TABLE IF NOT EXISTS profiles (
  profile_id     TEXT PRIMARY KEY,        -- e.g. 'f9_rtls_descent'
  site_id        TEXT NOT NULL REFERENCES sites(site_id),
  description    TEXT NOT NULL,
  boom_events    INTEGER DEFAULT 1,       -- Starship profiles will use 2-3
  window_pre_s   REAL DEFAULT 60,        -- slack before crossover (seconds)
  window_post_s  REAL DEFAULT 120       -- slack after crossover
);

-- One row per tracked launch.
CREATE TABLE IF NOT EXISTS launches (
  id            TEXT PRIMARY KEY,        -- LL2 launch UUID
  site_id       TEXT NOT NULL REFERENCES sites(site_id),
  provider      TEXT NOT NULL,
  vehicle       TEXT NOT NULL,
  mission       TEXT NOT NULL,
  net_utc       TEXT NOT NULL,           -- ISO 8601, e.g. '2026-11-18T03:14:00Z'
  window_min    INTEGER,                -- window length in minutes (nullable)
  recovery_type TEXT CHECK(recovery_type IN
                  ('rtls','droneship','expendable','catch','unknown'))
                  DEFAULT 'unknown',
  landing_site  TEXT,
  raw_json      TEXT                     -- archived LL2 payload
);

-- Predicted boom windows. One row per (launch, boom_seq).
CREATE TABLE IF NOT EXISTS predictions (
  launch_id     TEXT NOT NULL REFERENCES launches(id),
  boom_seq      INTEGER NOT NULL DEFAULT 1,
  profile_id    TEXT NOT NULL REFERENCES profiles(profile_id),
  crossover_s   REAL NOT NULL,           -- fitted Mach-crossover time, T+ seconds
  prop_delay_s  REAL,                    -- sound travel to site reference point
  confidence    REAL,                    -- prior P(boom), 0..1
  model_version TEXT NOT NULL,
  PRIMARY KEY (launch_id, boom_seq)
);

-- Crowdsourced reports.
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  launch_id     TEXT NOT NULL REFERENCES launches(id),
  boom_seq      INTEGER NOT NULL DEFAULT 1,
  heard         TEXT NOT NULL CHECK(heard IN ('yes','no','unsure')),
  magnitude     INTEGER CHECK(magnitude BETWEEN 1 AND 5),
  observed_utc  TEXT,
  lat           REAL,
  lon           REAL,
  distance_km   REAL,                    -- computed vs site recovery point at ingest
  trust         REAL DEFAULT 0.5,
  created_utc   TEXT NOT NULL
);

-- Computed verdicts, stamped by verdict-cron.
CREATE TABLE IF NOT EXISTS verdicts (
  launch_id     TEXT PRIMARY KEY REFERENCES launches(id),
  posterior     REAL,
  class         TEXT CHECK(class IN
                  ('confirmed','probable','unconfirmed','no_boom','insufficient_data')),
  n_reports     INTEGER,
  computed_utc  TEXT NOT NULL,
  model_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_launches_site_net ON launches(site_id, net_utc);
CREATE INDEX IF NOT EXISTS idx_reports_launch    ON reports(launch_id, heard);