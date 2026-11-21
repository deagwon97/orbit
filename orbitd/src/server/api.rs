use super::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use orb_common::{
    CreateEntryRequest, CreateEntryResponse, CreateSessionRequest, FsDirEntry, FsEntry,
    FsEntryKind, ListDirsResponse, ListEntriesResponse, ListSessionsQuery, LogsQuery,
    ReadFileResponse, StopRequest, WriteFileRequest,
};
use serde::Deserialize;
use std::path::{Path as FsPath, PathBuf};
use tokio::fs;

pub async fn list_backends(State(state): State<AppState>) -> Response {
    let backends: Vec<_> = state
        .registry
        .backends()
        .iter()
        .map(|backend| {
            let mut value = serde_json::to_value(backend).unwrap();
            value["modes"] = if backend.id == "codex" && state.registry.codex_available() {
                serde_json::json!(["cli", "web"])
            } else {
                serde_json::json!(["cli"])
            };
            value
        })
        .collect();
    Json(backends).into_response()
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Response {
    match state.registry.create_session(req).await {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, format!("{err:#}")).into_response(),
    }
}

pub async fn list_sessions(
    State(state): State<AppState>,
    Query(query): Query<ListSessionsQuery>,
) -> Response {
    match state.registry.list_sessions(query) {
        Ok(sessions) => Json(sessions).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn get_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.registry.get_session(&id) {
        Ok(session) => Json(session).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

pub async fn stop_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(_req): Json<StopRequest>,
) -> Response {
    match state.registry.stop_session(&id).await {
        Ok(session) => Json(session).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

pub async fn delete_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.registry.delete_session(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListDirsQuery {
    pub path: Option<String>,
}

pub async fn list_dirs(
    State(_state): State<AppState>,
    Query(query): Query<ListDirsQuery>,
) -> Response {
    let fallback = std::env::var("ORBIT_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let requested = query
        .path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback);

    let current = match fs::canonicalize(&requested).await {
        Ok(p) => p,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    let meta = match fs::metadata(&current).await {
        Ok(m) => m,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    if !meta.is_dir() {
        return (StatusCode::BAD_REQUEST, "path is not a directory").into_response();
    }

    let mut read_dir = match fs::read_dir(&current).await {
        Ok(e) => e,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };

    let mut dirs = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if let Ok(ft) = entry.file_type().await {
            if ft.is_dir() {
                dirs.push(FsDirEntry {
                    path: current.join(&name),
                    name,
                });
            }
        }
    }
    dirs.sort_by(|a, b| a.name.cmp(&b.name));

    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let parent = current.parent().map(|p| p.to_path_buf());

    Json(ListDirsResponse {
        cwd,
        home,
        path: current,
        parent,
        dirs,
    })
    .into_response()
}

pub async fn create_dir(Json(req): Json<CreateEntryRequest>) -> Response {
    create_entry(req, FsEntryKind::Dir).await
}

pub async fn create_file(Json(req): Json<CreateEntryRequest>) -> Response {
    create_entry(req, FsEntryKind::File).await
}

async fn create_entry(req: CreateEntryRequest, kind: FsEntryKind) -> Response {
    let parent_input = req
        .parent
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let name = req.name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        let message = match kind {
            FsEntryKind::Dir => "invalid folder name",
            FsEntryKind::File => "invalid file name",
        };
        return (StatusCode::BAD_REQUEST, message).into_response();
    }

    let parent = match fs::canonicalize(&parent_input).await {
        Ok(path) => path,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };
    match fs::metadata(&parent).await {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return (StatusCode::BAD_REQUEST, "parent is not a directory").into_response(),
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }

    let path = parent.join(name);
    let result = match kind {
        FsEntryKind::Dir => fs::create_dir(&path).await,
        FsEntryKind::File => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .map(drop),
    };
    match result {
        Ok(()) => (StatusCode::CREATED, Json(CreateEntryResponse { path })).into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => (
            StatusCode::CONFLICT,
            "An entry with that name already exists.",
        )
            .into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            (StatusCode::FORBIDDEN, err.to_string()).into_response()
        }
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListEntriesQuery {
    path: Option<String>,
    #[serde(default)]
    include_hidden: bool,
}

pub async fn list_entries(
    State(_state): State<AppState>,
    Query(query): Query<ListEntriesQuery>,
) -> Response {
    let fallback = std::env::var("ORBIT_WORKSPACE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let requested = query
        .path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback);

    let current = match fs::canonicalize(&requested).await {
        Ok(p) => p,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    if !fs::metadata(&current)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return (StatusCode::BAD_REQUEST, "path is not a directory").into_response();
    }

    let mut read_dir = match fs::read_dir(&current).await {
        Ok(e) => e,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !query.include_hidden && name.starts_with('.') {
            continue;
        }
        if let Ok(ft) = entry.file_type().await {
            let kind = if ft.is_dir() {
                FsEntryKind::Dir
            } else if ft.is_file() {
                FsEntryKind::File
            } else {
                continue;
            };
            entries.push(FsEntry {
                path: current.join(&name),
                name,
                kind,
            });
        }
    }
    entries.sort_by(|a, b| match (&a.kind, &b.kind) {
        (FsEntryKind::Dir, FsEntryKind::File) => std::cmp::Ordering::Less,
        (FsEntryKind::File, FsEntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));

    Json(ListEntriesResponse {
        parent: current.parent().map(|p| p.to_path_buf()),
        home,
        path: current,
        entries,
        can_create_file: true,
        can_move_file: cfg!(target_os = "linux"),
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct MoveFileRequest {
    path: PathBuf,
    parent: PathBuf,
}

pub async fn move_file(Json(req): Json<MoveFileRequest>) -> Response {
    let Some(name) = req.path.file_name() else {
        return (StatusCode::BAD_REQUEST, "A source filename is required.").into_response();
    };
    if !req.path.is_absolute() || !req.parent.is_absolute() {
        return (StatusCode::BAD_REQUEST, "Absolute paths are required.").into_response();
    }
    match fs::symlink_metadata(&req.path).await {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return (StatusCode::BAD_REQUEST, "Source is not a regular file.").into_response(),
        Err(err) => return move_file_error(err),
    }
    let parent = match fs::canonicalize(&req.parent).await {
        Ok(path) => path,
        Err(err) => return move_file_error(err),
    };
    let destination = parent.join(name);
    match tokio::task::spawn_blocking({
        let destination = destination.clone();
        move || rename_file_exclusive(&req.path, &destination)
    })
    .await
    {
        Ok(Ok(())) => Json(CreateEntryResponse { path: destination }).into_response(),
        Ok(Err(err)) => move_file_error(err),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

fn move_file_error(err: std::io::Error) -> Response {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::AlreadyExists => (
            StatusCode::CONFLICT,
            "An entry with that name already exists.",
        )
            .into_response(),
        ErrorKind::CrossesDevices => (
            StatusCode::BAD_REQUEST,
            "Files can only be moved within the same filesystem.",
        )
            .into_response(),
        ErrorKind::NotFound => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
        ErrorKind::NotADirectory | ErrorKind::InvalidInput => {
            (StatusCode::BAD_REQUEST, err.to_string()).into_response()
        }
        ErrorKind::PermissionDenied => (StatusCode::FORBIDDEN, err.to_string()).into_response(),
        ErrorKind::Unsupported => (StatusCode::NOT_IMPLEMENTED, err.to_string()).into_response(),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

#[cfg(target_os = "linux")]
fn rename_file_exclusive(source: &FsPath, destination: &FsPath) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // The kernel checks for a collision and renames in the same operation.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "linux"))]
fn rename_file_exclusive(_source: &FsPath, _destination: &FsPath) -> std::io::Result<()> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(all(test, target_os = "linux"))]
mod move_file_tests {
    use super::*;

    #[tokio::test]
    async fn moves_regular_files_without_overwriting_destination() {
        struct TestDirectory(PathBuf);
        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory = TestDirectory(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()));
        let parent = directory.0.join("target");
        fs::create_dir_all(&parent).await.unwrap();
        let source = directory.0.join("새 파일.txt");
        let destination = parent.join("새 파일.txt");
        fs::write(&source, "source").await.unwrap();
        fs::write(&destination, "destination").await.unwrap();

        let request = || {
            Json(MoveFileRequest {
                path: source.clone(),
                parent: parent.clone(),
            })
        };
        assert_eq!(move_file(request()).await.status(), StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&source).await.unwrap(), "source");
        assert_eq!(
            fs::read_to_string(&destination).await.unwrap(),
            "destination"
        );

        fs::remove_file(&destination).await.unwrap();
        assert_eq!(move_file(request()).await.status(), StatusCode::OK);
        assert!(!fs::try_exists(&source).await.unwrap());
        assert_eq!(fs::read_to_string(&destination).await.unwrap(), "source");
        assert_eq!(move_file(request()).await.status(), StatusCode::NOT_FOUND);
    }
}

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

pub async fn read_file(
    State(_state): State<AppState>,
    Query(query): Query<FilePathQuery>,
) -> Response {
    let path = PathBuf::from(&query.path);

    let meta = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    };

    if !meta.is_file() {
        return (StatusCode::BAD_REQUEST, "path is not a file").into_response();
    }

    if meta.len() > MAX_FILE_SIZE {
        return (StatusCode::BAD_REQUEST, "file too large (max 10 MB)").into_response();
    }

    match fs::read_to_string(&path).await {
        Ok(content) => Json(ReadFileResponse {
            path: fs::canonicalize(&path).await.unwrap_or(path),
            content,
        })
        .into_response(),
        Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }
}

pub async fn read_raw_file(
    State(_state): State<AppState>,
    Query(query): Query<FilePathQuery>,
) -> Response {
    let path = PathBuf::from(&query.path);

    let meta = match fs::metadata(&path).await {
        Ok(m) => m,
        Err(err) => return (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    };

    if !meta.is_file() {
        return (StatusCode::BAD_REQUEST, "path is not a file").into_response();
    }

    if meta.len() > MAX_FILE_SIZE {
        return (StatusCode::BAD_REQUEST, "file too large (max 10 MB)").into_response();
    }

    let bytes = match fs::read(&path).await {
        Ok(b) => b,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };

    let content_type = mime_for_path(&path);
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn mime_for_path(path: &PathBuf) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("tiff") | Some("tif") => "image/tiff",
        _ => "application/octet-stream",
    }
}

pub async fn write_file(
    State(_state): State<AppState>,
    Json(req): Json<WriteFileRequest>,
) -> Response {
    if let Err(err) = fs::write(&req.path, &req.content).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
    }
    Json(serde_json::json!({ "path": req.path })).into_response()
}

pub async fn get_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<LogsQuery>,
) -> Response {
    let result = if let Some(tail) = query.tail {
        state.registry.logs(&id, tail)
    } else {
        state.registry.logs_page(
            &id,
            query.after.unwrap_or(0),
            query.limit.unwrap_or(200),
            query.until,
        )
    };
    match result {
        Ok(logs) => Json(logs).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}
