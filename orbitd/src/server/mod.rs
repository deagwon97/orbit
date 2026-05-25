pub mod api;
pub mod ws;

use crate::{auth::token::TokenConfig, session::registry::SessionRegistry};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<SessionRegistry>,
    pub token: Arc<TokenConfig>,
}

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/api/v1/sessions",
            post(api::create_session).get(api::list_sessions),
        )
        .route(
            "/api/v1/sessions/:id",
            get(api::get_session).delete(api::delete_session),
        )
        .route("/api/v1/sessions/:id/stop", post(api::stop_session))
        .route("/api/v1/sessions/:id/logs", get(api::get_logs))
        .route("/api/v1/sessions/:id/attach", get(ws::attach))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth))
}

async fn auth(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.uri().path() == "/healthz" {
        return Ok(next.run(req).await);
    }
    let header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if state.token.validate_header(header) {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}
