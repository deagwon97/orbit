export type CodexItem = { id: string; type: string; [key: string]: any };
export function newChatState() {
  return { items: new Map<string, CodexItem>(), order: [] as string[], versions: new Map<string, number>(), revision: 0,
    activity: '', turnStarts: new Map<string, number>(), lifecycle: 0, approvalsRevision: 0, active: null as string | null, completed: new Set<string>(), forkableTurns: new Set<string>(), approvals: new Map<string, any>(), nextCursor: null as string | null, settings: {} as any, tokenUsage: null as any, capabilities: {} as any, queue: { items: [] as any[], paused: false, error: null as string | null, version: 0 } };
}
export type ChatState = ReturnType<typeof newChatState>;
export function putItem(state: ChatState, item: CodexItem) {
  if (!item?.id) return;
  if (!state.items.has(item.id)) state.order.push(item.id);
  state.items.set(item.id, { ...state.items.get(item.id), ...item });
  state.versions.set(item.id, ++state.revision);
}
export function rememberTurnStart(state: ChatState, turn: any, observed = false) {
  if (!turn?.id) return;
  const raw=turn.startedAtMs ?? turn.startedAt;
  let start=typeof raw==='number'?raw:typeof raw==='string'?Date.parse(raw):NaN;
  if (turn.startedAtMs == null && typeof raw==='number' && raw>0 && raw<1e12) start=raw*1000;
  if (Number.isFinite(start) && start>0) state.turnStarts.set(turn.id,start);
  else if(observed&&!state.turnStarts.has(turn.id))state.turnStarts.set(turn.id,Date.now());
}
export function observe(state: ChatState, message: any) {
  const p = message.params || {}, method = message.method;
  if (method === 'thread/settings/updated') state.settings = p.threadSettings;
  if (method === 'thread/tokenUsage/updated') state.tokenUsage = p.tokenUsage;
  if (method === 'turn/started') {
    state.activity = '';
    rememberTurnStart(state,p.turn,true);
    state.active = p.turn.id; state.lifecycle = ++state.revision;
    for (const item of p.turn.items || []) putItem(state, { ...item, turnId: p.turn.id });
  } else if (method === 'turn/completed') {
    if (state.active === p.turn.id) {state.active = null;state.activity='';}
    state.completed.add(p.turn.id); state.lifecycle = ++state.revision;
    if (p.turn.status === 'completed') state.forkableTurns.add(p.turn.id);
    else state.forkableTurns.delete(p.turn.id);
    for (const item of p.turn.items || []) putItem(state, { ...item, turnId: p.turn.id, status: item.status || p.turn.status });
    for (const item of state.items.values()) if (item.turnId === p.turn.id && item.status === 'inProgress') putItem(state, { ...item, status: p.turn.status });
    for (const [id, request] of state.approvals) if (request.params.turnId === p.turn.id) state.approvals.delete(id);
    state.approvalsRevision = ++state.revision;
    if (p.turn.error) putItem(state, { id: `error-${p.turn.id}`, type: 'system', text: p.turn.error.message || 'Turn failed' });
  } else if (method === 'item/started' || method === 'item/completed') {
    state.activity='';
    putItem(state, { ...p.item, turnId: p.turnId, status: p.item.status || (method === 'item/started' ? 'inProgress' : 'completed') });
  } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    state.activity='';
    const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: method === 'item/plan/delta' ? 'plan' : 'agentMessage', status: 'inProgress', ...old, turnId: p.turnId, text: (old?.text || '') + p.delta });
  } else if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta'].includes(method)) {
    state.activity='';const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: method.includes('fileChange') ? 'fileChange' : 'commandExecution', status: 'inProgress', ...old, turnId: p.turnId, aggregatedOutput: (old?.aggregatedOutput || '') + p.delta });
  } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded') {
    state.activity='';
    if (!Number.isInteger(p.summaryIndex) || p.summaryIndex < 0 || p.summaryIndex > 10000) return;
    const old = state.items.get(p.itemId), summary = [...(old?.summary || [])];
    summary[p.summaryIndex] = (summary[p.summaryIndex] || '') + (p.delta || '');
    putItem(state, { id: p.itemId, type: 'reasoning', status: 'inProgress', ...old, turnId: p.turnId, summary });
  } else if (method === 'item/mcpToolCall/progress') {
    const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: 'mcpToolCall', status: 'inProgress', ...old, turnId: p.turnId, progress: (old?.progress || '') + p.message + '\n' });
  } else if (method === 'turn/plan/updated') {
    putItem(state, { id: `plan-${p.turnId}`, type: 'plan', turnId: p.turnId, status: p.plan?.some((step: any) => step.status !== 'completed') ? 'inProgress' : 'completed', text: [p.explanation, ...(p.plan || []).map((step: any) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`)].filter(Boolean).join('\n') });
  } else if (method === 'item/fileChange/patchUpdated') {
    putItem(state,{id:p.itemId,type:'fileChange',status:'inProgress',...state.items.get(p.itemId),turnId:p.turnId,changes:p.changes});
  } else if (method === 'item/commandExecution/terminalInteraction') {
    const id=`terminal-${p.itemId}-${state.revision}`;
    putItem(state,{id,type:'terminalInteraction',turnId:p.turnId,status:'completed',processId:p.processId,stdin:p.stdin});
  } else if (['warning','guardianWarning','auth/recovery','thread/authRecovery','turn/authRecovery','deprecationNotice','turn/strictReviewRequired','autoApprovalReview/strictReviewRequired','modelProvider/authRecoveryStarted','modelProvider/authRecoveryCompleted','configWarning'].includes(method)) {
    const text=p.message||p.summary||(method.includes('strictReviewRequired')?'리뷰 검사 중입니다.':'');
    if(text){state.activity=method==='modelProvider/authRecoveryCompleted'?'':text;putItem(state,{id:`notice-${state.revision}`,type:'progressNotice',text,turnId:p.turnId||state.active,status:'completed'});}
  } else if (method === 'hook/started' || method === 'hook/completed') {
    const run=p.run||{};putItem(state,{id:`hook-${run.id}`,type:'hook',turnId:p.turnId||state.active,status:method==='hook/started'?'inProgress':'completed',text:[run.statusMessage,...(run.entries||[]).map((entry:any)=>entry.text)].filter(Boolean).join('\n'),eventName:run.eventName});
  } else if (method === 'thread/status/changed') {
    if(p.status?.type==='active'){
      const flags=p.status.activeFlags||[];
      state.activity=flags.includes('waitingOnApproval')?'승인 대기 중':flags.includes('waitingOnUserInput')?'사용자 입력 대기 중':'';
    }else if(p.status?.type==='idle')state.activity='';
  } else if (method === 'serverRequest/resolved') {
    state.approvals.delete(JSON.stringify(p.requestId)); state.approvalsRevision = ++state.revision;
  } else if (method === 'error' && p.willRetry) {
    const text=p.error?.message||'연결을 복구하고 다시 시도하고 있습니다.';state.activity=text;
    putItem(state,{id:`retry-${state.revision}`,type:'progressNotice',text:`재시도 중 · ${text}`,turnId:p.turnId||state.active,status:'completed'});
  } else if (method === 'error' && !p.willRetry) {
    putItem(state, { id: `server-error-${state.revision}`, type: 'system', text: p.error?.message || 'Codex error' });
  }
}
export function applyLiveState(state: ChatState, live: any, since: number) {
  if (live.settings) state.settings = live.settings;
  if (live.tokenUsage) state.tokenUsage = live.tokenUsage;
  if (live.capabilities) state.capabilities = live.capabilities;
  if (live.queue && (live.queue.version || 0) >= state.queue.version) state.queue = live.queue;
  if (state.lifecycle <= since) state.active = live.activeTurn && !state.completed.has(live.activeTurn) ? live.activeTurn : null;
  if (state.approvalsRevision <= since) state.approvals = new Map((live.approvals || []).map((r: any) => [JSON.stringify(r.id), r]));
}
export function mergeHistory(state: ChatState, result: any, since: number, older: boolean) {
  for (const turn of result.thread.turns || []) {
    rememberTurnStart(state, turn);
    if (!state.completed.has(turn.id)) {
      if (turn.status === 'completed') state.forkableTurns.add(turn.id);
      else state.forkableTurns.delete(turn.id);
    }
  }
  const history: CodexItem[] = (result.thread.turns || []).flatMap((turn: any) => (turn.items || []).map((item: CodexItem) => ({ ...item, turnId: turn.id, status: item.status || (turn.status === 'inProgress' ? 'inProgress' : turn.status) })));
  const ids: string[] = [];
  for (const item of history) {
    ids.push(item.id);
    if ((state.versions.get(item.id) || 0) <= since && (!older || !state.items.has(item.id))) state.items.set(item.id, item);
  }
  state.order = [...new Set(older ? [...ids, ...state.order] : [...ids, ...state.order.filter(id => (state.versions.get(id) || 0) > since)])];
  const retained = new Set(state.order);
  for (const id of state.items.keys()) if (!retained.has(id)) state.items.delete(id);
  state.nextCursor = result.nextCursor || null;
  if (!older) applyLiveState(state, result.state, since);
}
export function itemText(item: CodexItem): string {
  return item.text ?? (item.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
}
const format=(value:any)=>value==null?'':typeof value==='string'?value:JSON.stringify(value,null,2);
function contentText(content:any) {
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return '';
  return content.map(c=>['text','inputText'].includes(c.type)?c.text:c.type==='resource'?c.resource?.text||c.resource?.uri:['image','inputImage'].includes(c.type)?'[이미지 결과]':'').filter(Boolean).join('\n');
}
export function output(item:CodexItem):string {
  // Raw reasoning content is deliberately excluded; only supplied summaries render.
  if(item.type==='reasoning')return (item.summary||[]).join('\n\n');
  if(item.type==='mcpToolCall')return [item.progress,contentText(item.result?.content),item.result?.structuredContent&&format(item.result.structuredContent),item.result&&!item.result.content&&!item.result.structuredContent&&format(item.result),item.error?.message||item.error].filter(Boolean).join('\n');
  if(item.type==='dynamicToolCall')return [item.progress,contentText(item.contentItems),item.error?.message].filter(Boolean).join('\n');
  if(item.type==='functionCallOutput')return contentText(item.output?.content)||format(item.output);
  if(item.type==='collabAgentToolCall')return Object.entries(item.agentsStates||{}).map(([id,state]:[string,any])=>`${id}: ${state.status||''}${state.message?'\n'+state.message:''}`).join('\n');
  if(item.type==='terminalInteraction')return item.stdin||'';
  if(['enteredReviewMode','exitedReviewMode'].includes(item.type))return item.review||'';
  return item.aggregatedOutput||item.text||'';
}
