# Orbit 아키텍처

Orbit은 중앙 런타임 서버 `orbitd`(Rust)와 Go 클라이언트 `orb`(TUI + CLI)로 구성된다. TUI가 세션 CRUD, 로그 조회, WebSocket attach를 모두 직접 구현한다.

```
터미널                      브라우저 (web UI)
(orb TUI/CLI)                      |
       |                   web/backend (Fastify)
       |                   (동일 출처 리버스 프록시)
       |                           |
       |  REST: sessions CRUD, logs, filesystem
       |  WebSocket: attach
       v
       orbitd (Rust + axum)
              |
              +-------> 설정된 에이전트 백엔드 (자식 프로세스)
              |
              | 인메모리 SQLite (세션 + 로그)
              | Raw 로그 파일 (./tmp/<session-id>.log)
              | JSONL 감사 로그 (~/.local/share/orbit/audit.jsonl)
```

핵심 원칙: `orbitd`만 PTY, 자식 프로세스, 파일시스템 API를 소유한다. TUI, CLI, 웹 UI는 모두 동일한 API를 호출하는 클라이언트다. 웹 백엔드는 리버스 프록시 역할을 하여 세션, 백엔드, 파일시스템, WebSocket attach 호출을 `orbitd`에 전달한다.

## 패키지 역할

```text
orbitd/
  Rust 데몬 서버. HTTP/WebSocket API, 인증, 세션 레지스트리, PTY 관리,
  인메모리 세션 저장소, 감사 로깅을 담당한다.
  `orb-common/`(공유 Rust 타입)과 `API.md`(API 요약)를 포함한다.

orb/
  Orbit 로컬 클라이언트. Go Bubble Tea TUI + CLI. 세션 목록, 생성,
  attach, stop, delete, logs를 처리한다.

web/
  웹 클라이언트 — 두 부분으로 구성:
  backend/  Fastify (Node.js) 리버스 프록시. orbitd 세션 및 백엔드 API
            엔드포인트, 파일시스템 엔드포인트, WebSocket attach를 프록시한다.
  frontend/ React + Vite + xterm.js. 브라우저 기반 세션 UI. 풀 터미널 에뮬레이션,
            폴더 선택기, 텍스트 파일 편집기, 로그 뷰어, 로그인 화면을 포함한다.
```

## orbitd 내부 구조

`orbitd/src/main.rs`는 설정 로딩, 토큰 생성/로드, 인메모리 DB 마이그레이션, `SessionRegistry` 생성, axum 서버 바인딩을 수행한다.

### 모듈 맵

```text
server/
  api.rs   REST endpoint 핸들러
  ws.rs    WebSocket attach 핸들러
  mod.rs   라우트 구성과 Bearer token 미들웨어

session/
  registry.rs  세션 레지스트리 — create, list, get, stop, delete, attach 진입점

pty/
  manager.rs     portable-pty 기반 프로세스 spawn, output broadcast, resize, stop
  input.rs       Input arbiter — stdin 단일 writer 강제
  scrollback.rs  스크롤백 버퍼 (라인 수와 바이트 크기로 제한)
  utf8.rs        UTF-8 디코더 — 청크 경계의 부분 멀티바이트 시퀀스 재조립

db/
  mod.rs  인메모리 SQLite — sessions 및 session_logs 테이블

auth/
  token.rs  ~/.config/orbit/token 로드/생성 및 Authorization 헤더 검증

adapter/
  mod.rs  에이전트 백엔드 레지스트리, 기본 백엔드, YAML 백엔드 설정 파서
```

### SessionRegistry

`SessionRegistry`는 중앙 코디네이터 역할을 한다. 다음을 보유한다:

- `Arc<Db>` (인메모리 SQLite) — 메타데이터와 로그
- `Config` — 경로와 제한값
- `RwLock<HashMap<String, Arc<PtyManager>>>` — 라이브 세션 (attach 가능)

