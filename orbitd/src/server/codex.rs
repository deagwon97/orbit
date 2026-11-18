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
    let mut operations = tokio::task::JoinSet::<Value>::new();
    loop {
        let outgoing = tokio::select! {
            completed=operations.join_next(), if !operations.is_empty() => match completed {
                Some(Ok(value))=>value,
                _=>json!({"type":"resync"}),
            },
            event = events.recv() => match event {
                Ok(event) => { if event["type"] == "drain" { continue; } event },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => json!({"type":"resync"}),
                Err(_) => break,
            },
            message = receive.next() => {
                let Some(Ok(Message::Text(text))) = message else { break; };
                if text.len() > 256_000 { break; }
                let Ok(body) = serde_json::from_str::<Value>(&text) else { continue; };
                let resume_arg = if body["op"]=="command" { body["command"].as_str().and_then(|text|text.trim().strip_prefix("/resume")).filter(|tail|tail.is_empty() || tail.starts_with(char::is_whitespace)).map(str::trim) } else { None };
                let resume_id=resume_arg.filter(|arg|uuid::Uuid::parse_str(arg).is_ok());
                let allowed = state.registry.get_session(&id).map(|session| resume_arg.is_some() || crate::codex::CodexSession::read_operation(&body) || session.status == orb_common::SessionStatus::Running).unwrap_or(false);
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
                if let Some(thread_id)=resume_id {
                    // Switching is idle-only and must deliver its result before the old
                    // connection's disconnected event, so keep this operation ordered.
                    match state.registry.resume_web_thread(&id,thread_id).await {
                        Ok(session)=>json!({"type":"result","id":body["id"],"op":body["op"],"result":{"type":"resumeOpened","session":session}}),
                        Err(error)=>json!({"type":"error","id":body["id"],"error":format!("{error:#}")}),
                    }
                } else {
                    if operations.len()>=32 {
                        json!({"type":"error","id":body["id"],"error":"요청이 너무 많습니다. 잠시 후 다시 시도하세요."})
                    } else {
                        let connection=connection.clone();
                        let mut operation=Box::pin(async move {
                            match connection.operation(&body).await {
                                Ok(result)=>json!({"type":"result","id":body["id"],"op":body["op"],"result":result}),
                                Err(error)=>json!({"type":"error","id":body["id"],"error":format!("{error:#}")}),
                            }
                        });
                        // Poll admission in receive order before detaching the RPC wait.
                        // This preserves FIFO input ordering while still streaming events.
                        match futures_util::poll!(operation.as_mut()) {
                            std::task::Poll::Ready(value)=>value,
                            std::task::Poll::Pending=>{operations.spawn(operation);continue;}
                        }
                    }
                }
            }
        };
        let disconnected =
            outgoing["type"] == "disconnected" || outgoing["result"]["type"] == "resumeOpened";
        if send
            .send(Message::Text(outgoing.to_string()))
            .await
            .is_err()
            || disconnected
        {
            break;
        }
    }
    // Complete already accepted requests even if the browser closes; never cancel an
    // in-flight turn/start and accidentally drain queued inputs before it resolves.
    operations.detach_all();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    #[tokio::test]
    async fn pending_rpc_does_not_block_progress_or_acceptance_of_later_inputs() {
        let fixture = crate::codex::tests::fixture().await;
        let mut config = crate::config::Config::default();
        config.codex_socket = fixture.socket.clone();
        config.data_dir = fixture.directory.join("data");
        config.audit_path = fixture.directory.join("audit");
        let db = Arc::new(crate::db::Db::open().unwrap());
        db.migrate().unwrap();
        let registry = Arc::new(crate::session::registry::SessionRegistry::new(db, config));
        let session = registry
            .create_session(
                serde_json::from_value(
                    json!({"tool":"codex","mode":"web","cwd":fixture.directory}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let token_path = fixture.directory.join("token");
        let token = Arc::new(crate::auth::token::TokenConfig::load_or_create(&token_path).unwrap());
        let app = super::super::routes(AppState {
            registry: registry.clone(),
            token,
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut request = format!("ws://127.0.0.1:{port}/api/v1/sessions/{}/codex", session.id)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "Authorization",
            format!(
                "Bearer {}",
                std::fs::read_to_string(token_path).unwrap().trim()
            )
            .parse()
            .unwrap(),
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        let ready = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&ready).unwrap()["type"],
            "ready"
        );
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"id":1,"op":"command","command":"/ps"}).to_string(),
            ))
            .await
            .unwrap();
        let progress = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&progress).unwrap()["type"],
            "notification"
        );
        for (id, text) in [(2, "fast second"), (3, "fast third")] {
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    json!({"id":id,"op":"queue","text":text}).to_string(),
                ))
                .await
                .unwrap();
        }
        let mut replies = Vec::new();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while replies.len() < 3 {
                let raw = socket.next().await.unwrap().unwrap().into_text().unwrap();
                let value: Value = serde_json::from_str(&raw).unwrap();
                if value["type"] == "result" {
                    replies.push(value["id"].as_i64().unwrap());
                }
            }
        })
        .await
        .unwrap();
        assert!(
            replies.iter().position(|id| *id == 3).unwrap()
                < replies.iter().position(|id| *id == 1).unwrap()
        );
        socket.close(None).await.unwrap();
        registry.delete_session(&session.id).await.unwrap();
        server.abort();
    }
}
