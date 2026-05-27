use crate::adapter::AgentBackends;
use anyhow::Context;
use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: String,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub session_logs_dir: PathBuf,
    pub audit_path: PathBuf,
    pub token_path: PathBuf,
    pub process_path: String,
    pub scrollback_lines: usize,
    pub scrollback_max_bytes: usize,
    pub backends_path: PathBuf,
    pub backends: AgentBackends,
}

impl Default for Config {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let config_dir = PathBuf::from(&home).join(".config/orbit");
        let data_dir = PathBuf::from(&home).join(".local/share/orbit");
        let session_logs_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tmp");
        Self {
            listen: "127.0.0.1:7777".into(),
            audit_path: data_dir.join("audit.jsonl"),
            token_path: config_dir.join("token"),
            process_path: std::env::var("PATH").unwrap_or_default(),
            backends_path: std::env::var("ORBIT_BACKENDS_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|_| config_dir.join("backends.yaml")),
            backends: AgentBackends::default(),
            config_dir,
            data_dir,
            session_logs_dir,
            scrollback_lines: 10_000,
            scrollback_max_bytes: 100 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    listen: Option<String>,
    backends: Option<PathBuf>,
    pty: Option<PtyConfig>,
}

#[derive(Debug, Deserialize)]
struct PtyConfig {
    scrollback_lines: Option<usize>,
    scrollback_max_bytes: Option<usize>,
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let mut cfg = Self::default();
        let path = cfg.config_dir.join("config.toml");
        if path.exists() {
            let file: FileConfig = toml::from_str(&fs::read_to_string(&path)?)?;
            if let Some(listen) = file.listen {
                cfg.listen = listen;
            }
            if let Some(backends) = file.backends {
                cfg.backends_path = backends;
            }
            if let Some(pty) = file.pty {
                cfg.scrollback_lines = pty.scrollback_lines.unwrap_or(cfg.scrollback_lines);
                cfg.scrollback_max_bytes =
                    pty.scrollback_max_bytes.unwrap_or(cfg.scrollback_max_bytes);
            }
        }
        cfg.backends = AgentBackends::load(&cfg.backends_path)?;
        Ok(cfg)
    }

    pub fn ensure_dirs(&self) -> anyhow::Result<()> {
        fs::create_dir_all(&self.config_dir).context("create config dir")?;
        fs::create_dir_all(&self.data_dir).context("create data dir")?;
        fs::create_dir_all(&self.session_logs_dir).context("create session logs dir")?;
        Ok(())
    }
}
