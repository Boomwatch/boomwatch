-- BoomWatch v1 seed data: Vandenberg SFB site + Falcon 9 RTLS profiles.
-- Apply AFTER schema.sql. Safe to run once; re-running will fail on PK conflict.

INSERT INTO sites (site_id, name, ll2_pad_id, ll2_location_id, ref_lat, ref_lon, active, audibility_km)
VALUES ('vandenberg', 'Vandenberg SFB', 16, 11, 34.633, -120.615, 1, 250);

INSERT INTO profiles (profile_id, site_id, description, boom_events, window_pre_s, window_post_s)
VALUES
  ('f9_rtls_ascent',  'vandenberg',
   'Falcon 9 supersonic ascent boom carpet, southbound polar trajectory',
   1, 60, 180),
  ('f9_rtls_descent', 'vandenberg',
   'Falcon 9 booster RTLS return to LZ-4: entry/descent boom + landing',
   1, 120, 240);