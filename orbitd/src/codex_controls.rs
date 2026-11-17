use super::*;

pub(super) fn safe_settings(value: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in [
        "cwd",
        "model",
        "modelProvider",
        "effort",
        "serviceTier",
        "approvalPolicy",
        "sandboxPolicy",
        "collaborationMode",
    ] {
        if let Some(value) = value.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}
pub(super) fn resume_settings(result: &Value) -> Value {
    safe_settings(
        &json!({"cwd":result["cwd"],"model":result["model"],"modelProvider":result["modelProvider"],"effort":result["reasoningEffort"],"serviceTier":result["serviceTier"],"approvalPolicy":result["approvalPolicy"],"sandboxPolicy":result["sandbox"],"collaborationMode":result["collaborationMode"]}),
    )
}
pub(super) fn message_text(body: &Value) -> Result<&str> {
    let text = body["text"]
        .as_str()
        .filter(|t| !t.trim().is_empty() && t.len() <= 100_000)
        .context("Enter a message of 1–100,000 bytes")?;
    if text.trim_start().starts_with('/') {
        bail!("슬래시 명령은 명령으로 실행하세요. /help에서 지원 명령을 확인할 수 있습니다.");
    }
    Ok(text)
}
fn no_args(args: &str) -> Result<()> {
    if !args.is_empty() {
        bail!("이 명령은 인수를 받지 않습니다.");
    }
    Ok(())
}
fn catalog() -> Value {
    json!([
        {"name":"status","description":"세션 설정 · 토큰 사용량","duringTask":true},
        {"name":"model","description":"모델 · 추론 강도 선택","usage":"/model [모델] [추론 강도]","duringTask":true},
        {"name":"permissions","description":"작업 권한 선택","usage":"/permissions [read-only|workspace-write|full-access]","duringTask":true},
        {"name":"fast","description":"Fast 모드 조회 · 변경","usage":"/fast [on|off]","duringTask":true},
        {"name":"usage","description":"계정 사용 한도","duringTask":true},
        {"name":"plan","description":"Plan 모드 조회 · 변경","usage":"/plan [on|off]","duringTask":false},
        {"name":"compact","description":"대화 문맥 압축","duringTask":false},
        {"name":"review","description":"변경 사항 코드 리뷰","usage":"/review [리뷰 지침]","duringTask":false},
        {"name":"rename","description":"Codex 대화 이름 변경","usage":"/rename 이름","duringTask":true},
        {"name":"pwd","description":"현재 작업 폴더","duringTask":true},
        {"name":"skills","description":"사용 가능한 스킬","duringTask":true},
        {"name":"mcp","description":"현재 대화의 MCP 서버와 도구","duringTask":true},
        {"name":"ps","description":"이 대화의 백그라운드 터미널","duringTask":true},
        {"name":"stop","description":"이 대화의 백그라운드 터미널 정리","duringTask":true},
        {"name":"copy","description":"마지막 답변 복사","duringTask":true},
        {"name":"export","description":"대화 Markdown 다운로드","duringTask":false},
        {"name":"help","description":"지원 명령과 입력 방법","duringTask":true}
    ])
}
impl CodexSession {
    pub(super) fn gate(&self) -> Result<SendingGuard> {
        let guard = self
            .sending
            .clone()
            .try_lock_owned()
            .map_err(|_| anyhow!("입력 또는 설정 적용 중입니다. 잠시 후 다시 시도하세요."))?;
        Ok(SendingGuard {
            _guard: Some(guard),
            events: self.events.clone(),
        })
    }
    pub(crate) fn read_operation(body: &Value) -> bool {
        if body["op"] == "history" {
            return true;
        }
        if body["op"] != "command" {
            return false;
        }
        let text = body["command"].as_str().unwrap_or("").trim();
        let (name, args) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        (args.trim().is_empty()
            && [
                "/help",
                "/?",
                "/status",
                "/model",
                "/permissions",
                "/permission",
                "/usage",
                "/pwd",
                "/cwd",
                "/skills",
                "/mcp",
                "/ps",
                "/copy",
                "/export",
                "/fast",
                "/plan",
            ]
            .contains(&name))
            || (name == "/fast" && args.trim() == "status")
    }
    pub(super) fn publish_state(&self) {
        self.state.lock().unwrap().queue_version += 1;
        let _ = self
            .events
            .send(json!({"type":"state","state":self.snapshot()}));
    }
    pub(crate) fn restore_queue(&self, snapshot: &Value) {
        let mut live = self.state.lock().unwrap();
        live.queue = snapshot["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into();
        live.queue_version = snapshot["version"].as_u64().unwrap_or(0) + 1;
        live.queue_paused = !live.queue.is_empty();
        if live.queue_paused {
            live.queue_error = Some("재연결 후 이력을 확인하고 대기열을 다시 시작하세요.".into());
        }
    }
    pub(super) fn enqueue(&self, body: &Value) -> Result<Value> {
        let text = message_text(body)?;
        if !self.connected() {
            bail!("연결이 종료되었습니다. 다시 연결한 뒤 추가하세요.");
        }
        let mut live = self.state.lock().unwrap();
        if live.queue.len() >= 20 {
            bail!("대기 메시지는 최대 20개입니다.");
        }
        let entry = json!({"id":Uuid::new_v4().to_string(),"text":text});
        live.queue.push_back(entry.clone());
        drop(live);
        self.publish_state();
        Ok(json!({"queued":true,"entryId":entry["id"],"state":self.snapshot()}))
    }
    pub(super) async fn drain_queue(&self) {
        let Ok(_guard) = self.sending.try_lock() else {
            return;
        };
        loop {
            let entry = {
                let mut live = self.state.lock().unwrap();
                if !live.connected || live.active.is_some() || live.queue_paused {
                    return;
                }
                live.queue.pop_front()
            };
            let Some(entry) = entry else {
                return;
            };
            self.publish_state();
            if let Err(error) = self.start_text(entry["text"].as_str().unwrap_or("")).await {
                let mut live = self.state.lock().unwrap();
                live.queue.push_front(entry);
                live.queue_paused = true;
                live.queue_error = Some(format!(
                    "전송 여부를 이력에서 확인한 뒤 재시작하세요: {error}"
                ));
                drop(live);
                self.publish_state();
                return;
            }
        }
    }
    pub(super) async fn start_text(&self, text: &str) -> Result<Value> {
        let result = self.rpc("turn/start", json!({"threadId":self.thread_id(),"input":[{"type":"text","text":text,"text_elements":[]}]})).await?;
        let mut live = self.state.lock().unwrap();
        if let Some(id) = result["turn"]["id"].as_str() {
            if result["turn"]["status"] == "inProgress" && !live.completed.contains(id) {
                live.active = Some(id.into());
            }
        }
        Ok(result)
    }
    async fn models(&self) -> Result<Value> {
        let mut data = Vec::new();
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        loop {
            let page = self
                .rpc("model/list", json!({"limit":100,"cursor":cursor}))
                .await?;
            data.extend(
                page["data"]
                    .as_array()
                    .context("Invalid model list")?
                    .iter()
                    .cloned(),
            );
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            if !seen.insert(cursor.to_string()) {
                bail!("Repeated model cursor");
            }
        }
        Ok(json!(data))
    }
    async fn settings_update(&self, patch: Value) -> Result<Value> {
        let current = self.snapshot()["settings"].clone();
        let unchanged = patch
            .as_object()
            .context("Invalid settings")?
            .iter()
            .all(|(key, value)| current.get(key) == Some(value));
        if unchanged {
            return Ok(current);
        }
        let mut events = self.events.subscribe();
        let mut params = patch.as_object().cloned().context("Invalid settings")?;
        params.insert("threadId".into(), json!(self.thread_id()));
        self.rpc("thread/settings/update", json!(params)).await?;
        let notification = timeout(Duration::from_secs(2), async {
            loop {
                let event = events
                    .recv()
                    .await
                    .context("Settings notification unavailable")?;
                if event["message"]["method"] == "thread/settings/updated" {
                    return Ok::<_, anyhow::Error>(());
                }
            }
        })
        .await;
        if matches!(notification, Ok(Ok(()))) {
            return Ok(self.snapshot()["settings"].clone());
        }
        // No-op changes do not necessarily emit an event. Rejoin this exact loaded thread
        // with no overrides to fetch authoritative settings, rather than claiming success.
        let result = self
            .rpc(
                "thread/resume",
                json!({"threadId":self.thread_id(),"excludeTurns":true}),
            )
            .await?;
        let fresh = resume_settings(&result);
        let mut live = self.state.lock().unwrap();
        for (key, value) in fresh.as_object().unwrap() {
            if !value.is_null() || key == "serviceTier" {
                live.settings[key] = value.clone();
            }
        }
        let matches = patch.as_object().unwrap().iter().all(|(key, value)| {
            if key == "sandboxPolicy" {
                live.settings[key]["type"] == value["type"]
            } else {
                live.settings.get(key) == Some(value)
            }
        });
        if !matches {
            bail!("설정 적용을 확인하지 못했습니다. /status로 현재 설정을 확인하세요.");
        }
        Ok(live.settings.clone())
    }
    pub(super) async fn command(&self, body: &Value) -> Result<Value> {
        let input = body["command"]
            .as_str()
            .filter(|v| v.starts_with('/') && v.len() <= 2000)
            .context("올바른 슬래시 명령을 입력하세요.")?
            .trim();
        let (raw, args) = input.split_once(char::is_whitespace).unwrap_or((input, ""));
        let args = args.trim();
        let name = match raw {
            "/?" => "help",
            "/permission" => "permissions",
            "/cwd" => "pwd",
            other => &other[1..],
        };
        let commands = catalog();
        if !commands
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == name)
        {
            bail!(
                "지원하지 않는 명령입니다: {raw}. 모델에 전송하지 않았습니다. /help를 확인하세요."
            );
        }
        let _guard = self.gate()?;
        let running = self.state.lock().unwrap().active.is_some();
        if running && ["compact", "review", "plan", "export"].contains(&name) {
            bail!("{raw}는 현재 작업이 끝난 뒤 실행할 수 있습니다.");
        }
        let settings = self.snapshot()["settings"].clone();
        let thread_id = self.thread_id();
        let result = match name {
            "help" => {
                no_args(args)?;
                json!({"type":"help","commands":commands})
            }
            "status" => {
                no_args(args)?;
                json!({"type":"status","threadId":thread_id,"state":self.snapshot()})
            }
            "model" => {
                let models = self.models().await?;
                if !args.is_empty() {
                    let parts: Vec<_> = args.split_whitespace().collect();
                    if parts.len() > 2 {
                        bail!("/model 모델 [추론 강도] 형식으로 입력하세요.");
                    }
                    let selected = models
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|model| model["model"] == parts[0] || model["id"] == parts[0])
                        .context("지원하지 않는 모델입니다. /model에서 선택하세요.")?;
                    let efforts = selected["supportedReasoningEfforts"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let effort = if parts.len() == 2 {
                        if !efforts.iter().any(|e| e["reasoningEffort"] == parts[1]) {
                            bail!("이 모델에서 지원하지 않는 추론 강도입니다.");
                        }
                        json!(parts[1])
                    } else {
                        selected["defaultReasoningEffort"].clone()
                    };
                    let mut patch = json!({"model":selected["model"]});
                    if !effort.is_null() {
                        patch["effort"] = effort;
                    }
                    self.settings_update(patch).await?;
                }
                json!({"type":"model","models":models,"state":self.snapshot(),"applied":!args.is_empty()})
            }
            "permissions" => {
                if !args.is_empty() {
                    let (policy, approval) = match args {
                        "read-only" => (
                            json!({"type":"readOnly","networkAccess":false}),
                            "on-request",
                        ),
                        "workspace-write" | "auto" => (
                            json!({"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}),
                            "on-request",
                        ),
                        "full-access" => {
                            if body["confirmFullAccess"] != true {
                                bail!("전체 접근은 파일·네트워크 권한 확인 후 명시적으로 동의해야 합니다.");
                            }
                            (json!({"type":"dangerFullAccess"}), "never")
                        }
                        _ => bail!("read-only, workspace-write, full-access 중 선택하세요."),
                    };
                    self.settings_update(json!({"sandboxPolicy":policy,"approvalPolicy":approval}))
                        .await?;
                }
                json!({"type":"permissions","state":self.snapshot(),"applied":!args.is_empty()})
            }
            "fast" => {
                if !["", "status", "on", "off"].contains(&args) {
                    bail!("/fast [on|off] 형식으로 입력하세요.");
                }
                let models = self.models().await?;
                let model = models
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["model"] == settings["model"])
                    .context("현재 모델 정보를 찾을 수 없습니다.")?;
                let mut supported = model["serviceTiers"].as_array().is_some_and(|tiers| {
                    tiers
                        .iter()
                        .any(|t| t["id"] == "priority" || t["id"] == "fast")
                }) || model["additionalSpeedTiers"]
                    .as_array()
                    .is_some_and(|tiers| tiers.contains(&json!("fast")));
                let config = self
                    .rpc(
                        "config/read",
                        json!({"cwd":settings["cwd"],"includeLayers":false}),
                    )
                    .await?;
                let requirements = self.rpc("configRequirements/read", json!({})).await?;
                supported &= config["config"]["features"]["fast_mode"] != false
                    && requirements["requirements"]["featureRequirements"]["fast_mode"] != false;
                if args == "on" && !supported {
                    bail!("현재 모델에서 Fast를 지원하지 않습니다.");
                }
                if args == "on" || args == "off" {
                    self.settings_update(
                        json!({"serviceTier":if args == "on" {"priority"} else {"default"}}),
                    )
                    .await?;
                }
                json!({"type":"fast","supported":supported,"state":self.snapshot()})
            }
            "usage" => {
                no_args(args)?;
                let usage = self
                    .rpc(
                        "account/rateLimits/read",
                        json!({"excludeResetCreditDetails":true}),
                    )
                    .await?;
                // Only relay quota buckets; never account IDs, email or credentials.
                json!({"type":"usage","rateLimits":usage["rateLimits"],"rateLimitsByLimitId":usage["rateLimitsByLimitId"]})
            }
            "pwd" => {
                no_args(args)?;
                json!({"type":"pwd","cwd":settings["cwd"]})
            }
            "rename" => {
                if args.is_empty() || args.len() > 200 {
                    bail!("/rename 이름 (최대 200바이트) 형식으로 입력하세요.");
                }
                self.rpc("thread/name/set", json!({"threadId":thread_id,"name":args}))
                    .await?;
                json!({"type":"rename","name":args})
            }
            "compact" => {
                no_args(args)?;
                self.rpc("thread/compact/start", json!({"threadId":thread_id}))
                    .await?;
                json!({"type":"compact","message":"대화 문맥 압축을 시작했습니다."})
            }
            "review" => {
                let target = if args.is_empty() {
                    json!({"type":"uncommittedChanges"})
                } else {
                    json!({"type":"custom","instructions":args})
                };
                let result = self
                    .rpc(
                        "review/start",
                        json!({"threadId":thread_id,"target":target,"delivery":"inline"}),
                    )
                    .await?;
                if let Some(id) = result["turn"]["id"].as_str() {
                    let mut live = self.state.lock().unwrap();
                    if result["turn"]["status"] == "inProgress" && !live.completed.contains(id) {
                        live.active = Some(id.into());
                    }
                }
                json!({"type":"review","message":"코드 리뷰를 시작했습니다.","state":self.snapshot()})
            }
            "plan" => {
                if !["", "on", "off"].contains(&args) {
                    bail!("/plan [on|off] 형식으로 입력하세요.");
                }
                let modes = self.rpc("collaborationMode/list", json!({})).await?;
                if !args.is_empty() {
                    let mode = if args == "on" { "plan" } else { "default" };
                    if !modes["data"]
                        .as_array()
                        .is_some_and(|modes| modes.iter().any(|m| m["mode"] == mode))
                    {
                        bail!("이 데몬에서 요청한 대화 모드를 지원하지 않습니다.");
                    }
                    self.settings_update(json!({"collaborationMode":{"mode":mode,"settings":{"model":settings["model"],"reasoning_effort":settings["effort"],"developer_instructions":null}}})).await?;
                }
                json!({"type":"plan","modes":modes["data"],"state":self.snapshot()})
            }
            "mcp" => {
                no_args(args)?;
                let result = self
                    .rpc(
                        "mcpServerStatus/list",
                        json!({"threadId":thread_id,"detail":"full","limit":100}),
                    )
                    .await?;
                json!({"type":"mcp","data":result["data"],"nextCursor":result["nextCursor"]})
            }
            "skills" => {
                no_args(args)?;
                let result = self
                    .rpc("skills/list", json!({"cwds":[settings["cwd"]]}))
                    .await?;
                json!({"type":"skills","data":result["data"]})
            }
            "ps" => {
                no_args(args)?;
                let result = self
                    .rpc(
                        "thread/backgroundTerminals/list",
                        json!({"threadId":thread_id,"limit":100}),
                    )
                    .await?;
                json!({"type":"ps","data":result})
            }
            "stop" => {
                no_args(args)?;
                self.rpc(
                    "thread/backgroundTerminals/clean",
                    json!({"threadId":thread_id}),
                )
                .await?;
                json!({"type":"stop","message":"이 대화의 백그라운드 터미널을 정리했습니다."})
            }
            "copy" | "export" => {
                no_args(args)?;
                json!({"type":name})
            }
            _ => unreachable!(),
        };
        self.publish_state();
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn setup() -> (crate::codex::tests::Fixture, CodexSession) {
        let f = crate::codex::tests::fixture().await;
        let handle = CodexSession::connect(&f.socket).await.unwrap();
        handle.create(&f.directory).await.unwrap();
        (f, handle)
    }
    async fn command(h: &CodexSession, text: &str) -> Result<Value> {
        h.operation(&json!({"op":"command","command":text})).await
    }
    #[tokio::test]
    async fn status_models_and_inventory_are_read_only_and_do_not_expose_config_or_account_identifiers(
    ) {
        let (_f, h) = setup().await;
        for text in [
            "/status",
            "/model",
            "/usage",
            "/fast",
            "/permissions",
            "/plan",
            "/pwd",
            "/mcp",
            "/skills",
            "/ps",
            "/help",
        ] {
            let value = command(&h, text).await.unwrap();
            assert!(!value.to_string().contains("PRIVATE"), "{text}");
        }
        assert!(h.state.lock().unwrap().completed.is_empty());
        assert!(h.snapshot()["activeTurn"].is_null());
        assert_eq!(
            command(&h, "/status").await.unwrap()["state"]["settings"]["model"],
            "test-model"
        );
        assert!(command(&h, "/status extra").await.is_err());
        assert!(command(&h, "/not-a-command").await.is_err());
        assert!(h
            .operation(&json!({"op":"send","text":"/model"}))
            .await
            .is_err());
        h.close().await;
    }
    #[tokio::test]
    async fn model_permissions_and_fast_apply_to_the_thread_and_validate_effort_and_full_access() {
        let (_f, h) = setup().await;
        h.operation(&json!({"op":"send","text":"working"}))
            .await
            .unwrap();
        command(&h, "/model test-model low").await.unwrap();
        assert_eq!(h.snapshot()["settings"]["effort"], "low");
        assert!(command(&h, "/model small high").await.is_err());
        assert!(command(&h, "/permissions full-access").await.is_err());
        h.operation(
            &json!({"op":"command","command":"/permissions full-access","confirmFullAccess":true}),
        )
        .await
        .unwrap();
        assert_eq!(
            h.snapshot()["settings"]["sandboxPolicy"]["type"],
            "dangerFullAccess"
        );
        command(&h, "/permissions read-only").await.unwrap();
        assert_eq!(h.snapshot()["settings"]["approvalPolicy"], "on-request");
        command(&h, "/fast on").await.unwrap();
        assert_eq!(h.snapshot()["settings"]["serviceTier"], "priority");
        command(&h, "/fast off").await.unwrap();
        assert_eq!(h.snapshot()["settings"]["serviceTier"], "default");
        for text in ["/plan on", "/compact", "/review", "/export"] {
            assert!(command(&h, text).await.is_err());
        }
        assert_eq!(h.snapshot()["activeTurn"], "turn-1");
        h.operation(&json!({"op":"interrupt"})).await.unwrap();
        command(&h, "/model small").await.unwrap();
        assert!(command(&h, "/fast on").await.is_err());
        command(&h, "/plan on").await.unwrap();
        assert_eq!(
            h.snapshot()["settings"]["collaborationMode"]["mode"],
            "plan"
        );
        h.close().await;
    }
    #[tokio::test]
    async fn steer_keeps_the_same_turn_and_queued_messages_run_in_order_after_completion() {
        let (_f, h) = setup().await;
        h.operation(&json!({"op":"send","text":"working"}))
            .await
            .unwrap();
        let steer = h
            .operation(&json!({"op":"steer","text":"more detail"}))
            .await
            .unwrap();
        assert_eq!(steer["steered"], true);
        assert_eq!(h.snapshot()["activeTurn"], "turn-1");
        h.operation(&json!({"op":"queue","text":"fast second"}))
            .await
            .unwrap();
        let canceled = h
            .operation(&json!({"op":"queue","text":"remove me"}))
            .await
            .unwrap();
        h.operation(&json!({"op":"queue","text":"fast third"}))
            .await
            .unwrap();
        h.operation(&json!({"op":"queue/remove","entryId":canceled["entryId"]}))
            .await
            .unwrap();
        assert_eq!(h.snapshot()["queue"]["items"].as_array().unwrap().len(), 2);
        h.operation(&json!({"op":"reply","requestId":101,"decision":"accept"}))
            .await
            .unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if h.state.lock().unwrap().completed.len() == 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(h.snapshot()["queue"]["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(h.snapshot()["activeTurn"].is_null());
        h.close().await;
    }
    #[tokio::test]
    async fn interrupt_pauses_and_preserves_queued_messages_until_explicit_resume() {
        let (_f, h) = setup().await;
        h.operation(&json!({"op":"send","text":"working"}))
            .await
            .unwrap();
        h.operation(&json!({"op":"queue","text":"fast next"}))
            .await
            .unwrap();
        h.operation(&json!({"op":"interrupt"})).await.unwrap();
        assert_eq!(h.snapshot()["queue"]["paused"], true);
        assert_eq!(h.snapshot()["queue"]["items"].as_array().unwrap().len(), 1);
        h.operation(&json!({"op":"queue/resume"})).await.unwrap();
        assert!(h.snapshot()["queue"]["items"]
            .as_array()
            .unwrap()
            .is_empty());
        h.close().await;
    }
    #[test]
    fn stopped_sessions_allow_only_explicit_read_operations() {
        for text in [
            "/status",
            "/model",
            "/fast status",
            "/usage",
            "/permissions",
        ] {
            assert!(CodexSession::read_operation(
                &json!({"op":"command","command":text})
            ));
        }
        for text in [
            "/model small",
            "/fast on",
            "/permissions full-access",
            "/compact",
            "/review",
        ] {
            assert!(!CodexSession::read_operation(
                &json!({"op":"command","command":text})
            ));
        }
        assert!(!CodexSession::read_operation(
            &json!({"op":"steer","text":"x"})
        ));
    }
}
