# Orbit Architecture

Orbit consists of a central runtime server `orbitd` (Rust) and a Go client `orb` (TUI + CLI). The TUI implements session CRUD, log retrieval, and WebSocket attach directly.

```
Terminal (orb TUI/CLI)         Browser (web UI)
       |                             |
       | REST: sessions CRUD, logs   | REST: sessions CRUD, logs
       | WebSocket: attach           | WebSocket: attach (relayed)
       v                             v
   orbitd (Rust + axum)    web/backend (Fastify reverse proxy)
       |                      |  Proxies /api/v1/sessions/* + /api/v1/backends
       |                      |  Adds /api/v1/fs/dirs (browse/create dirs)
       |                      v
       +-------> configured agent backends (child processes)
       |
       | In-memory SQLite (sessions + logs)
       | Raw log files (./tmp/<session-id>.log)
       | JSONL audit log (~/.local/share/orbit/audit.jsonl)
```

Core principle: only `orbitd` owns the PTY and child processes. The TUI, CLI, and web UI are all API clients. The web backend acts as a reverse proxy, forwarding session and backend API calls to `orbitd` while adding its own filesystem endpoints.

## Package Roles

```text
orbitd/
  Rust daemon server. HTTP/WebSocket API, auth, session registry, PTY management,
  in-memory session storage, audit logging.
  Contains `orb-common/` (shared Rust types) and `API.md` (API summary).

orb/
  Orbit local client. Go Bubble Tea TUI + CLI. Handles session listing, creation,
  attach, stop, delete, and logs.

web/
  Web client — two parts:
  backend/  Fastify (Node.js) reverse proxy. Proxies orbitd session and backend
            API endpoints. Adds /api/v1/fs/dirs for directory browsing and creation.
  frontend/ React + Vite + xterm.js. Browser-based session UI with full
            terminal emulation, folder picker, log viewer, and login screen.
```

## orbitd Internals

`orbitd/src/main.rs` performs config loading, token generation/loading, in-memory DB migration, `SessionRegistry` creation, and axum server binding.

### Module Map

```text
server/
  api.rs   REST endpoint handlers
  ws.rs    WebSocket attach handler
  mod.rs   Route composition and Bearer token middleware

session/
  registry.rs  Session registry — create, list, get, stop, delete, attach entry point

pty/
  manager.rs     portable-pty based process spawn, output broadcast, resize, stop
  input.rs       Input arbiter — single-writer enforcement for stdin
  scrollback.rs  Scrollback buffer (bounded by line count and byte size)
  utf8.rs        UTF-8 decoder — reassembles partial multi-byte sequences across chunks

db/
  mod.rs  In-memory SQLite — sessions and session_logs tables

auth/
  token.rs  ~/.config/orbit/token load/create and Authorization header validation

adapter/
  mod.rs  Agent backend registry, default backends, and YAML backend config parser
```

### SessionRegistry

`SessionRegistry` is the central coordinator. It holds:

- An `Arc<Db>` (in-memory SQLite) for persistent metadata and logs.
- A `Config` for paths and limits.
- A `RwLock<HashMap<String, Arc<PtyManager>>>` of live, attachable sessions.

On `create_session`:
1. Generates a 12-character session ID from a UUID v4.
2. Inserts a `created` session row into the in-memory DB.
3. Resolves `req.tool` as a backend ID from the configured backend registry.
4. Calls `PtyManager::spawn` to start the backend command inside a PTY.
5. On success, updates the session status to `running` in DB and stores the `PtyManager` in the live map.
6. On failure, rolls back by deleting the session row.

On `delete_session` or `stop_session`:
1. Looks up the session.
2. If a `PtyManager` is in the live map, calls `stop()` (kills the child process).
3. Updates or removes the session row.
4. Appends an audit event.

On `attach`:
1. Looks up the session.
2. Returns the `Arc<PtyManager>` from the live map.
3. Fails if the session has already exited (no `PtyManager` in map).

### Auth

Token-based authentication using a random 32-byte secret stored at `~/.config/orbit/token`. Format:

```
orbit_<base64url-nopad-32-bytes>
```

All `/api/v1/*` requests require `Authorization: Bearer <token>`. `/healthz` is unauthenticated.

## API

Base: `http://127.0.0.1:7777`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Health check → `"ok"` |
| `GET` | `/api/v1/backends` | List configured agent backends |
| `POST` | `/api/v1/sessions` | Create session and spawn backend process |
| `GET` | `/api/v1/sessions` | List sessions (`?tool=codex`, `?status=running`) |
| `GET` | `/api/v1/sessions/:id` | Get session by ID or name |
| `POST` | `/api/v1/sessions/:id/stop` | Stop a running session |
| `DELETE` | `/api/v1/sessions/:id` | Delete session (kills process if running) |
| `GET` | `/api/v1/sessions/:id/logs?tail=N` | Get base64-encoded log chunks |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket upgrade for live attach |

