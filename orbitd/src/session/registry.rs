use crate::{audit, config::Config, db::Db, pty::manager::PtyManager};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use orb_common::{CreateSessionRequest, ListSessionsQuery, Session, SessionMode, SessionStatus};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, RwLock},
};
use uuid::Uuid;

pub struct SessionRegistry {
    db: Arc<Db>,
    web: tokio::sync::Mutex<HashMap<String, crate::codex::CodexSession>>,
    has_input: std::sync::Mutex<HashSet<String>>,
    metadata: std::sync::Mutex<()>,
    config: Config,
    supervisors: RwLock<HashMap<String, Arc<PtyManager>>>,
}

impl SessionRegistry {
    pub fn new(db: Arc<Db>, config: Config) -> Self {
        let registry = Self {
            web: tokio::sync::Mutex::new(HashMap::new()),
            has_input: std::sync::Mutex::new(HashSet::new()),
            metadata: std::sync::Mutex::new(()),
            db,
            config,
            supervisors: RwLock::new(HashMap::new()),
        };
        registry.restore_web_sessions();
        registry
    }

    pub async fn create_session(&self, req: CreateSessionRequest) -> Result<Session> {
        if req.mode == SessionMode::Web && req.tool != "codex" {
            bail!("Web mode is only available for Codex");
        }
        if req.mode == SessionMode::Web && !req.env.is_empty() {
            bail!("Web mode uses the Codex daemon environment; per-session environment overrides are unsupported");
        }
        let backend = self
            .config
            .backends
            .get(&req.tool)
            .with_context(|| format!("unsupported backend: {}", req.tool))?;
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        let cwd = req.cwd.unwrap_or(std::env::current_dir()?);
        let name = req.name.unwrap_or_else(|| format!("{}-{id}", req.tool));
        let mut session = Session {
            mode: req.mode,
            codex_thread_id: None,
            id: id.clone(),
            name,
            tool: req.tool,
            pid: None,
            cwd: cwd.clone(),
            status: SessionStatus::Created,
            created_at: Utc::now(),
            last_attached_at: None,
            exit_code: None,
        };
        if req.mode == SessionMode::Web {
            session.cwd =
                std::fs::canonicalize(&session.cwd).context("Resolve session working directory")?;
            if !session.cwd.is_dir() {
                bail!("Working directory is not a directory");
            }
            let handle = self.connect_web(true).await?;
            handle.bind_uploads(&session.id);
            let id = match handle.create(&session.cwd).await {
                Ok(id) => id,
                Err(error) => {
                    handle.close().await;
                    return Err(error);
                }
            };
            session.codex_thread_id = Some(id);
            session.pid = handle.pid();
            session.status = SessionStatus::Running;
            self.register_web_session(&session, handle, false).await?;
            audit::append(
                &self.config.audit_path,
                audit::AuditEvent {
                    timestamp: String::new(),
                    action: "session.create.web",
                    session_id: Some(&session.id),
                    detail: session.codex_thread_id.as_deref(),
                },
            );
            return Ok(session);
        }
        self.db.create_session(&session)?;
        let args: Vec<&str> = backend.args.iter().map(String::as_str).collect();
        let (pty, pid) = match PtyManager::spawn(
            id.clone(),
            &backend.command,
            &args,
            &cwd,
            &req.env,
            self.db.clone(),
            &self.config,
        ) {
            Ok(result) => result,
            Err(err) => {
                self.db.delete_session(&id).ok();
                return Err(err);
            }
        };
        session.pid = Some(pid);
        session.status = SessionStatus::Running;
        self.db
            .update_runtime(&id, Some(pid), SessionStatus::Running, None)?;
        self.supervisors.write().unwrap().insert(id, pty);
        audit::append(
            &self.config.audit_path,
            audit::AuditEvent {
                timestamp: String::new(),
                action: "session.create",
                session_id: Some(&session.id),
                detail: Some(&backend.command),
            },
        );
        Ok(session)
    }

