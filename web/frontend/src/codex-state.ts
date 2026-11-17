export type CodexItem = { id: string; type: string; [key: string]: any };
export function newChatState() {
  return { items: new Map<string, CodexItem>(), order: [] as string[], versions: new Map<string, number>(), revision: 0,
    lifecycle: 0, approvalsRevision: 0, active: null as string | null, completed: new Set<string>(), approvals: new Map<string, any>(), nextCursor: null as string | null };
}
export type ChatState = ReturnType<typeof newChatState>;
export function putItem(state: ChatState, item: CodexItem) {
  if (!item?.id) return;
  if (!state.items.has(item.id)) state.order.push(item.id);
  state.items.set(item.id, { ...state.items.get(item.id), ...item });
  state.versions.set(item.id, ++state.revision);
}
export function observe(state: ChatState, message: any) {
  const p = message.params || {}, method = message.method;
  if (method === 'turn/started') {
    state.active = p.turn.id; state.lifecycle = ++state.revision;
    for (const item of p.turn.items || []) putItem(state, { ...item, turnId: p.turn.id });
  } else if (method === 'turn/completed') {
    if (state.active === p.turn.id) state.active = null;
    state.completed.add(p.turn.id); state.lifecycle = ++state.revision;
    for (const item of p.turn.items || []) putItem(state, { ...item, turnId: p.turn.id, status: item.status || p.turn.status });
    for (const item of state.items.values()) if (item.turnId === p.turn.id && item.status === 'inProgress') putItem(state, { ...item, status: p.turn.status });
    for (const [id, request] of state.approvals) if (request.params.turnId === p.turn.id) state.approvals.delete(id);
    state.approvalsRevision = ++state.revision;
    if (p.turn.error) putItem(state, { id: `error-${p.turn.id}`, type: 'system', text: p.turn.error.message || 'Turn failed' });
  } else if (method === 'item/started' || method === 'item/completed') {
    putItem(state, { ...p.item, turnId: p.turnId, status: p.item.status || (method === 'item/started' ? 'inProgress' : 'completed') });
  } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: method === 'item/plan/delta' ? 'plan' : 'agentMessage', status: 'inProgress', ...old, turnId: p.turnId, text: (old?.text || '') + p.delta });
  } else if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta'].includes(method)) {
    const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: method.includes('fileChange') ? 'fileChange' : 'commandExecution', status: 'inProgress', ...old, turnId: p.turnId, aggregatedOutput: (old?.aggregatedOutput || '') + p.delta });
  } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded') {
    if (!Number.isInteger(p.summaryIndex) || p.summaryIndex < 0 || p.summaryIndex > 10000) return;
    const old = state.items.get(p.itemId), summary = [...(old?.summary || [])];
    summary[p.summaryIndex] = (summary[p.summaryIndex] || '') + (p.delta || '');
    putItem(state, { id: p.itemId, type: 'reasoning', status: 'inProgress', ...old, turnId: p.turnId, summary });
  } else if (method === 'item/mcpToolCall/progress') {
    const old = state.items.get(p.itemId);
    putItem(state, { id: p.itemId, type: 'mcpToolCall', status: 'inProgress', ...old, turnId: p.turnId, progress: (old?.progress || '') + p.message + '\n' });
  } else if (method === 'turn/plan/updated') {
    putItem(state, { id: `plan-${p.turnId}`, type: 'plan', turnId: p.turnId, status: p.plan?.some((step: any) => step.status !== 'completed') ? 'inProgress' : 'completed', text: [p.explanation, ...(p.plan || []).map((step: any) => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`)].filter(Boolean).join('\n') });
  } else if (method === 'serverRequest/resolved') {
    state.approvals.delete(JSON.stringify(p.requestId)); state.approvalsRevision = ++state.revision;
  } else if (method === 'error' && !p.willRetry) {
    putItem(state, { id: `server-error-${state.revision}`, type: 'system', text: p.error?.message || 'Codex error' });
  }
}
export function applyLiveState(state: ChatState, live: any, since: number) {
  if (state.lifecycle <= since) state.active = live.activeTurn && !state.completed.has(live.activeTurn) ? live.activeTurn : null;
  if (state.approvalsRevision <= since) state.approvals = new Map((live.approvals || []).map((r: any) => [JSON.stringify(r.id), r]));
}
export function mergeHistory(state: ChatState, result: any, since: number, older: boolean) {
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
export function output(item: CodexItem): string {
  if (item.type === 'reasoning') return (item.summary || []).join('\n\n');
  if (item.type === 'mcpToolCall') return [item.progress, item.result && JSON.stringify(item.result, null, 2)].filter(Boolean).join('\n');
  return item.aggregatedOutput || item.text || '';
}
