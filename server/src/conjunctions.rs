use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use rayon::prelude::*;
use tracing::info;

use crate::catalog::{Catalog, CatalogEntry, Group};
use crate::propagate::{
    ecef_to_geodetic, gmst_rad, propagate_state_at, teme_to_ecef, StateVector,
};

pub const THRESHOLD_KM: f64 = 5.0;
pub const APSIDES_MARGIN_KM: f32 = 5.0;
const GRID_CELL_KM: f64 = 50.0;
pub const SAMPLE_COUNT: usize = 13;
const MAX_EVENTS: usize = 500;

/// Output of one screening pass. Mirrors `WireConjunction` but uses the
/// strongly-typed `Group` enum; mapped to `u8` at the wire boundary.
#[derive(Debug, Clone, Copy)]
pub struct ConjunctionEvent {
    pub norad_a: u32,
    pub norad_b: u32,
    pub tca_epoch_ms: u64,
    pub miss_km: f32,
    pub rel_vel_kms: f32,
    pub group_a: Group,
    pub group_b: Group,
    pub mid_lat_deg: f32,
    pub mid_lng_deg: f32,
}

/// 13 half-space neighbor offsets in 3D — every unordered pair of cells is
/// visited exactly once when paired with same-cell traversal.
const NEIGHBOR_OFFSETS: [(i32, i32, i32); 13] = [
    (1, -1, -1), (1, -1, 0), (1, -1, 1),
    (1,  0, -1), (1,  0, 0), (1,  0, 1),
    (1,  1, -1), (1,  1, 0), (1,  1, 1),
    (0,  1, -1), (0,  1, 0), (0,  1, 1),
    (0,  0,  1),
];

/// Run one full conjunction screen over the catalog. Returns at most
/// `MAX_EVENTS` events sorted by TCA ascending.
pub fn screen(catalog: &Catalog, now: DateTime<Utc>, window: Duration) -> Vec<ConjunctionEvent> {
    let total_start = std::time::Instant::now();
    let entries = &catalog.entries;
    let n = entries.len();
    if n < 2 {
        return Vec::new();
    }

    // 1. Sample times across [now, now + window].
    let times: Vec<DateTime<Utc>> = (0..SAMPLE_COUNT)
        .map(|i| {
            let frac = i as f64 / (SAMPLE_COUNT - 1) as f64;
            let dt_ms = (window.num_milliseconds() as f64 * frac) as i64;
            now + Duration::milliseconds(dt_ms)
        })
        .collect();

    // 2. Propagate state vectors per sample, parallel over samples.
    let propagate_start = std::time::Instant::now();
    let samples: Vec<Vec<Option<StateVector>>> = times
        .par_iter()
        .map(|&t| propagate_state_at(entries, t))
        .collect();
    let propagate_ms = propagate_start.elapsed().as_millis() as u64;

    // 3. Live mask: entry k is alive for screening iff it propagated at every sample.
    let live: Vec<bool> = (0..n)
        .map(|k| samples.iter().all(|s| s[k].is_some()))
        .collect();
    let live_count = live.iter().filter(|&&b| b).count();

    // 4. Broadphase: 50 km TEME grid per sample. Two cheap rejects in
    //    `insert_pair` so the candidate set stays small.
    let broadphase_start = std::time::Instant::now();
    let mut candidates: HashSet<(usize, usize)> = HashSet::new();
    let mut dropped_debris = 0usize;
    let mut dropped_apsides = 0usize;
    for sample in &samples {
        let mut grid: HashMap<(i32, i32, i32), Vec<usize>> = HashMap::new();
        for (k, sv_opt) in sample.iter().enumerate() {
            if !live[k] {
                continue;
            }
            // Safe — `live[k]` requires Some at every sample.
            let sv = sv_opt.as_ref().expect("live entry has state vector");
            let key = (
                (sv.r_teme[0] / GRID_CELL_KM).floor() as i32,
                (sv.r_teme[1] / GRID_CELL_KM).floor() as i32,
                (sv.r_teme[2] / GRID_CELL_KM).floor() as i32,
            );
            grid.entry(key).or_default().push(k);
        }

        for (&(cx, cy, cz), bucket) in &grid {
            // Same-cell pairs.
            for i in 0..bucket.len() {
                for j in (i + 1)..bucket.len() {
                    insert_pair(
                        &mut candidates,
                        entries,
                        bucket[i],
                        bucket[j],
                        &mut dropped_debris,
                        &mut dropped_apsides,
                    );
                }
            }
            // Half-space neighbor pairs.
            for &(dx, dy, dz) in &NEIGHBOR_OFFSETS {
                if let Some(other) = grid.get(&(cx + dx, cy + dy, cz + dz)) {
                    for &k1 in bucket {
                        for &k2 in other {
                            insert_pair(
                                &mut candidates,
                                entries,
                                k1,
                                k2,
                                &mut dropped_debris,
                                &mut dropped_apsides,
                            );
                        }
                    }
                }
            }
        }
    }
    let broadphase_ms = broadphase_start.elapsed().as_millis() as u64;
    let candidate_count = candidates.len();

    // 5. Narrowphase: parallel over candidates. Min‑separation bracket +
    //    analytic line-segment minimization.
    let narrow_start = std::time::Instant::now();
    let mut events: Vec<ConjunctionEvent> = candidates
        .par_iter()
        .filter_map(|&(a, b)| narrowphase(entries, &samples, &times, a, b))
        .collect();
    let narrow_ms = narrow_start.elapsed().as_millis() as u64;

    // 6+7. Sort by TCA, truncate to cap.
    events.sort_by_key(|e| e.tca_epoch_ms);
    events.truncate(MAX_EVENTS);

    info!(
        catalog = n,
        live = live_count,
        candidates = candidate_count,
        events = events.len(),
        dropped_debris,
        dropped_apsides,
        propagate_ms,
        broadphase_ms,
        narrow_ms,
        total_ms = total_start.elapsed().as_millis() as u64,
        "conjunction screen complete"
    );

    events
}

