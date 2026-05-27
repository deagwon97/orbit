# Orbit

> A lightweight daemon for managing and multiplexing configurable AI coding agent sessions.

Orbit decouples AI coding agent sessions from your terminal. The `orbitd` daemon owns all PTY processes, sessions, and logs. The `orb` client (TUI or CLI) connects via REST/WebSocket — you can detach, reattach, and inspect sessions independently of your terminal lifetime.

## Features

- **Session management** — Create, list, attach, stop, and delete coding agent sessions.
- **Detach / reattach** — Start a session, detach with `Ctrl-]`, and reconnect later from any terminal.
- **Triple client** — Full-featured [Bubble Tea](https://github.com/charmbracelet/bubbletea) TUI, a CLI interface, and a **web UI** (React + xterm.js).
- **WebSocket attach** — Raw PTY I/O relay with automatic terminal color adaptation (light/dark background detection).
- **Scrollback + logs** — Sessions keep a configurable scrollback buffer; logs are persisted in-memory and as raw files.
- **Configurable agent backends** — `orbitd` reads backend command definitions from YAML, while keeping `codex`, `claude`, `opencode`, and `pi` defaults.
- **REST API + filesystem API** — JSON API for sessions, directory browsing, folder creation, and text file read/write.
- **Web terminal + editor** — Browser-based xterm.js attach with folder picker and a lightweight text file editor.
- **Audit trail** — All session lifecycle events are recorded to `audit.jsonl`.

## Architecture

```
Terminal (orb TUI/CLI)         Browser (web UI)
       |                             |
       | REST: sessions CRUD, logs   | REST: sessions CRUD, logs
       | WebSocket: attach           | WebSocket: attach (relayed)
       v                             v
   orbitd (Rust + axum)    web/backend (Fastify reverse proxy)
       |                      |  Proxies /api/v1/sessions/*, /api/v1/backends,
       |                      |  /api/v1/fs/*, and WebSocket attach
       |                      v
       +-------> configured agent backends (child processes)
       |
       | In-memory SQLite (sessions + logs)
       | Raw log files (./tmp/<id>.log)
       | JSONL audit log (~/.local/share/orbit/audit.jsonl)
```

Only `orbitd` owns the PTY, child processes, and filesystem API. The TUI, CLI, and web UI are all API clients. The web backend acts as a reverse proxy, forwarding session, backend, filesystem, and WebSocket attach calls to `orbitd` so the browser talks to a single same-origin API.

## Quick Start

### 1. Prerequisites

- **Rust toolchain** — for building `orbitd`
- **Go 1.23+** — for building the `orb` client
- **Node.js + npm** — optional, for the web UI
- Target backend commands on `PATH`, or absolute command paths in the backend YAML

### 2. Build & start the daemon

```bash
cd orbitd
cargo run -p orbitd
```

The server starts on `127.0.0.1:7777` by default. It uses these paths:

| Path | Purpose |
|------|---------|
| `~/.config/orbit/token` | Bearer token for client auth |
| `~/.config/orbit/config.toml` | Optional config file |
| `~/.local/share/orbit/audit.jsonl` | Session audit trail |

Session metadata and logs are stored in an in-memory SQLite database — **everything is lost when `orbitd` exits**. Raw PTY output is also written to `./tmp/<session-id>.log` for offline inspection.

### 3. Build & run the client

```bash
cd orb
go run .              # launch the TUI
```

Or use the CLI:

```bash
go build -o orb .
./orb ps              # list running sessions
./orb backends        # list backends exposed by orbitd
./orb run codex       # create a session and attach
```

## Usage

### TUI

```
┌──────────────────────────────────────────────────┐
│ Orb Sessions  running                             │
│                                                   │
│  ID           NAME           TOOL        STATUS   │
│ > abc12345    codex-abc12   codex       running   │
│   def67890    ...           claude      running   │
│                                                   │
│ enter/a attach | n create/run | x remove          │
│ l logs | tab toggle filter | r refresh | q quit   │
│ Ctrl-]/Ctrl-\ detach (while attached)             │
└──────────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move selection |
| `enter` or `a` | Attach to selected session |
| `n` | Open session creation form |
| `x` | Delete selected session |
| `l` | Show last 100 log chunks for selected session |
| `tab` | Toggle between running / all sessions filter |
| `r` | Refresh session list |
| `q` or `Ctrl-C` | Quit |

**Session creation form** — navigate with `tab`/`↑`/`↓`, edit with typing, toggle with `←`/`→`:

| Field | Description |
|-------|-------------|
| `tool` | Backend ID from `orbitd` (←/→ to cycle) |
| `name` | Optional session name |
| `cwd` | Optional working directory (defaults to current dir) |
| `env` | Space-separated `KEY=VALUE` pairs |
| `detach` | `true` → return to list; `false` → attach immediately |

**When attached**: press `Ctrl-]` or `Ctrl-\` to detach while keeping the session running. If your terminal intercepts those keys, `Ctrl-G`, `Ctrl-^`, or `Ctrl-_` also work.

### CLI

```bash
orb                    # launch TUI (no arguments)
orb backends           # list agent backends available from orbitd
orb ps                 # list running sessions
orb ps --all           # list all sessions (including stopped/crashed)
orb ps -a              # shorthand for --all

