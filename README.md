# BoomWatch

Crowdsourced sonic boom tracking for orbital launch re-entry and ascent events.
Currently tracking: Falcon 9 launches from Vandenberg SFB (SLC-4E), with
plans to expand to Cape Canaveral and Starbase.

## What it does

Vandenberg launches regularly produce audible sonic booms across the
Central California coast — most famously the double boom of a Falcon 9
booster returning to Landing Zone 4, but also the supersonic ascent
boom carpet from southbound launches. Residents hear them, but there is
no public service that confirms *whether that sound was a sonic boom*,
let alone predicts when the next one will arrive at a given location.

BoomWatch is an attempt to fix that:

- **Predict**: computes the expected audible boom window at *your*
  location for upcoming launches, from launch timings and simple
  sound-propagation physics (~343 m/s surface sound speed).
- **Confirm**: collects anonymous crowdsourced reports
  (heard / not heard / unsure, with time and rough location) and
  combines them with the prediction using a Bayesian update to produce
  a verdict per launch: confirmed / probable / unconfirmed / no boom.

## Architecture

Static frontend + serverless backend, deliberately cheap to run:

| Component | Technology |
|---|---|
| Static site | Cloudflare Pages (plain HTML/JS, no framework) |
| API + cron workers | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite) |
| Launch data | Launch Library 2 (ll.thespacedevs.com) |
| Abuse protection | Cloudflare Turnstile, KV-based rate limiting |

Three workers:
- `ingest-cron` — daily pull of upcoming launches, boom-window prediction
- `api` — report intake and public reads
- `verdict-cron` — post-launch Bayesian aggregation

## Status

**Early development.** Not yet live. See `docs/` for the design.

## Development

Requires Node LTS and the Cloudflare Wrangler CLI.

```bash
npm install -g wrangler
wrangler login
wrangler d1 execute boomwatch-db --remote --file=./shared/schema.sql
wrangler dev

## Notes

- All launch data courtesy of The Space Devs (Launch Library 2).
- Predictions are estimates; boom audibility depends heavily on atmospheric conditions.
- This is a hobby/community project, not affiliated with SpaceX, Vandenberg SFB, or any launch provider. 