fn insert_pair(
    set: &mut HashSet<(usize, usize)>,
    entries: &[CatalogEntry],
    a: usize,
    b: usize,
    dropped_debris: &mut usize,
    dropped_apsides: &mut usize,
) {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    let ea = &entries[lo];
    let eb = &entries[hi];

    // Reject debris-vs-debris — primary requirement filters most noise.
    if matches!(ea.group, Group::Debris) && matches!(eb.group, Group::Debris) {
        *dropped_debris += 1;
        return;
    }

    // Reject if altitude shells [perigee, apogee] don't overlap within margin.
    let margin = THRESHOLD_KM as f32 + APSIDES_MARGIN_KM;
    if ea.perigee_km > eb.apogee_km + margin || eb.perigee_km > ea.apogee_km + margin {
        *dropped_apsides += 1;
        return;
    }

    set.insert((lo, hi));
}

fn narrowphase(
    entries: &[CatalogEntry],
    samples: &[Vec<Option<StateVector>>],
    times: &[DateTime<Utc>],
    a: usize,
    b: usize,
) -> Option<ConjunctionEvent> {
    let n_samples = samples.len();

    // Walk samples to find the index with the minimum separation.
    let mut best_k = 0usize;
    let mut best_d2 = f64::INFINITY;
    for k in 0..n_samples {
        let sa = samples[k][a].as_ref()?;
        let sb = samples[k][b].as_ref()?;
        let d2 = sq_dist(&sa.r_teme, &sb.r_teme);
        if d2 < best_d2 {
            best_d2 = d2;
            best_k = k;
        }
    }

    // Bracket [k0, k1] = best_k and its tighter neighbor, falling back at edges.
    let (k0, k1) = if best_k == 0 {
        (0, 1)
    } else if best_k == n_samples - 1 {
        (best_k - 1, best_k)
    } else {
        let prev = sq_dist(
            &samples[best_k - 1][a].as_ref()?.r_teme,
            &samples[best_k - 1][b].as_ref()?.r_teme,
        );
        let next = sq_dist(
            &samples[best_k + 1][a].as_ref()?.r_teme,
            &samples[best_k + 1][b].as_ref()?.r_teme,
        );
        if prev < next {
            (best_k - 1, best_k)
        } else {
            (best_k, best_k + 1)
        }
    };

    let s0a = samples[k0][a].as_ref()?;
    let s0b = samples[k0][b].as_ref()?;
    let s1a = samples[k1][a].as_ref()?;
    let s1b = samples[k1][b].as_ref()?;

    let dr0 = sub3(&s0a.r_teme, &s0b.r_teme);
    let dr1 = sub3(&s1a.r_teme, &s1b.r_teme);
    let d_r = sub3(&dr1, &dr0);
    let d_r2 = dot3(&d_r, &d_r);

    // Degenerate bracket — fall back to nearer endpoint.
    let t_star = if d_r2 < 1e-9 {
        0.0
    } else {
        (-dot3(&dr0, &d_r) / d_r2).clamp(0.0, 1.0)
    };

    let r_at = lerp3(&dr0, &dr1, t_star);
    let miss_km = dot3(&r_at, &r_at).sqrt() as f32;
    if miss_km > THRESHOLD_KM as f32 {
        return None;
    }

    let dv0 = sub3(&s0a.v_teme, &s0b.v_teme);
    let dv1 = sub3(&s1a.v_teme, &s1b.v_teme);
    let dv_at = lerp3(&dv0, &dv1, t_star);
    let rel_vel_kms = dot3(&dv_at, &dv_at).sqrt() as f32;

    let t0_ms = times[k0].timestamp_millis();
    let t1_ms = times[k1].timestamp_millis();
    let tca_epoch_ms_f = t0_ms as f64 + (t1_ms - t0_ms) as f64 * t_star;
    let tca_epoch_ms = tca_epoch_ms_f.max(0.0) as u64;
    let tca = DateTime::<Utc>::from_timestamp_millis(tca_epoch_ms as i64).unwrap_or(times[k0]);

    // Midpoint at TCA: average TEME positions, transform to ECEF, then geodetic.
    let r_a_at = lerp3(&s0a.r_teme, &s1a.r_teme, t_star);
    let r_b_at = lerp3(&s0b.r_teme, &s1b.r_teme, t_star);
    let mid_teme = [
        0.5 * (r_a_at[0] + r_b_at[0]),
        0.5 * (r_a_at[1] + r_b_at[1]),
        0.5 * (r_a_at[2] + r_b_at[2]),
    ];
    let gmst = gmst_rad(tca);
    let (ex, ey, ez) = teme_to_ecef(mid_teme, gmst);
    let (mid_lat_deg, mid_lng_deg, _alt) = ecef_to_geodetic(ex, ey, ez);
    if !mid_lat_deg.is_finite() || !mid_lng_deg.is_finite() {
        return None;
    }

    Some(ConjunctionEvent {
        norad_a: entries[a].norad_id as u32,
        norad_b: entries[b].norad_id as u32,
        tca_epoch_ms,
        miss_km,
        rel_vel_kms,
        group_a: entries[a].group,
        group_b: entries[b].group,
        mid_lat_deg: mid_lat_deg as f32,
        mid_lng_deg: mid_lng_deg as f32,
    })
}

