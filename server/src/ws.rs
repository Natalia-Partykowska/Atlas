use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::catalog::SharedCatalog;
use crate::propagate::{propagate_all, Position};
use crate::protocol::{PositionBatchMsg, ViewportMsg};
use crate::viewport::filter_and_encode;

pub const MAX_CONNECTIONS: usize = 200;
const VIEWPORT_MIN_INTERVAL_MS: u128 = 200; // 5 Hz

pub type PositionsTick = Arc<Vec<Position>>;

#[derive(Clone)]
pub struct StreamState {
    pub catalog: SharedCatalog,
    pub tx: broadcast::Sender<PositionsTick>,
    pub connections: Arc<AtomicUsize>,
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

pub async fn stream_handler(
    ws: WebSocketUpgrade,
    State(state): State<StreamState>,
) -> axum::response::Response {
    if state.connections.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
        return (StatusCode::SERVICE_UNAVAILABLE, "max connections").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: StreamState) {
    let n = state.connections.fetch_add(1, Ordering::Relaxed) + 1;
    info!(connections = n, "client connected");

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

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

    let vp_reader = viewport.clone();
    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(positions) => {
                    let vp = *vp_reader.read().await;
                    let filtered = filter_and_encode(&positions, &vp);
                    let batch = PositionBatchMsg {
                        tick_epoch_ms: chrono::Utc::now().timestamp_millis() as u64,
                        positions: filtered,
                    };
                    let bytes = match bincode::serialize(&batch) {
                        Ok(b) => b,
                        Err(e) => {
                            warn!(error = %e, "bincode encode failed");
                            continue;
                        }
                    };
                    if sender.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "broadcast lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    tokio::select! {
        _ = recv_task => {},
        _ = send_task => {},
    }

    let n = state.connections.fetch_sub(1, Ordering::Relaxed) - 1;
    info!(connections = n, "client disconnected");
}
