use crate::adapter::AgentBackends;
use anyhow::Context;
use orb_common::AgentBackend;
use serde::Deserialize;
use std::{fs, path::PathBuf};

/// Default directory holding orbitd configuration files.
const DEFAULT_CONFIG_DIR: &str = "/etc/orbitd";
/// Environment variable overriding the config file path.
const ENV_CONFIG: &str = "ORBITD_CONFIG";
/// Environment variable overriding the token file path.
const ENV_TOKEN_PATH: &str = "ORBITD_TOKEN_PATH";

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: String,
    pub config_path: PathBuf,
    pub data_dir: PathBuf,
    pub session_logs_dir: PathBuf,
    pub audit_path: PathBuf,
    pub token_path: PathBuf,
    pub process_path: String,
    pub scrollback_lines: usize,
    pub scrollback_max_bytes: usize,
    pub backends: AgentBackends,
}

fn default_config_path() -> PathBuf {
    std::env::var(ENV_CONFIG)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_CONFIG_DIR).join("config.yaml"))
}

fn default_token_path() -> PathBuf {
    std::env::var(ENV_TOKEN_PATH)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_CONFIG_DIR).join("token"))
}

impl Default for Config {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let data_dir = PathBuf::from(&home).join(".local/share/orbit");
        let session_logs_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tmp");

        // Get PATH from user's shell if available, otherwise from current env
        let process_path = get_user_path().unwrap_or_else(|_| std::env::var("PATH").unwrap_or_default());

        Self {
            listen: "127.0.0.1:7777".into(),
            audit_path: data_dir.join("audit.jsonl"),
            token_path: default_token_path(),
            process_path,
            backends: AgentBackends::default(),
            config_path: default_config_path(),
            data_dir,
            session_logs_dir,
            scrollback_lines: 10_000,
            scrollback_max_bytes: 100 * 1024 * 1024,
        }
    }
}

fn get_user_path() -> Result<String, Box<dyn std::error::Error>> {
    // Try to get PATH from user's shell profile
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;

    // Try reading from common shell config files
    let shell_configs = [
        PathBuf::from(&home).join(".profile"),
        PathBuf::from(&home).join(".bash_profile"),
        PathBuf::from(&home).join(".bashrc"),
        PathBuf::from(&home).join(".zshrc"),
        PathBuf::from(&home).join(".zprofile"),
    ];

    for config in &shell_configs {
        if config.exists() {
            if let Ok(content) = std::fs::read_to_string(config) {
                // Look for PATH=... or export PATH=...
                for line in content.lines() {
                    let line = line.trim();
                    if line.starts_with("export PATH=") || line.starts_with("PATH=") {
                        if let Some(eq_pos) = line.find('=') {
                            let path_value = line[eq_pos + 1..].trim().trim_matches('"').trim_matches('\'');
                            if !path_value.is_empty() {
                                // Expand $HOME and ~
                                let expanded = path_value.replace("$HOME", &home).replace("~", &home);
                                return Ok(expanded);
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: try to run shell and get PATH
    if let Ok(output) = std::process::Command::new("/bin/bash")
        .args(["-c", "echo $PATH"])
        .env("HOME", &home)
        .output()
    {
        if output.status.success() {
            if let Ok(path) = String::from_utf8(output.stdout) {
                return Ok(path.trim().to_string());
            }
        }
    }

    Err("Could not determine user PATH".into())
}

#[derive(Debug, Deserialize)]
struct FileConfig {
    listen: Option<String>,
    backends: Option<Vec<AgentBackend>>,
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
        if cfg.config_path.exists() {
            let raw = fs::read_to_string(&cfg.config_path)
                .with_context(|| format!("read config {}", cfg.config_path.display()))?;
            let file: FileConfig = serde_yaml::from_str(&raw)
                .with_context(|| format!("parse config {}", cfg.config_path.display()))?;
            if let Some(listen) = file.listen {
                cfg.listen = listen;
            }
            if let Some(items) = file.backends {
                cfg.backends = AgentBackends::from_items(items)?;
            }
            if let Some(pty) = file.pty {
                cfg.scrollback_lines = pty.scrollback_lines.unwrap_or(cfg.scrollback_lines);
                cfg.scrollback_max_bytes =
                    pty.scrollback_max_bytes.unwrap_or(cfg.scrollback_max_bytes);
            }
        }
        Ok(cfg)
    }

    pub fn ensure_dirs(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create config dir {}", parent.display()))?;
        }
        if let Some(parent) = self.token_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create token dir {}", parent.display()))?;
        }
        fs::create_dir_all(&self.data_dir).context("create data dir")?;
        fs::create_dir_all(&self.session_logs_dir).context("create session logs dir")?;
        Ok(())
    }
}
