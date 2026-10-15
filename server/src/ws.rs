use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::time::{interval, Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::catalog::{CatalogStatus, CatalogStatusRx, SharedCatalog};
use crate::conjunctions::{self, ConjunctionEvent};
use crate::propagate::{propagate_all, Position};
use crate::protocol::{
    CatalogStatusMsg, ConjunctionBatchMsg, PositionBatchMsg, ViewportMsg, WireConjunction,
    MSG_CONJUNCTION_BATCH, MSG_POSITION_BATCH,
};
use crate::viewport::filter_and_encode;

pub const MAX_CONNECTIONS: usize = 200;
const VIEWPORT_MIN_INTERVAL_MS: u128 = 200; // 5 Hz
const CONJUNCTION_TICK_SECS: u64 = 10; // 0.1 Hz

pub type PositionsTick = Arc<Vec<Position>>;
pub type ConjunctionsTick = Arc<Vec<ConjunctionEvent>>;

/// Shared screener telemetry. Updated by the conjunction tick task; read by
/// the `/health` handler. Atomics so we don't need a mutex on the hot path.
#[derive(Clone)]
pub struct ScreenerStats {
    pub last_elapsed_ms: Arc<AtomicU64>,
    pub last_event_count: Arc<AtomicU64>,
    pub last_generated_epoch_ms: Arc<AtomicU64>,
}

impl ScreenerStats {
    pub fn new() -> Self {
        Self {
            last_elapsed_ms: Arc::new(AtomicU64::new(0)),
            last_event_count: Arc::new(AtomicU64::new(0)),
            last_generated_epoch_ms: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone)]
pub struct StreamState {
    pub catalog: SharedCatalog,
    pub tx: broadcast::Sender<PositionsTick>,
    pub conj_tx: broadcast::Sender<ConjunctionsTick>,
    pub connections: Arc<AtomicUsize>,
    pub screener: ScreenerStats,
    pub catalog_status: CatalogStatusRx,
}

pub fn spawn_broadcast_tick(
    catalog: SharedCatalog,
) -> (broadcast::Sender<PositionsTick>, Arc<AtomicUsize>) {
    let (tx, _) = broadcast::channel::<PositionsTick>(4);
    let connections = Arc::new(AtomicUsize::new(0));

    let tx_clone = tx.clone();
    let conns_clone = connections.clone();
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if conns_clone.load(Ordering::Relaxed) == 0 {
                continue;
            }
            let cat = catalog.load_full();
            let start = Instant::now();
            let positions = propagate_all(&cat, chrono::Utc::now());
            let elapsed_ms = start.elapsed().as_millis() as u64;
            debug!(positions = positions.len(), elapsed_ms, "broadcast tick");
            let _ = tx_clone.send(Arc::new(positions));
        }
    });

    (tx, connections)
}

/// Spawn the 0.1 Hz conjunction screener task. Idle-skips when no clients are
/// connected (mirrors the position tick).
pub fn spawn_conjunction_tick(
    catalog: SharedCatalog,
    connections: Arc<AtomicUsize>,
    stats: ScreenerStats,
) -> broadcast::Sender<ConjunctionsTick> {
    let (tx, _) = broadcast::channel::<ConjunctionsTick>(2);
    let tx_clone = tx.clone();
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(CONJUNCTION_TICK_SECS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if connections.load(Ordering::Relaxed) == 0 {
                continue;
            }
            let cat = catalog.load_full();
            let start = Instant::now();
            let events = conjunctions::screen(&cat, chrono::Utc::now(), chrono::Duration::hours(2));
            let elapsed_ms = start.elapsed().as_millis() as u64;
            stats.last_elapsed_ms.store(elapsed_ms, Ordering::Relaxed);
            stats
                .last_event_count
                .store(events.len() as u64, Ordering::Relaxed);
            stats.last_generated_epoch_ms.store(
                chrono::Utc::now().timestamp_millis() as u64,
                Ordering::Relaxed,
            );
            let _ = tx_clone.send(Arc::new(events));
        }
    });
    tx
}

