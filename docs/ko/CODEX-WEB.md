# Codex 세션의 CLI / Web 실행 방식

새 Codex 세션을 만들 때 **Open with → CLI · Terminal / Web · Chat**을 선택한다.
기존 세션과 `mode`를 생략한 API 요청은 CLI로 동작한다. Orb 세션의 CLI/Web 실행 방식 자체는 생성 후 변경하지 않는다. Web에서는 `/resume`으로 저장된 Codex 대화로 전환할 수 있다.

- CLI: 기존 orbitd PTY, xterm Attach, 터미널 로그 경로를 사용한다.
- Web: 선택한 orbitd 호스트의 기존 Codex App Server 데몬에 Unix WebSocket으로 연결한다. PTY와 Codex CLI 프로세스를 생성하지 않는다.
- 채팅에 포함: 입력, 스트리밍, 페이지 이력, 요약·계획·도구 출력, 중단, 명령/파일 승인, 사용자 질문 응답.
- 세션 목록·생성·삭제·파일 탐색·서버 선택은 기존 Orb 화면을 사용한다. 별도 Codex 계정 로그인 화면은 제공하지 않는다. 대화 안에서 모델·권한·Fast 설정과 사용량 조회, 추가 입력·대기열을 사용한다.
- Web의 새 대화는 **YOLO (`sandbox: danger-full-access`, `approvalPolicy: never`)**를 기본으로 생성한다. `/resume`과 재연결은 저장된 모델·권한을 override 없이 이어받는다. 세션별 Environment 입력은 지원하지 않으며 데몬의 실행 환경을 사용한다.

## 서버 준비

orbitd와 Codex 데몬은 같은 사용자 권한으로 실행한다. 이미 실행 중인 데몬에만 연결하며 자동 기동·업데이트·독립 서버 fallback은 하지 않는다.

```sh
codex app-server daemon version
codex app-server daemon start  # 아직 실행하지 않은 경우에만
```

| 환경 변수 | 의미 |
| --- | --- |
| `ORBIT_CODEX_SOCKET` | Codex 데몬 소켓. 기본은 `$CODEX_HOME/app-server-control/app-server-control.sock`, CODEX_HOME 미설정 시 `~/.codex` 기준 |
| `ORBIT_DATA_DIR` | Orbit 데이터 디렉터리. 기본 `~/.local/share/orbit` |

`GET /api/v1/backends`는 `modes`를 제공한다. Codex 소켓이 있으면 `codex`는 `["cli","web"]`, 나머지는 `["cli"]`다. 구버전 서버나 소켓이 없는 서버에서는 Web 선택을 막는다. 소켓 존재 확인 이후 실제 연결 실패도 사용자에게 표시하며 CLI 세션으로 바꾸지 않는다.

```json
POST /api/v1/sessions
{"tool":"codex","mode":"web","name":"작업","cwd":"/absolute/project","env":{}}
```

응답은 `mode: "web"`, `pid: null`, `codex_thread_id`를 포함한다. WebSocket `/api/v1/sessions/:id/codex`는 기존 Bearer 인증을 사용하며, Web 백엔드가 선택한 orbitd로 연결과 인증을 전달한다. 브라우저는 세션 ID로만 접근하고 임의 RPC·소켓 경로·Codex thread ID를 지정할 수 없다.

허용 작업은 `history`, `send`, `steer`, `queue`, `queue/remove`, `queue/resume`, `command`, `interrupt`, `reply`다. 실행 중 Enter는 현재 턴에 추가 지시를 반영하고, Tab 또는 다음 턴 버튼은 완료 후 순차 전송할 대기열에 넣는다. 복수 브라우저의 중복 입력과 승인 응답은 서버에서 검사한다. 서버가 제공하는 추론 요약만 표시하며 raw reasoning은 표시하지 않는다.

## 대화 명령과 입력

`/`를 입력하면 서버가 제공하는 명령 목록이 열린다. 방향키로 선택하고 Tab으로 완성한다. 지원하지 않는 명령은 모델에 전송하지 않고 입력창에 남긴다.

