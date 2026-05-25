use chrono::Utc;
use serde::Serialize;
use std::{fs::OpenOptions, io::Write, path::Path};

#[derive(Debug, Serialize)]
pub struct AuditEvent<'a> {
    pub timestamp: String,
    pub action: &'a str,
    pub session_id: Option<&'a str>,
    pub detail: Option<&'a str>,
}

pub fn append(path: &Path, event: AuditEvent<'_>) {
    let event = AuditEvent {
        timestamp: Utc::now().to_rfc3339(),
        ..event
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(file, "{line}");
        }
    }
}
