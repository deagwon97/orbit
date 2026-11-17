//! Private, session-scoped image files on the execution host, never arbitrary paths.
use anyhow::{bail, Context, Result};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;
pub const MAX_BYTES: usize = 50 * 1024 * 1024;
static UPLOAD: Mutex<()> = Mutex::new(());
fn private_dir(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let meta = fs::symlink_metadata(path)?;
    // The daemon and Codex run as the same Unix user.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("Image directory is not private");
    }
    Ok(())
}
fn directory(session: &str, create: bool) -> Result<PathBuf> {
    if session.len() != 12
        || !session
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("Invalid session ID");
    }
    let root =
        std::env::temp_dir().join(format!("orbit-codex-images-{}", unsafe { libc::geteuid() }));
    if create {
        private_dir(&root)?;
    }
    let dir = root.join(session);
    if create {
        private_dir(&dir)?;
    }
    Ok(dir)
}
fn extension(mime: &str, bytes: &[u8]) -> Result<&'static str> {
    match mime {
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("png"),
        "image/jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Ok("jpg"),
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Ok("webp")
        }
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Ok("gif"),
        _ => bail!("PNG, JPEG, WebP, GIF 이미지만 첨부할 수 있습니다. 파일 형식을 확인하세요."),
    }
}
pub fn mime(id: &str) -> Result<&'static str> {
    let (uuid, ext) = id.rsplit_once('.').context("Invalid image ID")?;
    if Uuid::parse_str(uuid)?.to_string() != uuid {
        bail!("Invalid image ID");
    }
    match ext {
        "png" => Ok("image/png"),
        "jpg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        _ => bail!("Invalid image type"),
    }
}
pub fn path(session: &str, id: &str) -> Result<PathBuf> {
    mime(id)?;
    let dir = directory(session, false)?;
    // Refuse symlinks and files made writable by other users.
    private_existing(&dir)?;
    let path = dir.join(id);
    let meta = fs::symlink_metadata(&path)?;
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("Invalid image file");
    }
    Ok(path)
}
fn private_existing(dir: &Path) -> Result<()> {
    for path in [dir.parent().context("Missing image root")?, dir] {
        let m = fs::symlink_metadata(path)?;
        if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
            bail!("Invalid image directory");
        }
    }
    Ok(())
}
pub fn save(session: &str, mime: &str, bytes: &[u8]) -> Result<serde_json::Value> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        bail!("이미지는 파일당 최대 50 MiB입니다.");
    }
    let ext = extension(mime, bytes)?;
    let _guard = UPLOAD.lock().unwrap();
    let dir = directory(session, true)?;
    let entries: Vec<_> = fs::read_dir(&dir)?.collect::<std::io::Result<_>>()?;
    let size: u64 = entries
        .iter()
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();
    if entries.len() >= 128 || size + bytes.len() as u64 > 512 * 1024 * 1024 {
        bail!("이 세션의 임시 이미지 한도(512 MiB / 128개)에 도달했습니다.");
    }
    let id = format!("{}.{}", Uuid::new_v4(), ext);
    let path = dir.join(&id);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)?;
    if let Err(e) = file.write_all(bytes) {
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(serde_json::json!({"id":id,"path":path,"mime":mime,"size":bytes.len()}))
}
pub fn read(session: &str, id: &str) -> Result<Vec<u8>> {
    let path = path(session, id)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let mut out = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut out)?;
    if out.len() > MAX_BYTES {
        bail!("Image too large");
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_fifty_mib_and_rejects_larger_files() {
        let session = Uuid::new_v4().simple().to_string()[..12].to_string();
        let mut bytes = vec![0; MAX_BYTES];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let upload = save(&session, "image/png", &bytes).unwrap();
        assert_eq!(
            fs::metadata(upload["path"].as_str().unwrap())
                .unwrap()
                .len(),
            MAX_BYTES as u64
        );
        bytes.push(0);
        assert!(save(&session, "image/png", &bytes).is_err());
        fs::remove_dir_all(directory(&session, false).unwrap()).unwrap();
    }
    #[test]
    fn images_are_private_session_scoped_and_cannot_resolve_arbitrary_files() {
        let session = Uuid::new_v4().simple().to_string()[..12].to_string();
        let uploaded = save(&session, "image/png", b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let id = uploaded["id"].as_str().unwrap();
        assert_eq!(read(&session, id).unwrap(), b"\x89PNG\r\n\x1a\nfixture");
        assert!(read(&Uuid::new_v4().simple().to_string()[..12].to_string(), id).is_err());
        assert!(read(&session, "../../etc/passwd").is_err());
        assert!(save(&session, "image/png", b"<svg></svg>").is_err());
        assert!(save(&session, "image/svg+xml", b"<svg></svg>").is_err());
        let path = path(&session, id).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", path).unwrap();
        assert!(read(&session, id).is_err());
        fs::remove_dir_all(directory(&session, false).unwrap()).unwrap();
    }
}