### Create Session Request

```json
{
  "tool": "codex",
  "name": "optional-name",
  "cwd": "/home/user/project",
  "env": { "KEY": "VALUE" }
}
```

`tool` is a backend ID returned by `GET /api/v1/backends`.

### WebSocket Attach Protocol

JSON-framed messages over a WebSocket connection.

**Client → Server:**

| Type | Fields | Purpose |
|------|--------|---------|
| `stdin` | `data` (base64) | PTY input |
| `resize` | `cols`, `rows` (u16) | PTY resize — applied immediately |
| `ping` | — | Keepalive |
| `detach` | — | End the attach session gracefully |

**Server → Client:**

| Type | Fields | Purpose |
|------|--------|---------|
| `stdout` | `data` (base64) | PTY output |
| `status` | `value` (SessionStatus) | Session status change notification |
| `exit` | `code` (i32 or null) | Process exit notification |
| `pong` | — | Ping response |
| `error` | `code`, `message` | Error notification |

### Log Retrieval

`GET /api/v1/sessions/:id/logs?tail=N` returns base64-encoded chunks from the in-memory `session_logs` table, ordered by insertion. Set `tail=0` for all logs. Logs are stored base64-encoded, one row per PTY read chunk (~8 KB).

## Session Lifecycle

```
created
  → running     spawn succeeded
  → stopped     stop requested or process exited with code 0
  → crashed     process exited non-zero or error
  → removed     DELETE / TUI rm after stopped/crashed
```

On `create_session`:
1. `SessionRegistry` generates a 12-char ID from UUID v4.
2. Inserts `created` status into in-memory DB.
3. Resolves the requested backend ID to a command and argument list.
4. `PtyManager::spawn` executes the backend command inside a PTY.
5. On success, status advances to `running`.

## Output Flow

Backend PTY output fans out through four paths simultaneously:

```
PTY reader thread (blocking read in std::thread)
  |
  ├──→ ScrollbackBuffer (bounded by lines/bytes, for new attaches)
  ├──→ broadcast::channel (for live WebSocket attach clients)
  ├──→ In-memory session_logs table (base64 encoded, SQLite)
  └──→ ./tmp/<session-id>.log (raw binary output file)
```

Additionally, a monitor thread polls `child.try_wait()` every 500 ms to detect exit and update the session status.

## Input Arbiter

Only one WebSocket client may write to the PTY at a time. The `InputArbiter` in `pty/input.rs` enforces single-writer semantics:

- `claim(client_id)` — registers a writer.
- `try_write(client_id)` — succeeds only if the caller is the current writer.
- `release(client_id)` — clears the writer if it matches.

When a client sends a `detach` WebSocket message or disconnects, the writer is released, allowing the next attach client to claim it.

## Storage

Default file layout:

```text
~/.config/orbit/config.toml       # TOML config (optional)
~/.config/orbit/backends.yaml     # Optional backend registry override
~/.config/orbit/token             # Bearer token (auto-generated)
~/.local/share/orbit/audit.jsonl  # JSONL audit trail (session lifecycles)
./tmp/<session-id>.log            # Raw PTY output (relative to orbitd CWD)
```

The in-memory SQLite database (not persisted to disk) contains:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tool TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_attached_at TEXT,
  exit_code INTEGER
);

CREATE TABLE IF NOT EXISTS session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

The audit log is a JSONL file at `~/.local/share/orbit/audit.jsonl`. Each line is a JSON object with `timestamp`, `action` (e.g. `session.create`, `session.attach`, `session.stop`, `session.delete`), `session_id`, and optional `detail`.

## TUI Client

`orb` connects to `http://127.0.0.1:7777` and reads the token from `~/.config/orbit/token`.

Capabilities implemented directly (no external subprocess):

- Run / create session
- List running or all sessions
- WebSocket attach
- Delete session
- Tail log display (last 100 chunks)

### Attach Implementation

The attach logic lives in `orb/internal/attach/`. It performs:

