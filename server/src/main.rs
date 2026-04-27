use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use serde::Serialize;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

mod catalog;
mod celestrak;
mod config;
mod conjunctions;
mod propagate;
mod protocol;
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
    connections: usize,
    screener_last_elapsed_ms: u64,
    screener_last_event_count: u64,
    screener_last_generated_epoch_ms: u64,
}

async fn health(State(state): State<StreamState>) -> (StatusCode, Json<HealthResponse>) {
    let cat = state.catalog.load();
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            service: "atlas-orbit",
            version: env!("CARGO_PKG_VERSION"),
            catalog_size: cat.len(),
            catalog_loaded_at: cat.loaded_at.to_rfc3339(),
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
    "atlas-orbit: real-time orbital streaming service. See /health, /stream."
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
    info!(port = cfg.port, origins = ?cfg.allowed_origins, "starting atlas-orbit");

    let initial = catalog::load()
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
    catalog::spawn_daily_refresh(shared.clone());

    let (tx, connections) = ws::spawn_broadcast_tick(shared.clone());
    let screener = ScreenerStats::new();
    let conj_tx = ws::spawn_conjunction_tick(shared.clone(), connections.clone(), screener.clone());
    let state = StreamState {
        catalog: shared.clone(),
        tx,
        conj_tx,
        connections,
        screener,
    };

    let cors = CorsLayer::new()
        .allow_origin(cfg.cors_origins())
        .allow_methods([axum::http::Method::GET]);

    let app = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/stream", get(ws::stream_handler))
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

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