**create_session** 동작:
1. UUID v4에서 12자리 세션 ID 생성
2. 인메모리 DB에 `created` 상태로 세션 행 삽입
3. `req.tool`을 설정된 백엔드 레지스트리의 백엔드 ID로 해석
4. `PtyManager::spawn` 호출로 PTY 안에서 백엔드 명령 시작
5. 성공 시 DB 상태를 `running`으로 업데이트하고 `PtyManager`를 라이브 맵에 저장
6. 실패 시 세션 행을 롤백(삭제)

**delete_session / stop_session** 동작:
1. 세션 조회
2. 라이브 맵에 `PtyManager`가 있으면 `stop()` 호출 (자식 프로세스 종료)
3. DB 행 업데이트 또는 삭제
4. 감사 이벤트 추가

**attach** 동작:
1. 세션 조회
2. 라이브 맵에서 `Arc<PtyManager>` 반환
3. 세션이 이미 종료되었으면(PtyManager가 없으면) 실패

### 인증

`~/.config/orbit/token`에 저장된 무작위 32바이트 시크릿 기반 Bearer 토큰 인증.

```
orbit_<base64url-nopad-32-bytes>
```

모든 `/api/v1/*` 요청은 `Authorization: Bearer <token>` 헤더가 필요하다. `/healthz`는 인증 없이 접근 가능하다.

## API

Base URL: `http://127.0.0.1:7777`

| Method | Path | 용도 |
|--------|------|---------|
| `GET` | `/healthz` | 헬스 체크 → `"ok"` |
| `GET` | `/api/v1/backends` | 설정된 에이전트 백엔드 목록 조회 |
| `POST` | `/api/v1/sessions` | 세션 생성 및 백엔드 프로세스 spawn |
| `GET` | `/api/v1/sessions` | 세션 목록 조회 (`?tool=codex`, `?status=running`) |
| `GET` | `/api/v1/sessions/:id` | ID 또는 name으로 세션 조회 |
| `POST` | `/api/v1/sessions/:id/stop` | 실행 중인 세션 중지 |
| `DELETE` | `/api/v1/sessions/:id` | 세션 삭제 (실행 중이면 프로세스 종료) |
| `GET` | `/api/v1/sessions/:id/logs?tail=N` | base64 인코딩 로그 청크 조회 |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket 업그레이드로 라이브 attach |
| `GET` | `/api/v1/fs/dirs?path=...` | 표시 가능한 하위 디렉토리 조회 |
| `POST` | `/api/v1/fs/dirs` | 하위 디렉토리 생성 |
| `GET` | `/api/v1/fs/entries?path=...` | 표시 가능한 파일과 디렉토리 조회 |
| `GET` | `/api/v1/fs/files?path=...` | UTF-8 텍스트 파일 읽기, 최대 10 MB |
| `PUT` | `/api/v1/fs/files` | UTF-8 텍스트 내용을 파일에 쓰기 |

### 세션 생성 요청

```json
{
  "tool": "codex",
  "name": "optional-name",
  "cwd": "/home/user/project",
  "env": { "KEY": "VALUE" }
}
```

`tool`은 `GET /api/v1/backends`가 반환한 백엔드 ID다.

### WebSocket Attach 프로토콜

JSON 프레임 메시지.

**클라이언트 → 서버:**

| Type | 필드 | 용도 |
|------|------|---------|
| `stdin` | `data` (base64) | PTY 입력 |
| `resize` | `cols`, `rows` (u16) | PTY 리사이즈 — 즉시 적용 |
| `ping` | — | Keepalive |
| `detach` | — | attach 종료 |

**서버 → 클라이언트:**

| Type | 필드 | 용도 |
|------|------|---------|
| `stdout` | `data` (base64) | PTY 출력 |
| `status` | `value` (SessionStatus) | 세션 상태 변경 알림 |
| `exit` | `code` (i32 또는 null) | 프로세스 종료 알림 |
| `pong` | — | Ping 응답 |
| `error` | `code`, `message` | 오류 알림 |

### 로그 조회

`GET /api/v1/sessions/:id/logs?tail=N`은 인메모리 `session_logs` 테이블에서 base64 인코딩 청크를 반환한다. `tail=0`이면 전체 로그를 반환한다. 로그는 PTY read 청크(~8KB)당 한 행씩 base64 인코딩되어 저장된다.

