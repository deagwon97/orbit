//! Session-scoped connections to the existing local Codex daemon.
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    os::fd::{AsFd, OwnedFd},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::UnixStream,
    process::{Child, Command as ProcessCommand},
    sync::{broadcast, mpsc, oneshot},
    time::timeout,
};
use tokio_tungstenite::{client_async, tungstenite::Message};
use uuid::Uuid;

#[path = "codex_controls.rs"]
mod controls;

pub(crate) async fn run_worker(path: &Path) -> Result<()> {
    let fd = std::io::stdin().as_fd().try_clone_to_owned()?;
    let transport = std::os::unix::net::UnixStream::from(fd);
    transport.set_nonblocking(true)?;
    let mut transport = UnixStream::from_std(transport)?;
    let mut daemon = UnixStream::connect(path)
        .await
        .with_context(|| format!("Connect to existing Codex daemon at {}", path.display()))?;
    tokio::io::copy_bidirectional(&mut transport, &mut daemon).await?;
    Ok(())
}

pub(crate) struct SendingGuard {
    _guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    events: broadcast::Sender<Value>,
}
impl Drop for SendingGuard {
    fn drop(&mut self) {
        drop(self._guard.take());
        let _ = self.events.send(json!({"type":"drain"}));
    }
}
pub(crate) struct SwitchingGuard {
    state: Arc<Mutex<LiveState>>,
}
impl Drop for SwitchingGuard {
    fn drop(&mut self) {
        self.state.lock().unwrap().switching = false;
    }
}
type Reply = oneshot::Sender<Result<Value, String>>;
enum Command {
    Rpc(String, Value, Reply),
    Write(Value, Reply),
    Close(oneshot::Sender<()>),
}
#[derive(Default)]
struct LiveState {
    connected: bool,
    thread_id: String,
    upload_session: String,
    switching: bool,
    active: Option<String>,
    completed: HashSet<String>,
    approvals: HashMap<String, Value>,
    settings: Value,
    tokens: Value,
    queue: std::collections::VecDeque<Value>,
    queue_paused: bool,
    queue_error: Option<String>,
    queue_version: u64,
}
#[derive(Clone)]
pub struct CodexSession {
    commands: Arc<mpsc::Sender<Command>>,
    pub events: broadcast::Sender<Value>,
    state: Arc<Mutex<LiveState>>,
    sending: Arc<tokio::sync::Mutex<()>>,
    pid: Option<u32>,
}
impl CodexSession {
    pub(crate) fn begin_switch(&self) -> Result<SwitchingGuard> {
        let mut live = self.state.lock().unwrap();
        if live.switching
            || live.active.is_some()
            || !live.queue.is_empty()
            || !live.approvals.is_empty()
        {
            bail!("현재 작업과 대기 메시지를 정리한 뒤 대화를 전환하세요.");
        }
        live.switching = true;
        Ok(SwitchingGuard {
            state: self.state.clone(),
        })
    }
    pub(crate) fn bind_uploads(&self, session: &str) {
        self.state.lock().unwrap().upload_session = session.into();
    }
    pub async fn connect(path: &Path) -> Result<Self> {
        let stream = timeout(Duration::from_secs(10), UnixStream::connect(path))
            .await?
            .with_context(|| format!("Connect to existing Codex daemon at {}", path.display()))?;
        Self::connect_transport(stream, None).await
    }
    pub(crate) async fn connect_worker(path: &Path) -> Result<Self> {
        let (client, worker) = std::os::unix::net::UnixStream::pair()?;
        client.set_nonblocking(true)?;
        let client = UnixStream::from_std(client)?;
        let worker = ProcessCommand::new(std::env::current_exe()?)
            .args([
                std::ffi::OsStr::new("--web-session-worker"),
                path.as_os_str(),
            ])
            .stdin(OwnedFd::from(worker))
            .stdout(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Start Orbit Web session worker")?;
        Self::connect_transport(client, Some(worker)).await
    }
    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }
    async fn connect_transport(stream: UnixStream, mut worker: Option<Child>) -> Result<Self> {
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
            commands: Arc::new(commands),
            events: events.clone(),
            state: state.clone(),
            sending: Arc::new(tokio::sync::Mutex::new(())),
            pid: worker.as_ref().and_then(Child::id),
        };
        tokio::spawn(async move {
            let mut pending: HashMap<String, Reply> = HashMap::new();
            let mut closed = None;
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
                        Some(Command::Close(reply)) => { closed = Some(reply); break; }
                        None => break,
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
                            let target=p["threadId"].as_str().or_else(||p["thread"]["id"].as_str());
                            !live.thread_id.is_empty() && (target==Some(live.thread_id.as_str()) || (target.is_none() && ["warning","deprecationNotice","configWarning"].contains(&method)))
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
                            if method == "thread/settings/updated" { live.settings = controls::safe_settings(&p["threadSettings"]); }
                            if method == "thread/tokenUsage/updated" { live.tokens = p["tokenUsage"].clone(); }
                            if method == "turn/completed" {
                                if p["turn"]["status"] != "completed" { live.queue_paused = true; live.queue_error = Some("작업이 중단되거나 실패해 대기열을 멈췄습니다.".into()); }
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
            drop(socket);
            if let Some(worker) = &mut worker {
                if timeout(Duration::from_secs(2), worker.wait())
                    .await
                    .is_err()
                {
                    let _ = worker.kill().await;
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
            if let Some(reply) = closed {
                let _ = reply.send(());
            }
        });
        let init = async {
            handle.rpc("initialize", json!({"clientInfo":{"name":"orbit_web","title":"Orbit Web","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
            handle.write(json!({"method":"initialized","params":{}})).await
        }.await;
        if let Err(error) = init {
            handle.close().await;
            return Err(error);
        }
        let queue_commands = Arc::downgrade(&handle.commands);
        let queue_state = handle.state.clone();
        let queue_events_tx = handle.events.clone();
        let queue_sending = handle.sending.clone();
        let mut queue_events = handle.events.subscribe();
        tokio::spawn(async move {
            loop {
                let (drain, publish) = match queue_events.recv().await {
                    Ok(event) if event["type"] == "disconnected" => break,
                    Ok(event) => (
                        event["type"] == "drain" || event["message"]["method"] == "turn/completed",
                        event["type"] != "drain",
                    ),
                    Err(broadcast::error::RecvError::Lagged(_)) => (true, false),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if drain {
                    let Some(commands) = queue_commands.upgrade() else {
                        break;
                    };
                    let queue_handle = Self {
                        commands,
                        events: queue_events_tx.clone(),
                        state: queue_state.clone(),
                        sending: queue_sending.clone(),
                        pid: None,
                    };
                    if publish {
                        queue_handle.publish_state();
                    }
                    queue_handle.drain_queue().await;
                }
            }
        });
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
        json!({"activeTurn":state.active,"connected":state.connected,"approvals":state.approvals.values().cloned().collect::<Vec<_>>(),"settings":state.settings,"tokenUsage":state.tokens,"queue":{"items":state.queue,"paused":state.queue_paused,"error":state.queue_error,"version":state.queue_version},"capabilities":{"commands":true,"steer":true,"queue":true,"images":true,"fileAttachments":true,"resume":true,"liveInput":true,"fork":true}})
    }
    pub async fn create(&self, cwd: &Path) -> Result<String> {
        let result = self
            .rpc(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": "gpt-6.2-sol",
                    "config": {"model_reasoning_effort": "medium"},
                    "serviceTier": "priority",
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                }),
            )
            .await?;
        let id = result["thread"]["id"]
            .as_str()
            .context("Codex did not return a thread ID")?
            .to_string();
        self.state.lock().unwrap().settings = controls::resume_settings(&result);
        self.state.lock().unwrap().thread_id = id.clone();
        Ok(id)
    }
    pub(crate) async fn saved_thread(&self, thread_id: &str) -> Result<Value> {
        Ok(self
            .rpc(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":false}),
            )
            .await?["thread"]
            .clone())
    }
    pub(crate) async fn fork(
        &self,
        source_thread: &str,
        turn_id: &str,
    ) -> Result<(String, std::path::PathBuf)> {
        let result = self
            .rpc(
                "thread/fork",
                json!({
                    "threadId": source_thread,
                    "lastTurnId": turn_id,
                    "excludeTurns": true,
                }),
            )
            .await?;
        let thread = &result["thread"];
        let id = thread["id"]
            .as_str()
            .filter(|id| !id.is_empty() && *id != source_thread)
            .context("Codex did not return a new thread ID")?
            .to_string();
        let cwd = std::path::PathBuf::from(
            thread["cwd"]
                .as_str()
                .context("Missing fork working directory")?,
        );
        anyhow::ensure!(
            cwd.is_absolute() && cwd.is_dir(),
            "포크한 대화의 작업 폴더를 찾을 수 없습니다."
        );
        // Older app servers can ignore an unknown cutoff field.
        let last_turn = if thread["historyMode"] == "paginated" {
            self.rpc(
                "thread/turns/list",
                json!({
                    "threadId":id,"limit":1,"sortDirection":"desc","itemsView":"summary"
                }),
            )
            .await?["data"][0]
                .clone()
        } else {
            self.rpc("thread/read", json!({"threadId":id,"includeTurns":true}))
                .await?["thread"]["turns"]
                .as_array()
                .and_then(|turns| turns.last())
                .cloned()
                .unwrap_or_default()
        };
        anyhow::ensure!(
            last_turn["id"] == turn_id && last_turn["status"] == "completed",
            "선택한 턴까지의 기록을 확인할 수 없습니다. Codex 버전과 턴 상태를 확인하세요."
        );
        let mut state = self.state.lock().unwrap();
        state.thread_id = id.clone();
        state.settings = controls::resume_settings(&result);
        Ok((id, cwd))
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
        let resumed = self
            .rpc(
                "thread/resume",
                json!({"threadId":thread_id,"excludeTurns":true}),
            )
            .await?;
        self.state.lock().unwrap().settings = controls::resume_settings(&resumed);
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
        if self.state.lock().unwrap().switching {
            bail!("대화를 전환하고 있습니다. 잠시 후 다시 시도하세요.");
        }
        match body["op"].as_str().unwrap_or("") {
            "history" => self.history(body["cursor"].as_str()).await,
            "command" => self.command(body).await,
            "queue" => {
                let result = self.enqueue(body)?;
                self.drain_queue().await;
                Ok(result)
            }
            "queue/remove" => {
                let id = body["entryId"]
                    .as_str()
                    .context("Choose a queued message")?;
                let mut live = self.state.lock().unwrap();
                let index = live
                    .queue
                    .iter()
                    .position(|entry| entry["id"] == id)
                    .context("Message already submitted or removed")?;
                live.queue.remove(index);
                drop(live);
                self.publish_state();
                Ok(self.snapshot())
            }
            "queue/resume" => {
                {
                    let mut live = self.state.lock().unwrap();
                    live.queue_paused = false;
                    live.queue_error = None;
                }
                self.drain_queue().await;
                self.publish_state();
                Ok(self.snapshot())
            }
            "send" | "steer" => {
                let _guard = match self.gate() {
                    Ok(guard) => guard,
                    Err(_) if body["op"] == "steer" || body["op"] == "send" => {
                        let mut queued = self.enqueue(body)?;
                        queued["reason"] = json!("inputPending");
                        return Ok(queued);
                    }
                    Err(error) => return Err(error),
                };
                if !self.connected() {
                    bail!("Codex connection is closed");
                }
                let input = self.message_input(body)?;
                let active = self.state.lock().unwrap().active.clone();
                if let Some(active) = active {
                    if body["op"] != "steer" {
                        bail!("작업 중에는 즉시 반영 또는 대기열 추가를 선택하세요.");
                    }
                    if let Err(error)=self.rpc(
                        "turn/steer",
                        json!({"threadId":self.thread_id(),"expectedTurnId":active,"input":input}),
                    ).await {
                        // These are definitive, unsubmitted rejections from Codex, as in CLI.
                        let message=error.to_string();
                        if ["cannot steer a review turn","cannot steer a compact turn","no active turn to steer","active turn uses a different output schema"].contains(&message.as_str()) || message.starts_with("expected active turn id `") {
                            let mut queued=self.enqueue(body)?;queued["reason"]=json!("turnNotSteerable");return Ok(queued);
                        }
                        return Err(error);
                    }
                    return Ok(json!({"steered":true}));
                }
                if !self.state.lock().unwrap().queue.is_empty() {
                    bail!("대기열이 있습니다. 대기열에 추가하거나 먼저 취소하세요.");
                }
                {
                    let mut live = self.state.lock().unwrap();
                    live.queue_paused = false;
                    live.queue_error = None;
                }
                let result = self.start_message(body).await?;
                drop(_guard);
                self.drain_queue().await;
                Ok(result)
            }
            "interrupt" => {
                {
                    let mut live = self.state.lock().unwrap();
                    live.queue_paused = true;
                    live.queue_error = Some("작업을 중단해 대기열을 멈췄습니다.".into());
                }
                self.publish_state();
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
        let (reply, closed) = oneshot::channel();
        if self.commands.send(Command::Close(reply)).await.is_ok() {
            let _ = closed.await;
        }
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
                    let mut thread_id = "test-thread".to_string();
                    let mut active = false;
                    let mut turn_seq = 0u32;
                    let mut active_turn = "turn-1".to_string();
                    let mut settings = json!({"cwd":cwd,"model":"test-model","modelProvider":"openai","effort":"high","serviceTier":"default","approvalPolicy":"on-request","sandboxPolicy":{"type":"workspaceWrite"}});
                    while let Some(Ok(Message::Text(raw))) = ws.next().await {
                        let m: Value = serde_json::from_str(&raw).unwrap();
                        let method = m["method"].as_str().unwrap_or("");
                        let p = &m["params"];
                        if method == "thread/read" && p["threadId"] == "missing-thread" {
                            ws.send(Message::Text(json!({"id":m["id"],"error":{"code":-32602,"message":"no rollout found for thread id missing-thread"}}).to_string())).await.unwrap();
                            continue;
                        }
                        if method == "thread/fork" && p["lastTurnId"] == "unknown" {
                            ws.send(Message::Text(json!({"id":m["id"],"error":{"code":-32602,"message":"Unknown fork turn"}}).to_string())).await.unwrap();
                            continue;
                        }
                        if method == "thread/turns/list" && empty {
                            ws.send(Message::Text(json!({"id":m["id"],"error":{"code":-32602,"message":"thread is not materialized yet; unavailable before first user message"}}).to_string())).await.unwrap();
                            continue;
                        }
                        if method == "turn/steer"
                            && p["input"][0]["text"].as_str().is_some_and(|text| {
                                text.contains("reject-review") || text.contains("reject-compact")
                            })
                        {
                            let message = if p["input"][0]["text"]
                                .as_str()
                                .unwrap()
                                .contains("reject-review")
                            {
                                "cannot steer a review turn"
                            } else {
                                "cannot steer a compact turn"
                            };
                            ws.send(Message::Text(
                                json!({"id":m["id"],"error":{"code":-32600,"message":message}})
                                    .to_string(),
                            ))
                            .await
                            .unwrap();
                            continue;
                        }
                        let result = match method {
                            "initialize" => json!({"userAgent":"fake-codex"}),
                            "initialized" => continue,
                            "thread/start" => {
                                assert_eq!(p["cwd"], cwd);
                                assert_eq!(p["model"], "gpt-6.2-sol");
                                assert_eq!(p["config"]["model_reasoning_effort"], "medium");
                                assert_eq!(p["serviceTier"], "priority");
                                assert_eq!(p["approvalPolicy"], "never");
                                assert_eq!(p["sandbox"], "danger-full-access");
                                settings["model"] = p["model"].clone();
                                settings["effort"] = p["config"]["model_reasoning_effort"].clone();
                                settings["serviceTier"] = p["serviceTier"].clone();
                                settings["approvalPolicy"] = json!("never");
                                settings["sandboxPolicy"] = json!({"type":"dangerFullAccess"});
                                json!({"thread":{"id":thread_id,"cwd":cwd},"cwd":cwd,"model":settings["model"],"modelProvider":"openai","reasoningEffort":settings["effort"],"approvalPolicy":settings["approvalPolicy"],"sandbox":settings["sandboxPolicy"],"serviceTier":settings["serviceTier"]})
                            }
                            "thread/resume" => {
                                thread_id = p["threadId"].as_str().unwrap().to_string();
                                assert_eq!(
                                    p,
                                    &json!({"threadId":p["threadId"],"excludeTurns":true})
                                );
                                json!({"thread":{"id":thread_id,"cwd":cwd},"cwd":cwd,"model":settings["model"],"modelProvider":"openai","reasoningEffort":settings["effort"],"approvalPolicy":settings["approvalPolicy"],"sandbox":settings["sandboxPolicy"],"serviceTier":settings["serviceTier"]})
                            }
                            "thread/fork" => {
                                assert_eq!(p["threadId"], "test-thread");
                                assert_eq!(p["excludeTurns"], true);
                                assert!(
                                    p["lastTurnId"] == "turn-1" || p["lastTurnId"] == "ignored"
                                );
                                thread_id = "forked-thread".into();
                                json!({"thread":{"id":thread_id,"cwd":cwd,"historyMode":"paginated"},"cwd":cwd,"model":settings["model"],"sandbox":settings["sandboxPolicy"]})
                            }
                            "thread/list" => {
                                json!({"data":[{"id":"11111111-1111-4111-8111-111111111111","name":"Saved conversation","cwd":cwd,"preview":"saved answer","updatedAt":1700000000,"status":{"type":"notLoaded"}}],"nextCursor":null})
                            }
                            "thread/read" => {
                                json!({"thread":{"id":p["threadId"],"name":"Saved conversation","cwd":cwd,"historyMode":"paginated","status":{"type":"notLoaded"}}})
                            }
                            "thread/turns/list" => {
                                json!({"data":[{"id":active_turn,"status":if active {"inProgress"} else {"completed"}}],"nextCursor":null})
                            }
                            "thread/items/list" => {
                                json!({"data":[{"item":{"id":"agent-1","type":"agentMessage","text":"saved answer"}}],"nextCursor":null})
                            }
                            "model/list" => json!({"data":[
                                {"id":"gpt-6.2-sol","model":"gpt-6.2-sol","displayName":"GPT-6.2-Sol","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium"}],"serviceTiers":[{"id":"priority"}]},
                                {"id":"test-model","model":"test-model","displayName":"Test","defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"high"},{"reasoningEffort":"low"}],"serviceTiers":[{"id":"priority"}]},
                                {"id":"small","model":"small","defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"}],"serviceTiers":[]}
                            ],"nextCursor":null}),
                            "thread/settings/update" => {
                                assert_eq!(p["threadId"], thread_id);
                                for (key, value) in p.as_object().unwrap() {
                                    if key != "threadId" {
                                        settings[key] = value.clone();
                                    }
                                }
                                ws.send(Message::Text(json!({"method":"thread/settings/updated","params":{"threadId":thread_id,"threadSettings":settings}}).to_string())).await.unwrap();
                                json!({})
                            }
                            "config/read" => {
                                json!({"config":{"features":{"fast_mode":true},"api_key":"PRIVATE_CONFIG"}})
                            }
                            "configRequirements/read" => {
                                json!({"requirements":{"featureRequirements":{"fast_mode":true}}})
                            }
                            "account/rateLimits/read" => {
                                json!({"rateLimits":{"primary":{"usedPercent":25}},"accountId":"PRIVATE_ACCOUNT"})
                            }
                            "collaborationMode/list" => {
                                json!({"data":[{"mode":"plan"},{"mode":"default"}]})
                            }
                            "thread/name/set"
                            | "thread/compact/start"
                            | "thread/backgroundTerminals/clean" => {
                                assert_eq!(p["threadId"], thread_id);
                                json!({})
                            }
                            "thread/backgroundTerminals/list" => {
                                ws.send(Message::Text(json!({"method":"item/mcpToolCall/progress","params":{"threadId":thread_id,"turnId":"turn-1","itemId":"slow-progress","message":"progress while pending"}}).to_string())).await.unwrap();
                                tokio::time::sleep(Duration::from_millis(300)).await;
                                json!({"data":[],"nextCursor":null})
                            }
                            "skills/list" => {
                                json!({"data":[{"cwd":cwd,"skills":[{"name":"test-skill","path":"/test/SKILL.md"}]}]})
                            }
                            "mcpServerStatus/list" => {
                                assert_eq!(p["threadId"], thread_id);
                                json!({"data":[],"nextCursor":null})
                            }
                            "turn/steer" => {
                                assert_eq!(p["threadId"], thread_id);
                                assert_eq!(p["expectedTurnId"], active_turn);
                                assert!(active);
                                json!({"turnId":active_turn})
                            }
                            "turn/start" => {
                                assert_eq!(p["threadId"], thread_id);
                                turn_seq += 1;
                                active_turn = format!("turn-{turn_seq}");
                                active = true;
                                ws.send(Message::Text(json!({"method":"turn/started","params":{"threadId":thread_id,"turn":{"id":active_turn,"status":"inProgress"}}}).to_string())).await.unwrap();
                                if p["input"][0]["text"]
                                    .as_str()
                                    .unwrap_or("")
                                    .starts_with("fast")
                                {
                                    active = false;
                                    ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":active_turn,"status":"completed"}}}).to_string())).await.unwrap();
                                } else {
                                    ws.send(Message::Text(json!({"id":101,"method":"item/commandExecution/requestApproval","params":{"threadId":thread_id,"turnId":active_turn,"command":"echo test","availableDecisions":["accept","decline"]}}).to_string())).await.unwrap();
                                }
                                json!({"turn":{"id":active_turn,"status":"inProgress","items":[{"id":format!("user-{turn_seq}"),"type":"userMessage","content":p["input"]}]}})
                            }
                            "turn/interrupt" => {
                                active = false;
                                ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":active_turn,"status":"interrupted"}}}).to_string())).await.unwrap();
                                json!({})
                            }
                            "" if m["id"] == 101 => {
                                active = false;
                                ws.send(Message::Text(json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":active_turn,"status":"completed"}}}).to_string())).await.unwrap();
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
