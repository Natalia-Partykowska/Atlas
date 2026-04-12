# Atlas Backend v1 — Real-Time Orbital Streaming Service

## Context

Atlas is currently a frontend-only app deployed on Vercel. It visualizes static country datasets plus a curated ~250-satellite sample (ISS, Starlink subset, GPS) propagated client-side with `satellite.js` at 5 Hz. The browser cannot scale this loop past ~1k objects without frame drops.

This backend elevates Atlas from a visualization demo into a real-time distributed system. A new Rust service propagates the **full CelesTrak catalog (~28,000 tracked objects, including all active satellites and tracked debris)** server-side, streams viewport-filtered positions to each connected client over WebSocket, and renders on the same MapLibre layers Atlas already uses. The visual payoff — the dense LEO swarm, visible Starlink rings, palpable debris belt — is something a browser genuinely cannot produce, which makes it a credible "full-stack systems engineering" portfolio piece rather than a bolted-on CRUD backend.

**v1 scope is streaming only.** Conjunction (close-approach) screening is deferred to a potential v2; shipping streaming first de-risks the infrastructure (WebSocket fan-out, viewport protocol, binary encoding, TLE refresh, Fly deploy, bandwidth reality) before layering numerical work on top.

## Decisions locked in

| Decision | Choice |
|---|---|
| v1 feature set | Stream only — no conjunctions, no trails-on-click |
| Catalog size | Full ~28k CelesTrak catalog |
| Repo layout | Monorepo; new `server/` directory at repo root |
| Client behavior when server is unreachable | Fall back to today's bundled 250-sat local propagation |
| TLE refresh cadence | Daily at 04:00 UTC |
| Deploy target | Fly.io, $15/mo hard spending cap |
| Update rate | 1 Hz on the wire, client interpolates for smoothness |

## Architecture

```
Browser ── HTTPS ──> Vercel (static Atlas frontend, unchanged)
Browser ── WSS ────> Fly.io: atlas-orbit Rust service
                     └── in-memory TLE catalog (~28k SatRecs)
                     └── tokio daily refresh task (04:00 UTC)
                     └── per-connection viewport state
                     └── 1 Hz broadcast tick, per-client filter
```

Vercel is not in the data path. The browser opens a WebSocket directly to `wss://atlas-orbit.fly.dev/stream`. CORS/Origin allow-list restricts to the Atlas origin + localhost.

## Tech stack (server)

- **Rust stable**, edition 2021
- **tokio** — async runtime
- **axum** — HTTP + WebSocket framework
- **tokio-tungstenite** (via axum) — WebSocket
- **sgp4** crate — SGP4 propagation (pure Rust, SIMD-friendly, faster than JS)
- **rayon** — parallelize per-tick propagation across CPU cores
- **serde** + **bincode** — binary message encoding on the wire (smaller than JSON)
- **tracing** + **tracing-subscriber** — structured logs
- **reqwest** — fetch CelesTrak TLEs

## WebSocket protocol

Binary messages, bincode-encoded. Two directions.

**Client → Server** (sent on connect and whenever viewport changes, throttled to ~5 Hz on client):
```rust
struct ViewportMsg {
  west: f32, south: f32, east: f32, north: f32,  // degrees
  min_alt_km: u16, max_alt_km: u16,              // altitude filter
}
```

**Server → Client** (1 Hz tick):
```rust
struct PositionBatchMsg {
  tick_epoch_ms: u64,     // server timestamp for this batch
  positions: Vec<Position>,
}
struct Position {
  norad_id: u32,          // stable ID
  lng: f32, lat: f32,     // degrees
  alt_km: u16,            // altitude
  group: u8,              // 0=iss, 1=active, 2=debris, 3=gps, etc.
}
```

At ~10k visible objects per viewport × 15 bytes/object × 1 Hz = ~150 KB/sec per client. With deflate permessage compression: ~50–80 KB/sec.

Metadata (satellite name, owner, launch date) is sent lazily: client requests `MetadataReq { norad_id }` on hover, server responds with `MetadataResp { name, owner, launch_date, ... }`. Avoids shipping 28k names every tick.

## Server directory layout (monorepo)