### 파일시스템 API

파일시스템 엔드포인트는 `orbitd`에 구현되어 있고 `web/backend`가 프록시한다.

- `GET /api/v1/fs/dirs?path=...`는 표시 가능한 하위 디렉토리 목록을 `{ cwd, home, path, parent, dirs }`로 반환한다.
- `POST /api/v1/fs/dirs`는 `{ "parent": "...", "name": "..." }`로 하위 디렉토리 하나를 생성한다. `name`은 단일 경로 세그먼트여야 한다.
- `GET /api/v1/fs/entries?path=...`는 표시 가능한 파일과 디렉토리를 `{ home, path, parent, entries }`로 반환하며, 디렉토리를 먼저 정렬한다.
- `GET /api/v1/fs/files?path=...`는 UTF-8 텍스트 파일을 읽고, 파일이 아닌 경로, 비 UTF-8 내용, 10 MB 초과 파일을 거부한다.
- `PUT /api/v1/fs/files`는 `{ "path": "...", "content": "..." }` 내용을 디스크에 쓴다.

디렉토리 또는 엔트리 목록에서 `path`를 생략하면 `$ORBIT_WORKSPACE`가 설정된 경우 그 값을 사용하고, 아니면 `orbitd`의 현재 작업 디렉토리에서 시작한다. 숨김 항목은 제외된다.

## 세션 라이프사이클

```
created
  → running     spawn 성공
  → stopped     stop 요청 또는 정상 종료(code 0)
  → crashed     비정상 종료 또는 오류
  → removed     stopped/crashed 상태에서 DELETE / TUI rm
```

create_session 동작:
1. `SessionRegistry`가 UUID v4에서 12자리 ID 생성
2. 인메모리 DB에 `created` 상태 삽입
3. 요청된 백엔드 ID를 명령과 인자 목록으로 해석
4. `PtyManager::spawn`이 PTY 안에서 백엔드 명령 실행
5. 성공 시 상태가 `running`으로 전환

## 출력 흐름

백엔드 PTY 출력은 네 경로로 동시에 분기된다:

```
PTY reader thread (std::thread의 blocking read)
  |
  ├──→ ScrollbackBuffer (lines/bytes 제한, 새 attach 클라이언트용)
  ├──→ broadcast::channel (라이브 WebSocket attach 클라이언트용)
  ├──→ In-memory session_logs table (base64 인코딩, SQLite)
  └──→ ./tmp/<session-id>.log (raw 바이너리 출력 파일)
```

추가로, monitor 스레드가 500ms마다 `child.try_wait()`를 폴링하여 프로세스 종료를 감지하고 세션 상태를 업데이트한다.

## Input Arbiter

한 번에 하나의 WebSocket 클라이언트만 PTY에 쓸 수 있다. `pty/input.rs`의 `InputArbiter`가 단일 writer를 강제한다:

- `claim(client_id)` — writer 등록
- `try_write(client_id)` — 호출자가 현재 writer인 경우에만 성공
- `release(client_id)` — 일치하면 writer 해제

클라이언트가 `detach` WebSocket 메시지를 보내거나 연결이 끊기면 writer가 해제되어 다음 attach 클라이언트가 쓸 수 있다.

## 저장소

기본 파일 배치:

```text
~/.config/orbit/config.toml       # TOML 설정 (선택)
~/.config/orbit/backends.yaml     # 선택적 백엔드 레지스트리 override
~/.config/orbit/token             # Bearer 토큰 (자동 생성)
~/.local/share/orbit/audit.jsonl  # JSONL 감사 로그 (세션 생명주기)
./tmp/<session-id>.log            # Raw PTY 출력 (orbitd CWD 기준 상대 경로)
```

인메모리 SQLite 데이터베이스(디스크에 유지되지 않음):

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

감사 로그는 `~/.local/share/orbit/audit.jsonl`의 JSONL 파일이다. 각 행은 `timestamp`, `action`(예: `session.create`, `session.attach`, `session.stop`, `session.delete`), `session_id`, 선택적 `detail`을 포함하는 JSON 객체다.

