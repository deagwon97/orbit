use super::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

pub async fn attach(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    match state.registry.get_session(&id) {
        Ok(session) if session.mode == orb_common::SessionMode::Web => ws
            .on_upgrade(move |socket| handle(socket, state, id))
            .into_response(),
        Ok(_) => (StatusCode::BAD_REQUEST, "This session uses CLI mode").into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}
async fn handle(mut socket: WebSocket, state: AppState, id: String) {
    let connection = match state.registry.codex_session(&id).await {
        Ok(connection) => connection,
        Err(error) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":format!("{error:#}")}).to_string(),
                ))
                .await;
            return;
        }
    };
    // Subscribe before reading snapshots; the UI merges any newer notifications by item ID.
    let mut events = connection.events.subscribe();
    let (mut send, mut receive) = socket.split();
    let _ = send
        .send(Message::Text(
            json!({"type":"ready","state":connection.snapshot()}).to_string(),
        ))
        .await;
    loop {
        let outgoing = tokio::select! {
            event = events.recv() => match event {
                Ok(event) => { if event["type"] == "drain" { continue; } event },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => json!({"type":"resync"}),
                Err(_) => break,
            },
            message = receive.next() => {
                let Some(Ok(Message::Text(text))) = message else { break; };
                if text.len() > 256_000 { break; }
                let Ok(body) = serde_json::from_str::<Value>(&text) else { continue; };
                let allowed = state.registry.get_session(&id).map(|session| crate::codex::CodexSession::read_operation(&body) || session.status == orb_common::SessionStatus::Running).unwrap_or(false);
                if !allowed {
                    if send.send(Message::Text(json!({"type":"error","id":body["id"],"error":"This session is stopped or removed"}).to_string())).await.is_err() { break; }
                    continue;
                }
                // Mark before submitting: after a crash, an attempted input must never be mistaken for an empty conversation.
                if ["send", "steer", "queue"].contains(&body["op"].as_str().unwrap_or("")) || (body["op"] == "command" && body["command"].as_str().is_some_and(|c| c.trim() == "/compact" || c.starts_with("/review"))) {
                    if let Err(error) = state.registry.mark_web_input(&id) {
                        if send.send(Message::Text(json!({"type":"error","id":body["id"],"error":error.to_string()}).to_string())).await.is_err() { break; }
                        continue;
                    }
                }
                match connection.operation(&body).await {
                    Ok(result) => json!({"type":"result","id":body["id"],"op":body["op"],"result":result}),
                    Err(error) => json!({"type":"error","id":body["id"],"error":format!("{error:#}")}),
                }
            }
        };
        let disconnected = outgoing["type"] == "disconnected";
        if send
            .send(Message::Text(outgoing.to_string()))
            .await
            .is_err()
            || disconnected
        {
            break;
        }
    }
    // Dropping a browser connection does not stop the turn or the shared daemon.
}

fn image_session(
    state: &AppState,
    id: &str,
    upload: bool,
) -> Result<orb_common::Session, (StatusCode, String)> {
    let session = state
        .registry
        .get_session(id)
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if session.mode != orb_common::SessionMode::Web
        || session.tool != "codex"
        || (upload && session.status != orb_common::SessionStatus::Running)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "실행 중인 Codex Web 세션에만 첨부할 수 있습니다.".into(),
        ));
    }
    Ok(session)
}
pub async fn upload_image(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    bytes: axum::body::Bytes,
) -> Response {
    let session = match image_session(&state, &id, true) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let mime = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    match tokio::task::spawn_blocking(move || crate::images::save(&session.id, &mime, &bytes)).await
    {
        Ok(Ok(value)) => axum::Json(value).into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error":e.to_string()})),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
pub async fn read_image(
    State(state): State<AppState>,
    Path((id, image)): Path<(String, String)>,
) -> Response {
    let session = match image_session(&state, &id, false) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let mime = match crate::images::mime(&image) {
        Ok(m) => m,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match tokio::task::spawn_blocking(move || crate::images::read(&session.id, &image)).await {
        Ok(Ok(bytes)) => (
            [
                ("content-type", mime),
                ("x-content-type-options", "nosniff"),
                ("cache-control", "private, no-store"),
            ],
            bytes,
        )
            .into_response(),
        _ => (
            StatusCode::NOT_FOUND,
            "임시 이미지를 찾을 수 없습니다. 다시 첨부하세요.",
        )
            .into_response(),
    }
}