```
server/
├── Cargo.toml
├── Cargo.lock
├── fly.toml                    # Fly deploy config; single region, 512MB VM
├── Dockerfile                  # multi-stage, distroless runtime
├── .dockerignore
├── src/
│   ├── main.rs                 # bootstrap: load TLEs, start refresh task, start server
│   ├── catalog.rs              # in-memory catalog, atomic swap on refresh
│   ├── celestrak.rs            # TLE fetch + parse (reuses logic from scripts/fetch-satellites.mjs)
│   ├── propagate.rs            # SGP4 tick, rayon parallelization
│   ├── ws.rs                   # axum WebSocket handler, per-client state
│   ├── viewport.rs             # viewport filter logic
│   ├── protocol.rs             # shared message types (serde + bincode)
│   └── config.rs               # env vars, CORS origins
└── README.md                   # run locally, deploy, message protocol spec
```

## Implementation phases

### Phase 0 — Scaffolding (0.5 day)
- Create `server/` directory, `Cargo.toml`, `Dockerfile`, `fly.toml`.
- `cargo new --bin` with axum hello-world on port 8080.
- Verify local `curl localhost:8080/health` works.
- Stub CORS middleware with allow-list.

### Phase 1 — Catalog loader (0.5 day)
- Implement `celestrak.rs`: fetch `stations`, `active`, `gps-ops`, `geo`, `cosmos-1408-debris`, `fengyun-1c-debris`, `iridium-33-debris` groups from CelesTrak GP API.
- Parse TLE triplets into `sgp4::Elements`.
- Store in `Catalog { records: Vec<CatalogEntry> }` where `CatalogEntry = { norad_id, name, group, constants: sgp4::Constants }`.
- Startup: fetch all groups, build catalog, log count. Target ~28k objects.
- Daily refresh: `tokio::time::interval` that sleeps until next 04:00 UTC, then re-fetches and atomically swaps the catalog (`ArcSwap<Catalog>`).

### Phase 2 — Propagation loop (1 day)
- `propagate.rs`: given `&Catalog` and `Utc::now()`, compute `Vec<Position>` using rayon parallel iterator.
- Benchmark: target full catalog in <50ms on a shared-cpu-1x. If slower, investigate sgp4 crate constants caching.
- Handle SGP4 errors (decayed satellites, numerical failures) by excluding from output and logging at DEBUG level.

### Phase 3 — WebSocket handler + viewport filter (1 day)
- `ws.rs`: accept WebSocket, spawn per-connection task.
- Each connection maintains current `ViewportMsg` state.
- Global 1 Hz tick: broadcast channel (`tokio::sync::broadcast`) publishes `Arc<Vec<Position>>` (full set).
- Per-connection task receives broadcast, applies viewport filter, encodes, sends.
- Connection caps: reject beyond 200 concurrent connections (protects cost cap).
- Rate-limit viewport updates per-connection to 5 Hz.

### Phase 4 — Frontend integration (1 day)
- New file `src/lib/orbitStream.ts`: `connectOrbitStream({ onPositions, onDisconnect })` returns a handle with `updateViewport(bounds)` and `close()`.
- Binary message decoding using `bincode`-compatible reader (hand-rolled or via `borsh`/`msgpack` swap if bincode-in-browser is awkward — decision deferred to implementation).
- Env var `VITE_ORBIT_WS_URL` in `.env.local` and Vercel. Dev: `ws://localhost:8080/stream`. Prod: `wss://atlas-orbit.fly.dev/stream`.
- Modify `src/components/map/Map.tsx` satellite `useEffect` (currently lines 1097–1160):
  - On enable: attempt WebSocket connection.
  - On successful first batch: replace local propagation path — skip `parseTLEData` / `propagateAll` / 200ms interval; instead feed incoming positions directly into `buildSatelliteGeoJSON` and `setData`.
  - On connection failure or disconnect without reconnect within 3s: fall back to today's local propagation (existing code path untouched).
  - On disable: close WebSocket, clear sources.
- Viewport sync: on `map.on('moveend')`, throttle + send `ViewportMsg` with current bounds.
- Group styling: existing `SATELLITE_GROUPS` config in `src/lib/satellites.ts` is keyed by group name string. Extend to cover the broader group set from the catalog (iss, active, debris, gps, geo). Existing MapLibre paint `match` expressions in `Map.tsx` extended accordingly.