pub async fn stream_handler(
    ws: WebSocketUpgrade,
    State(state): State<StreamState>,
) -> axum::response::Response {
    if state.connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
        return (StatusCode::SERVICE_UNAVAILABLE, "max connections").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn status_msg(status: &CatalogStatus) -> CatalogStatusMsg {
    CatalogStatusMsg {
        catalog_version: status.version,
        missing_groups: status.missing(),
    }
}

async fn handle_socket(mut socket: WebSocket, state: StreamState) {
    // The catalog status goes first, so the client knows which catalog it's
    // seeing before the first batch.
    let mut status_rx = state.catalog_status.clone();
    let mut sent_status = status_msg(&status_rx.borrow_and_update());
    if socket
        .send(Message::Binary(sent_status.frame()))
        .await
        .is_err()
    {
        return;
    }

    let n = state.connections.fetch_add(1, Ordering::Relaxed) + 1;
    info!(connections = n, "client connected");

    let (sender, mut receiver) = socket.split();
    // The send tasks share this sink; the WebSocket spec forbids interleaved
    // frames, so writes must serialise through a mutex.
    let sender = Arc::new(Mutex::new(sender));

    let viewport: Arc<RwLock<ViewportMsg>> = Arc::new(RwLock::new(ViewportMsg::default()));

    let vp_writer = viewport.clone();
    let recv_task = tokio::spawn(async move {
        let mut last = Instant::now()
            .checked_sub(Duration::from_millis(VIEWPORT_MIN_INTERVAL_MS as u64 + 1))
            .unwrap_or_else(Instant::now);
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(t) => {
                    if last.elapsed().as_millis() < VIEWPORT_MIN_INTERVAL_MS {
                        continue;
                    }
                    last = Instant::now();
                    match serde_json::from_str::<ViewportMsg>(&t) {
                        Ok(vp) => *vp_writer.write().await = vp,
                        Err(e) => warn!(error = %e, "invalid viewport message"),
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    let sender_p = sender.clone();
    let vp_reader = viewport.clone();
    let mut pos_rx = state.tx.subscribe();
    let send_task_pos = tokio::spawn(async move {
        loop {
            match pos_rx.recv().await {
                Ok(positions) => {
                    let vp = *vp_reader.read().await;
                    let filtered = filter_and_encode(&positions, &vp);
                    let batch = PositionBatchMsg {
                        tick_epoch_ms: chrono::Utc::now().timestamp_millis() as u64,
                        positions: filtered,
                    };
                    let payload = match bincode::serialize(&batch) {
                        Ok(b) => b,
                        Err(e) => {
                            warn!(error = %e, "bincode encode failed");
                            continue;
                        }
                    };
                    let mut frame = Vec::with_capacity(1 + payload.len());
                    frame.push(MSG_POSITION_BATCH);
                    frame.extend_from_slice(&payload);
                    let mut sink = sender_p.lock().await;
                    if sink.send(Message::Binary(frame)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "position broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let sender_c = sender.clone();
    let mut conj_rx = state.conj_tx.subscribe();
    let send_task_conj = tokio::spawn(async move {
        loop {
            match conj_rx.recv().await {
                Ok(events) => {
                    let wire_events: Vec<WireConjunction> = events
                        .iter()
                        .map(|e| WireConjunction {
                            norad_a: e.norad_a,
                            norad_b: e.norad_b,
                            tca_epoch_ms: e.tca_epoch_ms,
                            miss_km: e.miss_km,
                            rel_vel_kms: e.rel_vel_kms,
                            group_a: e.group_a.as_u8(),
                            group_b: e.group_b.as_u8(),
                            mid_lat: e.mid_lat_deg,
                            mid_lng: e.mid_lng_deg,
                            mid_alt_km: e.mid_alt_km,
                        })
                        .collect();
                    let batch = ConjunctionBatchMsg {
                        generated_epoch_ms: chrono::Utc::now().timestamp_millis() as u64,
                        events: wire_events,
                    };
                    let payload = match bincode::serialize(&batch) {
                        Ok(b) => b,
                        Err(e) => {
                            warn!(error = %e, "bincode encode failed (conjunctions)");
                            continue;
                        }
                    };
                    let mut frame = Vec::with_capacity(1 + payload.len());
                    frame.push(MSG_CONJUNCTION_BATCH);
                    frame.extend_from_slice(&payload);
                    let mut sink = sender_c.lock().await;
                    if sink.send(Message::Binary(frame)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "conjunction broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Sends the status again when the catalog changes. The maintenance task
    // publishes after every download pass; most change neither the version
    // nor the missing groups (a failed retry only moves the next one).
    let sender_s = sender.clone();
    let send_task_status = tokio::spawn(async move {
        while status_rx.changed().await.is_ok() {
            let status = status_msg(&status_rx.borrow_and_update());
            if status == sent_status {
                continue;
            }
            let mut sink = sender_s.lock().await;
            if sink.send(Message::Binary(status.frame())).await.is_err() {
                break;
            }
            sent_status = status;
        }
    });

    tokio::select! {
        _ = recv_task => {},
        _ = send_task_pos => {},
        _ = send_task_conj => {},
    }
    // It may wait hours for the next change, so it doesn't notice the
    // client is gone.
    send_task_status.abort();

    let n = state.connections.fetch_sub(1, Ordering::Relaxed) - 1;
    info!(connections = n, "client disconnected");
}
