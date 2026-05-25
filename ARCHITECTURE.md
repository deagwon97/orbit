# Orbit Architecture

## 현재 구조

Orbit은 중앙 런타임 서버 `orbitd`와 Go TUI 클라이언트 `orb`로 구성된다. Rust 기반 `orbit` CLI 패키지는 제거되었고, TUI가 세션 CRUD, 로그 조회, attach를 모두 직접 구현한다.

```text
사용자 터미널
  |
  v
orb (Go + Bubble Tea)
  | REST: sessions CRUD, logs
  | WebSocket: attach stdin/stdout
  v
orbitd (Rust + axum)
  | SessionRegistry
  | PtyManager
  | in-memory SQLite
  v
codex / claude / opencode / pi 프로세스
```

핵심 원칙은 하나다. PTY와 실제 도구 프로세스의 소유권은 `orbitd`만 가진다. TUI와 웹 UI는 모두 같은 API를 호출하는 클라이언트다.

## 패키지 역할

```text
orbitd/
  Rust daemon 서버. HTTP/WebSocket API, 인증, 세션 레지스트리, PTY 관리, 인메모리 세션 저장소를 담당한다.
  내부에 `orb-common/` Rust 공용 타입 crate와 `API.md` API 요약 문서를 둔다.

orb/
  Orbit 로컬 클라이언트. 현재는 Go Bubble Tea TUI이며 세션 목록, 생성, attach, stop, delete, logs를 직접 처리한다.

web/
  웹 UI 개발 영역. orbitd API를 사용하는 별도 클라이언트가 된다.
```

## orbitd 내부

`orbitd/src/main.rs`는 설정 로딩, 토큰 생성/로드, 인메모리 DB 마이그레이션, `SessionRegistry` 생성, axum 서버 바인딩을 수행한다.

주요 모듈은 다음과 같다.

```text
server/
  api.rs   REST endpoint
  ws.rs    attach WebSocket endpoint
  mod.rs   route 구성과 Bearer token middleware

session/
  registry.rs  세션 생성/조회/중지/삭제/attach 진입점

pty/
  manager.rs     portable-pty 기반 프로세스 spawn, output broadcast, stop
  input.rs       attach writer 단일화
  scrollback.rs  최근 출력 버퍼
  utf8.rs        출력 chunk UTF-8 decode 보조

db/
  mod.rs  in-memory SQLite schema, sessions/logs CRUD

auth/
  token.rs  ~/.config/orbit/token 로드/생성 및 Authorization 검증

adapter/
  mod.rs  ToolType -> 실행 바이너리 매핑
```

## API

모든 `/api/v1/*` 요청은 `Authorization: Bearer <token>` 헤더가 필요하다. `/healthz`는 인증 없이 `ok`를 반환한다.

| Method | Path | 용도 |
| --- | --- | --- |
| `GET` | `/healthz` | 서버 상태 확인 |
| `POST` | `/api/v1/sessions` | 세션 생성 및 도구 프로세스 spawn |
| `GET` | `/api/v1/sessions` | 세션 목록 조회, `tool`, `status` query 지원 |
| `GET` | `/api/v1/sessions/:id` | ID 또는 name으로 세션 조회 |
| `POST` | `/api/v1/sessions/:id/stop` | 세션 중지 |
| `DELETE` | `/api/v1/sessions/:id` | 세션 삭제, running이면 프로세스도 종료 |
| `GET` | `/api/v1/sessions/:id/logs?tail=100` | base64 로그 조회 |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket attach |

세션 생성 request:

```json
{
  "tool": "codex",
  "name": "optional-name",
  "cwd": "/data/private/orbit",
  "env": { "KEY": "VALUE" }
}
```

WebSocket attach client message:

```json
{ "type": "stdin", "data": "<base64>" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "ping" }
```

WebSocket attach server message:

```json
{ "type": "stdout", "data": "<base64>" }
```

현재 서버는 resize 메시지를 프로토콜 호환 목적으로 수신하지만 PTY 크기는 초기값 `120x30`으로 유지한다.

## 세션 라이프사이클

```text
created
  -> running     spawn 성공
  -> stopped     stop 요청 또는 정상 종료
  -> crashed     비정상 종료 감지
  -> removed     stopped/crashed 상태에서 delete
```

세션 생성 시 `SessionRegistry`가 UUID 앞 12자를 ID로 만들고 인메모리 DB에 `created` 상태를 저장한다. 이후 `PtyManager::spawn`이 도구 바이너리를 PTY 안에서 실행하고, 성공하면 `running`으로 갱신한다.

도구 출력은 세 경로로 동시에 흐른다.

```text
PTY reader thread
  -> ScrollbackBuffer
  -> broadcast channel for live attach clients
  -> in-memory session_logs table, base64 encoded
  -> ./tmp/<session-id>.log raw output file
```

## 저장소

기본 경로는 다음과 같다. 세션 메타데이터와 REST 로그는 파일 DB에 저장하지 않고 `orbitd` 프로세스 메모리에만 유지한다. 원본 PTY 출력 로그는 `orbitd` 실행 위치 기준 `./tmp/<session-id>.log`에 저장한다.

```text
~/.config/orbit/config.toml
~/.config/orbit/token
~/.local/share/orbit/audit.jsonl
```

현재 인메모리 SQLite schema:

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

## TUI 동작

`orb`는 `http://127.0.0.1:7777`에 연결하고 `~/.config/orbit/token`을 읽어 Bearer token으로 사용한다.

TUI가 직접 구현하는 기능:

```text
run/create session
ps/list running or all sessions
attach over WebSocket
delete session
logs tail display
```

Attach 구현은 Go 내부 `orb/internal/attach`에 있다. attach 시 REST logs로 과거 기록을 먼저 출력한 뒤 WebSocket live attach를 시작한다. HTTP upgrade를 직접 수행하고, WebSocket frame mask 처리, stdin raw mode, stdout relay, `Ctrl-]`/`Ctrl-\` detach sequence를 처리한다. 터미널 호환 fallback으로 `Ctrl-G`, `Ctrl-^`, `Ctrl-_`도 detach로 처리한다. detach는 명시적 WebSocket `detach` 메시지로 서버에 전달된다. 더 이상 외부 attach subprocess를 실행하지 않는다.

## 지원 도구

`ToolType`과 실행 바이너리 매핑은 다음과 같다.

| Tool | 실행 바이너리 |
| --- | --- |
| `codex` | `codex` |
| `claude-code` | `claude` |
| `opencode` | `opencode` |
| `pi` | `pi` |

## 현재 제한

- 실행 중인 세션도 삭제할 수 있으며 삭제 시 프로세스를 종료한다.
- attach 가능한 세션은 현재 `orbitd` 프로세스 메모리에 `PtyManager`가 살아 있는 세션이다.
- `orbitd`가 종료되면 세션 메타데이터와 로그도 모두 사라진다.
- WebSocket log streaming route는 없다. 로그는 REST tail 조회만 제공한다.
- PTY resize는 메시지를 수신하지만 실제 resize 적용은 아직 MVP 범위 밖이다.
