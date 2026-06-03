# Orbit

> 설정 가능한 AI 코딩 에이전트 세션을 관리하고 멀티플렉싱하는 경량 데몬

Orbit은 AI 코딩 에이전트 세션을 터미널 수명과 분리한다. `orbitd` 데몬이 모든 PTY 프로세스, 세션, 로그를 소유하고, `orb` 클라이언트(TUI 또는 CLI)가 REST/WebSocket으로 연결한다. 터미널 수명과 관계없이 세션을 detach/reattach하고 로그를 확인할 수 있다.

## 기능

- **세션 관리** — 코딩 에이전트 세션 생성, 목록, attach, 중지, 삭제
- **Detach / Reattach** — `Ctrl-]`로 세션을 유지한 채 detach하고, 나중에 다른 터미널에서 재연결
- **삼중 클라이언트** — 풀 [Bubble Tea](https://github.com/charmbracelet/bubbletea) TUI, CLI 인터페이스, 그리고 **웹 UI**(React + xterm.js)
- **WebSocket attach** — Raw PTY I/O 중계, 자동 터미널 색상 적응(밝음/어두움 배경 감지)
- **스크롤백 + 로그** — 설정 가능한 스크롤백 버퍼, 인메모리 + raw 파일 이중 저장
- **설정 가능한 에이전트 백엔드** — `orbitd`가 YAML의 백엔드 명령 정의를 읽고 실행한다. 기본값으로 `codex`, `claude`, `opencode`, `pi`를 제공한다.
- **REST API + 파일시스템 API** — 세션, 디렉토리 탐색, 폴더 생성, 텍스트 파일 읽기/쓰기용 JSON API
- **웹 터미널 + 편집기** — 브라우저 기반 xterm.js attach, 폴더 선택기, 경량 텍스트 파일 편집기
- **감사 로그** — 모든 세션 생명주기 이벤트가 `audit.jsonl`에 기록

## 아키텍처

```
Terminal                    Browser (web UI)
(orb TUI/CLI)                      |
       |                   web/backend (Fastify)
       |                   (동일 출처 리버스 프록시)
       |                           |
       |  REST: sessions CRUD, logs, filesystem
       |  WebSocket: attach
       v
       orbitd (Rust + axum)
              |
              +-------> configured agent backends (child processes)
              |
              | In-memory SQLite (sessions + logs)
              | Raw log files (./tmp/<id>.log)
              | JSONL audit log (~/.local/share/orbit/audit.jsonl)
```

`orbitd`만 PTY, 자식 프로세스, 파일시스템 API를 소유한다. TUI, CLI, 웹 UI는 모두 API 클라이언트다 — `orb`와 `web/backend` 모두 동일한 REST/WebSocket API로 `orbitd`를 직접 호출한다. 웹 백엔드는 브라우저가 cross-origin 문제 없이 `orbitd`에 접근할 수 있도록 동일 출처 리버스 프록시 역할을 한다.

## 빠른 시작

### 1. 사전 준비

- **Rust toolchain** — `orbitd` 빌드용
- **Go 1.23+** — `orb` 클라이언트 빌드용
- **Node.js + npm** — 웹 UI용(선택사항)
- **백엔드 명령** — `PATH`에 있거나 백엔드 YAML에 절대 경로로 지정된 명령

### 2. 데몬 빌드 및 실행

```bash
cd orbitd
cargo run -p orbitd
```

서버는 기본적으로 `127.0.0.1:7777`에서 실행된다. 기본적으로 다음 경로를 사용한다:

| 경로 | 용도 |
|------|------|
| `/etc/orbitd/token` | 클라이언트 인증용 Bearer 토큰 (자동 생성) |
| `/etc/orbitd/config.yaml` | 선택적 설정 파일 (백엔드 정의 포함) |
| `~/.local/share/orbit/audit.jsonl` | 세션 감사 로그 |

`orb` 클라이언트는 자체 파일을 사용한다:

| 경로 | 용도 |
|------|------|
| `~/.config/orbit/orb/config.yaml` | 선택적 클라이언트 설정 (orbitd URL) |
| `~/.config/orbit/orb/token` | Bearer 토큰 (보통 `/etc/orbitd/token`에 대한 심볼릭 링크) |

세션 메타데이터와 로그는 인메모리 SQLite 데이터베이스에 저장된다 — **`orbitd`가 종료되면 모든 데이터가 사라진다**. Raw PTY 출력은 오프라인 확인을 위해 `./tmp/<session-id>.log`에도 기록된다.

### 3. 클라이언트 빌드 및 실행

```bash
cd orb
go run .              # TUI 실행
```

CLI로도 사용 가능:

```bash
go build -o orb .
./orb ps              # 실행 중인 세션 목록
./orb backends        # orbitd가 제공하는 백엔드 목록
./orb run codex       # 세션 생성 및 attach
```

## 사용법

### TUI

```
┌───────────────────────────────────────────────────┐
│ Orb Sessions  running                             │
│                                                   │
│  ID           NAME           TOOL        STATUS   │
│ > abc12345    codex-abc12   codex       running   │
│   def67890    ...           claude      running   │
│                                                   │
│ enter/a attach | n create/run | x remove          │
│ l logs | tab toggle filter | r refresh | q quit   │
│ Ctrl-]/Ctrl-\ detach (while attached)             │
└───────────────────────────────────────────────────┘
```

| 키 | 동작 |
|-----|------|
| `↑`/`↓` 또는 `k`/`j` | 선택 이동 |
| `enter` 또는 `a` | 선택한 세션 attach |
| `n` | 세션 생성 폼 열기 |
| `x` | 선택한 세션 삭제 |
| `l` | 마지막 100개 로그 청크 표시 |
| `tab` | running / all 필터 전환 |
| `r` | 세션 목록 새로고침 |
| `q` 또는 `Ctrl-C` | 종료 |

**세션 생성 폼** — `tab`/`↑`/`↓`로 이동, 타이핑으로 편집, `←`/`→`로 전환:

| 필드 | 설명 |
|------|------|
| `tool` | `orbitd`가 제공하는 백엔드 ID (←/→로 순환) |
| `name` | 선택적 세션 이름 |
| `cwd` | 선택적 작업 디렉토리 (기본값: 현재 디렉토리) |
| `env` | 공백 구분 `KEY=VALUE` 쌍 |
| `detach` | `true` → 목록 복귀; `false` → 즉시 attach |

**Attach 중**: `Ctrl-]` 또는 `Ctrl-\`를 누르면 세션을 유지한 채 detach한다. 터미널이 해당 키를 가로채는 경우 `Ctrl-G`, `Ctrl-^`, `Ctrl-_`도 사용 가능하다.

### CLI

```bash
orb                    # TUI 실행 (인자 없음)
orb backends           # orbitd가 제공하는 에이전트 백엔드 목록
orb ps                 # 실행 중인 세션 목록
orb ps --all           # 전체 세션 목록 (중지/크래시 포함)
orb ps -a              # --all의 단축형

orb run codex          # 세션 생성 및 attach
orb run --detach codex # 생성만 하고 attach하지 않음
orb run --name my-session --cwd /path/to/project codex
orb run -e KEY=VALUE -e FOO=bar codex

orb attach <id>        # ID 또는 이름으로 세션 attach
orb logs <id>          # 전체 로그 출력
orb logs --tail 50 <id>   # 마지막 50개 로그 청크
orb logs --raw <id>    # Raw PTY 출력 (ANSI 필터링 없음)

orb rm <id>...         # 하나 이상의 세션 ID/이름으로 삭제
```

### API

Base URL: `http://127.0.0.1:7777` — `/healthz`를 제외한 모든 엔드포인트에 `Authorization: Bearer <token>` 헤더 필요.

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/healthz` | 헬스 체크 (인증 불필요) |
| `GET` | `/api/v1/backends` | `orbitd`가 사용할 수 있는 에이전트 백엔드 목록 |
| `POST` | `/api/v1/sessions` | 세션 생성 |
| `GET` | `/api/v1/sessions` | 세션 목록 (`?status=running`, `?tool=codex`) |
| `GET` | `/api/v1/sessions/:id` | ID 또는 이름으로 세션 조회 |
| `POST` | `/api/v1/sessions/:id/stop` | 실행 중인 세션 중지 |
| `DELETE` | `/api/v1/sessions/:id` | 세션 삭제 (실행 중이면 프로세스 종료) |
| `GET` | `/api/v1/sessions/:id/logs?tail=N` | base64 인코딩 로그 청크 조회 |
| `GET` | `/api/v1/sessions/:id/attach` | WebSocket 업그레이드로 라이브 attach |
| `GET` | `/api/v1/fs/dirs?path=...` | 지정 경로의 표시 가능한 하위 디렉토리 조회 |
| `POST` | `/api/v1/fs/dirs` | 하위 디렉토리 생성 |
| `GET` | `/api/v1/fs/entries?path=...` | 지정 경로의 표시 가능한 파일/디렉토리 조회 |
| `GET` | `/api/v1/fs/files?path=...` | UTF-8 텍스트 파일 읽기, 최대 10 MB |
| `PUT` | `/api/v1/fs/files` | UTF-8 텍스트 내용을 파일에 쓰기 |

**세션 생성** 요청 본문:

```json
{
  "tool": "codex",
  "name": "my-session",
  "cwd": "/home/user/project",
  "env": { "KEY": "VALUE" }
}
```

`tool` 필드는 `/api/v1/backends`에서 받은 백엔드 ID다.

**WebSocket attach** — JSON 프레임 메시지:

```
→ { "type": "stdin",  "data": "<base64>" }
→ { "type": "resize", "cols": 120, "rows": 40 }
→ { "type": "detach" }
← { "type": "stdout", "data": "<base64>" }
```

**파일시스템 API** — `path`를 생략하면 `$ORBIT_WORKSPACE`가 설정된 경우 그 값을 사용하고, 아니면 `orbitd` 프로세스의 작업 디렉토리를 사용한다. 숨김 항목은 제외된다. 디렉토리 목록은 canonical path와 `parent`, `home` 참조를 반환하며, 파일 읽기는 파일이 아닌 경로, 비 UTF-8 내용, 10 MB 초과 파일을 거부한다.

## 설정

### orbitd (데몬)

`orbitd`는 `/etc/orbitd/config.yaml`이 존재하면 읽는다. 백엔드 정의와 PTY 튜닝
모두 이 한 파일에 들어간다:

```yaml
listen: "127.0.0.1:7777"

pty:
  scrollback_lines: 10000
  scrollback_max_bytes: 104857600

# 선택 — 내장 백엔드 레지스트리를 대체한다.
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

기본 경로와 런타임 설정:

| 설정 | 기본값 | 환경 변수 override |
|------|--------|-------------------|
| `listen` | `127.0.0.1:7777` | — |
| `config_path` | `/etc/orbitd/config.yaml` | `ORBITD_CONFIG` |
| `token_path` | `/etc/orbitd/token` | `ORBITD_TOKEN_PATH` |
| `data_dir` | `~/.local/share/orbit` | — |
| `session_logs_dir` | `./tmp` (orbitd 작업 디렉토리 기준) | — |
| `audit_path` | `~/.local/share/orbit/audit.jsonl` | — |
| `process_path` | 서버 환경의 `$PATH` | — |
| `scrollback_lines` | 10,000 | — |
| `scrollback_max_bytes` | 100 MB | — |

### orb (클라이언트)

`orb`는 `~/.config/orbit/orb/config.yaml`이 존재하면 읽는다. 예시:

```yaml
url: "http://127.0.0.1:7777"
```

| 설정 | 기본값 | 환경 변수 override |
|------|--------|-------------------|
| `config_path` | `~/.config/orbit/orb/config.yaml` | `ORB_CONFIG` |
| `token_path` | `~/.config/orbit/orb/token` | `ORB_TOKEN_PATH` |
| `url` | `http://127.0.0.1:7777` (`config.yaml`에서) | — |

## 에이전트 백엔드

기본적으로 `orbitd`는 다음 백엔드 ID를 제공한다:

| 백엔드 ID | 명령 | 추가 인자 |
|-----------|------|-----------|
| `codex` | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| `claude` | `claude` | `--dangerously-skip-permissions` |
| `opencode` | `opencode` | _(없음)_ |
| `pi` | `pi` | _(없음)_ |

기본 목록을 대체하려면 `/etc/orbitd/config.yaml`에 `backends` 항목을 추가한다:

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

TUI, CLI, 웹 UI는 `GET /api/v1/backends`에서 사용 가능한 백엔드 목록을 읽는다.

## 소스에서 빌드

### 데몬 (Rust)

```bash
cd orbitd
cargo build --workspace      # 전체 워크스페이스
cargo build -p orbitd         # 데몬만
cargo build -p orbitd --release
# 바이너리: target/debug/orbitd 또는 target/release/orbitd
```

### 클라이언트 (Go)

```bash
cd orb
go build -o orb .
# 바이너리: ./orb
```

### 검증

```bash
cd orbitd && cargo check --workspace
cd orb    && go test ./... && go build -o orb .
```

### 웹 UI (선택사항)

웹 클라이언트는 함께 실행되는 두 부분으로 구성된다:

- **백엔드** (Fastify/Node.js, 3001번 포트) — `orbitd`의 리버스 프록시.
  `orbitd`의 세션, 백엔드, 파일시스템, attach 엔드포인트를 프록시한다:
  - `GET /api/v1/auth/check` — 설정된 `orbitd` URL/token 조합 검증
  - `GET /api/v1/fs/dirs?path=...` — 서버 디렉토리 탐색
  - `POST /api/v1/fs/dirs` — 새 빈 디렉토리 생성
  - `GET /api/v1/fs/entries?path=...` — 파일과 디렉토리 탐색
  - `GET /api/v1/fs/files?path=...` — 텍스트 파일 읽기
  - `PUT /api/v1/fs/files` — 텍스트 파일 저장
- **프론트엔드** (React + xterm.js + Vite) — 브라우저 기반 세션 UI.
  xterm.js 터미널, 폴더 선택기, 텍스트 파일 편집기, 세션 목록, 여러 `orbitd` 연결 관리 포함.

```bash
cd web/backend   && npm install && npm run dev
cd web/frontend  && npm install && npm run dev
```

단일 로컬 데몬을 사용할 때 가장 단순한 설정:

```bash
export ORBITD_URL=http://127.0.0.1:7777
export ORBIT_TOKEN="$(cat ~/.config/orbit/orb/token)"
cd web/backend && npm run dev
```

이후 Vite 프론트엔드를 열고 Orbitd 연결을 추가한다:

| 필드 | 예시 | 설명 |
|------|------|------|
| Name | `local` | 웹 UI에 표시할 이름 |
| URL | `http://127.0.0.1:7777` | 웹 백엔드에서 접근 가능한 `orbitd` HTTP 엔드포인트 |
| Token | `~/.config/orbit/orb/token` 내용 (또는 `/etc/orbitd/token`) | `orbitd`가 생성한 Bearer token |

웹 백엔드는 다음 환경 변수를 지원한다:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3001` | 웹 백엔드 수신 포트 |
| `ORBITD_URL` | `http://127.0.0.1:7777` | fallback 업스트림 orbitd URL |
| `ORBIT_TOKEN` | `""` | fallback orbitd 인증용 Bearer 토큰 |

브라우저의 Orbitd 연결은 label, URL, Bearer token으로 구성되며 `localStorage`에 저장된다. 각 프록시 요청은 선택된 업스트림 URL을 웹 백엔드로 전달하고, 백엔드는 HTTP(S) URL인지 검증한 뒤 `orbitd`로 전달한다. 따라서 하나의 웹 UI에서 여러 `orbitd` 인스턴스의 세션을 조회하고 attach할 수 있다.

## systemd 배포

`/etc/systemd/system/orbitd.service`에 서비스 파일 생성:

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

그리고:

```bash
cargo build -p orbitd --release
sudo install -m 0755 target/release/orbitd /opt/orbit/orbitd
sudo systemctl daemon-reload
sudo systemctl enable --now orbitd
```

> 백엔드 명령이 절대 경로가 아닐 때는 `PATH` 환경 변수가 중요하다. `orbitd`는 세션을 생성할 때 이 값으로 설정된 백엔드 명령을 찾는다.

## 세션 라이프사이클

```
created  →  running  →  stopped    (정상 종료)
                      →  crashed    (비정상 종료 / 오류)
                      →  removed    (DELETE API / TUI rm)
```

세션은 인메모리 SQLite 데이터베이스에 저장되므로 **`orbitd` 재시작 시 유지되지 않는다**. Raw PTY 출력 파일(`./tmp/<id>.log`)은 재시작 후에도 남지만, 재attach할 수는 없다.

## 문제 해결

| 문제 | 확인할 사항 |
|------|-----------|
| TUI 인증 실패 | `~/.config/orbit/orb/token`이 존재하는지 확인 (`/etc/orbitd/token`에 심볼릭 링크 가능). `orbitd`를 한 번 실행하면 원본 토큰이 생성됨 |
| 연결 거부 | `orbitd`가 `127.0.0.1:7777`에서 실행 중인지 확인, 서버 로그 확인 |
| 웹 UI 연결 실패 | 웹 백엔드가 3001번 포트에서 실행 중인지 확인. `ORBITD_URL`이 올바른지, `ORBIT_TOKEN` 환경 변수가 설정되었거나 로그인 화면에서 토큰을 입력했는지 확인 |
| 세션 생성 실패 | 백엔드 ID가 `orb backends`에 있는지, 해당 명령이 `PATH`에 있거나 절대 경로로 설정되었는지 확인 |
| "Cannot attach" | 세션이 이미 종료되어 정리되었을 수 있음 |
| Rust 빌드 오류 | `pkg-config`와 `libdbus-1-dev`가 설치되어 있는지 확인 (`portable-pty` 의존성) |

## 라이선스

Apache 2.0