- `/resume [검색어 또는 대화 ID]`: 이전 대화를 찾고 같은 Orb 세션에서 전환.
- `/status`: 현재 세션 설정, 토큰 사용량.
- `/model [모델] [추론 강도]`: 실제 사용 가능한 모델 목록과 추론 강도 선택.
- `/permissions [read-only|workspace-write|full-access]`: 현재 대화의 권한 변경. 전체 접근은 선택 창에서 명시적으로 확인한다.
- `/fast [on|off]`, `/usage`: Fast 설정과 계정 사용 한도. 서버 정책과 모델이 지원할 때만 Fast를 적용한다.
- `/plan [on|off]`, `/compact`, `/review [지침]`: Plan, 문맥 압축, 변경 리뷰. 실행 중인 작업이 끝난 뒤 사용한다.
- `/rename 이름`, `/pwd`, `/skills`, `/mcp`, `/ps`, `/stop`: 대화 이름·폴더·스킬·MCP·현재 대화의 백그라운드 터미널 조회/정리.
- `/copy`, `/export`, `/help`: 마지막 답변 복사, 대화 Markdown 다운로드, 지원 명령 안내.

모델·권한·Fast·상태 조회는 작업 중에도 사용할 수 있다. 설정은 해당 Codex thread에만 적용한다. 임의 RPC나 전역 설정 파일 쓰기는 허용하지 않는다. CLI의 계정 로그인, TUI 전환 등 모든 명령을 지원하는 것은 아니며 실제 지원 목록은 `/help`로 확인한다. 종료된 세션에서는 조회 명령과 명시적인 `/resume` 전환을 허용한다. 전환 성공 시 같은 Orb 세션을 running으로 갱신한다.

대기열은 최대 20개이며 항목별 취소가 가능하다. 중단·실패·연결 종료 시 자동 전송을 멈추고, 사용자가 이력을 확인한 뒤 재시작한다. 브라우저를 닫아도 orbitd가 대기열을 처리하지만 **orbitd 프로세스를 재시작하면 아직 보내지 않은 대기열은 사라진다**.

화면 상단에 실행 호스트·작업 폴더·Web 구분을, 입력창 아래에 모델·추론 강도·Fast 상태를 표시한다. 모바일 Web 입력창은 `+` 버튼·입력·전송을 한 행에 배치하고 별도 키보드 버튼은 제공하지 않는다. CLI의 터미널 단축키 바는 유지한다. 출력은 최대 높이와 위·아래 접기 버튼을 유지하며 빈 추론 요약은 표시하지 않는다.

구버전 orbitd에서는 capability를 확인해 새 명령과 실행 중 입력을 비활성화한다. 새 프론트와 함께 orbitd 바이너리를 교체해야 기능이 활성화된다.

## `/resume`으로 대화 전환

`/resume`은 현재 작업 폴더의 최근 대화를 표시한다. 이름 검색, 모든 작업 폴더 선택, 페이지 추가 조회를 지원한다. `/resume <Codex UUID>`는 해당 대화로 직접 전환한다. CLI에서 저장한 대화도 목록에 포함되며, Codex 데몬의 writer 잠금 오류를 우회하지 않는다.

**Orb 세션 ID와 실행 호스트는 유지**하고 Codex thread ID·대화 이름·작업 폴더·이력·모델·권한을 선택한 대화로 바꾼다. 전환 전 현재 작업·승인·대기 메시지가 없어야 하고, 선택한 대화에서도 작업이 실행 중이면 거부한다. 다른 실행 중 Orb Web 세션에 연결된 대화는 해당 세션에서 계속 사용한다. 로컬 첨부를 먼저 보내거나 해제한 뒤 전환한다.

새 연결에서 대상 대화와 이력을 확인한 뒤 메타데이터를 저장하고 연결을 교체한다. 오류가 나면 원래 대화를 유지한다. 재시작 후에도 전환한 thread를 복원하며, resume된 대화를 빈 thread로 교체하지 않는다. 다른 브라우저의 이전 연결은 끊어 오래된 화면에서 이전 대화로 입력하지 못하게 한다. 대상 대화의 과거 이미지가 다른 Orb 세션이나 CLI의 경로라면 경로만 표시할 수 있다.

## 이미지 첨부

입력창의 **+ → 이미지 선택**, 채팅 화면에 드래그 앤 드롭, 클립보드 이미지 붙여넣기를 지원한다. 모바일에서는 파일 선택기와 붙여넣기를 사용한다. PNG/JPEG/WebP/GIF를 파일당 50 MiB, 메시지당 8개까지 첨부한다. 업로드 중이거나 실패한 첨부가 있으면 전송을 막고 재시도·첨부 해제를 제공한다.

이미지는 Orb API 컨테이너가 아닌 **선택한 orbitd 실행 호스트**의 `/tmp/orbit-codex-images-<uid>/<orb-session-id>/<image-uuid>.<확장자>`에 저장한다. 디렉터리는 0700, 파일은 0600이며 API 인증·세션 범위·파일 형식을 확인한다. 세션당 임시 저장 한도는 512 MiB / 128개다. 클라이언트는 업로드 ID만 전송하고 임의 경로를 지정할 수 없다.