    pub fn codex_available(&self) -> bool {
        self.config.codex_socket.exists()
    }

    async fn connect_web(&self, managed: bool) -> Result<crate::codex::CodexSession> {
        // Unit tests use a fixture socket without starting the orbitd executable.
        if managed && !cfg!(test) {
            crate::codex::CodexSession::connect_worker(&self.config.codex_socket).await
        } else {
            crate::codex::CodexSession::connect(&self.config.codex_socket).await
        }
    }

    fn watch_web_worker(&self, id: &str, handle: &crate::codex::CodexSession) {
        let Some(pid) = handle.pid() else { return };
        let mut events = handle.events.subscribe();
        let connected = handle.connected();
        let db = self.db.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            if connected {
                loop {
                    match events.recv().await {
                        Ok(event) if event["type"] != "disconnected" => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        _ => break,
                    }
                }
            }
            if let Err(error) = db.clear_web_pid(&id, pid) {
                tracing::warn!(session_id = %id, %pid, %error, "Cannot clear Web worker PID");
            }
        });
    }

    async fn register_web_session(
        &self,
        session: &Session,
        handle: crate::codex::CodexSession,
        has_history: bool,
    ) -> Result<()> {
        let mut web = self.web.lock().await;
        if has_history {
            self.has_input.lock().unwrap().insert(session.id.clone());
        }
        let result = self.save_web_session(session).and_then(|_| {
            self.db.create_session(session).inspect_err(|_| {
                let _ = std::fs::remove_file(self.web_metadata_path(&session.id));
            })
        });
        if let Err(error) = result {
            self.has_input.lock().unwrap().remove(&session.id);
            drop(web);
            handle.close().await;
            return Err(error);
        }
        self.watch_web_worker(&session.id, &handle);
        web.insert(session.id.clone(), handle);
        Ok(())
    }

    pub async fn fork_web_thread(
        &self,
        ident: &str,
        source_thread: &str,
        turn_id: &str,
    ) -> Result<Session> {
        anyhow::ensure!(
            !turn_id.trim().is_empty() && turn_id.len() <= 256,
            "올바른 턴을 선택하세요."
        );
        let source = self.get_session(ident)?;
        anyhow::ensure!(
            source.mode == SessionMode::Web
                && source.tool == "codex"
                && source.codex_thread_id.as_deref() == Some(source_thread),
            "대화가 변경되었습니다. 다시 연결한 뒤 포크하세요."
        );
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        let child = self.connect_web(true).await?;
        child.bind_uploads(&id);
        let (thread_id, cwd) = match child.fork(source_thread, turn_id).await {
            Ok(fork) => fork,
            Err(error) => {
                child.close().await;
                return Err(error);
            }
        };
        let session = Session {
            id,
            name: format!(
                "{} · 포크",
                source.name.chars().take(95).collect::<String>()
            ),
            tool: source.tool,
            mode: SessionMode::Web,
            cwd,
            codex_thread_id: Some(thread_id),
            pid: child.pid(),
            status: SessionStatus::Running,
            created_at: Utc::now(),
            last_attached_at: None,
            exit_code: None,
        };
        self.register_web_session(&session, child, true).await?;
        audit::append(
            &self.config.audit_path,
            audit::AuditEvent {
                timestamp: String::new(),
                action: "session.fork.web",
                session_id: Some(&session.id),
                detail: Some(&source.id),
            },
        );
        Ok(session)
    }

    pub async fn codex_session(&self, ident: &str) -> Result<crate::codex::CodexSession> {
        let mut web = self.web.lock().await;
        let mut session = self.get_session(ident)?;
        if session.mode != SessionMode::Web || session.tool != "codex" {
            bail!("This is not a Codex Web session");
        }
        if let Some(handle) = web.get(&session.id).filter(|handle| handle.connected()) {
            return Ok(handle.clone());
        }
        let previous_queue = web
            .get(&session.id)
            .map(|handle| handle.snapshot()["queue"].clone());
        let running = session.status == SessionStatus::Running;
        let handle = self.connect_web(running).await?;
        handle.bind_uploads(&session.id);
        if let Some(queue) = previous_queue {
            handle.restore_queue(&queue);
        }
        if let Err(error) = handle
            .resume(
                session
                    .codex_thread_id
                    .as_deref()
                    .context("Missing Codex thread mapping")?,
                &session.cwd,
            )
            .await
        {
            handle.close().await;
            let missing = session
                .codex_thread_id
                .as_deref()
                .is_some_and(|id| thread_missing(&error, id));
            if missing && !self.has_input.lock().unwrap().contains(&session.id) {
                // Codex has no saved conversation before the first message. Recreate only a known-empty thread.
                let replacement = self.connect_web(running).await?;
                replacement.bind_uploads(&session.id);
                let prepared = async {
                    session.codex_thread_id = Some(replacement.create(&session.cwd).await?);
                    session.pid = replacement.pid();
                    self.save_web_session(&session)?;
                    self.db.update_web_session(&session)
                }
                .await;
                if let Err(error) = prepared {
                    replacement.close().await;
                    return Err(error);
                }
                self.watch_web_worker(&session.id, &replacement);
                web.insert(session.id, replacement.clone());
                return Ok(replacement);
            }
            return Err(error);
        }
        // Seed running state before accepting input, including a turn left running during a daemon reconnect.
        if let Err(error) = handle.history(None).await {
            handle.close().await;
            return Err(error);
        }
        if running {
            if let Err(error) =
                self.db
                    .update_runtime(&session.id, handle.pid(), session.status, session.exit_code)
            {
                handle.close().await;
                return Err(error);
            }
            self.watch_web_worker(&session.id, &handle);
        }
        web.insert(session.id, handle.clone());
        Ok(handle)
    }
    pub async fn resume_web_thread(&self, ident: &str, thread_id: &str) -> Result<Session> {
        let thread_id = Uuid::parse_str(thread_id)
            .context("올바른 Codex 대화 ID를 입력하세요.")?
            .to_string();
        let mut web = self.web.lock().await;
        let previous = self.get_session(ident)?;
        if previous.mode != SessionMode::Web || previous.tool != "codex" {
            bail!("Codex Web 세션에서만 사용할 수 있습니다.");
        }
        if previous.codex_thread_id.as_deref() == Some(&thread_id) {
            bail!("이미 현재 대화입니다.");
        }
        if self
            .list_sessions(ListSessionsQuery::default())?
            .iter()
            .any(|s| {
                s.id != previous.id
                    && s.mode == SessionMode::Web
                    && s.status == SessionStatus::Running
                    && s.codex_thread_id.as_deref() == Some(&thread_id)
            })
        {
            bail!("다른 Orb 세션에서 열려 있는 대화입니다. 해당 세션에서 이어가세요.");
        }
        let old = web
            .get(&previous.id)
            .context("세션을 다시 연결한 뒤 재시도하세요.")?
            .clone();
        let _guard = old.gate()?;
        let _switch = old.begin_switch()?;
        let next = self.connect_web(true).await?;
        next.bind_uploads(&previous.id);
        let prepared = async {
            let thread = next.saved_thread(&thread_id).await?;
            if thread["status"]["type"] == "active" {
                bail!("선택한 대화에서 작업이 실행 중입니다. 완료 후 다시 시도하세요.");
            }
            let cwd = std::path::PathBuf::from(
                thread["cwd"]
                    .as_str()
                    .context("저장된 작업 폴더가 없습니다.")?,
            );
            if !cwd.is_absolute() || !cwd.is_dir() {
                bail!("저장된 작업 폴더가 없습니다: {}", cwd.display());
            }
            next.resume(&thread_id, &cwd).await?;
            next.history(None).await?;
            if !next.snapshot()["activeTurn"].is_null() {
                bail!("선택한 대화에서 작업이 시작되었습니다. 완료 후 다시 시도하세요.");
            }
            let mut session = previous.clone();
            session.cwd = cwd;
            session.codex_thread_id = Some(thread_id.clone());
            session.status = SessionStatus::Running;
            session.pid = next.pid();
            session.exit_code = None;
            session.name = thread["name"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| thread["preview"].as_str())
                .unwrap_or("Codex")
                .chars()
                .take(100)
                .collect();
            // Resumed history must never be mistaken for a replaceable empty thread.
            self.has_input.lock().unwrap().insert(session.id.clone());
            self.save_web_session(&session)?;
            if let Err(error) = self.db.update_web_session(&session) {
                let _ = self.save_web_session(&previous);
                return Err(error);
            }
            Ok::<Session, anyhow::Error>(session)
        }
        .await;
        match prepared {
            Ok(session) => {
                self.watch_web_worker(&session.id, &next);
                web.insert(session.id.clone(), next);
                old.close().await;
                Ok(session)
            }
            Err(error) => {
                next.close().await;
                Err(error)
            }
        }
    }
    pub fn mark_web_input(&self, ident: &str) -> Result<()> {
        let _guard = self.metadata.lock().unwrap();
        let session = self.get_session(ident)?;
        self.has_input.lock().unwrap().insert(session.id.clone());
        self.write_web_session(&session)
    }
    pub async fn rename_web_session(
        &self,
        ident: &str,
        handle: &crate::codex::CodexSession,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let _web = self.web.lock().await;
        let previous = self.get_session(ident)?;
        let thread_id = handle.thread_id();
        anyhow::ensure!(
            previous.status == SessionStatus::Running
                && previous.codex_thread_id.as_deref() == Some(&thread_id),
            "대화가 변경되었습니다. 다시 연결한 뒤 이름을 바꾸세요."
        );
        let mut result = handle.operation(body).await?;
        let name = result["name"].as_str().context("Codex 대화 이름이 없습니다.")?;
        let _guard = self.metadata.lock().unwrap();
        let mut session = self.get_session(ident)?;
        session.name = name.to_owned();
        self.write_web_session(&session)?;
        if let Err(error) = self.db.rename_web_session(&session.id, &thread_id, name) {
            let _ = self.write_web_session(&previous);
            return Err(error);
        }
        result["session"] = serde_json::to_value(session)?;
        Ok(result)
    }
    fn web_metadata_path(&self, id: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("codex-sessions")
            .join(format!("{id}.json"))
    }
    fn save_web_session(&self, session: &Session) -> Result<()> {
        let _guard = self.metadata.lock().unwrap();
        self.write_web_session(session)
    }
    fn write_web_session(&self, session: &Session) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = self.web_metadata_path(&session.id);
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let temporary = path.with_extension("tmp");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        let mut metadata = serde_json::to_value(session)?;
        // PIDs are local to the current orbitd process lifetime.
        metadata["pid"] = serde_json::Value::Null;
        metadata["codex_has_input"] =
            serde_json::json!(self.has_input.lock().unwrap().contains(&session.id));
        file.write_all(&serde_json::to_vec(&metadata)?)?;
        file.sync_all()?;
        std::fs::rename(temporary, path)?;
        Ok(())
    }
    fn restore_web_sessions(&self) {
        let directory = self.config.data_dir.join("codex-sessions");
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let restored = (|| -> Result<()> {
                let metadata: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.path())?)?;
                let mut session: Session = serde_json::from_value(metadata.clone())?;
                session.pid = None;
                if session.mode != SessionMode::Web
                    || session.tool != "codex"
                    || session.codex_thread_id.is_none()
                    || entry.file_name().to_str() != Some(format!("{}.json", session.id).as_str())
                {
                    bail!("Invalid web session metadata");
                }
                if metadata["codex_has_input"] != false {
                    self.has_input.lock().unwrap().insert(session.id.clone());
                }
                self.db.create_session(&session)
            })();
            if let Err(error) = restored {
                tracing::warn!(
                    "Cannot restore Codex session {}: {error}",
                    entry.path().display()
                );
            }
        }
    }

    pub fn backends(&self) -> Vec<orb_common::AgentBackend> {
        self.config.backends.list()
    }

    pub fn list_sessions(&self, filter: ListSessionsQuery) -> Result<Vec<Session>> {
        self.db.list_sessions(&filter)
    }

    pub fn get_session(&self, ident: &str) -> Result<Session> {
        self.db
            .get_session(ident)?
            .with_context(|| format!("session not found: {ident}"))
    }

    pub async fn stop_session(&self, ident: &str) -> Result<Session> {
        let session = self.get_session(ident)?;
        if session.mode == SessionMode::Web {
            if session.status == SessionStatus::Running {
                match self.codex_session(&session.id).await {
                    Ok(_) => {}
                    Err(error)
                        if session
                            .codex_thread_id
                            .as_deref()
                            .is_some_and(|id| thread_missing(&error, id)) => {}
                    Err(error) => return Err(error),
                }
                let mut web = self.web.lock().await;
                let current = self.get_session(&session.id)?;
                if current.status != SessionStatus::Running {
                    return Ok(current);
                }
                if let Some(handle) = web.get(&session.id) {
                    handle.stop().await?;
                }
                web.remove(&session.id);
                self.db
                    .update_runtime(&session.id, None, SessionStatus::Stopped, Some(0))?;
                let stopped = self.get_session(&session.id)?;
                self.save_web_session(&stopped)?;
                return Ok(stopped);
            }
            let mut web = self.web.lock().await;
            if self.get_session(&session.id)?.status == SessionStatus::Running {
                drop(web);
                // A concurrent /resume may have reopened the session.
                bail!("대화가 다시 열렸습니다. 세션 상태를 새로고침한 뒤 중단하세요.");
            }
            if let Some(handle) = web.remove(&session.id) {
                handle.close().await;
            }
            return Ok(session);
        }
        if let Some(supervisor) = self.supervisors.write().unwrap().remove(&session.id) {
            supervisor.stop().ok();
        }
        self.db
            .update_runtime(&session.id, session.pid, SessionStatus::Stopped, Some(0))?;
        audit::append(
            &self.config.audit_path,
            audit::AuditEvent {
                timestamp: String::new(),
                action: "session.stop",
                session_id: Some(&session.id),
                detail: None,
            },
        );
        self.get_session(&session.id)
    }

    pub async fn delete_session(&self, ident: &str) -> Result<()> {
        let session = self.get_session(ident)?;
        if session.mode == SessionMode::Web {
            self.stop_session(&session.id).await?;
            let path = self.web_metadata_path(&session.id);
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            self.db.delete_session(&session.id)?;
            self.has_input.lock().unwrap().remove(&session.id);
            return Ok(());
        }
        if let Some(supervisor) = self.supervisors.write().unwrap().remove(&session.id) {
            supervisor.stop().ok();
        }
        self.db.delete_session(&session.id)?;
        audit::append(
            &self.config.audit_path,
            audit::AuditEvent {
                timestamp: String::new(),
                action: "session.delete",
                session_id: Some(&session.id),
                detail: None,
            },
        );
        Ok(())
    }

    pub fn logs(&self, ident: &str, tail: usize) -> Result<orb_common::LogsResponse> {
        self.db.logs(ident, tail)
    }

    pub fn logs_page(
        &self,
        ident: &str,
        after: i64,
        limit: usize,
        until: Option<i64>,
    ) -> Result<orb_common::LogsResponse> {
        self.db.logs_page(ident, after, limit, until)
    }

    pub fn attach(&self, ident: &str) -> Result<Arc<PtyManager>> {
        let session = self.get_session(ident)?;
        if session.mode == SessionMode::Web {
            bail!("This session uses Codex Web. Open it in Orb Web instead of PTY attach.");
        }
        self.db.touch_attached(&session.id).ok();
        audit::append(
            &self.config.audit_path,
            audit::AuditEvent {
                timestamp: String::new(),
                action: "session.attach",
                session_id: Some(&session.id),
                detail: None,
            },
        );
        self.supervisors
            .read()
            .unwrap()
            .get(&session.id)
            .cloned()
            .with_context(|| format!("session is not attachable: {}", session.id))
    }
}

