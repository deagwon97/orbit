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
