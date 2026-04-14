use crate::propagate::Position;
use crate::protocol::{ViewportMsg, WirePosition};

pub fn filter_and_encode(positions: &[Position], vp: &ViewportMsg) -> Vec<WirePosition> {
    let wraps_antimeridian = vp.west > vp.east;
    positions
        .iter()
        .filter(|p| p.alt_km >= vp.min_alt_km && p.alt_km <= vp.max_alt_km)
        .filter(|p| p.lat_deg >= vp.south && p.lat_deg <= vp.north)
        .filter(|p| {
            if wraps_antimeridian {
                p.lng_deg >= vp.west || p.lng_deg <= vp.east
            } else {
                p.lng_deg >= vp.west && p.lng_deg <= vp.east
            }
        })
        .map(|p| WirePosition {
            norad_id: p.norad_id,
            lng: p.lng_deg,
            lat: p.lat_deg,
            alt_km: p.alt_km,
            group: p.group.as_u8(),
        })
        .collect()
}
