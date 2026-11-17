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
            let handle = crate::codex::CodexSession::connect(&self.config.codex_socket).await?;
            let id = match handle.create(&session.cwd).await {
                Ok(id) => id,
                Err(error) => {
                    handle.close().await;
                    return Err(error);
                }
            };
            session.codex_thread_id = Some(id);
            session.status = SessionStatus::Running;
            if let Err(error) = self
                .save_web_session(&session)
                .and_then(|_| self.db.create_session(&session))
            {
                handle.close().await;
                return Err(error);
            }
            self.web.lock().await.insert(session.id.clone(), handle);
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

    pub async fn codex_session(&self, ident: &str) -> Result<crate::codex::CodexSession> {
        let mut session = self.get_session(ident)?;
        if session.mode != SessionMode::Web || session.tool != "codex" {
            bail!("This is not a Codex Web session");
        }
        let mut web = self.web.lock().await;
        if let Some(handle) = web.get(&session.id).filter(|handle| handle.connected()) {
            return Ok(handle.clone());
        }
        let handle = crate::codex::CodexSession::connect(&self.config.codex_socket).await?;
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
                let replacement =
                    crate::codex::CodexSession::connect(&self.config.codex_socket).await?;
                session.codex_thread_id = Some(replacement.create(&session.cwd).await?);
                self.save_web_session(&session)?;
                self.db.update_codex_thread(
                    &session.id,
                    session.codex_thread_id.as_deref().unwrap(),
                )?;
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
        web.insert(session.id, handle.clone());
        Ok(handle)
    }
    pub fn mark_web_input(&self, ident: &str) -> Result<()> {
        let session = self.get_session(ident)?;
        self.has_input.lock().unwrap().insert(session.id.clone());
        self.save_web_session(&session)
    }
    fn web_metadata_path(&self, id: &str) -> std::path::PathBuf {
        self.config
            .data_dir
            .join("codex-sessions")
            .join(format!("{id}.json"))
    }
    fn save_web_session(&self, session: &Session) -> Result<()> {
        let _guard = self.metadata.lock().unwrap();
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
                let session: Session = serde_json::from_value(metadata.clone())?;
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
                    Ok(handle) => handle.stop().await?,
                    Err(error)
                        if session
                            .codex_thread_id
                            .as_deref()
                            .is_some_and(|id| thread_missing(&error, id)) => {}
                    Err(error) => return Err(error),
                }
                self.web.lock().await.remove(&session.id);
                self.db
                    .update_runtime(&session.id, None, SessionStatus::Stopped, Some(0))?;
                let stopped = self.get_session(&session.id)?;
                self.save_web_session(&stopped)?;
                return Ok(stopped);
            }
            if let Some(handle) = self.web.lock().await.remove(&session.id) {
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
