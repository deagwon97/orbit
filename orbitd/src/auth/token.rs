use anyhow::{bail, Context};
use rand::RngCore;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

#[derive(Debug, Clone)]
pub struct TokenConfig {
    token: String,
}

impl TokenConfig {
    pub fn load_or_create(path: &Path) -> anyhow::Result<Self> {
        if !path.exists() {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let token = format!(
                "orbit_{}",
                base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
            );
            fs::write(path, format!("{token}\n")).context("write token file")?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok();
        }
        let token = fs::read_to_string(path)?.trim().to_string();
        if token.is_empty() {
            bail!("token file is empty: {}", path.display());
        }
        Ok(Self { token })
    }

    pub fn validate_header(&self, header: Option<&str>) -> bool {
        let Some(header) = header else { return false };
        let Some(token) = header.strip_prefix("Bearer ") else {
            return false;
        };
        token == self.token
    }
}
