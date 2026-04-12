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

    for (group, group_name) in SOURCES {
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
    let constants = sgp4::Constants::from_elements(&elements).context("sgp4 constants")?;

    Ok(CatalogEntry {
        norad_id,
        name: raw.name.clone(),
        group,
        constants,
    })
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
