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
    path::Path,
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
        let mut cmd = CommandBuilder::new(executable);
        cmd.cwd(cwd);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn {executable}"))?;
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
                    break;
                }
            }
        });
        Ok((manager, pid))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
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
