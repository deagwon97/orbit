# Orbit API

All endpoints except `/healthz` require `Authorization: Bearer <token>`.

- `POST /api/v1/sessions` creates a session with `{ "tool": "codex", "name": "...", "cwd": "...", "env": {} }`.
- `GET /api/v1/backends` lists agent backends available to `orbitd`.
- `GET /api/v1/sessions` lists sessions.
- `GET /api/v1/sessions/:id` returns one session by id or name.
- `POST /api/v1/sessions/:id/stop` stops a session.
- `DELETE /api/v1/sessions/:id` removes a session and stops its process if it is still running.
- `GET /api/v1/sessions/:id/logs?tail=100` returns base64-encoded PTY output chunks.
- `WS /api/v1/sessions/:id/attach` relays JSON messages documented in `ARCHITECTURE.md`.

`tool` is a backend ID from `/api/v1/backends`. By default, `orbitd` exposes `codex`, `claude`, `opencode`, and `pi`. To override the list, set `ORBIT_BACKENDS_CONFIG` or `backends = "/path/to/backends.yaml"` in `~/.config/orbit/config.toml`.

Example `backends.yaml`:

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
