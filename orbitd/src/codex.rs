//! A session-scoped client of the existing local Codex daemon. Never spawns it.
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::UnixStream,
    sync::{broadcast, mpsc, oneshot},
    time::timeout,
};
use tokio_tungstenite::{client_async, tungstenite::Message};
use uuid::Uuid;

type Reply = oneshot::Sender<Result<Value, String>>;
enum Command {
    Rpc(String, Value, Reply),
    Write(Value, Reply),
    Close,
}
#[derive(Default)]
struct LiveState {
    connected: bool,
    thread_id: String,
    active: Option<String>,
    completed: HashSet<String>,
    approvals: HashMap<String, Value>,
}
#[derive(Clone)]
pub struct CodexSession {
    commands: mpsc::Sender<Command>,
    pub events: broadcast::Sender<Value>,
    state: Arc<Mutex<LiveState>>,
    sending: Arc<tokio::sync::Mutex<()>>,
}
impl CodexSession {
    pub async fn connect(path: &Path) -> Result<Self> {
        let stream = timeout(Duration::from_secs(10), UnixStream::connect(path))
            .await?
            .with_context(|| format!("Connect to existing Codex daemon at {}", path.display()))?;
        let (mut socket, _) = timeout(
            Duration::from_secs(10),
            client_async("ws://localhost/rpc", stream),
        )
        .await??;
        let (commands, mut rx) = mpsc::channel(64);
        let (events, _) = broadcast::channel(512);
        let state = Arc::new(Mutex::new(LiveState {
            connected: true,
            ..Default::default()
        }));
        let handle = Self {
            commands,
            events: events.clone(),
            state: state.clone(),
            sending: Arc::new(tokio::sync::Mutex::new(())),
        };
        tokio::spawn(async move {
            let mut pending: HashMap<String, Reply> = HashMap::new();
            loop {
                tokio::select! {
                    command = rx.recv() => match command {
                        Some(Command::Rpc(method, params, reply)) => {
                            if pending.len() >= 128 { let _ = reply.send(Err("Too many pending Codex requests".into())); continue; }
                            let id = format!("orb-{}", Uuid::new_v4());
                            pending.insert(id.clone(), reply);
                            if socket.send(Message::Text(json!({"id":id,"method":method,"params":params}).to_string())).await.is_err() { break; }
                        },
                        Some(Command::Write(message, reply)) => {
                            let result = socket.send(Message::Text(message.to_string())).await.map(|_| json!({})).map_err(|e| e.to_string());
                            let failed = result.is_err(); let _ = reply.send(result); if failed { break; }
                        },
                        Some(Command::Close) | None => { let _ = socket.close(None).await; break; }
                    },
                    frame = socket.next() => {
                        let Some(Ok(frame)) = frame else { break; };
                        let Message::Text(raw) = frame else { if frame.is_close() { break; } continue; };
                        let Ok(message) = serde_json::from_str::<Value>(&raw) else { break; };
                        if message.get("method").is_none() {
                            if let Some(reply) = message["id"].as_str().and_then(|id| pending.remove(id)) {
                                let result = if message.get("error").is_some() { Err(message["error"]["message"].as_str().unwrap_or("Codex request failed").to_string()) }
                                    else { Ok(message["result"].clone()) };
                                let _ = reply.send(result);
                            }
                            continue;
                        }
                        let method = message["method"].as_str().unwrap_or("");
                        let p = &message["params"];
                        let belongs = {
                            let live = state.lock().unwrap();
                            !live.thread_id.is_empty() && p["threadId"].as_str().or_else(|| p["thread"]["id"].as_str()) == Some(live.thread_id.as_str())
                        };
                        if !belongs { continue; }
                        let request = message.get("id").is_some();
                        if request && !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].contains(&method) {
                            if socket.send(Message::Text(json!({"id":message["id"],"error":{"code":-32601,"message":"This operation requires Codex CLI"}}).to_string())).await.is_err() { break; }
                            continue;
                        }
                        {
                            let mut live = state.lock().unwrap();
                            if request { live.approvals.insert(message["id"].to_string(), message.clone()); }
                            if method == "turn/started" { live.active = p["turn"]["id"].as_str().map(String::from); }
                            if method == "turn/completed" {
                                if let Some(id) = p["turn"]["id"].as_str() {
                                    if live.active.as_deref() == Some(id) { live.active = None; }
                                    if live.completed.len() >= 1000 { live.completed.clear(); }
                                    live.completed.insert(id.to_string());
                                    live.approvals.retain(|_, request| request["params"]["turnId"].as_str() != Some(id));
                                }
                            }
                            if method == "serverRequest/resolved" { live.approvals.remove(&p["requestId"].to_string()); }
                        }
                        let _ = events.send(json!({"type":if request {"request"} else {"notification"},"message":message}));
                    }
                }
            }
            {
                let mut live = state.lock().unwrap();
                live.connected = false;
                live.active = None;
                live.approvals.clear();
            }
            for (_, reply) in pending {
                let _ = reply.send(Err(
                    "Codex daemon connection closed; reopen the session to reconnect".into(),
                ));
            }
            let _ = events.send(json!({"type":"disconnected","error":"Codex daemon disconnected. Reconnect to resume this conversation."}));
        });
        handle.rpc("initialize", json!({"clientInfo":{"name":"orbit_web","title":"Orbit Web","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        handle
            .write(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(handle)
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Rpc(method.into(), params, tx))
            .await
            .map_err(|_| anyhow!("Codex connection closed"))?;
        timeout(Duration::from_secs(30), rx)
            .await
            .context("Codex request timed out; check conversation history before retrying")??
            .map_err(|e| anyhow!(e))
    }
    async fn write(&self, message: Value) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Command::Write(message, tx))
            .await
            .map_err(|_| anyhow!("Codex connection closed"))?;
        timeout(Duration::from_secs(10), rx)
            .await??
            .map_err(|e| anyhow!(e))
    }
    pub fn connected(&self) -> bool {
        self.state.lock().unwrap().connected
    }
    pub fn thread_id(&self) -> String {
        self.state.lock().unwrap().thread_id.clone()
    }
    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"activeTurn":state.active,"connected":state.connected,"approvals":state.approvals.values().cloned().collect::<Vec<_>>()})
    }
    pub async fn create(&self, cwd: &Path) -> Result<String> {
        let result = self
            .rpc(
                "thread/start",
                json!({"cwd":cwd,"approvalPolicy":"on-request","sandbox":"workspace-write"}),
            )
            .await?;
        let id = result["thread"]["id"]
            .as_str()
            .context("Codex did not return a thread ID")?
            .to_string();
        self.state.lock().unwrap().thread_id = id.clone();
        Ok(id)
    }
    pub async fn resume(&self, thread_id: &str, cwd: &Path) -> Result<()> {
        let read = self
            .rpc(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )
            .await?;
        if read["thread"]["cwd"].as_str() != cwd.to_str() {
            bail!("Codex thread workspace does not match Orb session");
        }
        self.state.lock().unwrap().thread_id = thread_id.into();
        self.rpc(
            "thread/resume",
            json!({"threadId":thread_id,"excludeTurns":true}),
        )
        .await?;
        Ok(())
    }
    pub async fn history(&self, cursor: Option<&str>) -> Result<Value> {
        let id = self.thread_id();
        let read = self
            .rpc("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?;
        let mut thread = read["thread"].clone();
        let mut turns = Vec::new();
        let mut next = Value::Null;
        if thread["historyMode"] == "paginated" {
            let mut params =
                json!({"threadId":id,"limit":10,"sortDirection":"desc","itemsView":"summary"});
            if let Some(cursor) = cursor {
                params["cursor"] = json!(cursor);
            }
            let page = match self.rpc("thread/turns/list", params).await {
                Ok(page) => page,
                Err(error)
                    if cursor.is_none() && error.to_string().contains("not materialized yet") =>
                {
                    json!({"data":[],"nextCursor":null})
                }
                Err(error) => return Err(error),
            };
            next = page["nextCursor"].clone();
            if cursor.is_some() && next.as_str() == cursor {
                bail!("Repeated turn history cursor");
            }
            for turn in page["data"].as_array().context("Invalid turn history")? {
                let mut turn = turn.clone();
                let mut items = Vec::new();
                let mut seen = HashSet::new();
                let mut item_cursor = Value::Null;
                loop {
                    let mut params = json!({"threadId":id,"turnId":turn["id"],"limit":100,"sortDirection":"desc"});
                    if !item_cursor.is_null() {
                        params["cursor"] = item_cursor.clone();
                    }
                    let page = self.rpc("thread/items/list", params).await?;
                    for entry in page["data"].as_array().context("Invalid item history")? {
                        items.push(entry.get("item").unwrap_or(entry).clone());
                    }
                    item_cursor = page["nextCursor"].clone();
                    if item_cursor.is_null() {
                        break;
                    }
                    if !seen.insert(item_cursor.to_string()) {
                        bail!("Repeated history cursor");
                    }
                }
                items.reverse();
                turn["items"] = json!(items);
                turns.push(turn);
            }
            turns.reverse();
            thread["turns"] = json!(turns);
        } else {
            if cursor.is_some() {
                bail!("This conversation has no older history pages");
            }
            thread = self
                .rpc("thread/read", json!({"threadId":id,"includeTurns":true}))
                .await?["thread"]
                .clone();
        }
        // Persisted running turns seed the state after reconnect, including approval waits.
        let running = thread["turns"]
            .as_array()
            .and_then(|turns| turns.iter().find(|t| t["status"] == "inProgress"))
            .and_then(|t| t["id"].as_str());
        if let Some(running) = running {
            let mut state = self.state.lock().unwrap();
            if !state.completed.contains(running) {
                state.active = Some(running.into());
            }
        }
        Ok(json!({"thread":thread,"nextCursor":next,"state":self.snapshot()}))
    }
    pub async fn operation(&self, body: &Value) -> Result<Value> {
        match body["op"].as_str().unwrap_or("") {
            "history" => self.history(body["cursor"].as_str()).await,
            "send" => {
                let _guard = self
                    .sending
                    .try_lock()
                    .map_err(|_| anyhow!("A message is already being submitted"))?;
                if !self.connected() {
                    bail!("Codex connection is closed");
                }
                if self.state.lock().unwrap().active.is_some() {
                    bail!("Wait for the current turn to finish before sending");
                }
                let text = body["text"]
                    .as_str()
                    .filter(|t| !t.trim().is_empty() && t.len() <= 100_000)
                    .context("Enter a message of 1–100,000 bytes")?;
                let result = self.rpc("turn/start", json!({"threadId":self.thread_id(),"input":[{"type":"text","text":text,"text_elements":[]}]})).await?;
                let mut state = self.state.lock().unwrap();
                if let Some(id) = result["turn"]["id"].as_str() {
                    if result["turn"]["status"] == "inProgress" && !state.completed.contains(id) {
                        state.active = Some(id.into());
                    }
                }
                Ok(result)
            }
            "interrupt" => {
                let active = self
                    .state
                    .lock()
                    .unwrap()
                    .active
                    .clone()
                    .context("No running turn")?;
                self.rpc(
                    "turn/interrupt",
                    json!({"threadId":self.thread_id(),"turnId":active}),
                )
                .await
            }
            "reply" => {
                let id = body["requestId"].to_string();
                let request = self
                    .state
                    .lock()
                    .unwrap()
                    .approvals
                    .get(&id)
                    .cloned()
                    .context("Approval expired or already resolved")?;
                let result = approval_result(&request, body)?;
                // Remove atomically before awaiting so two browser tabs cannot reply twice.
                if self.state.lock().unwrap().approvals.remove(&id).is_none() {
                    bail!("Approval already resolved");
                }
                self.write(json!({"id":request["id"],"result":result}))
                    .await?;
                let _ = self
                    .events
                    .send(json!({"type":"resolved","requestId":request["id"]}));
                Ok(json!({}))
            }
            _ => bail!("Unsupported Codex operation"),
        }
    }
    pub async fn stop(&self) -> Result<()> {
        let _guard = self.sending.lock().await;
        if self.state.lock().unwrap().active.is_some() {
            self.operation(&json!({"op":"interrupt"})).await?;
        }
        self.close().await;
        Ok(())
    }
    pub async fn close(&self) {
        self.state.lock().unwrap().connected = false;
        let _ = self.commands.send(Command::Close).await;
    }
}
fn approval_result(request: &Value, body: &Value) -> Result<Value> {
    if request["method"] == "item/tool/requestUserInput" {
        let mut answers = serde_json::Map::new();
        for question in request["params"]["questions"]
            .as_array()
            .context("Invalid question")?
        {
            let id = question["id"].as_str().context("Invalid question ID")?;
            let answer = body["answers"][id]
                .as_str()
                .filter(|a| !a.is_empty() && a.len() <= 10_000)
                .context("Answer every question")?;
            answers.insert(id.into(), json!({"answers":[answer]}));
        }
        Ok(json!({"answers":answers}))
    } else {
        let decision = body["decision"]
            .as_str()
            .context("Choose an approval decision")?;
        if !["accept", "decline", "cancel"].contains(&decision) {
            bail!("Unsupported approval decision");
        }
        if let Some(allowed) = request["params"]["availableDecisions"].as_array() {
            if !allowed.contains(&json!(decision)) {
                bail!("Decision is unavailable for this request");
            }
        }
        Ok(json!({"decision":decision}))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::net::UnixListener;
    pub(crate) struct Fixture {
        pub directory: std::path::PathBuf,
        pub socket: std::path::PathBuf,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    pub(crate) async fn fixture() -> Fixture {
        fixture_mode(false).await
    }
    async fn fixture_mode(empty: bool) -> Fixture {
        let directory = std::env::temp_dir().join(format!("orb-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let socket = directory.join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let cwd = directory.to_string_lossy().to_string();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let cwd = cwd.clone();
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                    let mut active = false;
                    while let Some(Ok(Message::Text(raw))) = ws.next().await {
                        let m: Value = serde_json::from_str(&raw).unwrap();
                        let method = m["method"].as_str().unwrap_or("");
                        let p = &m["params"];
                        if method == "thread/read" && p["threadId"] == "missing-thread" {
                            ws.send(Message::Text(json!({"id":m["id"],"error":{"code":-32602,"message":"no rollout found for thread id missing-thread"}}).to_string())).await.unwrap();
                            continue;
                        }
                        if method == "thread/turns/list" && empty {
                            ws.send(Message::Text(json!({"id":m["id"],"error":{"code":-32602,"message":"thread is not materialized yet; unavailable before first user message"}}).to_string())).await.unwrap();
                            continue;
                        }
                        let result = match method {
                            "initialize" => json!({"userAgent":"fake-codex"}),
                            "initialized" => continue,
                            "thread/start" => {
                                assert_eq!(p["cwd"], cwd);
                                assert_eq!(p["approvalPolicy"], "on-request");
                                json!({"thread":{"id":"test-thread","cwd":cwd}})
                            }
                            "thread/resume" => {
                                assert_eq!(
                                    p,
                                    &json!({"threadId":"test-thread","excludeTurns":true})
                                );
                                json!({"thread":{"id":"test-thread","cwd":cwd}})
                            }
                            "thread/read" => {
                                json!({"thread":{"id":"test-thread","cwd":cwd,"historyMode":"paginated"}})
                            }
                            "thread/turns/list" => {
                                json!({"data":[{"id":"turn-1","status":if active {"inProgress"} else {"completed"}}],"nextCursor":null})
                            }
                            "thread/items/list" => {
                                json!({"data":[{"item":{"id":"agent-1","type":"agentMessage","text":"saved answer"}}],"nextCursor":null})
                            }
                            "turn/start" => {
                                active = true;
                                ws.send(Message::Text(json!({"method":"turn/started","params":{"threadId":"test-thread","turn":{"id":"turn-1","status":"inProgress"}}}).to_string())).await.unwrap();
                                if p["input"][0]["text"] == "fast" {
                                    active = false;
                                    ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":"test-thread","turn":{"id":"turn-1","status":"completed"}}}).to_string())).await.unwrap();
                                } else {
                                    ws.send(Message::Text(json!({"id":101,"method":"item/commandExecution/requestApproval","params":{"threadId":"test-thread","turnId":"turn-1","command":"echo test","availableDecisions":["accept","decline"]}}).to_string())).await.unwrap();
                                }
                                json!({"turn":{"id":"turn-1","status":"inProgress"}})
                            }
                            "turn/interrupt" => {
                                active = false;
                                ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":"test-thread","turn":{"id":"turn-1","status":"interrupted"}}}).to_string())).await.unwrap();
                                json!({})
                            }
                            "" if m["id"] == 101 => {
                                active = false;
                                ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":"test-thread","turn":{"id":"turn-1","status":"completed"}}}).to_string())).await.unwrap();
                                continue;
                            }
                            other => panic!("Unexpected fake RPC {other}"),
                        };
                        if ws
                            .send(Message::Text(
                                json!({"id":m["id"],"result":result}).to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        Fixture {
            directory,
            socket,
            task,
        }
    }
    #[tokio::test]
    async fn native_daemon_client_scopes_threads_paginates_history_and_resolves_approvals_once() {
        let fixture = fixture().await;
        let handle = CodexSession::connect(&fixture.socket).await.unwrap();
        assert_eq!(
            handle.create(&fixture.directory).await.unwrap(),
            "test-thread"
        );
        let history = handle.history(None).await.unwrap();
        assert_eq!(
            history["thread"]["turns"][0]["items"][0]["text"],
            "saved answer"
        );
        let mut events = handle.events.subscribe();
        handle
            .operation(&json!({"op":"send","text":"approval"}))
            .await
            .unwrap();
        assert!(handle
            .operation(&json!({"op":"send","text":"overlap"}))
            .await
            .is_err());
        loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "request" {
                break;
            }
        }
        assert_eq!(handle.snapshot()["approvals"][0]["id"], 101);
        assert!(handle
            .operation(&json!({"op":"reply","requestId":101,"decision":"acceptForSession"}))
            .await
            .is_err());
        handle
            .operation(&json!({"op":"reply","requestId":101,"decision":"decline"}))
            .await
            .unwrap();
        assert!(handle
            .operation(&json!({"op":"reply","requestId":101,"decision":"accept"}))
            .await
            .is_err());
        handle.close().await;
        let restored = CodexSession::connect(&fixture.socket).await.unwrap();
        restored
            .resume("test-thread", &fixture.directory)
            .await
            .unwrap();
        assert!(restored
            .resume("test-thread", Path::new("/wrong-workspace"))
            .await
            .is_err());
        restored.close().await;
    }
    #[tokio::test]
    async fn completion_before_response_is_not_resurrected_and_missing_socket_never_spawns_a_daemon(
    ) {
        let f = fixture().await;
        let h = CodexSession::connect(&f.socket).await.unwrap();
        h.create(&f.directory).await.unwrap();
        h.operation(&json!({"op":"send","text":"fast"}))
            .await
            .unwrap();
        assert!(h.snapshot()["activeTurn"].is_null());
        assert!(h
            .operation(&json!({"op":"rpc","method":"thread/list"}))
            .await
            .is_err());
        h.close().await;
        assert!(CodexSession::connect(&f.directory.join("missing.sock"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn stopping_interrupts_only_this_conversation_and_rejects_further_input() {
        let f = fixture().await;
        let h = CodexSession::connect(&f.socket).await.unwrap();
        h.create(&f.directory).await.unwrap();
        h.operation(&json!({"op":"send","text":"working"}))
            .await
            .unwrap();
        h.stop().await.unwrap();
        assert!(!h.connected());
        assert!(h
            .operation(&json!({"op":"send","text":"again"}))
            .await
            .is_err());
        // The same Unix listener remains available after closing an individual client.
        let next = CodexSession::connect(&f.socket).await.unwrap();
        next.close().await;
    }
    #[tokio::test]
    async fn a_new_unmaterialized_thread_has_empty_history_before_its_first_message() {
        let f = fixture_mode(true).await;
        let h = CodexSession::connect(&f.socket).await.unwrap();
        h.create(&f.directory).await.unwrap();
        let history = h.history(None).await.unwrap();
        assert_eq!(history["thread"]["turns"], json!([]));
        assert!(history["nextCursor"].is_null());
        assert!(h.history(Some("older")).await.is_err());
        h.close().await;
    }
    #[test]
    fn question_answers_and_available_decisions_are_validated() {
        let q =
            json!({"method":"item/tool/requestUserInput","params":{"questions":[{"id":"choice"}]}});
        assert!(approval_result(&q, &json!({"answers":{}})).is_err());
        assert_eq!(
            approval_result(&q, &json!({"answers":{"choice":"yes"}})).unwrap(),
            json!({"answers":{"choice":{"answers":["yes"]}}})
        );
        let a = json!({"method":"item/fileChange/requestApproval","params":{"availableDecisions":["decline"]}});
        assert!(approval_result(&a, &json!({"decision":"accept"})).is_err());
    }
}