orb run codex          # create a session and attach
orb run --detach codex # create without attaching
orb run --name my-session --cwd /path/to/project codex
orb run -e KEY=VALUE -e FOO=bar codex

orb attach <id>        # attach to session by ID or name
orb logs <id>          # print all logs
orb logs --tail 50 <id>   # last 50 log chunks
orb logs --raw <id>    # print raw PTY output (no ANSI filtering)

orb rm <id>...         # delete one or more sessions by ID or name
```

### API

Base: `http://127.0.0.1:7777` — all endpoints except `/healthz` require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check (no auth) |
| `GET` | `/api/v1/backends` | List agent backends available to `orbitd` |
| `POST` | `/api/v1/sessions` | Create a session |
| `GET` | `/api/v1/sessions` | List sessions (`?status=running`, `?tool=codex`) |
| `GET` | `/api/v1/sessions/:id` | Get session by ID or name |
| `POST` | `/api/v1/sessions/:id/stop` | Stop a running session |
| `DELETE` | `/api/v1/sessions/:id` | Delete session (kills process if running) |
| `GET` | `/api/v1/sessions/:id/logs?tail=N` | Get base64-encoded log chunks |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket upgrade for live attach |
| `GET` | `/api/v1/fs/dirs?path=...` | List visible subdirectories for a path |
| `POST` | `/api/v1/fs/dirs` | Create a child directory |
| `GET` | `/api/v1/fs/entries?path=...` | List visible files and directories for a path |
| `GET` | `/api/v1/fs/files?path=...` | Read a UTF-8 text file, up to 10 MB |
| `PUT` | `/api/v1/fs/files` | Write UTF-8 text content to a file |

**Create session** request body:

```json
{
  "tool": "codex",
  "name": "my-session",
  "cwd": "/home/user/project",
  "env": { "KEY": "VALUE" }
}
```

The `tool` field is a backend ID from `/api/v1/backends`.

**WebSocket attach** — JSON-framed messages:

```
→ { "type": "stdin",  "data": "<base64>" }
→ { "type": "resize", "cols": 120, "rows": 40 }
→ { "type": "detach" }
← { "type": "stdout", "data": "<base64>" }
```

**Filesystem API** — `path` defaults to `$ORBIT_WORKSPACE` when set, otherwise the `orbitd` process working directory. Hidden entries are omitted. Directory listings return canonical paths plus `parent` and `home` references; file reads reject non-files, non-UTF-8 content, and files larger than 10 MB.

## Configuration

`orbitd` reads from `~/.config/orbit/config.toml` if it exists. Example:

```toml
listen = "127.0.0.1:7777"
backends = "/home/user/.config/orbit/backends.yaml"

[pty]
scrollback_lines = 10000
scrollback_max_bytes = 104857600
```

Default paths and runtime settings:

| Setting | Default |
|---------|---------|
| `listen` | `127.0.0.1:7777` |
| `config_dir` | `~/.config/orbit` |
| `data_dir` | `~/.local/share/orbit` |
| `session_logs_dir` | `./tmp` (relative to `orbitd` working dir) |
| `audit_path` | `~/.local/share/orbit/audit.jsonl` |
| `token_path` | `~/.config/orbit/token` |
| `process_path` | `$PATH` from server environment |
| `scrollback_lines` | 10,000 |
| `scrollback_max_bytes` | 100 MB |
| `backends_path` | `~/.config/orbit/backends.yaml` or `$ORBIT_BACKENDS_CONFIG` |

