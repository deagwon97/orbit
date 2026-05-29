use super::AppState;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use orb_common::{
    CreateDirRequest, CreateDirResponse, CreateSessionRequest, FsDirEntry, FsEntry, FsEntryKind,
    ListDirsResponse, ListEntriesResponse, ListSessionsQuery, LogsQuery, ReadFileResponse,
    StopRequest, WriteFileRequest,
};
use serde::Deserialize;
use std::path::PathBuf;
use tokio::fs;

pub async fn list_backends(State(state): State<AppState>) -> Response {
    Json(state.registry.backends()).into_response()
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Response {
    match state.registry.create_session(req) {
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
    match state.registry.stop_session(&id) {
        Ok(session) => Json(session).into_response(),
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

pub async fn delete_session(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.registry.delete_session(&id) {
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

pub async fn create_dir(
    State(_state): State<AppState>,
    Json(req): Json<CreateDirRequest>,
) -> Response {
    let parent_input = req.parent.unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });

    let name = req.name.trim().to_owned();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return (StatusCode::BAD_REQUEST, "invalid folder name").into_response();
    }

    let parent = match fs::canonicalize(&parent_input).await {
        Ok(p) => p,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    let meta = match fs::metadata(&parent).await {
        Ok(m) => m,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    if !meta.is_dir() {
        return (StatusCode::BAD_REQUEST, "parent is not a directory").into_response();
    }

    let created = parent.join(&name);
    if let Err(err) = fs::create_dir(&created).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
    }

    match fs::canonicalize(&created).await {
        Ok(p) => (StatusCode::CREATED, Json(CreateDirResponse { path: p })).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

pub async fn list_entries(
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

    if !fs::metadata(&current).await.map(|m| m.is_dir()).unwrap_or(false) {
        return (StatusCode::BAD_REQUEST, "path is not a directory").into_response();
    }

    let mut read_dir = match fs::read_dir(&current).await {
        Ok(e) => e,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };

    let mut entries = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
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
    })
    .into_response()
}

#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
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
    let ext = path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase());
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
