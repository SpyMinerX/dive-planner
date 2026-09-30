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
  N₂/He loading charts and surfacing-GF history. Dives are editable: name, dive site,
  GPS position (with map link + "use current location"), and notes. Planned dives are
  visually marked apart from real ones
- **Dive events** — tag moments on the profile (gas switches, emergencies, sightings,
  notes); they appear as glyph markers on the depth chart and sync with the logbook.
  Gas switches are derived automatically from the profile
- **UDDF 3.2 import/export** — bring dives from Subsurface or your dive computer
  (`samples/sample-dives.uddf` included for a test drive), export the whole logbook back out
- **Start fresh** — or carry residual tissue loading from your last logged dive into the plan
- **PWA** — installable, fully offline (service worker + manifest)
- **Cloud accounts (optional)** — sign in to sync the logbook **and the deco
  calculation settings** (GF defaults, rates, SAC, ppO₂ limits, surface pressure)
  across devices; the most recent settings edit wins. Sync is a fast push/pull
  loop (change-polling every 10 s + instant push on edits), so two devices can
  work on the same logbook simultaneously.
- **Current vs planned saturation** — the dashboard separates live tissue state
  (real dives only, ticking as you off-gas) from the projection after upcoming
  planned dives. Plans are replaced by importing the recorded dive (UDDF) — from
  the dive's detail page, or automatically when a general import contains a dive
  recorded within ±6 h of a plan's start.
  Offline-first: the device copy is always the source of truth, the app works fully
  without a connection, and changes sync **up** to the server whenever it's reachable
  (merge by dive id with deletion tombstones; conflicts resolved by re-merge).
  Signed out or server unreachable → everything simply stays local.

## Run it

**Docker (local development):**

```sh
docker compose up -d --build   # app on port 8080 + a throwaway PostgreSQL
```

The server keeps all accounts, sessions, logbooks and shared links in
**PostgreSQL**; the container itself is stateless, so it can run as several
replicas. Configuration comes from the environment — see `.env.example`
(`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` or `DATABASE_URL`;
any `<NAME>_FILE` variable is read from that file, for Docker/Swarm secrets).
The schema is created automatically at startup.

**Node directly** (needs a reachable PostgreSQL):

```sh
npm ci
DB_HOST=localhost DB_PASSWORD=… node server/server.js   # http://localhost:8080
```

**Static only** (no accounts — the app works fine without the API):

```sh
python -m http.server 8080
# or: npx http-server -p 8080
```

Open http://localhost:8080. To install as an app, use the browser's install button
(service workers require localhost or HTTPS). For production, put a TLS-terminating
reverse proxy in front of the Node server — credentials must not travel over plain HTTP.

## Deploying on AegisMesh (Docker Swarm)

| | |
|---|---|
| Image | `spyminer/abyss-deco-planner:<version>` (Docker Hub — use immutable tags, not `latest`) |
| Stack file | `stack.portainer.yml` (network `aegis-web`, 2 replicas on `apps == true`, Traefik labels) |
| Internal port | `8080` — no published host ports; Traefik routes to it |
| Public hostname | set in the Traefik `Host(...)` rule in `stack.portainer.yml` |
| Health | `GET /healthz` → `200 ok` / `503` when PostgreSQL is unreachable (also the image `HEALTHCHECK`) |
| Database | `postgres-ha:5000`, database `abyss`, role `abyss` (no extensions needed) |
| Secrets | `abyss_db_password` (Swarm secret, mounted via `DB_PASSWORD_FILE`) |
| Volumes / uploads | none |

HA notes: logbook writes use a row lock, so the optimistic-concurrency check is
atomic across replicas; the "new version" prompt uses a fingerprint of the
image's app files, so it is identical on every replica of a release; dropped DB
connections (Patroni failover) are replaced on the next query.

**1. Build and push** (the old server's compose file uses `:latest` — don't push
`latest` until the old deployment is retired):

```sh
docker build -t spyminer/abyss-deco-planner:2.0.0 . && docker push spyminer/abyss-deco-planner:2.0.0
```

**2. Database and secret** — on the Patroni leader (`patronictl list`):

```sh
sudo -u postgres psql -c "CREATE ROLE abyss LOGIN PASSWORD '<pw>';" -c "CREATE DATABASE abyss OWNER abyss;"
```

Then Portainer → Swarm → Secrets → `abyss_db_password` = exactly that password.

