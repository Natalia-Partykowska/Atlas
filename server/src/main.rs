use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

mod catalog;
mod celestrak;
mod config;
mod conjunctions;
mod downloads;
mod propagate;
mod protocol;
#[cfg(test)]
mod test_support;
mod viewport;
mod ws;

use catalog::SharedCatalog;
use ws::{ScreenerStats, StreamState};

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    catalog_size: usize,
    catalog_loaded_at: String,
    /// No group is missing (stale groups still have their satellites).
    catalog_complete: bool,
    catalog_version: u64,
    /// When missing or stale groups are downloaded again; null when every
    /// group is fresh.
    catalog_next_retry_at: Option<String>,
    catalog_groups: Vec<GroupHealth>,
    connections: usize,
    screener_last_elapsed_ms: u64,
    screener_last_event_count: u64,
    screener_last_generated_epoch_ms: u64,
}

/// One CelesTrak group in `/health`.
#[derive(Serialize)]
struct GroupHealth {
    group: &'static str,
    status: catalog::GroupStatus,
    /// Satellites in its last good download.
    entries: usize,
    loaded_at: Option<String>,
    last_error: Option<String>,
    last_error_at: Option<String>,
}

// A partial catalog is still "ok" with HTTP 200: the server works, and a
// failing health check could get it restarted, which downloads every group
// from CelesTrak again.
async fn health(State(state): State<StreamState>) -> (StatusCode, Json<HealthResponse>) {
    let cat = state.catalog.load();
    let status = state.catalog_status.borrow().clone();
    let catalog_groups = status
        .groups
        .iter()
        .map(|g| GroupHealth {
            group: g.name,
            status: g.status,
            entries: g.entries,
            loaded_at: g.loaded_at.map(|t| t.to_rfc3339()),
            last_error: g.failure.as_ref().map(|f| f.error.clone()),
            last_error_at: g.failure.as_ref().map(|f| f.at.to_rfc3339()),
        })
        .collect();
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            service: "atlas-orbit",
            version: env!("CARGO_PKG_VERSION"),
            catalog_size: cat.len(),
            catalog_loaded_at: cat.loaded_at.to_rfc3339(),
            catalog_complete: status.is_complete(),
            catalog_version: status.version,
            catalog_next_retry_at: status.next_retry_at.map(|t| t.to_rfc3339()),
            catalog_groups,
            connections: state.connections.load(Ordering::Relaxed),
            screener_last_elapsed_ms: state.screener.last_elapsed_ms.load(Ordering::Relaxed),
            screener_last_event_count: state.screener.last_event_count.load(Ordering::Relaxed),
            screener_last_generated_epoch_ms: state
                .screener
                .last_generated_epoch_ms
                .load(Ordering::Relaxed),
        }),
    )
}

async fn root() -> &'static str {
    "atlas-orbit: real-time orbital streaming service. See /health, /stream, /catalog, /sat/:norad/tle."
}

const CACHE_CONTROL_VAL: &str = "public, max-age=3600";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntryDto {
    name: String,
    group: catalog::Group,
    intl_designator: String,
}

#[derive(Serialize)]
struct TleResponseDto {
    name: String,
    tle1: String,
    tle2: String,
}

fn make_etag(loaded_at: &DateTime<Utc>) -> String {
    let mut h = DefaultHasher::new();
    loaded_at.to_rfc3339().hash(&mut h);
    format!("\"{:016x}\"", h.finish())
}

fn cache_headers(etag: &str) -> [(HeaderName, HeaderValue); 2] {
    [
        (
            header::ETAG,
            HeaderValue::from_str(etag).expect("etag is ASCII hex"),
        ),
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static(CACHE_CONTROL_VAL),
        ),
    ]
}

fn matches_if_none_match(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == etag)
        .unwrap_or(false)
}

