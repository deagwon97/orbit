# Orbit PRD

## 1. 제품 요약

Orbit은 여러 AI 코딩 도구를 지속형 PTY 세션으로 실행하고, 로컬/원격 클라이언트가 동일한 세션에 다시 붙을 수 있게 하는 세션 오케스트레이터다.

현재 제품 구조는 `orbitd` 런타임 서버와 Go 기반 `orb` 클라이언트다. Rust `orbit` CLI는 제거되었고, TUI가 세션 생성, 목록, attach, stop, delete, logs 기능을 직접 제공한다.

## 2. 핵심 가치

- 터미널을 닫아도 AI 도구 프로세스는 `orbitd` 아래에서 유지된다.
- Codex, Claude Code, OpenCode, pi를 같은 세션 모델로 실행한다.
- 세션 메타데이터와 REST 로그는 `orbitd` 프로세스 메모리에만 유지한다.
- 원본 세션 출력 로그는 `orbitd` 실행 위치 기준 `./tmp/<session-id>.log`에 저장한다.
- TUI와 웹 UI는 같은 `orbitd` API를 사용하는 클라이언트다.
- attach는 WebSocket 기반 stdin/stdout relay로 동작한다.

## 3. 지원 도구

| 제품 표시 | 세션 tool 값 | 실행 바이너리 |
| --- | --- | --- |
| Codex | `codex` | `codex` |
| Claude Code | `claude-code` | `claude` |
| OpenCode | `opencode` | `opencode` |
| pi | `pi` | `pi` |

## 4. 컴포넌트

### 4.1 orbitd

`orbitd`는 유일한 런타임 소유자다.

책임:

- 세션 생성/조회/중지/삭제
- PTY 생성과 도구 프로세스 spawn
- stdout scrollback 및 로그 저장
- 원본 PTY 출력 로그 파일 저장
- attach WebSocket 제공
- Bearer token 인증
- 인메모리 세션/로그 저장소
- audit log 기록

### 4.2 orb

`orb`는 Go Bubble Tea 기반 로컬 터미널 클라이언트다.

책임:

- running/all 세션 목록 표시
- 세션 생성 form 제공
- env/cwd/name/tool 입력
- WebSocket attach 직접 처리
- stop/delete/logs action 제공
- `~/.config/orbit/token`을 읽어 API 인증

현재 키맵:

```text
enter/a  attach
n        run/create session
s        stop
x        rm/delete
l        logs
tab      running/all filter
r        refresh
q        quit
```

### 4.3 Web UI

웹 UI는 장기적으로 같은 `orbitd` API를 사용하는 브라우저 클라이언트다. MVP의 핵심 조작 경로는 TUI다.

## 5. 세션 요구사항

세션은 다음 필드를 가진다.

```text
id
name
tool
pid
cwd
status
created_at
last_attached_at
exit_code
```

상태 값:

```text
created
running
stopped
crashed
```

요구사항:

- 세션 ID는 짧고 사람이 읽을 수 있어야 한다.
- name이 없으면 `<tool>-<id>` 형태로 자동 생성한다.
- running 세션도 바로 삭제할 수 있으며 삭제 시 프로세스가 함께 종료되어야 한다.
- 세션 출력은 attach 클라이언트에 실시간 전송되고 프로세스 메모리의 로그 tail에도 저장되어야 한다.
- `orbitd`가 종료되면 세션 메타데이터와 로그는 모두 사라져야 한다.

## 6. API 요구사항

모든 `/api/v1/*` 요청은 Bearer token 인증을 요구한다.

| Method | Path | 요구사항 |
| --- | --- | --- |
| `GET` | `/healthz` | 인증 없이 상태 확인 |
| `POST` | `/api/v1/sessions` | 세션 생성 |
| `GET` | `/api/v1/sessions` | 세션 목록 조회, `tool`, `status` 필터 |
| `GET` | `/api/v1/sessions/:id` | ID 또는 name 조회 |
| `POST` | `/api/v1/sessions/:id/stop` | 세션 중지 |
| `DELETE` | `/api/v1/sessions/:id` | 세션 삭제, running이면 프로세스도 종료 |
| `GET` | `/api/v1/sessions/:id/logs` | 로그 tail 조회 |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket attach |

세션 생성 request:

```json
{
  "tool": "codex",
  "name": "backend",
  "cwd": "/workspace/project",
  "env": { "KEY": "VALUE" }
}
```

로그 응답의 `content`는 base64 encoded PTY bytes다.

## 7. Attach 요구사항

Attach는 WebSocket으로 동작한다.

Client -> Server:

```json
{ "type": "stdin", "data": "<base64>" }
{ "type": "resize", "cols": 120, "rows": 40 }
{ "type": "ping" }
```

Server -> Client:

```json
{ "type": "stdout", "data": "<base64>" }
```

TUI attach 요구사항:

- 터미널 raw mode 진입과 복구
- attach 시작 시 REST logs로 과거 기록 출력
- stdin bytes를 base64 JSON message로 전송
- stdout bytes를 그대로 터미널에 출력
- client WebSocket frame masking
- `Ctrl-]` 또는 `Ctrl-\` detach
- detach 시 서버에 명시적 WebSocket `detach` 메시지 전송
- detach 시 도구 프로세스는 계속 running 유지

## 8. 저장소 요구사항

기본 경로:

```text
~/.config/orbit/config.toml
~/.config/orbit/token
~/.local/share/orbit/audit.jsonl
```

인메모리 SQLite table:

```text
sessions
session_logs
```

## 9. 보안 요구사항

- MVP 인증은 static Bearer token이다.
- token은 `orbitd`가 최초 실행 시 생성한다.
- 클라이언트는 `~/.config/orbit/token`을 읽어 `Authorization` 헤더로 보낸다.
- 원격 공개 배포 전에는 TLS, token 권한 검증, 멀티유저 격리 정책이 필요하다.

## 10. MVP 포함 범위

포함:

- `orbitd` REST API
- `orbitd` attach WebSocket
- PTY 기반 도구 실행
- 인메모리 세션/로그 저장소
- Go TUI 세션 조작
- Go TUI native attach
- `Ctrl-]` 또는 `Ctrl-\` detach

제외 또는 후속:

- Rust `orbit` CLI
- PTY 복원
- 웹 attach 완성
- RBAC / 멀티유저 격리
- TLS 자동 구성
- logs follow streaming
- PTY resize 실제 적용

## 11. 성공 기준

개발자는 다음 흐름을 TUI만으로 수행할 수 있어야 한다.

1. `orbitd` 실행
2. `orb` 실행
3. 새 AI 도구 세션 생성
4. 세션에 attach해 상호작용
5. detach 후 목록으로 복귀
6. 로그 확인
7. 세션 stop
8. 세션 delete

기본 검증 명령은 다음과 같다.

```bash
cd orbitd
cargo check --workspace
cd orb && go test ./... && go build -o orb .
```