경로는 첨부 카드에서 확인·복사할 수 있고 Codex에는 경로 문자열만 적는 대신 `localImage` 입력으로 전달한다. 이미지 단독 입력, 실행 중 즉시 반영, 다음 턴 대기열에서도 같은 첨부를 보낸다. 전송에 실패하면 첨부와 입력을 유지한다. 대화 이력에도 세션별 인증을 거쳐 미리보기를 표시하고 Markdown 내보내기에는 이미지 경로를 포함한다.

`POST /api/v1/sessions/:id/images`는 이미지 MIME의 바이너리를 받고 `{id,path,mime,size}`를 반환한다. `GET /api/v1/sessions/:id/images/:image`는 인증된 미리보기이며 임의 파일 읽기를 제공하지 않는다. WebSocket `send`·`steer`·`queue`의 `images`는 업로드 ID 배열이다. 새 orbitd의 `capabilities.images`가 있어야 첨부 UI가 활성화된다.

첨부 해제는 메시지에서만 제외한다. 업로드 파일은 재연결·orbitd 재시작 이후에도 임시 파일이 남아 있는 동안 사용할 수 있다. `/tmp`는 영구 보관소가 아니므로 OS의 임시 파일 정리나 호스트 재부팅으로 사라질 수 있다. 삭제된 이미지는 다시 첨부해야 한다. 대기열 자체의 orbitd 재시작 제한은 동일하다.

## 저장과 생명주기

Web 세션 메타데이터는 `$ORBIT_DATA_DIR/codex-sessions/<orb-session-id>.json`에 원자적으로 저장한다. 디렉터리 권한은 0700, 파일은 0600이다. Orb 세션 ID, 작업 폴더, 실행 방식, Codex thread ID, 상태를 보관하고 orbitd 재시작 시 복원한다. CLI 세션/PTY의 기존 인메모리 저장 동작은 변경하지 않는다.

- 브라우저 종료·Detach: Codex 턴과 데몬을 종료하지 않는다. 같은 Orb 세션을 열면 이력과 진행 상태에 다시 연결한다.
- 중단 버튼: 해당 대화의 실행 중인 턴만 중단한다.
- 세션 Stop: 전송 중인 요청을 조율하고 실행 중인 턴을 중단한 뒤 해당 Codex 연결을 닫고 stopped로 저장한다. 종료된 Web 세션을 다시 열면 이력만 조회하고 새 입력은 서버에서도 차단한다.
- 세션 Delete: 해당 세션을 중단하고 Orb의 연결 정보만 삭제한다. Codex 저장 대화를 삭제하거나 공유 데몬을 종료하지 않는다.
- 재연결: 저장된 정확한 thread ID를 설정 override 없이 resume한다. 폴더가 다르거나 다른 writer 잠금이 있으면 오류를 표시한다. 입력을 시도한 기록이 없는 빈 thread가 Codex에서 사라진 경우에만 새 빈 thread로 연결을 갱신한다. 입력 시도 여부는 제출 전에 메타데이터에 저장해, 대화가 있는 세션을 새 대화로 바꾸지 않는다. 이전 버전 메타데이터처럼 입력 여부를 모르면 보수적으로 기존 thread만 사용한다.
- 첫 입력 전 저장되지 않은 대화의 `not materialized yet` 이력 오류는 빈 이력으로 처리한다. 다른 오류는 숨기지 않는다.

## 모바일 화면 · 상태 · Working

모바일 대화 헤더에는 세션 이름·연결 상태·목록으로 돌아가기·명령 버튼을 표시한다. 호스트·폴더 요약을 누르면 전체 실행 위치를 펼친다. 탐색 메뉴는 대화를 밀지 않는 오버레이이며, 세션 목록은 이름·실행 방식·상태·경로 카드로 표시한다. Web 키보드 버튼은 제거하고 첨부·줄바꿈·예약 기능은 유지하며 첨부 카드는 가로로 넘길 수 있다. 명령 창은 모바일에서 하단 시트로 열고 visual viewport에 맞춰 키보드 위에 배치한다.

`/status`는 기존 `/usage` 조회를 함께 사용해 주간·단기 한도를 **남은 비율 막대**와 갱신 시각으로 표시한다. 설정·토큰·문맥 여유를 구분하고, 긴 모델명·경로는 화면 안에서 줄바꿈한다. 한도를 제공받지 못하면 없는 값을 채우지 않고 조회 불가로 표시한다. 상태와 사용량 조회는 모델 추론을 호출하지 않는다.

