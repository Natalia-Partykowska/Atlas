use anyhow::{anyhow, Context, Result};
use tracing::{debug, warn};

use crate::catalog::Group;

/// CelesTrak GP element endpoints we pull for the v1 catalog.
///
/// Order matters: earlier entries win during deduplication so that more specific
/// groups (stations, GPS, GEO, named debris fields) take precedence over the
/// catch-all `active` group.
pub const SOURCES: &[(Group, &str)] = &[
    (Group::Station, "stations"),
    (Group::Gps, "gps-ops"),
    (Group::Geo, "geo"),
    (Group::Debris, "cosmos-1408-debris"),
    (Group::Debris, "fengyun-1c-debris"),
    (Group::Debris, "iridium-33-debris"),
    (Group::Active, "active"),
];

const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (compatible; atlas-orbit/",
    env!("CARGO_PKG_VERSION"),
    "; +https://github.com/Natalia-Partykowska)"
);

pub struct RawEntry {
    pub name: String,
    pub line1: String,
    pub line2: String,
}

pub async fn fetch_group(client: &reqwest::Client, group_name: &str) -> Result<Vec<RawEntry>> {
    let url = format!(
        "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle",
        group_name
    );
    let body = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("non-2xx from {url}"))?
        .text()
        .await
        .context("read response body")?;

    parse_tle_text(&body).with_context(|| format!("parse TLE body from {group_name}"))
}

fn parse_tle_text(body: &str) -> Result<Vec<RawEntry>> {
    let lines: Vec<&str> = body.lines().map(str::trim_end).collect();
    if lines.is_empty() {
        return Err(anyhow!("empty TLE response"));
    }

    let mut out = Vec::with_capacity(lines.len() / 3);
    let mut i = 0;
    while i + 2 < lines.len() {
        let name_line = lines[i];
        let line1 = lines[i + 1];
        let line2 = lines[i + 2];

        if !line1.starts_with("1 ") || !line2.starts_with("2 ") {
            warn!(
                name = %name_line,
                "skipping malformed TLE triplet at line {}",
                i
            );
            i += 1;
            continue;
        }

        out.push(RawEntry {
            name: name_line.trim().to_string(),
            line1: line1.to_string(),
            line2: line2.to_string(),
        });
        i += 3;
    }

    debug!(count = out.len(), "parsed TLE triplets");
    Ok(out)
}

pub fn build_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .gzip(true)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("build reqwest client")
}
