# Abyss — Dive Planner & Deco Logbook

A dark-ocean-themed, offline-first PWA for decompression planning and dive logging.
Everything runs in the browser — no build step, no backend, no dependencies.

![engine](https://img.shields.io/badge/model-B%C3%BChlmann%20ZH--L16C%20%2B%20GF-blue)

## Features

- **Bühlmann ZH-L16C** decompression engine with **gradient factors** (GF low/high),
  Schreiner equation for descents/ascents, 16 N₂ + He compartments (full trimix support)
- **Dive planner** — multi-level profiles, bottom + deco gases with switch depths,
  deco schedule with runtime table, TTS, NDL, first stop, surfacing GF,
  CNS/OTU oxygen-toxicity tracking, MOD/END/hypoxia warnings, gas requirements with reserve
- **Deco logbook** — dives are chained: each dive's ending tissue saturation plus the
  surface interval feeds the next dive (repetitive-dive planning), with per-compartment
  N₂/He loading charts and surfacing-GF history
- **UDDF 3.2 import/export** — bring dives from Subsurface or your dive computer
  (`samples/sample-dives.uddf` included for a test drive), export the whole logbook back out
- **Start fresh** — or carry residual tissue loading from your last logged dive into the plan
- **PWA** — installable, fully offline (service worker + manifest)
- **Cloud accounts (optional)** — sign in to sync the logbook across devices.
  Offline-first: the device copy is always the source of truth, the app works fully
  without a connection, and changes sync **up** to the server whenever it's reachable
  (merge by dive id with deletion tombstones; conflicts resolved by re-merge).
  Signed out or server unreachable → everything simply stays local.

## Run it

**With cloud sync** (zero-dependency Node server, also serves the app):

```sh
node server/server.js          # http://localhost:8080, data in server/data/
```

**Static only** (no accounts — the app works fine without the API):

```sh
python -m http.server 8080
# or: npx http-server -p 8080
```

Open http://localhost:8080. To install as an app, use the browser's install button
(service workers require localhost or HTTPS). For production, put a TLS-terminating
reverse proxy (Caddy, nginx) in front of the Node server — credentials must not
travel over plain HTTP.

## Development

| Path | What |
|---|---|
| `js/deco.js` | ZH-L16C + GF engine: tissues, ceilings, planner, NDL, CNS/OTU |
| `js/uddf.js` | UDDF 3.2 parser (namespace-tolerant) and exporter |
| `js/charts.js` | Hand-rolled SVG profile/tissue charts with hover tooltips |
| `js/store.js` | localStorage persistence + deletion tombstones |
| `js/sync.js` | Account auth + offline-first cloud sync (merge, conflict retry) |
| `js/app.js` | Views, routing, tissue chaining, account UI, PWA glue |
| `server/server.js` | Zero-dep cloud server: scrypt auth, bearer sessions, logbook API |
| `scripts/test-deco.mjs` | Engine sanity tests — `node scripts/test-deco.mjs` |
| `scripts/make-icons.mjs` | Regenerates PNG icons — `node scripts/make-icons.mjs` |

## ⚠ Disclaimer

**Not for real-world dive planning.** This is an educational simulation. The algorithm
has not been validated for actual decompression diving; never dive a schedule produced
by unverified software. Get proper training and use certified tools.
