use chrono::{DateTime, Datelike, Timelike, Utc};
use rayon::prelude::*;

use crate::catalog::{Catalog, CatalogEntry, Group};

#[derive(Debug, Clone, Copy)]
pub struct Position {
    pub norad_id: u32,
    pub lat_deg: f32,
    pub lng_deg: f32,
    pub alt_km: u16,
    pub group: Group,
}

/// TEME-frame position (km) and velocity (km/s) at a sample instant.
/// Used by the conjunction screener — relative position is rotation-invariant,
/// so working in TEME avoids per-sample sidereal math.
#[derive(Debug, Clone, Copy)]
pub struct StateVector {
    pub r_teme: [f64; 3],
    pub v_teme: [f64; 3],
}

pub fn propagate_all(catalog: &Catalog, at: DateTime<Utc>) -> Vec<Position> {
    catalog
        .entries
        .par_iter()
        .filter_map(|e| propagate_one(e, at))
        .collect()
}

/// Propagate every catalog entry to `at`, returning TEME state vectors.
/// `None` slot at index `k` means SGP4 failed for `entries[k]` at this time —
/// the screener treats those entries as non-live for the tick.
pub fn propagate_state_at(entries: &[CatalogEntry], at: DateTime<Utc>) -> Vec<Option<StateVector>> {
    entries
        .par_iter()
        .map(|e| state_at_one(e, at))
        .collect()
}

fn state_at_one(entry: &CatalogEntry, at: DateTime<Utc>) -> Option<StateVector> {
    let dt_secs = (at - entry.epoch).num_milliseconds() as f64 / 1000.0;
    let minutes = sgp4::MinutesSinceEpoch(dt_secs / 60.0);
    let prediction = entry.constants.propagate(minutes).ok()?;
    let r = prediction.position;
    let v = prediction.velocity;
    if !r.iter().chain(v.iter()).all(|x| x.is_finite()) {
        return None;
    }
    Some(StateVector {
        r_teme: r,
        v_teme: v,
    })
}

fn propagate_one(entry: &CatalogEntry, at: DateTime<Utc>) -> Option<Position> {
    let dt_secs = (at - entry.epoch).num_milliseconds() as f64 / 1000.0;
    let minutes = sgp4::MinutesSinceEpoch(dt_secs / 60.0);

    let prediction = entry.constants.propagate(minutes).ok()?;
    let teme = prediction.position; // km, TEME frame

    let gmst = gmst_rad(at);
    let (ex, ey, ez) = teme_to_ecef(teme, gmst);
    let (lat_deg, lng_deg, alt_km) = ecef_to_geodetic(ex, ey, ez);

    if !lat_deg.is_finite() || !lng_deg.is_finite() || !alt_km.is_finite() {
        return None;
    }
    // Reject decayed / numerically nonsensical propagations.
    if !(-200.0..=60_000.0).contains(&alt_km) {
        return None;
    }

    Some(Position {
        norad_id: entry.norad_id as u32,
        lat_deg: lat_deg as f32,
        lng_deg: lng_deg as f32,
        alt_km: alt_km.clamp(0.0, 65_000.0) as u16,
        group: entry.group,
    })
}

/// Greenwich Mean Sidereal Time (radians) using IAU 1982.
pub(crate) fn gmst_rad(at: DateTime<Utc>) -> f64 {
    let jd = julian_date(at);
    let t = (jd - 2_451_545.0) / 36_525.0;

    // GMST in seconds, per Vallado (IAU 1982).
    let mut gmst_sec = 67_310.548_41
        + (876_600.0 * 3600.0 + 8_640_184.812_866) * t
        + 0.093_104 * t * t
        - 6.2e-6 * t * t * t;

    gmst_sec = gmst_sec.rem_euclid(86_400.0);
    gmst_sec * std::f64::consts::TAU / 86_400.0
}

fn julian_date(at: DateTime<Utc>) -> f64 {
    let (y, m, d) = (at.year() as i64, at.month() as i64, at.day() as i64);
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let a = y.div_euclid(100);
    let b = 2 - a + a.div_euclid(4);

    let day_fraction = (at.hour() as f64
        + at.minute() as f64 / 60.0
        + (at.second() as f64 + at.nanosecond() as f64 * 1e-9) / 3600.0)
        / 24.0;

    (365.25 * (y + 4716) as f64).floor()
        + (30.6001 * (m + 1) as f64).floor()
        + d as f64
        + b as f64
        - 1524.5
        + day_fraction
}

pub(crate) fn teme_to_ecef(teme: [f64; 3], gmst: f64) -> (f64, f64, f64) {
    let (s, c) = gmst.sin_cos();
    let x = c * teme[0] + s * teme[1];
    let y = -s * teme[0] + c * teme[1];
    let z = teme[2];
    (x, y, z)
}

/// ECEF (km) → geodetic lat/lng (deg) and altitude (km) on WGS84.
/// Closed-form Bowring, sufficient accuracy for visualization.
pub(crate) fn ecef_to_geodetic(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    const A: f64 = 6378.137; // equatorial radius, km
    const F: f64 = 1.0 / 298.257_223_563;
    const B: f64 = A * (1.0 - F);
    const E2: f64 = 2.0 * F - F * F;
    const EP2: f64 = (A * A - B * B) / (B * B);

    let r = (x * x + y * y).sqrt();
    let lng = y.atan2(x);

    let theta = (z * A).atan2(r * B);
    let (st, ct) = theta.sin_cos();
    let lat = (z + EP2 * B * st * st * st).atan2(r - E2 * A * ct * ct * ct);
    let n = A / (1.0 - E2 * lat.sin().powi(2)).sqrt();
    let alt = r / lat.cos() - n;

    (lat.to_degrees(), lng.to_degrees(), alt)
}
