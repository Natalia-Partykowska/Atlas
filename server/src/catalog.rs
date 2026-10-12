use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{info, warn};

use crate::celestrak::{RawEntry, SOURCES};

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

#[derive(Clone)]
pub struct CatalogEntry {
    pub norad_id: u64,
    pub name: String,
    pub group: Group,
    pub constants: sgp4::Constants,
    pub epoch: DateTime<Utc>,
    pub perigee_km: f32,
    pub apogee_km: f32,
    pub line1: String,
    pub line2: String,
    pub intl_designator: String,
}

/// The catalog the server propagates and serves, assembled from the groups'
/// downloads (see `assemble`).
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    /// When it was assembled.
    pub loaded_at: DateTime<Utc>,
    /// Changes with every assembly and only grows: the assembly time in ms,
    /// or the previous version + 1 if that isn't later.
    pub version: u64,
}

impl Catalog {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

pub type SharedCatalog = Arc<ArcSwap<Catalog>>;

/// Where a `SOURCES` group stands after its downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupStatus {
    /// The last download worked.
    Fresh,
    /// The last download failed; the satellites are from an earlier one.
    Stale,
    /// No download has worked yet, so its satellites are absent.
    Missing,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub at: DateTime<Utc>,
    pub error: String,
}

/// One `SOURCES` group: the satellites of its last good download, and the
/// failure if the latest download failed.
pub struct GroupSlot {
    pub name: &'static str,
    pub group: Group,
    loaded: Option<(Vec<CatalogEntry>, DateTime<Utc>)>,
    failure: Option<Failure>,
}

impl GroupSlot {
    pub fn status(&self) -> GroupStatus {
        match (&self.loaded, &self.failure) {
            (None, _) => GroupStatus::Missing,
            (Some(_), Some(_)) => GroupStatus::Stale,
            (Some(_), None) => GroupStatus::Fresh,
        }
    }

    pub fn entries(&self) -> &[CatalogEntry] {
        self.loaded.as_ref().map_or(&[], |(entries, _)| entries)
    }

    /// When the satellites it holds were downloaded.
    pub fn loaded_at(&self) -> Option<DateTime<Utc>> {
        self.loaded.as_ref().map(|(_, at)| *at)
    }

    /// The latest download's failure, if it failed.
    pub fn failure(&self) -> Option<&Failure> {
        self.failure.as_ref()
    }
}

/// Every group's downloads, kept so that a failed download never removes a
/// group's satellites from the catalog: the catalog is re-assembled from the
/// store after each download pass.
pub struct GroupStore {
    slots: Vec<GroupSlot>,
}

impl GroupStore {
    pub fn new() -> Self {
        Self {
            slots: SOURCES
                .iter()
                .map(|&(group, name)| GroupSlot {
                    name,
                    group,
                    loaded: None,
                    failure: None,
                })
                .collect(),
        }
    }

    /// In `SOURCES` order.
    pub fn slots(&self) -> &[GroupSlot] {
        &self.slots
    }

    /// Records one download of `SOURCES[idx]`. A download with no usable TLE
    /// counts as failed. Returns whether the group's satellites changed.
    pub fn record(
        &mut self,
        idx: usize,
        download: Result<Vec<RawEntry>>,
        now: DateTime<Utc>,
    ) -> bool {
        let slot = &mut self.slots[idx];
        let built = download.and_then(|raw| {
            let total = raw.len();
            let entries: Vec<CatalogEntry> = raw
                .iter()
                .filter_map(|r| match build_entry(r, slot.group) {
                    Ok(entry) => Some(entry),
                    Err(e) => {
                        warn!(error = ?e, name = %r.name, "skip TLE");
                        None
                    }
                })
                .collect();
            if entries.is_empty() {
                anyhow::bail!("none of the {total} TLEs could be used");
            }
            Ok(entries)
        });

        match built {
            Ok(entries) => {
                if slot.failure.is_some() {
                    info!(group = slot.name, entries = entries.len(), "group restored");
                }
                slot.loaded = Some((entries, now));
                slot.failure = None;
                true
            }
            Err(e) => {
                let error = format!("{e:#}");
                match slot.entries().len() {
                    0 => {
                        warn!(group = slot.name, %error, "group download failed; it has no satellites yet")
                    }
                    kept => {
                        warn!(group = slot.name, %error, kept, "group download failed; keeping its previous satellites")
                    }
                }
                slot.failure = Some(Failure { at: now, error });
                false
            }
        }
    }

