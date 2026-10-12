use axum::http::HeaderValue;
use tower_http::cors::AllowOrigin;

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
        }
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
}
