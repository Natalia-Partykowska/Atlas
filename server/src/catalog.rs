use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use tracing::{error, info, warn};

use crate::celestrak::{self, RawEntry, SOURCES};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Iss,
    Station,
    Gps,
    Geo,
    Debris,
    Active,
}

impl Group {
    pub fn as_u8(self) -> u8 {
        match self {
            Group::Iss => 0,
            Group::Station => 1,
            Group::Gps => 2,
            Group::Geo => 3,
            Group::Debris => 4,
            Group::Active => 5,
        }
    }
}

pub struct CatalogEntry {
    pub norad_id: u64,
    pub name: String,
    pub group: Group,
    pub constants: sgp4::Constants,
    pub epoch: DateTime<Utc>,
    pub perigee_km: f32,
    pub apogee_km: f32,
}

pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    pub loaded_at: DateTime<Utc>,
}

impl Catalog {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

pub type SharedCatalog = Arc<ArcSwap<Catalog>>;

/// Fetch every configured CelesTrak group, parse TLEs, build SGP4 constants.
/// Deduplicates by NORAD ID (first occurrence wins — see `SOURCES` ordering).
pub async fn load() -> Result<Catalog> {
    let client = celestrak::build_http_client()?;

    let mut seen: HashSet<u64> = HashSet::new();
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut per_group_counts: Vec<(&str, usize)> = Vec::new();

    for (idx, (group, group_name)) in SOURCES.iter().enumerate() {
        if idx > 0 {
            // CelesTrak free API rate-limits aggressive back-to-back fetches.
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }
        let raw = match celestrak::fetch_group(&client, group_name).await {
            Ok(r) => r,
            Err(e) => {
                warn!(error = ?e, group = group_name, "group fetch failed, skipping");
                continue;
            }
        };

        let before = entries.len();
        for entry in raw {
            match build_entry(&entry, *group) {
                Ok(built) => {
                    if seen.insert(built.norad_id) {
                        entries.push(built);
                    }
                }
                Err(e) => {
                    warn!(error = ?e, name = %entry.name, "skip TLE");
                }
            }
        }
        per_group_counts.push((group_name, entries.len() - before));
    }

    if entries.is_empty() {
        anyhow::bail!("catalog load produced zero entries");
    }

    // Promote ISS to its own group (NORAD ID 25544 is the Zarya module).
    for e in entries.iter_mut() {
        if e.norad_id == 25544 {
            e.group = Group::Iss;
        }
    }

    info!(
        total = entries.len(),
        breakdown = ?per_group_counts,
        "catalog loaded"
    );

    Ok(Catalog {
        entries,
        loaded_at: Utc::now(),
    })
}

fn build_entry(raw: &RawEntry, group: Group) -> Result<CatalogEntry> {
    let elements = sgp4::Elements::from_tle(
        Some(raw.name.clone()),
        raw.line1.as_bytes(),
        raw.line2.as_bytes(),
    )
    .context("parse TLE")?;

    let norad_id = elements.norad_id;
    let epoch = elements.datetime.and_utc();
    let mean_motion_rev_per_day = elements.mean_motion;
    let eccentricity = elements.eccentricity;
    let constants = sgp4::Constants::from_elements(&elements).context("sgp4 constants")?;

    let (perigee_km, apogee_km) = compute_apsides(mean_motion_rev_per_day, eccentricity)
        .context("nonsensical apsides")?;

    Ok(CatalogEntry {
        norad_id,
        name: raw.name.clone(),
        group,
        constants,
        epoch,
        perigee_km,
        apogee_km,
    })
}

/// Compute perigee/apogee altitudes (km) from TLE mean motion (rev/day) and
/// eccentricity. Used by the conjunction-screener apsides pre-filter.
///
/// Returns `None` for non-finite or absurd values (decayed / hyperbolic / bad TLE).
pub(crate) fn compute_apsides(mean_motion_rev_per_day: f64, eccentricity: f64) -> Option<(f32, f32)> {
    const MU_EARTH: f64 = 398_600.4418; // km^3 / s^2
    const R_EARTH: f64 = 6378.137; // km

    let n_rad_per_sec = mean_motion_rev_per_day * std::f64::consts::TAU / 86_400.0;
    if !n_rad_per_sec.is_finite() || n_rad_per_sec <= 0.0 {
        return None;
    }
    if !eccentricity.is_finite() || !(0.0..1.0).contains(&eccentricity) {
        return None;
    }

    let a_km = (MU_EARTH / n_rad_per_sec.powi(2)).powf(1.0 / 3.0);
    let perigee = (a_km * (1.0 - eccentricity) - R_EARTH) as f32;
    let apogee = (a_km * (1.0 + eccentricity) - R_EARTH) as f32;

    if !perigee.is_finite() || !apogee.is_finite() || perigee < -200.0 || apogee > 1_000_000.0 {
        return None;
    }
    Some((perigee, apogee))
}

/// Spawn a task that reloads the catalog every day at ~04:00 UTC and swaps it
/// atomically into `shared`.
pub fn spawn_daily_refresh(shared: SharedCatalog) {
    tokio::spawn(async move {
        loop {
            let sleep_secs = seconds_until_next_0400_utc();
            info!(sleep_secs, "next TLE refresh scheduled");
            tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)).await;

            match load().await {
                Ok(fresh) => {
                    let n = fresh.len();
                    shared.store(Arc::new(fresh));
                    info!(entries = n, "catalog refreshed");
                }
                Err(e) => {
                    error!(error = ?e, "catalog refresh failed; keeping previous catalog");
                }
            }
        }
    });
}