    /// True when no group is missing. A stale group still has all its
    /// satellites, so it doesn't make the catalog incomplete.
    pub fn is_complete(&self) -> bool {
        self.missing().next().is_none()
    }

    pub fn missing(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.slots
            .iter()
            .filter(|s| s.status() == GroupStatus::Missing)
            .map(|s| s.name)
    }
}

/// What `/health` and the stream report about the catalog. Published by the
/// maintenance task after every download pass (`downloads.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogStatus {
    /// The served catalog's `version`.
    pub version: u64,
    /// When missing or stale groups are downloaded again; `None` when every
    /// group is fresh.
    pub next_retry_at: Option<DateTime<Utc>>,
    /// In `SOURCES` order.
    pub groups: Vec<GroupReport>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupReport {
    pub name: &'static str,
    pub status: GroupStatus,
    /// Satellites in its last good download (before de-duplication).
    pub entries: usize,
    pub loaded_at: Option<DateTime<Utc>>,
    /// Why the latest download failed, if it did.
    pub failure: Option<Failure>,
}

pub type CatalogStatusRx = tokio::sync::watch::Receiver<CatalogStatus>;

impl CatalogStatus {
    pub fn of(store: &GroupStore, version: u64, next_retry_at: Option<DateTime<Utc>>) -> Self {
        Self {
            version,
            next_retry_at,
            groups: store
                .slots()
                .iter()
                .map(|slot| GroupReport {
                    name: slot.name,
                    status: slot.status(),
                    entries: slot.entries().len(),
                    loaded_at: slot.loaded_at(),
                    failure: slot.failure().cloned(),
                })
                .collect(),
        }
    }

    /// Groups with no satellites in the catalog. A stale group still has
    /// its satellites, so it isn't missing.
    pub fn missing(&self) -> Vec<&'static str> {
        self.groups
            .iter()
            .filter(|g| g.status == GroupStatus::Missing)
            .map(|g| g.name)
            .collect()
    }

    pub fn is_complete(&self) -> bool {
        self.missing().is_empty()
    }
}

/// Builds the catalog from every group's satellites, in `SOURCES` order. A
/// satellite listed by several groups keeps the first one (stations, GPS, GEO
/// and the debris fields before the catch-all `active`), whether that group is
/// fresh or stale.
pub fn assemble(store: &GroupStore, prev_version: u64, now: DateTime<Utc>) -> Catalog {
    let mut seen: HashSet<u64> = HashSet::new();
    let mut entries: Vec<CatalogEntry> = Vec::new();
    let mut breakdown: Vec<(&str, usize)> = Vec::new();

    for slot in store.slots() {
        let before = entries.len();
        for entry in slot.entries() {
            if seen.insert(entry.norad_id) {
                entries.push(entry.clone());
            }
        }
        breakdown.push((slot.name, entries.len() - before));
    }

    // Promote ISS to its own group (NORAD ID 25544 is the Zarya module).
    for e in entries.iter_mut() {
        if e.norad_id == 25544 {
            e.group = Group::Iss;
        }
    }

    let version = (now.timestamp_millis().max(0) as u64).max(prev_version + 1);
    let missing: Vec<&str> = store.missing().collect();
    let stale: Vec<&str> = store
        .slots()
        .iter()
        .filter(|s| s.status() == GroupStatus::Stale)
        .map(|s| s.name)
        .collect();
    info!(
        total = entries.len(),
        version,
        ?missing,
        ?stale,
        ?breakdown,
        "catalog assembled"
    );

    Catalog {
        entries,
        loaded_at: now,
        version,
    }
}

/// The catalog to start with. Fails when no group produced a satellite: the
/// server has nothing to serve.
pub fn initial_catalog(store: &GroupStore, now: DateTime<Utc>) -> Result<Catalog> {
    let catalog = assemble(store, 0, now);
    if catalog.entries.is_empty() {
        anyhow::bail!("catalog load produced zero entries");
    }
    Ok(catalog)
}

