use std::time::Duration;

use axum::http::HeaderValue;
use tower_http::cors::AllowOrigin;

use crate::downloads::{Refresh, Schedule};

/// Where the catalog is downloaded from unless `CELESTRAK_BASE_URL` says
/// otherwise.
pub const DEFAULT_CELESTRAK_BASE_URL: &str = "https://celestrak.org";

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    /// CelesTrak, or a server that answers like it (a local fake, so local
    /// runs and checks don't download from CelesTrak, which blocks addresses
    /// that download the same data more than once per update).
    pub celestrak_base_url: String,
    /// For local checks only: the first retry's delay (`CATALOG_RETRY_BASE_SECS`,
    /// default 1800). Production leaves it unset.
    pub catalog_retry_base_secs: Option<u64>,
    /// For local checks only: refresh every N seconds instead of daily at
    /// 04:00 UTC (`CATALOG_REFRESH_EVERY_SECS`). Production leaves it unset.
    pub catalog_refresh_every_secs: Option<u64>,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8080);

        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                "http://localhost:5173,http://127.0.0.1:5173".to_string()
            })
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        Self {
            port,
            allowed_origins,
            celestrak_base_url: celestrak_base_url(std::env::var("CELESTRAK_BASE_URL").ok()),
            catalog_retry_base_secs: positive_secs(std::env::var("CATALOG_RETRY_BASE_SECS").ok()),
            catalog_refresh_every_secs: positive_secs(
                std::env::var("CATALOG_REFRESH_EVERY_SECS").ok(),
            ),
        }
    }

    /// When the catalog's groups are retried and refreshed.
    pub fn catalog_schedule(&self) -> Schedule {
        let mut schedule = Schedule::PRODUCTION;
        if let Some(secs) = self.catalog_retry_base_secs {
            schedule.retry_base = Duration::from_secs(secs);
        }
        if let Some(secs) = self.catalog_refresh_every_secs {
            schedule.refresh = Refresh::Every(Duration::from_secs(secs));
        }
        schedule
    }

    pub fn cors_origins(&self) -> AllowOrigin {
        let values: Vec<HeaderValue> = self
            .allowed_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        AllowOrigin::list(values)
    }
}

fn celestrak_base_url(var: Option<String>) -> String {
    var.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CELESTRAK_BASE_URL.to_string())
}

/// A whole number of seconds above zero, or `None`.
fn positive_secs(var: Option<String>) -> Option<u64> {
    var.and_then(|s| s.trim().parse().ok()).filter(|&n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn celestrak_base_url_defaults_to_celestrak() {
        assert_eq!(celestrak_base_url(None), DEFAULT_CELESTRAK_BASE_URL);
        assert_eq!(
            celestrak_base_url(Some("  ".into())),
            DEFAULT_CELESTRAK_BASE_URL
        );
        assert_eq!(
            celestrak_base_url(Some(" http://127.0.0.1:8090 ".into())),
            "http://127.0.0.1:8090"
        );
    }

    #[test]
    fn the_catalog_schedule_is_productions_unless_overridden() {
        assert_eq!(positive_secs(None), None);
        assert_eq!(positive_secs(Some("0".into())), None);
        assert_eq!(positive_secs(Some("ten".into())), None);
        assert_eq!(positive_secs(Some(" 10 ".into())), Some(10));

        let mut cfg = Config {
            port: 8080,
            allowed_origins: vec![],
            celestrak_base_url: DEFAULT_CELESTRAK_BASE_URL.into(),
            catalog_retry_base_secs: None,
            catalog_refresh_every_secs: None,
        };
        let production = cfg.catalog_schedule();
        assert_eq!(production.retry_base, Duration::from_secs(1800));
        assert!(matches!(production.refresh, Refresh::DailyAt { hour: 4 }));

        cfg.catalog_retry_base_secs = Some(10);
        cfg.catalog_refresh_every_secs = Some(120);
        let local = cfg.catalog_schedule();
        assert_eq!(local.retry_base, Duration::from_secs(10));
        assert!(matches!(local.refresh, Refresh::Every(d) if d == Duration::from_secs(120)));
    }
}