**3. Deploy** — Portainer → Stacks → Add stack → Web editor → paste
`stack.portainer.yml` (hostname and tag filled in) → Deploy. Wait for 2 healthy tasks.

**4. Migrate the data** from the old JSON volume. On the old server:

```sh
IMAGE=spyminer/abyss-deco-planner:2.0.0
docker compose stop                                  # stop writes (omit for a rehearsal)
docker pull $IMAGE
docker run --rm -u root   -v <compose-project>_dive-data:/app/server/data:ro -v "$PWD:/export"   $IMAGE node scripts/export-data.mjs --data /app/server/data --out /export
```

Transfer `abyss-export-<timestamp>.tar` **and** its `.sha256` (binary mode) to an
AegisMesh node, then import as a one-off Swarm service (it uses the app's own secret):

```sh
F=abyss-export-<timestamp>.tar
sudo docker service create --name abyss-import --detach   --restart-condition none --network aegis-web --user root   --constraint node.hostname==$(hostname) --secret abyss_db_password   -e DB_HOST=postgres-ha -e DB_PORT=5000 -e DB_NAME=abyss -e DB_USER=abyss   -e DB_PASSWORD_FILE=/run/secrets/abyss_db_password   --mount type=bind,src=$HOME,dst=/import,readonly   spyminer/abyss-deco-planner:2.0.0   node scripts/migrate-json-to-postgres.mjs --archive /import/$F
until sudo docker service ps abyss-import --format '{{.CurrentState}}' | grep -qE 'Complete|Failed|Rejected'; do sleep 3; done
sudo docker service logs --raw abyss-import && sudo docker service rm abyss-import
```

Expect `Archive checksum OK`, `OK` on every validation line (users, sessions,
logbooks, dives, shares) and `Database import committed.` The import is one
transaction and refuses a non-empty target unless `--replace` is given.
Unexpired sessions are carried over, so users stay signed in. Afterwards delete
the `.tar` from both machines — it contains every password hash and logbook.

**5. Verify and cut over:**

```sh
curl -fsS -H 'Host: <hostname>' http://127.0.0.1:8080/healthz      # → ok
sudo docker service ps abyss_web                                     # 2 tasks across the apps nodes
sudo docker service logs --tail 100 abyss_web
sudo docker service update --force abyss_web                         # site stays up
```

Then point the Cloudflare tunnel hostname at `http://localhost:8080` and check
sign-in with an existing account, logbook sync between two devices, and a shared link.

**Rollback:** point the tunnel hostname back at the old server and run
`docker compose start` there (**start, not up** — the old container keeps its old
image and untouched JSON volume). Keep the new database for analysis. Once users
have synced changes to AegisMesh, rolling back loses those changes unless they
are merged by hand, so agree on a rollback window before cutover.

## Development

| Path | What |
|---|---|
| `js/deco.js` | ZH-L16C + GF engine: tissues, ceilings, planner, NDL, CNS/OTU |
| `js/uddf.js` | UDDF 3.2 parser (namespace-tolerant) and exporter |
| `js/charts.js` | Hand-rolled SVG profile/tissue charts with hover tooltips |
| `js/store.js` | localStorage persistence + deletion tombstones |
| `js/sync.js` | Account auth + offline-first cloud sync (merge, conflict retry) |
| `js/app.js` | Views, routing, tissue chaining, account UI, PWA glue |
| `server/server.js` | Cloud server: scrypt auth, bearer sessions, logbook/share API, `/healthz` |
| `server/db.js` | PostgreSQL pool, schema bootstrap (advisory lock), transactions |
| `server/secrets.js` | Loads `<NAME>_FILE` (Swarm secrets) into `<NAME>` |
| `scripts/export-data.mjs` | Packs the old JSON data dir into a checksummed `.tar` |
| `scripts/migrate-json-to-postgres.mjs` | Imports that archive into PostgreSQL, validated, in one transaction |
| `scripts/test-deco.mjs` | Engine sanity tests — `node scripts/test-deco.mjs` |
| `scripts/make-icons.mjs` | Regenerates PNG icons — `node scripts/make-icons.mjs` |

## ⚠ Disclaimer

**Plan with care.** Abyss can support your dive planning, but don't rely on it as your
only source: cross-check every schedule against your dive computer or established
tables, keep a conservative margin, and only conduct dives that your training and
certification qualify you for. No software replaces proper training and judgement.
