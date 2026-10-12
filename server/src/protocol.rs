use serde::{Deserialize, Serialize};

/// Type-byte prefix on every binary frame the server sends. Lets the client
/// demultiplex position vs conjunction batches over the same WebSocket.
pub const MSG_POSITION_BATCH: u8 = 0x01;
pub const MSG_CONJUNCTION_BATCH: u8 = 0x02;
pub const MSG_CATALOG_STATUS: u8 = 0x03;

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
/// `mid_lat` / `mid_lng` / `mid_alt_km` are the geodetic position of the TCA
/// midpoint in 3D — embedded so the client can render the elevated dot at
/// real altitude without a position-lookup race.
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
    pub mid_alt_km: f32,
}

#[derive(Debug, Serialize)]
pub struct ConjunctionBatchMsg {
    pub generated_epoch_ms: u64,
    pub events: Vec<WireConjunction>,
}

/// The catalog's version and the groups missing from it (none when it's
/// complete). Sent first on every connection and again whenever either
/// changes. Clients load names from `/catalog?v=<version>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogStatusMsg {
    pub catalog_version: u64,
    pub missing_groups: Vec<&'static str>,
}

impl CatalogStatusMsg {
    /// The type byte, then `u64 catalog_version | u64 n | n × (u64 len | UTF-8 name)`.
    pub fn frame(&self) -> Vec<u8> {
        let payload = bincode::serialize(self).expect("a version and strings always encode");
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(MSG_CATALOG_STATUS);
        frame.extend_from_slice(&payload);
        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // The client's decoder test (`src/lib/orbitStream.test.ts`) uses the same
    // bytes, so the two sides can't drift apart.
    #[test]
    fn a_catalog_status_frame_matches_the_golden_bytes() {
        let partial = CatalogStatusMsg {
            catalog_version: 1_791_763_200_000, // 2026-10-12T00:00:00Z in ms
            missing_groups: vec!["geo", "active"],
        };
        assert_eq!(
            hex(&partial.frame()),
            concat!(
                "03",               // MSG_CATALOG_STATUS
                "00b8682da1010000", // catalog_version, u64 LE
                "0200000000000000", // 2 missing groups
                "0300000000000000",
                "67656f", // "geo"
                "0600000000000000",
                "616374697665", // "active"
            )
        );

        let complete = CatalogStatusMsg {
            catalog_version: 1_791_763_200_000,
            missing_groups: vec![],
        };
        assert_eq!(hex(&complete.frame()), "0300b8682da10100000000000000000000");
    }
}