1. **WebSocket handshake** — raw HTTP upgrade with manual frame masking/unmasking, SHA-1 accept validation.
2. **Terminal raw mode** — enables raw mode on stdin via `unix.IoctlSetTermios`, with full restore on detach.
3. **Detach sequence detection** — scans stdin for `Ctrl-]` (0x1D), `Ctrl-\` (0x1C), and CSI-u / xterm modifyOtherKeys variants. Detach tokens are not forwarded to the PTY. Terminal fallback: `Ctrl-G`, `Ctrl-^`, `Ctrl-_` also trigger detach.
4. **Color adaptation** — on attach, queries the terminal's OSC 11 background color and adjusts SGR codes (swap black/white for visibility on light vs dark backgrounds).
5. **Resize loop** — `SIGWINCH` handler sends `resize` messages over the WebSocket.
6. **Output sanitization for logs** — escape sequence stripping, blank line compaction, backspace handling.
7. **Replay on attach** — when connecting, the server sends the scrollback snapshot first, then live output follows.

### TUI Keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` or `k` / `j` | Move selection |
| `enter` / `a` | Attach |
| `n` | Create session form |
| `x` | Delete selected |
| `l` | Show last 100 log chunks |
| `tab` | Toggle running/all filter |
| `r` | Refresh |
| `q` / `Ctrl-C` | Quit |

Session creation form fields: `tool` (backend ID from `orbitd`, ←/→ to cycle), `name`, `cwd`, `env` (space-separated KEY=VALUE), `detach` (true = return to list, false = attach immediately).

## Agent Backends

`orbitd` keeps an in-memory `AgentBackends` registry. If no backend YAML exists, the registry uses these defaults:

| Backend ID | Command | Extra args |
|------------|---------|------------|
| `codex` | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude` | `--dangerously-skip-permissions` |
| `opencode` | `opencode` | _(none)_ |
| `pi` | `pi` | _(none)_ |

The default registry is replaced when `ORBIT_BACKENDS_CONFIG` or `backends = "/path/to/backends.yaml"` in `~/.config/orbit/config.toml` points to a YAML file:

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

The API exposes the active registry through `GET /api/v1/backends`; `orb`, the TUI, and the web UI use that endpoint to populate backend selectors.

Environment setup happens in the PTY spawn path: TERM, COLORTERM, COLORFGBG are injected, NO_COLOR is stripped, and all terminal-related environment variables from the `orb` client (TERM_PROGRAM, KITTY_WINDOW_ID, etc.) are forwarded to the child process.

## Web Client Details

### Web Backend (`web/backend/`)

Built with Fastify (Node.js) and runs on port 3001 by default. It serves a dual role:

1. **Reverse proxy** — forwards `/api/v1/sessions/*` and `/api/v1/backends` requests to `orbitd`, including WebSocket attach upgrades. The browser never connects directly to `orbitd`.
2. **Filesystem API** — provides two additional endpoints not present in `orbitd`:
   - `GET /api/v1/fs/dirs?path=...` — lists subdirectories of the given path, along with `parent` (for "up" navigation), `home`, and `cwd` references.
   - `POST /api/v1/fs/dirs` — creates a new empty directory (`{ "parent": "...", "name": "..." }`).

The web backend reads the orbitd token from the `ORBIT_TOKEN` environment variable, the request `Authorization` header, or a `token` query parameter. It authenticates against `orbitd` on each filesystem request.

Configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Web backend listen port |
| `ORBITD_URL` | `http://127.0.0.1:7777` | Upstream orbitd URL |
| `ORBIT_TOKEN` | `""` | Bearer token for orbitd auth |

### Web Frontend (`web/frontend/`)

Built with React + Vite + xterm.js. Single-page application with:

- **Login screen** — prompts for the orbitd Bearer token, stored in `localStorage`.
- **Toolbar** — backend selector populated from `/api/v1/backends`, name input, cwd input + folder picker, env input, Attach toggle, Run button, All/Running filter, Refresh, Logout.
- **Session list** — clickable rows showing ID, name, tool, status (color-coded pill), PID.
- **Session pane** — two tabs:
  - **Attach** — xterm.js terminal connected via WebSocket through the backend proxy. Features: automatic resize (ResizeObserver), scroll-follow, detach detection (`Ctrl-]`/`Ctrl-\`), exit notification, reconnection.
  - **Logs** — read-only xterm.js showing base64-decoded output (last 500 chunks).
- **Folder picker** — modal dialog for browsing the server filesystem. Navigate up/home/server-cwd, create new folders, select a working directory. Uses the `/api/v1/fs/dirs` endpoints.

## Current Limitations

- Running sessions can be deleted, which kills the process immediately.
- Only sessions with a live `PtyManager` in the registry are attachable. Sessions that have already exited cannot be reattached.
- On `orbitd` restart, all session metadata and logs are lost (in-memory SQLite).
- No WebSocket log streaming — logs are REST-pull only (`GET /logs?tail=N`).
- No session persistence to disk (aside from raw log files and the audit trail).
- The web backend authenticates independently for filesystem requests — if the proxy token is missing or wrong, directory browsing fails even when the frontend token is valid.
