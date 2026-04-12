use axum::http::HeaderValue;
use tower_http::cors::AllowOrigin;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub allowed_origins: Vec<String>,
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
