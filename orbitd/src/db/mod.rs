use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use orb_common::{ListSessionsQuery, LogLine, Session, SessionStatus, ToolType};
use rusqlite::{params, Connection, OptionalExtension};
use std::{str::FromStr, sync::Mutex};

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open() -> Result<Self> {
        Ok(Self {
            conn: Mutex::new(Connection::open_in_memory().context("open in-memory session db")?),
        })
    }

    pub fn migrate(&self) -> Result<()> {
        self.conn.lock().unwrap().execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                tool TEXT NOT NULL,
                pid INTEGER,
                cwd TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_attached_at TEXT,
                exit_code INTEGER
            );
            CREATE TABLE IF NOT EXISTS session_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id, id);
            "#,
        )?;
        Ok(())
    }

    pub fn create_session(&self, session: &Session) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO sessions (id, name, tool, pid, cwd, status, created_at, last_attached_at, exit_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session.id,
                session.name,
                session.tool.to_string(),
                session.pid,
                session.cwd.to_string_lossy(),
                session.status.to_string(),
                session.created_at.to_rfc3339(),
                session.last_attached_at.map(|v| v.to_rfc3339()),
                session.exit_code
            ],
        )?;
        Ok(())
    }

    pub fn update_runtime(
        &self,
        id: &str,
        pid: Option<u32>,
        status: SessionStatus,
        exit_code: Option<i32>,
    ) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET pid = ?2, status = ?3, exit_code = ?4 WHERE id = ?1",
            params![id, pid, status.to_string(), exit_code],
        )?;
        Ok(())
    }

    pub fn touch_attached(&self, id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE sessions SET last_attached_at = ?2 WHERE id = ?1",
            params![id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_sessions(&self, filter: &ListSessionsQuery) -> Result<Vec<Session>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, tool, pid, cwd, status, created_at, last_attached_at, exit_code FROM sessions ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], row_to_session)?;
        let mut out = Vec::new();
        for row in rows {
            let session = row?;
            if filter
                .tool
                .as_ref()
                .is_some_and(|tool| tool != &session.tool)
            {
                continue;
            }
            if filter
                .status
                .as_ref()
                .is_some_and(|status| status != &session.status)
            {
                continue;
            }
            out.push(session);
        }
        Ok(out)
    }

    pub fn get_session(&self, ident: &str) -> Result<Option<Session>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT id, name, tool, pid, cwd, status, created_at, last_attached_at, exit_code FROM sessions WHERE id = ?1 OR name = ?1 LIMIT 1",
                [ident],
                row_to_session,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn delete_session(&self, ident: &str) -> Result<bool> {
        let changed = self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM sessions WHERE id = ?1 OR name = ?1", [ident])?;
        Ok(changed > 0)
    }

    pub fn append_log(&self, session_id: &str, content: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO session_logs (session_id, timestamp, content) VALUES (?1, ?2, ?3)",
            params![session_id, Utc::now().to_rfc3339(), content],
        )?;
        Ok(())
    }

    pub fn logs(&self, ident: &str, tail: usize) -> Result<Vec<LogLine>> {
        let session = self.get_session(ident)?.context("session not found")?;
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT timestamp, content FROM session_logs WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session.id, tail as i64], |row| {
            let ts: String = row.get(0)?;
            Ok(LogLine {
                timestamp: DateTime::parse_from_rfc3339(&ts)
                    .unwrap()
                    .with_timezone(&Utc),
                content: row.get(1)?,
            })
        })?;
        let mut lines = rows.collect::<Result<Vec<_>, _>>()?;
        lines.reverse();
        Ok(lines)
    }
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let tool: String = row.get(2)?;
    let status: String = row.get(5)?;
    let created_at: String = row.get(6)?;
    let last_attached_at: Option<String> = row.get(7)?;
    Ok(Session {
        id: row.get(0)?,
        name: row.get(1)?,
        tool: ToolType::from_str(&tool).unwrap(),
        pid: row.get(3)?,
        cwd: std::path::PathBuf::from(row.get::<_, String>(4)?),
        status: SessionStatus::from_str(&status).unwrap(),
        created_at: DateTime::parse_from_rfc3339(&created_at)
            .unwrap()
            .with_timezone(&Utc),
        last_attached_at: last_attached_at.map(|v| {
            DateTime::parse_from_rfc3339(&v)
                .unwrap()
                .with_timezone(&Utc)
        }),
        exit_code: row.get(8)?,
    })
}