열린 명령 창·탐색 메뉴·세션 생성/폴더 선택 등의 모달은 브라우저 뒤로가기로 먼저 닫는다. 중첩 모달은 직전 모달로 돌아오며 대화 화면은 유지한다. 닫기 버튼·Esc도 같은 이력을 정리한다.

진행 중에는 입력창 위에 `Working · 3m 54s`와 현재 작업·중단 버튼을 표시한다. 실행 시작 시간이 있으면 이력을 불러온 뒤에도 같은 시점부터 계산한다. 시작 시간을 받지 못한 기존 턴은 웹에서 확인한 시점을 저장하고 `연결 후` 경과 시간으로 구분한다. 타이머 갱신은 메시지 자동 스크롤을 유발하지 않는다. **대화 입력창의 Esc**와 가상 키보드의 Esc는 현재 턴만 중단한다. 모달 안의 Esc는 모달만 닫는다.

이 기능들은 기존 orbitd 명령과 알림을 이용하므로 웹만 갱신하며 데몬 재시작이 필요 없다.

## 개발 환경

운영 중인 `orbitd`는 재시작하면 기존 PTY 세션이 사라지므로 실행 중인 세션을 확인하고 교체한다. 이번 통합은 기존 7777 서비스를 유지한 채 별도 개발 인스턴스에서 검증했다.

```sh
./script/run-codex-web-dev.sh
```

개발용 서비스: `systemctl --user status orbitd-codex-web-dev.service`

- 개발용 orbitd: `17777`, 데이터는 `tmp/codex-web-dev/data`
- 기존 Orb 개발 Web: `14000`, Web 백엔드: `14001`
- Docker 개발 Web의 Orbitd 연결에 `http://host.docker.internal:17777` 추가. 토큰은 기존 `/etc/orbitd/token`과 동일하다.
- 이 서비스는 개발 검증용 transient user service이며 호스트 재부팅 후에는 다시 실행한다. 이미 실행 중이면 스크립트는 자동 재시작하지 않는다.

## 검증

```sh
cargo test --manifest-path orbitd/Cargo.toml
npm test --prefix web/backend
npm test --prefix web/frontend
npm run build --prefix web/frontend
(cd orb && go test ./...)
```

Rust 테스트는 네이티브 Unix WebSocket 연결, thread 범위, 페이지 이력, 첫 입력 전 빈 이력, 승인 검증·중복 응답, 중단, 완료/응답 순서 역전, 저장·복원, 기존 CLI PTY 경로를 확인한다. Web 프록시 테스트는 선택한 호스트와 Bearer 전달을 검사하고, 프론트 테스트는 이력/스트리밍 병합과 승인 복원을 검사한다.

`web/frontend/test/codex-ui.e2e.cjs`는 개발 Playwright 컨테이너에서 실행한다. 설정과 인증 토큰은 stdin JSON으로 전달한다. `inference: true`는 모델을 한 번 호출하므로 사용량이 발생한다. 실제 생성·응답·새로고침 복원·모바일과 구버전 capability 차단을 검사하고, 도구 실행 없는 WebSocket 테스트로 승인·파일 diff·질문 UI를 검사한다. 토큰을 명령 인수나 파일에 저장하지 않는다.

`web/frontend/test/codex-commands-ui.e2e.cjs`는 실제 개발 데몬에서 명령 UI와 설정 적용을 검증하고, WebSocket fixture로 실행 중 입력·대기열을 확인한다. 설정/토큰은 같은 방식으로 stdin으로만 전달한다. 모델 추론을 호출하지 않는다.

`web/frontend/test/codex-images-ui.e2e.cjs`는 파일 선택·드롭·붙여넣기·재시도·12 MiB 바이너리 왕복·모바일과 이미지 대기열을 확인한다. `inference: true`일 때 실제 Codex 이미지 입력과 새로고침 후 미리보기를 검증하며 모델 호출이 한 번 발생한다.

`web/frontend/test/codex-resume-ui.e2e.cjs`는 검증용 대화 두 개로 같은 Orb ID 전환·새 Orb 생성 없음·이력 복원·저장된 권한 보존·실패 복구·모바일·새로고침을 확인한다. 실제 저장 이력을 만들기 위해 도구 없는 모델 호출 한 번을 수행한다.

`web/frontend/test/mobile-ui.e2e.cjs`는 320/390/768px·데스크톱, 한도 막대, 뒤로가기·중첩 모달, visual viewport 모의 키보드, Working 타이머·Esc 중단을 검증한다. 실제 모델 호출 없이 WebSocket fixture를 사용하고 검증용 Orb 세션만 생성·삭제한다.