### Phase 5 — Deploy (0.5 day)
- `fly launch` in `server/`, region `iad` (US east) — low latency to most of North America and acceptable to Europe.
- Machine size: `shared-cpu-1x`, 512 MB RAM. Scale-to-zero disabled (keep always-on for instant demo).
- GitHub Actions workflow `.github/workflows/deploy-server.yml`: on push to main affecting `server/**`, run `fly deploy --remote-only`.
- Set $15/mo hard spending cap in Fly dashboard (manual, one-time).
- Add `VITE_ORBIT_WS_URL` to Vercel env vars for production.

### Phase 6 — Observability + hardening (0.5 day)
- `tracing` structured logs: connections, disconnections, tick duration, catalog refresh results.
- `/health` endpoint returns catalog size, last refresh time, active connections.
- `/metrics` endpoint (simple JSON) for manual inspection.
- Rate limiting per IP (tower-governor or similar): 5 connections/IP, 20 viewport updates/sec/connection.
- Graceful shutdown on SIGTERM: close all WebSockets with a "server restarting" message.

**Total estimated effort: ~4–5 focused days.**

## Critical files / reference points

From the Phase 1 exploration, the load-bearing integration seams on the frontend:

| Site | File | Line | What changes |
|---|---|---|---|
| Satellite animation effect | `src/components/map/Map.tsx` | 1097–1160 | Split into WS-primary + local-fallback paths |
| TLE fetch call | `src/components/map/Map.tsx` | 1145 | Skipped when WS connected |
| 200ms `setInterval` | `src/components/map/Map.tsx` | 1128 | Skipped when WS connected |
| `buildSatelliteGeoJSON` call | `src/components/map/Map.tsx` | 1131 | Reused — fed by WS positions or local positions |
| `parseTLEData` / `propagateAll` | `src/lib/satellites.ts` | 48, 65 | Retained for fallback only |
| `SATELLITE_GROUPS` styling | `src/lib/satellites.ts` | (top of file) | Extended to include `active`, `debris`, `geo` groups |
| Zustand satellite flag | `src/stores/useAtlasStore.ts` | 14, 35–36 | Unchanged — same `satellitesVisible` gates both paths |
| MapLibre sources/layers | `src/components/map/Map.tsx` | 216–223, 324, 337, 368, 398 | Unchanged — same GeoJSON sources receive data from either path |

The GeoJSON build and MapLibre layer updates stay identical — the server just replaces the *source* of `SatPosition[]`.

## Verification

**Local dev loop:**
1. `cd server && cargo run` — verify catalog loads (~28k objects logged), `/health` returns green.
2. `wscat -c ws://localhost:8080/stream` — send viewport JSON, verify binary position batches arrive at 1 Hz.
3. `pnpm dev` in repo root with `VITE_ORBIT_WS_URL=ws://localhost:8080/stream`.
4. Toggle globe mode + satellites → confirm dense swarm renders, movement is smooth, pan/zoom updates viewport.
5. Kill the Rust server → confirm frontend falls back to 250-sat local propagation without error.
6. Restart Rust server → confirm frontend reconnects and switches back to full catalog.

**Production checks:**
1. After Fly deploy, `curl https://atlas-orbit.fly.dev/health` — confirm catalog size and last refresh.
2. Open Atlas in production, toggle satellites on globe — confirm WebSocket connects (check browser devtools Network tab).
3. Let it run for 10 minutes — confirm memory is stable in Fly metrics dashboard.
4. Simulate Fly outage (stop the machine manually) — confirm frontend gracefully falls back.

**Bandwidth sanity check:**
- Use browser devtools to confirm compressed WebSocket payload per tick matches the ~50–80 KB/sec estimate. If dramatically higher, revisit encoding.

## Explicitly out of scope for v1

- Conjunction screening / close-approach alerts (v2)
- Click-to-inspect orbit trail for arbitrary satellite (v2)
- Rich satellite metadata beyond name + group (v2 — needs SATCAT ingestion)
- Historical replay / time scrubbing
- Pass prediction ("next ISS flyover for my location")
- Authentication, user accounts, persistence
- Database of any kind — catalog stays entirely in memory
- Multi-region Fly deployment