pub(crate) fn build_entry(raw: &RawEntry, group: Group) -> Result<CatalogEntry> {
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

    let intl_designator = raw
        .line1
        .get(9..17)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    Ok(CatalogEntry {
        norad_id,
        name: raw.name.clone(),
        group,
        constants,
        epoch,
        perigee_km,
        apogee_km,
        line1: raw.line1.clone(),
        line2: raw.line2.clone(),
        intl_designator,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::tle;
    use anyhow::anyhow;
    use chrono::{Duration, TimeZone};

    // ── Per-group store ─────────────────────────────────────────────────────

    fn ok(norads: &[u32]) -> Result<Vec<RawEntry>> {
        Ok(norads.iter().map(|&n| tle(n)).collect())
    }

    fn failed() -> Result<Vec<RawEntry>> {
        Err(anyhow!("non-2xx from celestrak: 503 Service Unavailable"))
    }

    /// `hours` after midnight UTC on 2026-10-12 (28 is 04:00 the next day).
    fn at(hours: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 12, 0, 0, 0).unwrap() + Duration::hours(hours)
    }

    fn idx(name: &str) -> usize {
        SOURCES.iter().position(|(_, n)| *n == name).unwrap()
    }

    fn norads(catalog: &Catalog) -> Vec<u64> {
        let mut ids: Vec<u64> = catalog.entries.iter().map(|e| e.norad_id).collect();
        ids.sort_unstable();
        ids
    }

    /// Every group downloaded once, `active` with `active`.
    fn full_store(active: &[u32]) -> GroupStore {
        let mut store = GroupStore::new();
        for (i, (_, name)) in SOURCES.iter().enumerate() {
            let download = if *name == "active" {
                ok(active)
            } else {
                ok(&[10_000 + i as u32])
            };
            store.record(i, download, at(4));
        }
        store
    }

    #[test]
    fn a_group_never_downloaded_is_missing() {
        let mut store = GroupStore::new();
        assert!(store
            .slots()
            .iter()
            .all(|s| s.status() == GroupStatus::Missing));

        store.record(idx("stations"), ok(&[25544]), at(4));
        store.record(idx("active"), failed(), at(4));

        let active = &store.slots()[idx("active")];
        assert_eq!(active.status(), GroupStatus::Missing);
        assert!(active.entries().is_empty());
        assert_eq!(active.loaded_at(), None);
        let failure = active.failure().expect("the failure is kept");
        assert_eq!(failure.at, at(4));
        assert!(failure.error.contains("503"), "{}", failure.error);

        assert!(!store.is_complete());
        assert!(store.missing().any(|name| name == "active"));
        assert_eq!(norads(&assemble(&store, 0, at(4))), [25544]);
    }

    #[test]
    fn a_failed_download_keeps_the_groups_previous_satellites() {
        let mut store = full_store(&[1, 2, 3]);
        let before = assemble(&store, 0, at(4));

        // The next day's refresh fails for `active`.
        store.record(idx("active"), failed(), at(28));

        let active = &store.slots()[idx("active")];
        assert_eq!(active.status(), GroupStatus::Stale);
        assert_eq!(active.entries().len(), 3);
        assert_eq!(
            active.loaded_at(),
            Some(at(4)),
            "loaded_at is the last good download"
        );
        assert_eq!(active.failure().unwrap().at, at(28));
        // Stale isn't missing: every satellite is still there.
        assert!(store.is_complete());
        assert_eq!(
            norads(&assemble(&store, before.version, at(28))),
            norads(&before)
        );
    }

    #[test]
    fn a_stale_group_is_fresh_again_after_a_download() {
        let mut store = full_store(&[1, 2, 3]);
        store.record(idx("active"), failed(), at(28));
        store.record(idx("active"), ok(&[1, 2, 3, 4]), at(29));

        let active = &store.slots()[idx("active")];
        assert_eq!(active.status(), GroupStatus::Fresh);
        assert!(active.failure().is_none());
        assert_eq!(active.loaded_at(), Some(at(29)));
        assert_eq!(active.entries().len(), 4);
    }

    #[test]
    fn the_status_reports_each_group_and_what_is_missing() {
        let mut store = full_store(&[1000]);
        store.record(idx("stations"), failed(), at(5));
        let mut fresh_store = GroupStore::new();
        fresh_store.record(idx("gps-ops"), ok(&[200]), at(1));

        let status = CatalogStatus::of(&store, 7, Some(at(6)));
        assert_eq!(status.version, 7);
        assert_eq!(status.next_retry_at, Some(at(6)));
        assert!(status.missing().is_empty(), "a stale group isn't missing");
        assert!(status.is_complete());
        let stations = &status.groups[idx("stations")];
        assert_eq!(stations.status, GroupStatus::Stale);
        assert_eq!(
            stations.entries,
            store.slots()[idx("stations")].entries().len()
        );
        assert_eq!(stations.loaded_at, Some(at(4)));
        assert_eq!(stations.failure.as_ref().map(|f| f.at), Some(at(5)));
        let active = &status.groups[idx("active")];
        assert_eq!(
            (active.status, active.entries, active.failure.is_none()),
            (GroupStatus::Fresh, 1, true)
        );

        let partial = CatalogStatus::of(&fresh_store, 8, None);
        assert_eq!(partial.groups.len(), SOURCES.len());
        assert_eq!(
            partial.missing(),
            [
                "stations",
                "geo",
                "cosmos-1408-debris",
                "fengyun-1c-debris",
                "iridium-33-debris",
                "active"
            ]
        );
        assert!(!partial.is_complete());
    }

    #[test]
    fn a_download_with_no_valid_tles_counts_as_failed() {
        let mut store = full_store(&[1, 2, 3]);
        let mut broken = tle(4);
        broken.line2.replace_range(
            68..69,
            if broken.line2.ends_with('0') {
                "1"
            } else {
                "0"
            },
        );

        store.record(idx("active"), Ok(vec![broken]), at(28));

        let active = &store.slots()[idx("active")];
        assert_eq!(active.status(), GroupStatus::Stale);
        assert_eq!(active.entries().len(), 3);
    }

    #[test]
    fn a_satellite_stays_in_the_first_group_that_lists_it_even_when_that_group_is_stale() {
        let mut store = GroupStore::new();
        store.record(idx("stations"), ok(&[25544, 49044]), at(4));
        store.record(idx("active"), ok(&[25544, 49044, 1, 1]), at(4));
        store.record(idx("stations"), failed(), at(28));

        let catalog = assemble(&store, 0, at(28));
        assert_eq!(
            norads(&catalog),
            [1, 25544, 49044],
            "duplicates appear once"
        );
        let group_of = |id| {
            catalog
                .entries
                .iter()
                .find(|e| e.norad_id == id)
                .unwrap()
                .group
        };
        assert_eq!(group_of(49044), Group::Station);
        assert_eq!(group_of(1), Group::Active);
        // The ISS (NORAD 25544, the Zarya module) gets its own group.
        assert_eq!(group_of(25544), Group::Iss);
    }

    #[test]
    fn a_catalog_with_no_satellites_is_an_error_at_boot() {
        let mut store = GroupStore::new();
        for i in 0..SOURCES.len() {
            store.record(i, failed(), at(4));
        }
        assert!(initial_catalog(&store, at(4)).is_err());

        store.record(idx("gps-ops"), ok(&[24876]), at(4));
        assert_eq!(norads(&initial_catalog(&store, at(4)).unwrap()), [24876]);
    }

    #[test]
    fn the_catalog_version_always_increases() {
        let store = full_store(&[1]);
        let first = assemble(&store, 0, at(4));
        assert_eq!(first.version, at(4).timestamp_millis() as u64);
        // Two assemblies in the same millisecond still get different versions.
        let second = assemble(&store, first.version, at(4));
        assert_eq!(second.version, first.version + 1);
        // A clock that steps back doesn't take the version with it.
        let third = assemble(&store, second.version, at(3));
        assert_eq!(third.version, second.version + 1);
    }

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