async fn catalog_handler(headers: HeaderMap, State(state): State<StreamState>) -> Response {
    let cat = state.catalog.load();
    let etag = make_etag(&cat.loaded_at);

    if matches_if_none_match(&headers, &etag) {
        return (StatusCode::NOT_MODIFIED, cache_headers(&etag)).into_response();
    }

    let map: HashMap<u64, CatalogEntryDto> = cat
        .entries
        .iter()
        .map(|e| {
            (
                e.norad_id,
                CatalogEntryDto {
                    name: e.name.clone(),
                    group: e.group,
                    intl_designator: e.intl_designator.clone(),
                },
            )
        })
        .collect();

    (StatusCode::OK, cache_headers(&etag), Json(map)).into_response()
}

async fn tle_handler(
    Path(norad): Path<u64>,
    headers: HeaderMap,
    State(state): State<StreamState>,
) -> Response {
    let cat = state.catalog.load();
    let etag = make_etag(&cat.loaded_at);

    if matches_if_none_match(&headers, &etag) {
        return (StatusCode::NOT_MODIFIED, cache_headers(&etag)).into_response();
    }

    match cat.entries.iter().find(|e| e.norad_id == norad) {
        Some(e) => (
            StatusCode::OK,
            cache_headers(&etag),
            Json(TleResponseDto {
                name: e.name.clone(),
                tle1: e.line1.clone(),
                tle2: e.line2.clone(),
            }),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn build_app(state: StreamState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/catalog", get(catalog_handler))
        .route("/sat/:norad/tle", get(tle_handler))
        .route("/stream", get(ws::stream_handler))
        .with_state(state)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "atlas_orbit=info,tower_http=info".into()),
        )
        .init();

    let cfg = config::Config::from_env();
    info!(
        port = cfg.port,
        origins = ?cfg.allowed_origins,
        celestrak = %cfg.celestrak_base_url,
        "starting atlas-orbit"
    );

    let celestrak =
        celestrak::CelesTrak::new(&cfg.celestrak_base_url).expect("build CelesTrak HTTP client");
    if cfg.catalog_retry_base_secs.is_some() || cfg.catalog_refresh_every_secs.is_some() {
        warn!(schedule = ?cfg.catalog_schedule(), "catalog schedule overridden (local checks only)");
    }
    let (groups, initial) = downloads::load(&celestrak)
        .await
        .expect("initial catalog load failed — cannot start");

    let bench_start = std::time::Instant::now();
    let positions = propagate::propagate_all(&initial, chrono::Utc::now());
    info!(
        propagated = positions.len(),
        dropped = initial.len() - positions.len(),
        elapsed_ms = bench_start.elapsed().as_millis() as u64,
        "initial propagation benchmark"
    );

    let shared: SharedCatalog = Arc::new(ArcSwap::from_pointee(initial));
    let catalog_status = downloads::spawn_catalog_maintenance(
        shared.clone(),
        groups,
        celestrak,
        cfg.catalog_schedule(),
        downloads::SystemClock,
    );

    let (tx, connections) = ws::spawn_broadcast_tick(shared.clone());
    let screener = ScreenerStats::new();
    let conj_tx = ws::spawn_conjunction_tick(shared.clone(), connections.clone(), screener.clone());
    let state = StreamState {
        catalog: shared.clone(),
        tx,
        conj_tx,
        connections,
        screener,
        catalog_status,
    };

    let cors = CorsLayer::new()
        .allow_origin(cfg.cors_origins())
        .allow_methods([axum::http::Method::GET]);

    let app = build_app(state).layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");
    info!(%addr, "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;
    use axum::body::Body;
    use axum::http::Request;
    use catalog::{Catalog, CatalogEntry, CatalogStatus, Group, GroupStore};
    use celestrak::{RawEntry, SOURCES};
    use chrono::{TimeZone, Utc};
    use futures_util::StreamExt;
    use protocol::CatalogStatusMsg;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;
    use tokio::sync::{broadcast, watch};
    use tower::ServiceExt;
    use ws::{ScreenerStats, StreamState};

    const ISS_NAME: &str = "ISS (ZARYA)";
    const ISS_LINE1: &str =
        "1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991";
    const ISS_LINE2: &str =
        "2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590";

    const POISK_NAME: &str = "POISK";
    const POISK_LINE1: &str =
        "1 36086U 09060A   26076.83874734  .00009567  00000+0  18567-3 0  9999";
    const POISK_LINE2: &str =
        "2 36086  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303554444";

    fn build_test_entry(name: &str, l1: &str, l2: &str, group: Group) -> CatalogEntry {
        let raw = RawEntry {
            name: name.to_string(),
            line1: l1.to_string(),
            line2: l2.to_string(),
        };
        catalog::build_entry(&raw, group).expect("test TLE should parse")
    }

    fn build_test_state(entries: Vec<CatalogEntry>) -> StreamState {
        build_test_state_with(entries, catalog_status(1, &[])).0
    }

    /// Every group downloaded at 01:00 on 2026-10-12, except `missing`, whose
    /// downloads failed.
    fn catalog_status(version: u64, missing: &[&str]) -> CatalogStatus {
        let loaded_at = Utc.with_ymd_and_hms(2026, 10, 12, 1, 0, 0).unwrap();
        let mut store = GroupStore::new();
        for (i, (_, name)) in SOURCES.iter().enumerate() {
            let download = if missing.contains(name) {
                Err(anyhow!("non-2xx from celestrak: 503 Service Unavailable"))
            } else {
                Ok(vec![test_support::tle(100 + i as u32)])
            };
            store.record(i, download, loaded_at);
        }
        let next_retry_at =
            (!missing.is_empty()).then(|| loaded_at + chrono::Duration::minutes(30));
        CatalogStatus::of(&store, version, next_retry_at)
    }

    /// Also returns the status sender, to change the status mid-test.
    fn build_test_state_with(
        entries: Vec<CatalogEntry>,
        status: CatalogStatus,
    ) -> (StreamState, watch::Sender<CatalogStatus>) {
        let cat = Catalog {
            entries,
            loaded_at: Utc::now(),
            version: status.version,
        };
        let shared: catalog::SharedCatalog = Arc::new(ArcSwap::from_pointee(cat));
        let (tx, _) = broadcast::channel::<ws::PositionsTick>(4);
        let (conj_tx, _) = broadcast::channel::<ws::ConjunctionsTick>(2);
        let connections = Arc::new(AtomicUsize::new(0));
        let screener = ScreenerStats::new();
        let (status_tx, catalog_status) = watch::channel(status);
        let state = StreamState {
            catalog: shared,
            tx,
            conj_tx,
            connections,
            screener,
            catalog_status,
        };
        (state, status_tx)
    }

    async fn get_json(app: Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn group<'a>(health: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
        health["catalog_groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["group"] == name)
            .unwrap()
    }

    #[tokio::test]
    async fn health_reports_a_complete_catalog() {
        let (state, _) = build_test_state_with(vec![], catalog_status(7, &[]));
        let (code, health) = get_json(build_app(state), "/health").await;

        assert_eq!(code, StatusCode::OK);
        assert_eq!(health["catalog_complete"], true);
        assert_eq!(health["catalog_version"], 7);
        assert_eq!(health["catalog_next_retry_at"], serde_json::Value::Null);
        let groups = health["catalog_groups"].as_array().unwrap();
        let names: Vec<&str> = groups
            .iter()
            .map(|g| g["group"].as_str().unwrap())
            .collect();
        let sources: Vec<&str> = SOURCES.iter().map(|(_, n)| *n).collect();
        assert_eq!(names, sources);
        assert!(groups
            .iter()
            .all(|g| g["status"] == "fresh" && g["last_error"].is_null()));
        assert_eq!(group(&health, "gps-ops")["entries"], 1);
        assert_eq!(
            group(&health, "gps-ops")["loaded_at"],
            "2026-10-12T01:00:00+00:00"
        );
    }

    #[tokio::test]
    async fn health_reports_a_partial_catalog_and_stays_ok() {
        let (state, _) = build_test_state_with(vec![], catalog_status(7, &["active"]));
        let (code, health) = get_json(build_app(state), "/health").await;

        // Degraded, not down: a failing check could restart the server.
        assert_eq!(code, StatusCode::OK);
        assert_eq!(health["status"], "ok");
        assert_eq!(health["catalog_complete"], false);
        assert_eq!(health["catalog_next_retry_at"], "2026-10-12T01:30:00+00:00");
        let active = group(&health, "active");
        assert_eq!(active["status"], "missing");
        assert_eq!(active["entries"], 0);
        assert_eq!(active["loaded_at"], serde_json::Value::Null);
        assert!(active["last_error"].as_str().unwrap().contains("503"));
        assert_eq!(active["last_error_at"], "2026-10-12T01:00:00+00:00");
        assert_eq!(group(&health, "stations")["status"], "fresh");
    }

    type WsClient = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// The next binary frame, skipping pings; fails after 5 s.
    async fn next_binary(ws: &mut WsClient) -> Vec<u8> {
        use tokio_tungstenite::tungstenite::Message;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await.expect("stream open").expect("frame") {
                    Message::Binary(bytes) => return bytes,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    other => panic!("unexpected frame {other:?}"),
                }
            }
        })
        .await
        .expect("a frame within 5 s")
    }

    #[tokio::test]
    async fn the_stream_sends_the_catalog_status_first_and_again_when_it_changes() {
        let (state, status_tx) = build_test_state_with(vec![], catalog_status(1, &["active"]));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, build_app(state)).await.unwrap() });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/stream"))
            .await
            .unwrap();

        let first = next_binary(&mut ws).await;
        let partial = CatalogStatusMsg {
            catalog_version: 1,
            missing_groups: vec!["active"],
        };
        assert_eq!(first, partial.frame());

        // A retry failed again: only the next retry moved, so nothing is sent.
        status_tx.send_modify(|s| {
            s.next_retry_at = s.next_retry_at.map(|t| t + chrono::Duration::hours(1))
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The next one worked.
        status_tx.send_replace(catalog_status(2, &[]));

        let second = next_binary(&mut ws).await;
        let complete = CatalogStatusMsg {
            catalog_version: 2,
            missing_groups: vec![],
        };
        assert_eq!(second, complete.frame());
    }

    #[tokio::test]
    async fn catalog_endpoint_returns_all_entries() {
        let entries = vec![
            build_test_entry(ISS_NAME, ISS_LINE1, ISS_LINE2, Group::Iss),
            build_test_entry(POISK_NAME, POISK_LINE1, POISK_LINE2, Group::Station),
        ];
        let app = build_app(build_test_state(entries));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/catalog")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().contains_key(header::ETAG));
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .unwrap()
                .to_str()
                .unwrap(),
            CACHE_CONTROL_VAL
        );

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: HashMap<String, serde_json::Value> = serde_json::from_slice(&body).unwrap();
        let iss = &json["25544"];
        assert_eq!(iss["name"], ISS_NAME);
        assert_eq!(iss["group"], "iss");
        assert_eq!(iss["intlDesignator"], "98067A");
        let poisk = &json["36086"];
        assert_eq!(poisk["name"], POISK_NAME);
        assert_eq!(poisk["group"], "station");
        assert_eq!(poisk["intlDesignator"], "09060A");
    }

    #[tokio::test]
    async fn tle_endpoint_returns_one_satellite() {
        let entries = vec![build_test_entry(ISS_NAME, ISS_LINE1, ISS_LINE2, Group::Iss)];
        let app = build_app(build_test_state(entries));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/sat/25544/tle")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["name"], ISS_NAME);
        assert_eq!(json["tle1"], ISS_LINE1);
        assert_eq!(json["tle2"], ISS_LINE2);
    }

    #[tokio::test]
    async fn tle_endpoint_returns_404_for_unknown_norad() {
        let entries = vec![build_test_entry(ISS_NAME, ISS_LINE1, ISS_LINE2, Group::Iss)];
        let app = build_app(build_test_state(entries));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/sat/9999/tle")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn etag_round_trip_returns_304() {
        let entries = vec![build_test_entry(ISS_NAME, ISS_LINE1, ISS_LINE2, Group::Iss)];
        let app = build_app(build_test_state(entries));

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/catalog")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let etag = first.headers().get(header::ETAG).unwrap().clone();

        let second = app
            .oneshot(
                Request::builder()
                    .uri("/catalog")
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            second.headers().get(header::ETAG).unwrap(),
            &etag,
            "304 should echo the ETag back"
        );
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("ctrl_c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("sigterm handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("shutdown signal received");
}
