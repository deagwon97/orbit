# Orbit 실행 및 빌드 매뉴얼

Orbit은 `orbitd` 런타임 서버와 Go 기반 `orb` 클라이언트로 구성됩니다. `orbitd`가 세션, PTY, 프로세스, 로그를 소유하고, `orb`는 `orbitd`의 REST/WebSocket API를 직접 호출합니다. 별도 Rust `orbit` CLI 패키지는 없습니다.

## 구성

```text
orbitd/  Rust daemon 서버와 Rust 공용 API 타입
orb/     Orbit 로컬 클라이언트, 현재 Go Bubble Tea TUI
web/     웹 UI 실험/개발 영역
```

`orbitd/orb-common/`은 daemon 내부 Rust 공용 타입 crate이고, `orbitd/API.md`는 현재 REST/WebSocket API 요약입니다.

## 사전 준비

- Rust toolchain: `orbitd` 빌드 및 실행에 필요
- Go 1.23 이상: TUI 실행 또는 빌드에 필요
- Node.js 및 npm: 웹 프론트엔드/백엔드 실행 또는 빌드에 필요
- 사용할 도구 바이너리: `codex`, `claude`, `opencode`, `pi` 중 필요한 항목이 PATH에 있어야 함

## 런타임 서버 실행

먼저 `orbitd` 서버를 실행합니다.

```bash
cd /data/private/orbit/orbitd
cargo run -p orbitd
```

서버는 기본적으로 `127.0.0.1:7777`에서 실행됩니다. 최초 실행 시 클라이언트 인증에 필요한 토큰 파일이 `~/.config/orbit/token`에 생성됩니다. 세션 메타데이터와 REST 로그는 파일 DB에 저장하지 않고 `orbitd` 프로세스 메모리에만 유지되며, `orbitd`가 종료되면 모두 사라집니다. 원본 세션 출력 로그는 `orbitd` 실행 위치 기준 `./tmp/<session-id>.log`에 저장됩니다.

설정 파일은 `~/.config/orbit/config.toml`에 둘 수 있습니다.

```toml
listen = "127.0.0.1:7777"

[pty]
scrollback_lines = 10000
scrollback_max_bytes = 104857600
```

## TUI 실행

`orbitd`가 실행 중인 상태에서 다른 터미널을 열고 TUI를 실행합니다.

```bash
cd /data/private/orbit/orb
go run .
```

빌드된 바이너리를 실행하려면 다음을 사용합니다.

```bash
cd /data/private/orbit/orb
go build -o orb .
./orb
```

## TUI 기능

```text
enter/a  attach
n        run/create session
x        rm/delete
l        logs
tab      running/all filter
r        refresh
q        quit
```

새 세션 생성 화면에서 지원하는 도구 값은 다음과 같습니다.

- `codex`
- `claude`
- `opencode`
- `pi`

`env` 값은 `KEY=VALUE` 형식으로 공백 구분해 입력합니다. `detach=false`로 생성하면 세션 생성 직후 TUI가 직접 WebSocket attach를 시작합니다. attach 중 `Ctrl-]` 또는 `Ctrl-\`를 누르면 세션은 유지한 채 detach합니다. 터미널이 키를 가로채는 경우 `Ctrl-G`, `Ctrl-^`, `Ctrl-_`도 detach로 처리합니다.

## CLI 실행

```bash
./orb run codex
```

`orb run <tool>`은 세션 생성 직후 자동으로 attach합니다. 세션만 만들고 attach하지 않으려면 `--detach`를 사용합니다.

## Rust 빌드

전체 Rust 워크스페이스를 빌드합니다.

```bash
cd /data/private/orbit/orbitd
cargo build --workspace
```

런타임 서버만 dev 프로파일로 빌드합니다.

```bash
cargo build -p orbitd
```

release 바이너리가 필요하면 `--release`를 붙입니다.

```bash
cargo build -p orbitd --release
```

빌드 결과는 프로파일에 따라 다음 위치에 생성됩니다.

```bash
target/debug/orbitd    # cargo build -p orbitd
target/release/orbitd  # cargo build -p orbitd --release
```

## 검증

```bash
cd /data/private/orbit/orbitd
cargo check --workspace

cd /data/private/orbit/orb
go test ./...
go build -o orb .
```

## 웹 백엔드 실행 및 빌드

```bash
cd /data/private/orbit/web/backend
npm install
npm run dev
```

```bash
npm run build
npm run start
```

## 웹 프론트엔드 실행 및 빌드

```bash
cd /data/private/orbit/web/frontend
npm install
npm run dev
```

```bash
npm run build
npm run preview
```

## 일반적인 실행 순서

터미널 1:

```bash
cd /data/private/orbit/orbitd
cargo run -p orbitd
```

터미널 2:

```bash
cd /data/private/orbit/orb
go run .
```

## 문제 해결

TUI에서 인증에 실패하면 `orbitd`를 한 번 먼저 실행해 `~/.config/orbit/token`이 생성되어 있는지 확인합니다.

`orbitd`가 이미 실행 중인데 TUI 연결이 실패하면 `127.0.0.1:7777` 포트와 서버 로그를 확인합니다.

새 세션 생성이 실패하면 선택한 도구 바이너리가 PATH에 있는지 확인합니다.

## systemd 실행

systemd로 `orbitd`를 실행할 때는 `codex`, `claude`, `opencode`, `pi`가 있는 경로를 `PATH`에 명시해야 합니다. 예시는 `deploy/orbitd.service`에 있습니다.

```bash
cd /data/private/orbit
cargo build -p orbitd --release --manifest-path orbitd/Cargo.toml
sudo install -m 0755 orbitd/target/release/orbitd /opt/orbit/orbitd
sudo install -m 0644 deploy/orbitd.service /etc/systemd/system/orbitd.service
sudo systemctl daemon-reload
sudo systemctl restart orbitd
```

서비스 파일의 `Environment=PATH=...` 값은 `orbitd`가 도구 프로세스를 만들 때 그대로 사용됩니다.
