use serde::{Deserialize, Serialize};

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
