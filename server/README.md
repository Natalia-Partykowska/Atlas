# atlas-orbit

Real-time orbital streaming service for Atlas. Propagates the full CelesTrak catalog server-side and streams viewport-filtered satellite positions over WebSocket.

See `../PLAN_backend.md` for the full design.

## Status

**Phase 0 — scaffolding.** HTTP server with `/` and `/health` only. No catalog, no WebSocket, no propagation yet.

## Prerequisites

- Rust stable (1.82+): https://rustup.rs

## Run locally

```bash
cd server
cargo run
```

Then:

```bash
curl http://localhost:8080/health
# {"status":"ok","service":"atlas-orbit","version":"0.1.0"}
```

## Configuration

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated CORS allow-list |
| `RUST_LOG` | `atlas_orbit=info,tower_http=info` | tracing env filter |

## Deploy

Hosted on [Railway](https://railway.com). The service is detected from the `Dockerfile`; no platform config file is committed.

```bash
cd server
railway up
```

Env vars (`ALLOWED_ORIGINS`, `RUST_LOG`) are managed via the Railway dashboard or `railway variables --set`. `PORT` is injected by Railway automatically.
