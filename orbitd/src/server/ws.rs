use super::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use orb_common::{WsClientMessage, WsServerMessage};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

pub async fn attach(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    match state.registry.attach(&id) {
        Ok(pty) => ws
            .on_upgrade(move |socket| handle(socket, pty))
            .into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

async fn handle(socket: WebSocket, pty: std::sync::Arc<crate::pty::manager::PtyManager>) {
    let client_id = Uuid::new_v4().to_string();
    pty.claim_writer(&client_id);
    let (mut sender, mut receiver) = socket.split();
    let mut output = pty.subscribe();

    let send_task = tokio::spawn(async move {
        loop {
            match output.recv().await {
                Ok(data) => {
                    if send_stdout(&mut sender, data).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!("attach output lagged; skipped {skipped} chunks");
                    continue;
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    while let Some(message) = receiver.next().await {
        match message {
            Ok(Message::Text(text)) => match serde_json::from_str::<WsClientMessage>(&text) {
                Ok(WsClientMessage::Stdin { data }) => {
                    match base64::engine::general_purpose::STANDARD.decode(data) {
                        Ok(bytes) => {
                            if let Err(err) = pty.write(&client_id, &bytes) {
                                tracing::warn!("stdin rejected: {err}");
                            }
                        }
                        Err(err) => tracing::warn!("bad stdin payload: {err}"),
                    }
                }
                Ok(WsClientMessage::Resize { cols, rows }) => {
                    if let Err(err) = pty.resize(cols, rows) {
                        tracing::warn!("resize rejected: {err}");
                    }
                }
                Ok(WsClientMessage::Ping) => {}
                Ok(WsClientMessage::Detach) => break,
                Err(err) => tracing::warn!("bad websocket message: {err}"),
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(err) => {
                tracing::warn!("websocket receive error: {err}");
                break;
            }
        }
    }
    pty.release_writer(&client_id);
    send_task.abort();
}

async fn send_stdout(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    data: Vec<u8>,
) -> Result<(), axum::Error> {
    let msg = WsServerMessage::Stdout {
        data: base64::engine::general_purpose::STANDARD.encode(data),
    };
    sender
        .send(Message::Text(serde_json::to_string(&msg).unwrap()))
        .await
}