## TUI 클라이언트

`orb`는 `http://127.0.0.1:7777`에 연결하고 `~/.config/orbit/token`에서 토큰을 읽어 사용한다.

직접 구현하는 기능 (외부 서브프로세스 없음):

- 세션 생성/실행
- 실행 중 또는 전체 세션 목록
- WebSocket attach
- 세션 삭제
- 로그 테일 표시 (마지막 100개 청크)

### Attach 구현

attach 로직은 `orb/internal/attach/`에 있다. 다음을 수행한다:

1. **WebSocket 핸드셰이크** — HTTP 업그레이드를 직접 수행, 수동 프레임 마스킹/언마스킹, SHA-1 accept 검증
2. **터미널 raw 모드** — `unix.IoctlSetTermios`로 stdin에 raw 모드 활성화, detach 시 완전 복원
3. **Detach 시퀀스 감지** — stdin에서 `Ctrl-]`(0x1D), `Ctrl-\`(0x1C), CSI-u / xterm modifyOtherKeys 변형을 스캔. Detach 토큰은 PTY로 전달되지 않음. 터미널 호환 fallback: `Ctrl-G`, `Ctrl-^`, `Ctrl-_`도 detach 트리거
4. **색상 적응** — attach 시 터미널의 OSC 11 배경색을 쿼리하여 SGR 코드 조정(밝은/어두운 배경에서 흑백 가시성 개선)
5. **리사이즈 루프** — `SIGWINCH` 핸들러가 WebSocket으로 `resize` 메시지 전송
6. **로그 출력 정화** — 이스케이프 시퀀스 제거, 빈 줄 압축, 백스페이스 처리
7. **Attach 시 재생** — 연결 시 서버가 먼저 스크롤백 스냅샷을 보내고, 이후 라이브 출력이 이어짐

### TUI 키바인딩

| 키 | 동작 |
|-----|--------|
| `↑` / `↓` 또는 `k` / `j` | 선택 이동 |
| `enter` / `a` | Attach |
| `n` | 세션 생성 폼 |
| `x` | 선택 삭제 |
| `l` | 마지막 100개 로그 청크 표시 |
| `tab` | running/all 필터 전환 |
| `r` | 새로고침 |
| `q` / `Ctrl-C` | 종료 |

세션 생성 폼 필드: `tool`(`orbitd`가 제공하는 백엔드 ID, ←/→ 순환), `name`, `cwd`, `env`(공백 구분 KEY=VALUE), `detach`(true = 목록 복귀, false = 즉시 attach)

## 에이전트 백엔드

`orbitd`는 인메모리 `AgentBackends` 레지스트리를 유지한다. 백엔드 YAML이 없으면 다음 기본값을 사용한다:

| 백엔드 ID | 명령 | 추가 인자 |
|-----------|------|-----------|
| `codex` | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude` | `--dangerously-skip-permissions` |
| `opencode` | `opencode` | _(없음)_ |
| `pi` | `pi` | _(없음)_ |

`ORBIT_BACKENDS_CONFIG` 또는 `~/.config/orbit/config.toml`의 `backends = "/path/to/backends.yaml"`이 YAML 파일을 가리키면 기본 레지스트리를 대체한다:

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

활성 레지스트리는 `GET /api/v1/backends`로 공개되며, `orb`, TUI, 웹 UI는 이 엔드포인트로 백엔드 선택지를 채운다.

환경 설정은 PTY spawn 경로에서 처리된다: TERM, COLORTERM, COLORFGBG가 주입되고, NO_COLOR는 제거되며, `orb` 클라이언트의 모든 터미널 관련 환경 변수(TERM_PROGRAM, KITTY_WINDOW_ID 등)가 자식 프로세스로 전달된다.

## 웹 클라이언트 상세

### 웹 백엔드 (`web/backend/`)

Fastify (Node.js)로 구축되었으며 기본적으로 3001번 포트에서 실행된다. 두 가지 역할을 수행한다:

