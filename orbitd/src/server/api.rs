use super::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use orb_common::{CreateSessionRequest, ListSessionsQuery, LogsQuery, LogsResponse, StopRequest};

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Response {
    match state.registry.create_session(req) {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, format!("{err:#}")).into_response(),
    }
}

pub async fn list_sessions(
    State(state): State<AppState>,
    Query(query): Query<ListSessionsQuery>,
) -> Response {
    match state.registry.list_sessions(query) {
        Ok(sessions) => Json(sessions).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn get_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.registry.get_session(&id) {
        Ok(session) => Json(session).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

pub async fn stop_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(_req): Json<StopRequest>,
) -> Response {
    match state.registry.stop_session(&id) {
        Ok(session) => Json(session).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

pub async fn delete_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.registry.delete_session(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }
}

pub async fn get_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Response {
    match state.registry.logs(&id, query.tail.unwrap_or(0)) {
        Ok(lines) => Json(LogsResponse { lines }).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}
