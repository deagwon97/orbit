# Orbit Implementation Plan

## 목표

현재 목표는 이전 명령줄 클라이언트를 제거한 구조에서 `orbitd` + `orb` 기반 MVP를 안정화하는 것이다. `orbitd`가 런타임과 PTY를 소유하고, Go TUI가 세션 클라이언트 기능을 직접 제공한다.

## 현재 완료된 구조

- Rust workspace: `orb-common`, `runtime`
- Go module: `tui`
- 제거됨: 이전 명령줄 클라이언트 패키지와 관련 산출물
- TUI 직접 구현: run/list/attach/stop/delete/logs
- 검증 명령: `cd orbitd && cargo check --workspace`, `go test ./...`, `go build -o orb .`

## Phase 1. 런타임 서버 현행화

완료된 항목:

- [x] `runtime` crate 생성
- [x] axum 기반 HTTP/WebSocket 서버
- [x] `/healthz`
- [x] Bearer token 인증 middleware
- [x] `~/.config/orbit/token` 로드/생성
- [x] `~/.config/orbit/config.toml` 설정 로드
- [x] in-memory SQLite DB open/migrate
- [x] sessions table
- [x] session_logs table
- [x] audit jsonl append

남은 항목:

- [ ] token 파일 권한 강제 또는 경고
- [ ] API error body 구조화
- [ ] stop timeout 의미 구현

## Phase 2. PTY와 세션 라이프사이클

완료된 항목:

- [x] `ToolType` 정의: `codex`, `claude-code`, `opencode`, `pi`
- [x] tool -> executable 매핑
- [x] portable-pty spawn
- [x] cwd/env 전달
- [x] session id/name/status/pid/cwd 저장
- [x] PTY output reader thread
- [x] output broadcast channel
- [x] scrollback buffer
- [x] in-memory 로그 저장, base64 encoded
- [x] child exit monitor thread
- [x] stop 요청 시 child kill
- [x] running 세션 삭제 방지

남은 항목:

- [ ] graceful stop: SIGTERM 후 timeout 뒤 kill
- [ ] `orbitd` 재시작 후 DB의 running 세션 상태 정리
- [ ] PTY resize 실제 적용
- [ ] scrollback/log 저장 정책 통합 정리

## Phase 3. orbitd API

현재 endpoint:

| Method | Path | 상태 |
| --- | --- | --- |
| `GET` | `/healthz` | 완료 |
| `POST` | `/api/v1/sessions` | 완료 |
| `GET` | `/api/v1/sessions` | 완료 |
| `GET` | `/api/v1/sessions/:id` | 완료 |
| `POST` | `/api/v1/sessions/:id/stop` | 완료 |
| `DELETE` | `/api/v1/sessions/:id` | 완료 |
| `GET` | `/api/v1/sessions/:id/logs` | 완료 |
| `GET` | `/api/v1/sessions/:id/attach` | 완료 |

남은 항목:

- [ ] API contract 테스트
- [ ] WebSocket status/exit/error message 송신
- [ ] logs follow streaming이 필요하면 별도 WebSocket 또는 SSE 설계

## Phase 4. Go TUI 클라이언트

완료된 항목:

- [x] Bubble Tea 기반 세션 목록
- [x] running/all 필터
- [x] 세션 생성 form
- [x] env 입력 parsing (`KEY=VALUE` 공백 구분)
- [x] stop/delete/logs action
- [x] REST client 구현
- [x] 외부 attach subprocess 의존 제거
- [x] Go WebSocket attach 구현
- [x] raw mode 처리
- [x] stdin -> WebSocket stdin relay
- [x] WebSocket stdout -> terminal relay
- [x] WebSocket client frame masking
- [x] `Ctrl-]`/`Ctrl-\` detach sequence
- [x] explicit WebSocket detach message

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

남은 항목:

- [ ] delete confirm UI
- [ ] create form validation 개선
- [ ] logs tail 개수 조절
- [ ] attach resize 이벤트 송신
- [ ] attach 구현 단위 테스트 추가
- [ ] 서버 주소 설정 옵션 추가

## Phase 5. 웹 UI

현재 웹 디렉터리는 유지하지만 핵심 MVP 경로는 TUI다. 웹은 같은 `orbitd` API를 호출하는 클라이언트로 유지한다.

남은 항목:

- [ ] 웹 백엔드와 orbitd API 관계 정리
- [ ] 웹 프론트 세션 목록 현행 API 연동
- [ ] 브라우저 attach가 필요하면 xterm.js + WebSocket 직접 연결

## Phase 6. 문서와 배포

완료된 항목:

- [x] README를 `orbitd` + `orb` 구조로 갱신
- [x] 이전 명령줄 클라이언트 참조 제거
- [x] Cargo workspace에서 `cli` 제거
- [x] Cargo.lock 재생성

남은 항목:

- [ ] 릴리즈 빌드 스크립트 정리
- [ ] systemd 또는 supervisor 실행 예시
- [ ] TUI 바이너리 설치 경로 결정

## 검증 체크리스트

기본 검증:

```bash
cd /data/private/orbit/orbitd
cargo check --workspace

cd /data/private/orbit/orb
go test ./...
go build -o orb .
```

수동 시나리오:

1. `cd orbitd && cargo run -p orbitd` 실행
2. `cd orb && go run .` 실행
3. `n`으로 `codex` 세션 생성
4. 세션 목록에 running 표시 확인
5. `enter` 또는 `a`로 attach
6. `Ctrl-]` 또는 `Ctrl-\`로 detach
7. `l`로 로그 확인
8. `s`로 stop
9. `tab`으로 all 목록 전환
10. `x`로 stopped 세션 삭제