1. **리버스 프록시** — `/api/v1/sessions/*`와 `/api/v1/backends` 요청을 `orbitd`로 전달하며, WebSocket attach 업그레이드도 포함한다. 브라우저는 `orbitd`에 직접 연결하지 않는다.
2. **파일시스템 프록시** — `orbitd`의 파일시스템 엔드포인트를 전달한다:
   - `GET /api/v1/fs/dirs?path=...` — 주어진 경로의 하위 디렉토리 목록과 `parent`(상위 이동), `home`, `cwd` 참조를 반환한다.
   - `POST /api/v1/fs/dirs` — 새 빈 디렉토리를 생성한다 (`{ "parent": "...", "name": "..." }`).
   - `GET /api/v1/fs/entries?path=...` — 파일 편집기용 파일과 디렉토리 목록을 반환한다.
   - `GET /api/v1/fs/files?path=...` — 텍스트 파일을 읽는다.
   - `PUT /api/v1/fs/files` — 텍스트 파일을 저장한다.

웹 백엔드는 `ORBIT_TOKEN` 환경 변수, 요청의 `Authorization` 헤더, 또는 `token` 쿼리 파라미터에서 orbitd 토큰을 읽고, 프록시 요청마다 `orbitd`로 전달한다.

환경 변수 설정:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3001` | 웹 백엔드 수신 포트 |
| `ORBITD_URL` | `http://127.0.0.1:7777` | 업스트림 orbitd URL |
| `ORBIT_TOKEN` | `""` | orbitd 인증용 Bearer 토큰 |

### 웹 프론트엔드 (`web/frontend/`)

React + Vite + xterm.js로 구축된 싱글 페이지 애플리케이션:

- **로그인 화면** — orbitd Bearer 토큰을 입력받아 `localStorage`에 저장한다.
- **툴바** — `/api/v1/backends`에서 채운 백엔드 선택기, 이름 입력, cwd 입력 + 폴더 선택기, env 입력, Attach 토글, Run 버튼, All/Running 필터, 새로고침, 로그아웃.
- **파일 편집기** — `/api/v1/fs/entries`로 탐색하고 `/api/v1/fs/files`로 파일을 열며 `PUT /api/v1/fs/files`로 저장하는 모달 텍스트 편집기.
- **세션 목록** — 클릭 가능한 행: ID, 이름, 도구, 상태(색상 코드 표시), PID.
- **세션 창** — 두 개의 탭:
  - **Attach** — 백엔드 프록시를 통해 WebSocket으로 연결된 xterm.js 터미널. 자동 리사이즈(ResizeObserver), 스크롤 팔로우, detach 감지(`Ctrl-]`/`Ctrl-\`), 종료 알림, 재연결 기능.
  - **Logs** — 읽기 전용 xterm.js에 base64 디코딩된 출력 표시(마지막 500개 청크).
- **폴더 선택기** — 서버 파일시스템을 탐색하는 모달 다이얼로그. 상위/홈/서버-cwd로 이동, 새 폴더 생성, 작업 디렉토리 선택. `/api/v1/fs/dirs` 엔드포인트를 사용한다.

## 현재 제한 사항

- 실행 중인 세션도 삭제할 수 있으며, 삭제 시 프로세스가 즉시 종료된다.
- 레지스트리에 라이브 `PtyManager`가 있는 세션만 attach 가능하다. 이미 종료된 세션은 다시 attach할 수 없다.
- `orbitd`가 재시작되면 모든 세션 메타데이터와 로그가 사라진다(인메모리 SQLite).
- WebSocket 로그 스트리밍 라우트가 없다 — 로그는 REST pull 전용(`GET /logs?tail=N`).
- raw 로그 파일과 감사 로그 외에는 세션을 디스크에 저장하지 않는다.
- 파일시스템 엔드포인트는 인증된 클라이언트에게 `orbitd` 프로세스의 파일시스템을 노출한다. 웹 UI 접근 권한을 줄 사용자와 같은 신뢰 경계에서 `orbitd`를 실행해야 한다.