## Agent Backends

By default, `orbitd` exposes these backend IDs:

| Backend ID | Command | Extra args |
|------------|---------|------------|
| `codex` | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude` | `--dangerously-skip-permissions` |
| `opencode` | `opencode` | _(none)_ |
| `pi` | `pi` | _(none)_ |

To replace the defaults, point `orbitd` at a YAML file with either `ORBIT_BACKENDS_CONFIG=/path/to/backends.yaml` or the `backends` key in `~/.config/orbit/config.toml`.
This repository includes a default-compatible `backends.yaml` you can use directly.

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

The TUI, CLI, and web UI read the available backend list from `GET /api/v1/backends`.

## Build from Source

### Daemon (Rust)

```bash
cd orbitd
cargo build --workspace      # full workspace
cargo build -p orbitd         # daemon only
cargo build -p orbitd --release
# Binary: target/debug/orbitd or target/release/orbitd
```

### Client (Go)

```bash
cd orb
go build -o orb .
# Binary: ./orb
```

### Verification

```bash
cd orbitd && cargo check --workspace
cd orb    && go test ./... && go build -o orb .
```

### Web UI (optional)

The web client consists of two parts that run together:

- **Backend** (Fastify/Node.js on port 3001) — reverse proxy to `orbitd`.
  Proxies `orbitd` session, backend, filesystem, and attach endpoints:
  - `GET /api/v1/fs/dirs?path=...` — browse server directories
  - `POST /api/v1/fs/dirs` — create a new empty directory
  - `GET /api/v1/fs/entries?path=...` — browse files and directories
  - `GET /api/v1/fs/files?path=...` — read a text file
  - `PUT /api/v1/fs/files` — save a text file
- **Frontend** (React + xterm.js + Vite) — browser-based session UI with
  xterm.js terminal, folder picker, text file editor, session list, log viewer.

```bash
cd web/backend   && npm install && npm run dev
cd web/frontend  && npm install && npm run dev
```

The web backend accepts the following environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Web backend listen port |
| `ORBITD_URL` | `http://127.0.0.1:7777` | Upstream orbitd URL |
| `ORBIT_TOKEN` | `""` | Bearer token for orbitd auth |

## systemd Deployment

Create a service file at `/etc/systemd/system/orbitd.service`:

```ini
[Unit]
Description=Orbit daemon
After=network.target

[Service]
Type=simple
ExecStart=/opt/orbit/orbitd
Restart=on-failure
Environment=PATH=/usr/local/bin:/usr/bin:/home/your-user/.local/bin

[Install]
WantedBy=multi-user.target
```

Then:

```bash
cargo build -p orbitd --release
sudo install -m 0755 target/release/orbitd /opt/orbit/orbitd
sudo systemctl daemon-reload
sudo systemctl enable --now orbitd
```

> The `PATH` environment variable is critical when backend commands are not absolute paths. `orbitd` uses it to locate configured backend commands when spawning sessions.

## Session Lifecycle

```
created  →  running  →  stopped    (normal exit)
                      →  crashed    (non-zero exit / error)
                      →  removed    (DELETE API / TUI rm)
```

Sessions are stored in an in-memory SQLite database and are **not persisted** across `orbitd` restarts. Raw PTY output files (`./tmp/<id>.log`) survive a restart but cannot be reattached.

## Troubleshooting

| Problem | Check |
|---------|-------|
| TUI auth failure | Ensure `~/.config/orbit/token` exists — start `orbitd` once to generate it |
| Connection refused | Is `orbitd` running on `127.0.0.1:7777`? Check server logs |
| Web UI can't connect | Is the web backend running on port 3001? Is `ORBITD_URL` correct? Is the token set via `ORBIT_TOKEN` env or entered in the login screen? |
| Session creation fails | Is the backend ID listed by `orb backends`? Is its command on `PATH`, or configured as an absolute path? |
| "Cannot attach" | Session may have already exited and been cleaned up |
| Build errors (Rust) | Ensure `pkg-config` and `libdbus-1-dev` are installed (`portable-pty` dependency) |

## License

MIT
