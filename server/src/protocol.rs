use serde::{Deserialize, Serialize};

/// Type-byte prefix on every binary frame the server sends. Lets the client
/// demultiplex position vs conjunction batches over the same WebSocket.
pub const MSG_POSITION_BATCH: u8 = 0x01;
pub const MSG_CONJUNCTION_BATCH: u8 = 0x02;

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ViewportMsg {
    pub west: f32,
    pub south: f32,
    pub east: f32,
    pub north: f32,
    #[serde(default)]
    pub min_alt_km: u16,
    #[serde(default = "default_max_alt")]
    pub max_alt_km: u16,
}

fn default_max_alt() -> u16 {
    65_000
}

impl Default for ViewportMsg {
    fn default() -> Self {
        Self {
            west: -180.0,
            south: -90.0,
            east: 180.0,
            north: 90.0,
            min_alt_km: 0,
            max_alt_km: 65_000,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct WirePosition {
    pub norad_id: u32,
    pub lng: f32,
    pub lat: f32,
    pub alt_km: u16,
    pub group: u8,
}

#[derive(Debug, Serialize)]
pub struct PositionBatchMsg {
    pub tick_epoch_ms: u64,
    pub positions: Vec<WirePosition>,
}

/// Single predicted close-approach event. 38 bytes/event with bincode framing.
/// `mid_lat` / `mid_lng` are the geodetic projection of the TCA midpoint —
/// embedded so the client can render the dot without a position-lookup race.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct WireConjunction {
    pub norad_a: u32,
    pub norad_b: u32,
    pub tca_epoch_ms: u64,
    pub miss_km: f32,
    pub rel_vel_kms: f32,
    pub group_a: u8,
    pub group_b: u8,
    pub mid_lat: f32,
    pub mid_lng: f32,
}

#[derive(Debug, Serialize)]
pub struct ConjunctionBatchMsg {
    pub generated_epoch_ms: u64,
    pub events: Vec<WireConjunction>,
}