fn seconds_until_next_0400_utc() -> u64 {
    let now = Utc::now();
    let today_0400 = now
        .date_naive()
        .and_hms_opt(4, 0, 0)
        .expect("04:00:00 is a valid time")
        .and_utc();
    let target = if now < today_0400 {
        today_0400
    } else {
        today_0400 + Duration::days(1)
    };
    (target - now).num_seconds().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iss_apsides_match_real_orbit() {
        // ISS: ~15.5 rev/day, near-circular ~412 km altitude.
        let (peri, apo) = compute_apsides(15.5, 0.0001).expect("ISS is a valid orbit");
        assert!((peri - apo).abs() < 5.0, "ISS is near-circular: peri={peri}, apo={apo}");
        assert!(
            (380.0..=440.0).contains(&peri),
            "ISS perigee in 380..440 km, got {peri}"
        );
    }

    #[test]
    fn geo_apsides_match_real_orbit() {
        // GEO: ~1.0027 rev/day, eccentricity ~0.
        let (peri, apo) = compute_apsides(1.0027, 0.0).expect("GEO is a valid orbit");
        assert!(
            (35_700.0..=35_900.0).contains(&peri),
            "GEO peri ~35786 km, got {peri}"
        );
        assert!(
            (peri - apo).abs() < 1.0,
            "GEO is circular: peri={peri}, apo={apo}"
        );
    }

    #[test]
    fn molniya_apsides_match_real_orbit() {
        // Molniya: 12-hour orbit (~2 rev/day), e ~0.74.
        let (peri, apo) = compute_apsides(2.0, 0.74).expect("Molniya is a valid orbit");
        assert!(
            (300.0..=900.0).contains(&peri),
            "Molniya peri ~600 km, got {peri}"
        );
        assert!(
            (39_000.0..=41_000.0).contains(&apo),
            "Molniya apo ~40000 km, got {apo}"
        );
    }

    #[test]
    fn leo_geo_shells_do_not_overlap() {
        // LEO and GEO shells must be far apart — guards the apsides pre-filter.
        let (leo_peri, leo_apo) = compute_apsides(15.5, 0.0001).unwrap();
        let (geo_peri, geo_apo) = compute_apsides(1.0027, 0.0).unwrap();
        let peri_gap = (leo_peri - geo_peri).abs();
        let apo_gap = (leo_apo - geo_apo).abs();
        assert!(
            peri_gap > 30_000.0,
            "LEO/GEO perigee shells must be >30 000 km apart, got {peri_gap}"
        );
        assert!(
            apo_gap > 30_000.0,
            "LEO/GEO apogee shells must be >30 000 km apart, got {apo_gap}"
        );
    }

    #[test]
    fn rejects_invalid_inputs() {
        assert!(compute_apsides(0.0, 0.0).is_none(), "zero mean motion");
        assert!(compute_apsides(-1.0, 0.0).is_none(), "negative mean motion");
        assert!(
            compute_apsides(15.5, 1.5).is_none(),
            "hyperbolic eccentricity"
        );
        assert!(
            compute_apsides(f64::NAN, 0.0).is_none(),
            "NaN mean motion"
        );
    }
}
