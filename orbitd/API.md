# Orbit API

All endpoints except `/healthz` require `Authorization: Bearer <token>`.

- `POST /api/v1/sessions` creates a session with `{ "tool": "codex", "mode": "cli", "name": "...", "cwd": "...", "env": {} }`. Omit `mode` to use CLI. Codex Web requests use `"mode": "web"` with an empty or omitted `env`.
- `GET /api/v1/backends` lists agent backends available to `orbitd`.
- `GET /api/v1/sessions` lists sessions.
- `GET /api/v1/sessions/:id` returns one session by id or name.
- `POST /api/v1/sessions/:id/stop` stops a session.
- `DELETE /api/v1/sessions/:id` removes a session and stops its process if it is still running.
- `GET /api/v1/sessions/:id/logs?tail=100` returns base64-encoded PTY output chunks.
- `WS /api/v1/sessions/:id/attach` relays CLI terminal frames as described in the [architecture guide](../docs/en/ARCHITECTURE.md).
- `WS /api/v1/sessions/:id/codex` handles Web chat. See the [Codex Web guide](../docs/ko/CODEX-WEB.md#서버-준비).
- `POST /api/v1/sessions/:id/images` and `POST /api/v1/sessions/:id/files?name=filename` upload Web attachments. The corresponding `GET` routes take the returned attachment ID.
- `GET /api/v1/fs/dirs?path=/path` lists visible child directories. If `path` is omitted, the server uses `$ORBIT_WORKSPACE` or the `orbitd` current working directory.
- `POST /api/v1/fs/dirs` creates one child directory with `{ "parent": "/path", "name": "child" }`.
- `GET /api/v1/fs/entries?path=/path` lists visible files and directories, sorted with directories first. Pass `include_hidden=true` to include dotfiles and hidden directories, as the Files tab does.
- `GET /api/v1/fs/files?path=/path/file.txt` reads a UTF-8 text file up to 10 MB.
- `POST /api/v1/fs/files` creates an empty file with `{ "parent": "/path", "name": "file.txt" }`. An existing name returns HTTP 409.
- `PUT /api/v1/fs/files` writes a text file with `{ "path": "/path/file.txt", "content": "..." }`.

`tool` is a backend ID from `/api/v1/backends`. By default, `orbitd` exposes `codex`, `claude`, `opencode`, and `pi`. To override the list, define an inline `backends` array in `/etc/orbitd/config.yaml`.

The filesystem API operates on paths visible to the `orbitd` process. Directory listings omit hidden entries. Entry listings include them when requested with `include_hidden=true`. File reads reject non-files, non-UTF-8 content, and files larger than 10 MB.

Example `backends` section inside `/etc/orbitd/config.yaml`:

```yaml
backends:
  - id: aider
    name: Aider
    command: aider
    args:
      - --yes-always
  - id: local-agent
    command: /usr/local/bin/local-agent
    args: ["--mode", "workspace"]
```
