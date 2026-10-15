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

#[derive(Debug)]
pub struct RawEntry {
    pub name: String,
    pub line1: String,
    pub line2: String,
}

/// Downloads TLE groups from CelesTrak, or from any server that answers the
/// same `gp.php` query: a local fake in tests and local runs, so they don't
/// download from CelesTrak (see `CELESTRAK_BASE_URL` in `config.rs`).
#[derive(Clone)]
pub struct CelesTrak {
    client: reqwest::Client,
    base_url: String,
}

impl CelesTrak {
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(Self {
            client: build_http_client()?,
            base_url: base_url.trim_end_matches('/').to_string(),
        })
    }

    pub async fn fetch_group(&self, group_name: &str) -> Result<Vec<RawEntry>> {
        let url = format!(
            "{}/NORAD/elements/gp.php?GROUP={}&FORMAT=tle",
            self.base_url, group_name
        );
        let body = self
            .client
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
}

fn parse_tle_text(body: &str) -> Result<Vec<RawEntry>> {
    let lines: Vec<&str> = body.lines().map(str::trim_end).collect();
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

    // A 2xx answer with no TLEs (a notice, an error page, an empty body) is a
    // failed download, not a group with no satellites, or it would empty the
    // group in the catalog.
    if out.is_empty() {
        return Err(anyhow!("no TLEs in response: {:?}", snippet(body)));
    }
    debug!(count = out.len(), "parsed TLE triplets");
    Ok(out)
}

/// The start of an answer, on one line, for an error message.
fn snippet(body: &str) -> String {
    const MAX_CHARS: usize = 120;
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &flat[..cut]),
        None => flat,
    }
}

fn build_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .gzip(true)
        // CelesTrak can take 12–25 s before the first byte (measured 2026-10-05)
        // and `active` (~2.7 MB, uncompressed) took 31 s end to end, so the old
        // 30 s total silently dropped it from the catalog. The limit covers the
        // whole response, body included.
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("build reqwest client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::RawQuery, http::StatusCode, routing::get, Router};
    use std::sync::{Arc, Mutex};

    const ISS_TLE: &str = "ISS (ZARYA)\n\
        1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991\n\
        2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590\n";

    /// A stand-in for CelesTrak on a free local port that answers every
    /// `gp.php` request with `status` and `body`. Returns its base URL and the
    /// query strings it was asked for.
    async fn fake_celestrak(
        status: StatusCode,
        body: &'static str,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let queries = Arc::new(Mutex::new(Vec::new()));
        let log = queries.clone();
        let app = Router::new().route(
            "/NORAD/elements/gp.php",
            get(move |RawQuery(query): RawQuery| {
                let log = log.clone();
                async move {
                    log.lock().unwrap().push(query.unwrap_or_default());
                    (status, body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, queries)
    }

    #[tokio::test]
    async fn fetches_a_group_from_the_configured_url() {
        let (base, queries) = fake_celestrak(StatusCode::OK, ISS_TLE).await;
        // A trailing slash in the configured URL doesn't double up.
        let celestrak = CelesTrak::new(&format!("{base}/")).unwrap();

        let entries = celestrak.fetch_group("gps-ops").await.unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "ISS (ZARYA)");
        assert!(entries[0].line1.starts_with("1 25544U"));
        assert_eq!(*queries.lock().unwrap(), ["GROUP=gps-ops&FORMAT=tle"]);
    }

    #[tokio::test]
    async fn a_non_2xx_answer_is_an_error() {
        let (base, _) = fake_celestrak(StatusCode::SERVICE_UNAVAILABLE, "busy").await;
        let err = CelesTrak::new(&base)
            .unwrap()
            .fetch_group("active")
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("503"), "{err:#}");
    }

    #[tokio::test]
    async fn an_answer_without_tles_is_an_error() {
        // CelesTrak can answer 200 with a notice instead of data. Treating it
        // as a group with no satellites would empty that group.
        let notice = "GP data has not updated since your last successful download \
                      of GROUP=active at 2026-10-12 04:00:41 UTC.\n\
                      Data is updated once every 2 hours.\n";
        let (base, _) = fake_celestrak(StatusCode::OK, notice).await;
        let err = CelesTrak::new(&base)
            .unwrap()
            .fetch_group("active")
            .await
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("no TLEs"), "{msg}");
        assert!(
            msg.contains("GP data has not updated"),
            "the error quotes the answer: {msg}"
        );
    }

    #[test]
    fn an_empty_body_is_an_error() {
        assert!(parse_tle_text("").is_err());
        assert!(parse_tle_text("\n\n").is_err());
    }

    #[test]
    fn a_long_answer_is_quoted_in_short() {
        let long = "x ".repeat(500);
        let quoted = snippet(&long);
        let chars = quoted.chars().count();
        assert!(chars <= 121, "{chars} chars");
        assert!(quoted.ends_with('…'));
        assert_eq!(snippet("two\n  lines"), "two lines");
    }
}
