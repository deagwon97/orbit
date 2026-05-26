use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ToolType {
    Codex,
    #[serde(rename = "claude")]
    ClaudeCode,
    Opencode,
    Pi,
}

impl ToolType {
    pub fn executable(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
        }
    }
}

impl std::fmt::Display for ToolType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
        };
        f.write_str(value)
    }
}

impl std::str::FromStr for ToolType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::ClaudeCode),
            "opencode" => Ok(Self::Opencode),
            "pi" => Ok(Self::Pi),
            other => Err(format!("unsupported tool: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Created,
    Running,
    Stopped,
    Crashed,
}

impl std::fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::Created => "created",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Crashed => "crashed",
        };
        f.write_str(value)
    }
}

impl std::str::FromStr for SessionStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "created" => Ok(Self::Created),
            "running" => Ok(Self::Running),
            "stopped" => Ok(Self::Stopped),
            "crashed" => Ok(Self::Crashed),
            other => Err(format!("unsupported status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub tool: ToolType,
    pub pid: Option<u32>,
    pub cwd: PathBuf,
    pub status: SessionStatus,
    pub created_at: DateTime<Utc>,
    pub last_attached_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    pub tool: ToolType,
    pub name: Option<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ListSessionsQuery {
    pub tool: Option<ToolType>,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopRequest {
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogsQuery {
    pub tail: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub timestamp: DateTime<Utc>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogsResponse {
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum WsClientMessage {
    Stdin { data: String },
    Resize { cols: u16, rows: u16 },
    Ping,
    Detach,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum WsServerMessage {
    Stdout { data: String },
    Status { value: SessionStatus },
    Exit { code: Option<i32> },
    Pong,
    Error { code: String, message: String },
}