fn thread_missing(error: &anyhow::Error, id: &str) -> bool {
    let message = error.to_string();
    message.contains(&format!("no rollout found for thread id {id}"))
        || message.contains(&format!("thread not loaded: {id}"))
        || message.contains(&format!("thread not found: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Arc<Db> {
        let db = Arc::new(Db::open().unwrap());
        db.migrate().unwrap();
        db
    }
    #[tokio::test]
    async fn fork_registers_a_distinct_web_session_with_durable_history() {
        let fixture = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.codex_socket = fixture.socket.clone();
        config.data_dir = fixture.directory.join("data");
        config.audit_path = fixture.directory.join("audit");
        let restored_config = config.clone();
        let registry = SessionRegistry::new(database(), config);
        let source = registry
            .create_session(
                serde_json::from_value(serde_json::json!({
                    "tool":"codex","mode":"web","cwd":fixture.directory
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(registry
            .fork_web_thread(&source.id, "old-thread", "turn-1")
            .await
            .is_err());
        assert!(registry
            .fork_web_thread(&source.id, "test-thread", "unknown")
            .await
            .is_err());
        assert!(registry
            .fork_web_thread(&source.id, "test-thread", "ignored")
            .await
            .is_err());
        assert_eq!(
            registry
                .list_sessions(ListSessionsQuery::default())
                .unwrap()
                .len(),
            1
        );

        let branch = registry
            .fork_web_thread(&source.id, "test-thread", "turn-1")
            .await
            .unwrap();
        assert_ne!(source.id, branch.id);
        assert_eq!(branch.codex_thread_id.as_deref(), Some("forked-thread"));
        assert!(branch.pid.is_none());
        assert_eq!(
            registry.get_session(&source.id).unwrap().codex_thread_id,
            source.codex_thread_id
        );
        assert!(registry
            .codex_session(&source.id)
            .await
            .unwrap()
            .connected());

        let restored = SessionRegistry::new(database(), restored_config);
        assert_eq!(
            restored.get_session(&branch.id).unwrap().codex_thread_id,
            branch.codex_thread_id
        );
        assert!(restored.has_input.lock().unwrap().contains(&branch.id));
    }
    #[tokio::test]
    async fn web_sessions_have_no_pty_and_restore_the_same_thread_mapping_after_restart() {
        let fixture = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.codex_socket = fixture.socket.clone();
        config.data_dir = fixture.directory.join("data");
        config.audit_path = fixture.directory.join("audit.jsonl");
        let registry = SessionRegistry::new(database(), config.clone());
        let req: CreateSessionRequest = serde_json::from_value(
            serde_json::json!({"tool":"codex","mode":"web","cwd":fixture.directory}),
        )
        .unwrap();
        let session = registry.create_session(req).await.unwrap();
        assert!(session.pid.is_none());
        assert_eq!(session.codex_thread_id.as_deref(), Some("test-thread"));
        assert!(registry.attach(&session.id).is_err());
        let handle = registry.codex_session(&session.id).await.unwrap();
        let suggestion = handle
            .operation(&serde_json::json!({"op":"command","command":"/rename"}))
            .await
            .unwrap();
        assert_eq!(suggestion["suggestion"], "파일 브라우저를 개선해 주세요");
        assert_eq!(registry.get_session(&session.id).unwrap().name, session.name);
        let renamed = registry
            .rename_web_session(
                &session.id,
                &handle,
                &serde_json::json!({"op":"command","command":"/rename 파일 브라우저 개선"}),
            )
            .await
            .unwrap();
        assert_eq!(renamed["session"]["name"], "파일 브라우저 개선");
        assert_eq!(registry.get_session(&session.id).unwrap().name, "파일 브라우저 개선");
        registry
            .web
            .lock()
            .await
            .remove(&session.id)
            .unwrap()
            .close()
            .await;
        drop(registry);
        let restored = SessionRegistry::new(database(), config);
        assert_eq!(restored.get_session(&session.id).unwrap().name, "파일 브라우저 개선");
        assert_eq!(
            restored.get_session(&session.id).unwrap().codex_thread_id,
            session.codex_thread_id
        );
        let handle = restored.codex_session(&session.id).await.unwrap();
        assert_eq!(handle.thread_id(), "test-thread");
        restored.stop_session(&session.id).await.unwrap();
        assert_eq!(
            restored.get_session(&session.id).unwrap().status,
            SessionStatus::Stopped
        );
        restored.delete_session(&session.id).await.unwrap();
        assert!(restored.get_session(&session.id).is_err());
    }
    #[tokio::test]
    async fn resume_switches_the_same_orb_session_preserves_saved_settings_and_survives_restart() {
        let f = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.codex_socket = f.socket.clone();
        config.data_dir = f.directory.join("data");
        config.audit_path = f.directory.join("audit.jsonl");
        let registry = SessionRegistry::new(database(), config.clone());
        let session = registry
            .create_session(
                serde_json::from_value(
                    serde_json::json!({"tool":"codex","mode":"web","cwd":f.directory}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let old = registry.codex_session(&session.id).await.unwrap();
        assert_eq!(
            old.snapshot()["settings"]["sandboxPolicy"]["type"],
            "dangerFullAccess"
        );
        assert_eq!(old.snapshot()["settings"]["approvalPolicy"], "never");
        let target = "11111111-1111-4111-8111-111111111111";
        let list = old
            .operation(&serde_json::json!({"op":"command","command":"/resume"}))
            .await
            .unwrap();
        assert_eq!(list["data"][0]["id"], target);
        assert!(registry
            .resume_web_thread(&session.id, "../../etc/passwd")
            .await
            .is_err());
        assert!(old.connected());
        let next = registry
            .resume_web_thread(&session.id, target)
            .await
            .unwrap();
        assert_eq!(session.id, next.id);
        assert_eq!(next.codex_thread_id.as_deref(), Some(target));
        assert_eq!(
            registry
                .list_sessions(ListSessionsQuery::default())
                .unwrap()
                .len(),
            1
        );
        assert!(!old.connected());
        let handle = registry.codex_session(&session.id).await.unwrap();
        assert_eq!(
            handle.snapshot()["settings"]["approvalPolicy"],
            "on-request"
        );
        assert_eq!(
            handle.snapshot()["settings"]["sandboxPolicy"]["type"],
            "workspaceWrite"
        );
        handle
            .operation(&serde_json::json!({"op":"send","text":"working"}))
            .await
            .unwrap();
        assert!(registry
            .resume_web_thread(&session.id, "22222222-2222-4222-8222-222222222222")
            .await
            .is_err());
        assert_eq!(handle.thread_id(), target);
        handle
            .operation(&serde_json::json!({"op":"interrupt"}))
            .await
            .unwrap();
        let switching = handle.begin_switch().unwrap();
        assert!(handle
            .operation(&serde_json::json!({"op":"queue","text":"racing input"}))
            .await
            .is_err());
        drop(switching);
        handle.close().await;
        drop(registry);
        let restored = SessionRegistry::new(database(), config);
        let saved = restored.get_session(&session.id).unwrap();
        assert_eq!(saved.codex_thread_id.as_deref(), Some(target));
        let resumed = restored.codex_session(&session.id).await.unwrap();
        assert_eq!(resumed.thread_id(), target);
        resumed.close().await;
    }
    #[tokio::test]
    async fn only_known_empty_missing_threads_can_be_recreated_after_restart() {
        let f = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.codex_socket = f.socket.clone();
        config.data_dir = f.directory.join("data");
        config.audit_path = f.directory.join("audit.jsonl");
        let registry = SessionRegistry::new(database(), config.clone());
        let session = registry
            .create_session(
                serde_json::from_value(
                    serde_json::json!({"tool":"codex","mode":"web","cwd":f.directory}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        registry
            .web
            .lock()
            .await
            .remove(&session.id)
            .unwrap()
            .close()
            .await;
        registry
            .db
            .update_codex_thread(&session.id, "missing-thread")
            .unwrap();
        registry
            .save_web_session(&registry.get_session(&session.id).unwrap())
            .unwrap();
        drop(registry);
        let registry = SessionRegistry::new(database(), config.clone());
        let replacement = registry.codex_session(&session.id).await.unwrap();
        assert_eq!(replacement.thread_id(), "test-thread");
        assert_eq!(
            registry
                .get_session(&session.id)
                .unwrap()
                .codex_thread_id
                .as_deref(),
            Some("test-thread")
        );
        registry.mark_web_input(&session.id).unwrap();
        registry
            .web
            .lock()
            .await
            .remove(&session.id)
            .unwrap()
            .close()
            .await;
        registry
            .db
            .update_codex_thread(&session.id, "missing-thread")
            .unwrap();
        registry
            .save_web_session(&registry.get_session(&session.id).unwrap())
            .unwrap();
        drop(registry);
        let protected = SessionRegistry::new(database(), config);
        assert!(protected.codex_session(&session.id).await.is_err());
        assert_eq!(
            protected
                .get_session(&session.id)
                .unwrap()
                .codex_thread_id
                .as_deref(),
            Some("missing-thread")
        );
        // A definitely absent thread has no running task and does not prevent deleting its Orb metadata.
        protected.delete_session(&session.id).await.unwrap();
    }
    #[tokio::test]
    async fn legacy_cli_creation_still_spawns_a_pty_and_stops_the_child() {
        let f = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.data_dir = f.directory.join("data");
        config.session_logs_dir = f.directory.clone();
        config.audit_path = f.directory.join("audit.jsonl");
        config.backends =
            crate::adapter::AgentBackends::from_items(vec![orb_common::AgentBackend {
                id: "shell".into(),
                name: "Shell".into(),
                command: "/bin/sh".into(),
                args: vec!["-c".into(), "printf legacy-ok; sleep 30".into()],
            }])
            .unwrap();
        let registry = SessionRegistry::new(database(), config);
        let request =
            serde_json::from_value(serde_json::json!({"tool":"shell","cwd":f.directory})).unwrap();
        let session = registry.create_session(request).await.unwrap();
        assert_eq!(session.mode, SessionMode::Cli);
        assert!(session.pid.is_some());
        assert!(session.codex_thread_id.is_none());
        assert!(registry.attach(&session.id).is_ok());
        registry.stop_session(&session.id).await.unwrap();
        assert_eq!(
            registry.get_session(&session.id).unwrap().status,
            SessionStatus::Stopped
        );
    }
    #[tokio::test]
    async fn legacy_requests_default_to_cli_and_invalid_web_requests_do_not_create_sessions() {
        let f = crate::codex::tests::fixture().await;
        let mut config = Config::default();
        config.data_dir = f.directory.join("data");
        let registry = SessionRegistry::new(database(), config);
        let legacy: CreateSessionRequest =
            serde_json::from_value(serde_json::json!({"tool":"codex"})).unwrap();
        assert_eq!(legacy.mode, SessionMode::Cli);
        for value in [
            serde_json::json!({"tool":"claude","mode":"web"}),
            serde_json::json!({"tool":"codex","mode":"web","env":{"X":"Y"}}),
        ] {
            assert!(registry
                .create_session(serde_json::from_value(value).unwrap())
                .await
                .is_err());
        }
        assert!(registry
            .list_sessions(ListSessionsQuery::default())
            .unwrap()
            .is_empty());
    }
}
