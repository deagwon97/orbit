use crate::{
    config::Config,
    db::Db,
    pty::{input::InputArbiter, scrollback::ScrollbackBuffer, utf8::Utf8Decoder},
};
use anyhow::{Context, Result};
use orb_common::SessionStatus;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::time::Duration;
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

pub struct PtyManager {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    arbiter: Mutex<InputArbiter>,
    output_tx: broadcast::Sender<Vec<u8>>,
    scrollback: Mutex<ScrollbackBuffer>,
}

impl PtyManager {
    pub fn spawn(
        session_id: String,
        executable: &str,
        args: &[&str],
        cwd: &Path,
        env: &HashMap<String, String>,
        db: Arc<Db>,
        config: &Config,
    ) -> Result<(Arc<Self>, u32)> {
        let pty_system = native_pty_system();
        let initial_size = PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(initial_size)?;
        let path_env = env
            .get("PATH")
            .map(String::as_str)
            .unwrap_or(&config.process_path);
        let resolved_executable = resolve_executable(executable, path_env);
        let mut cmd = CommandBuilder::new(&resolved_executable);
        cmd.args(args);
        cmd.cwd(cwd);
        apply_default_env(&mut cmd, path_env, env);
        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn {executable} with PATH={path_env}"))?;
        let pid = child.process_id().unwrap_or_default();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (output_tx, _) = broadcast::channel(512);
        let manager = Arc::new(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            arbiter: Mutex::new(InputArbiter::default()),
            output_tx,
            scrollback: Mutex::new(ScrollbackBuffer::new(
                config.scrollback_lines,
                config.scrollback_max_bytes,
            )),
        });
        let tx = manager.output_tx.clone();
        let reader_manager = manager.clone();
        let reader_db = db.clone();
        let reader_session_id = session_id.clone();
        let log_path = config.session_logs_dir.join(format!("{session_id}.log"));
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut utf8_decoder = Utf8Decoder::default();
            let mut log_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        if let Some(file) = log_file.as_mut() {
                            let _ = file.write_all(&chunk);
                            let _ = file.flush();
                        }
                        let _ = utf8_decoder.decode(&chunk);
                        reader_manager
                            .scrollback
                            .lock()
                            .unwrap()
                            .push(chunk.clone());
                        let _ = tx.send(chunk.clone());
                        let content = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &chunk,
                        );
                        let _ = reader_db.append_log(&reader_session_id, &content);
                    }
                    Err(_) => break,
                }
            }
        });
        let monitor_manager = manager.clone();
        let monitor_db = db;
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let status = {
                let mut child = monitor_manager.child.lock().unwrap();
                child.try_wait()
            };
            match status {
                Ok(Some(exit)) => {
                    let code = exit.exit_code() as i32;
                    let state = if exit.success() {
                        SessionStatus::Stopped
                    } else {
                        SessionStatus::Crashed
                    };
                    let _ = monitor_db.update_runtime(&session_id, Some(pid), state, Some(code));
                    monitor_manager.publish_system_output(
                        &monitor_db,
                        &session_id,
                        format!("\r\n[orb] process exited with code {code}\r\n").into_bytes(),
                    );
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    let _ = monitor_db.update_runtime(
                        &session_id,
                        Some(pid),
                        SessionStatus::Crashed,
                        Some(1),
                    );
                    monitor_manager.publish_system_output(
                        &monitor_db,
                        &session_id,
                        b"\r\n[orb] process status check failed\r\n".to_vec(),
                    );
                    break;
                }
            }
        });
        Ok((manager, pid))
    }

    pub fn subscribe_with_scrollback(&self) -> (broadcast::Receiver<Vec<u8>>, Vec<Vec<u8>>) {
        let scrollback = self.scrollback.lock().unwrap();
        let snapshot = scrollback
            .get_last_n(usize::MAX)
            .into_iter()
            .map(|line| line.content)
            .collect();
        (self.output_tx.subscribe(), snapshot)
    }

    pub fn claim_writer(&self, client_id: &str) {
        self.arbiter.lock().unwrap().claim(client_id);
    }

    pub fn write(&self, client_id: &str, data: &[u8]) -> Result<()> {
        self.arbiter.lock().unwrap().try_write(client_id)?;
        self.writer.lock().unwrap().write_all(data)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master.lock().unwrap().resize(size)?;
        Ok(())
    }

    pub fn release_writer(&self, client_id: &str) {
        self.arbiter.lock().unwrap().release(client_id);
    }

    pub fn stop(&self) -> Result<()> {
        self.child.lock().unwrap().kill()?;
        Ok(())
    }

    fn publish_system_output(&self, db: &Db, session_id: &str, chunk: Vec<u8>) {
        self.scrollback.lock().unwrap().push(chunk.clone());
        let _ = self.output_tx.send(chunk.clone());
        let content = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &chunk);
        let _ = db.append_log(session_id, &content);
    }

    #[allow(dead_code)]
    pub fn scrollback(&self, n: usize) -> Vec<Vec<u8>> {
        self.scrollback
            .lock()
            .unwrap()
            .get_last_n(n)
            .into_iter()
            .map(|line| line.content)
            .collect()
    }
}

fn apply_default_env(cmd: &mut CommandBuilder, path_env: &str, env: &HashMap<String, String>) {
    cmd.env("PATH", path_env);
    cmd.env_remove("NO_COLOR");
    set_env_if_missing(cmd, env, "TERM", "xterm-256color");
    set_env_if_missing(cmd, env, "COLORTERM", "truecolor");
    set_env_if_missing(cmd, env, "COLORFGBG", "15;0");
    for key in ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"] {
        if !env.contains_key(key) {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
}

fn set_env_if_missing(
    cmd: &mut CommandBuilder,
    env: &HashMap<String, String>,
    key: &str,
    fallback: &str,
) {
    if env.contains_key(key) {
        return;
    }
    let value = std::env::var(key).unwrap_or_else(|_| fallback.to_string());
    cmd.env(key, value);
}

fn resolve_executable(executable: &str, path_env: &str) -> String {
    if executable.contains(std::path::MAIN_SEPARATOR) {
        return executable.to_string();
    }
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(executable);
        if is_executable_file(&candidate) {
            return candidate.to_string_lossy().into_owned();
        }
    }
    executable.to_string()
}

#[cfg(unix)]
fn is_executable_file(path: &PathBuf) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.is_file()
        && path
            .metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &PathBuf) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::resolve_executable;

    #[test]
    fn leaves_unresolved_executable_when_path_does_not_match() {
        assert_eq!(resolve_executable("codex", "/no/such/path"), "codex");
    }
}