#[inline]
fn sub3(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn dot3(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn lerp3(a: &[f64; 3], b: &[f64; 3], t: f64) -> [f64; 3] {
    [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        a[2] + t * (b[2] - a[2]),
    ]
}
#[inline]
fn sq_dist(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let d = sub3(a, b);
    dot3(&d, &d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{compute_apsides, Catalog, CatalogEntry};
    use chrono::{NaiveDate, TimeZone};

    fn make_test_entry(norad_id: u64, mean_anomaly_deg: f64) -> CatalogEntry {
        let elements = sgp4::Elements {
            object_name: Some(format!("TEST-{norad_id}")),
            international_designator: None,
            norad_id,
            classification: sgp4::Classification::Unclassified,
            datetime: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
            mean_motion_dot: 0.0,
            mean_motion_ddot: 0.0,
            drag_term: 0.0,
            element_set_number: 999,
            inclination: 51.64,
            right_ascension: 100.0,
            eccentricity: 0.0001,
            argument_of_perigee: 90.0,
            mean_anomaly: mean_anomaly_deg,
            mean_motion: 15.5,
            revolution_number: 0,
            ephemeris_type: 0,
        };
        let constants = sgp4::Constants::from_elements(&elements).expect("sgp4 constants");
        let (perigee_km, apogee_km) =
            compute_apsides(elements.mean_motion, elements.eccentricity).expect("apsides");
        CatalogEntry {
            norad_id,
            name: format!("TEST-{norad_id}"),
            group: Group::Active,
            constants,
            epoch: elements.datetime.and_utc(),
            perigee_km,
            apogee_km,
        }
    }

    #[test]
    fn screener_detects_co_orbital_close_approach() {
        // Two satellites in an ISS-like orbit, separated only by mean anomaly.
        // 1 km along-track at orbital radius ~6790 km ≈ 0.00845° of mean anomaly,
        // so a 0.005° offset puts them roughly 0.6 km apart — well under 5 km.
        let a = make_test_entry(99990, 270.000);
        let b = make_test_entry(99991, 270.005);
        let catalog = Catalog {
            entries: vec![a, b],
            loaded_at: Utc::now(),
        };
        let now = Utc
            .with_ymd_and_hms(2026, 1, 1, 12, 30, 0)
            .single()
            .expect("valid epoch");
        let events = screen(&catalog, now, Duration::hours(1));

        assert_eq!(
            events.len(),
            1,
            "expected exactly one event for a co-orbital pair, got {}",
            events.len()
        );
        let e = &events[0];
        assert!(
            e.miss_km < THRESHOLD_KM as f32,
            "miss should be < {THRESHOLD_KM} km, got {}",
            e.miss_km
        );
        assert!(
            e.miss_km < 2.0,
            "miss should be near 1 km, got {}",
            e.miss_km
        );
        assert!(
            (e.norad_a == 99990 && e.norad_b == 99991)
                || (e.norad_a == 99991 && e.norad_b == 99990),
            "event should mention both NORAD IDs, got {} ↔ {}",
            e.norad_a,
            e.norad_b
        );
        assert!(
            e.mid_lat_deg.is_finite() && e.mid_lng_deg.is_finite(),
            "midpoint must be finite (lat={}, lng={})",
            e.mid_lat_deg,
            e.mid_lng_deg
        );
    }

    #[test]
    fn screener_returns_empty_for_far_apart_orbits() {
        // ISS-like LEO vs GEO — apsides shells should not overlap, no events emitted.
        let leo = make_test_entry(99990, 270.0);
        let mut geo_elements = sgp4::Elements {
            object_name: Some("GEO".to_string()),
            international_designator: None,
            norad_id: 99992,
            classification: sgp4::Classification::Unclassified,
            datetime: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
            mean_motion_dot: 0.0,
            mean_motion_ddot: 0.0,
            drag_term: 0.0,
            element_set_number: 999,
            inclination: 0.05,
            right_ascension: 0.0,
            eccentricity: 0.0001,
            argument_of_perigee: 0.0,
            mean_anomaly: 0.0,
            mean_motion: 1.0027,
            revolution_number: 0,
            ephemeris_type: 0,
        };
        let constants = sgp4::Constants::from_elements(&geo_elements).expect("constants");
        let (peri, apo) =
            compute_apsides(geo_elements.mean_motion, geo_elements.eccentricity).expect("apsides");
        // Borrow the timestamp from the GEO elements to silence the unused-mut hint.
        geo_elements.mean_motion += 0.0;
        let geo = CatalogEntry {
            norad_id: 99992,
            name: "GEO".into(),
            group: Group::Geo,
            constants,
            epoch: geo_elements.datetime.and_utc(),
            perigee_km: peri,
            apogee_km: apo,
        };

        let catalog = Catalog {
            entries: vec![leo, geo],
            loaded_at: Utc::now(),
        };
        let now = Utc
            .with_ymd_and_hms(2026, 1, 1, 12, 30, 0)
            .single()
            .expect("valid epoch");
        let events = screen(&catalog, now, Duration::hours(2));
        assert!(
            events.is_empty(),
            "LEO and GEO should never conjunct, got {} events",
            events.len()
        );
    }
}
