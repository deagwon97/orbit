use crate::{adapter, audit, config::Config, db::Db, pty::manager::PtyManager};
use anyhow::{Context, Result};
use chrono::Utc;
use orb_common::{CreateSessionRequest, ListSessionsQuery, Session, SessionStatus};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};
use uuid::Uuid;

pub struct SessionRegistry {
    db: Arc<Db>,
    config: Config,
    supervisors: RwLock<HashMap<String, Arc<PtyManager>>>,
}

impl SessionRegistry {
    pub fn new(db: Arc<Db>, config: Config) -> Self {
        Self {
            db,
            config,
            supervisors: RwLock::new(HashMap::new()),
        }
    }

    pub fn create_session(&self, req: CreateSessionRequest) -> Result<Session> {
        let id = Uuid::new_v4().simple().to_string()[..12].to_string();
        let cwd = req.cwd.unwrap_or(std::env::current_dir()?);
        let name = req.name.unwrap_or_else(|| format!("{}-{id}", req.tool));
        let mut session = Session {
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
        self.db.create_session(&session)?;
        let executable = adapter::executable_for(&session.tool);
        let (pty, pid) = PtyManager::spawn(
            id.clone(),
            executable,
            &cwd,
            &req.env,
            self.db.clone(),
            &self.config,
        )?;
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
                detail: Some(executable),
            },
        );
        Ok(session)
    }

    pub fn list_sessions(&self, filter: ListSessionsQuery) -> Result<Vec<Session>> {
        self.db.list_sessions(&filter)
    }

    pub fn get_session(&self, ident: &str) -> Result<Session> {
        self.db
            .get_session(ident)?
            .with_context(|| format!("session not found: {ident}"))
    }

    pub fn stop_session(&self, ident: &str) -> Result<Session> {
        let session = self.get_session(ident)?;
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

    pub fn delete_session(&self, ident: &str) -> Result<()> {
        let session = self.get_session(ident)?;
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

    pub fn logs(&self, ident: &str, tail: usize) -> Result<Vec<orb_common::LogLine>> {
        self.db.logs(ident, tail)
    }

    pub fn attach(&self, ident: &str) -> Result<Arc<PtyManager>> {
        let session = self.get_session(ident)?;
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
