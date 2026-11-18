import { test } from 'node:test';
import { queuesDuringTurn, specificActivity } from '../src/codex-progress.ts';
import assert from 'node:assert/strict';
import { newChatState, observe, mergeHistory, output, putItem } from '../src/codex-state.ts';

test('late history snapshots preserve streamed output and completed lifecycle state', () => {
  const state = newChatState(), since = state.revision;
  observe(state, { method: 'turn/started', params: { turn: { id: 't' } } });
  observe(state, { method: 'item/agentMessage/delta', params: { itemId: 'a', turnId: 't', delta: 'new answer' } });
  observe(state, { method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } });
  mergeHistory(state, { thread: { turns: [{ id: 't', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text: 'stale' }] }] }, state: { activeTurn: 't', approvals: [] } }, since, false);
  assert.equal(state.items.get('a').text, 'new answer'); assert.equal(state.active, null);
  assert(state.forkableTurns.has('t'));
});
test('older history prepends without replacing newer items or losing newer lifecycle state', () => {
  const state = newChatState(); putItem(state, { id: 'new', type: 'agentMessage', text: 'latest' }); state.active = 'running';
  mergeHistory(state, { thread: { turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'older' }] }] }, state: { activeTurn: null }, nextCursor: 'next' }, state.revision, true);
  assert.deepEqual(state.order, ['old', 'new']); assert.equal(state.active, 'running'); assert.equal(state.nextCursor, 'next');
  assert(state.forkableTurns.has('old-turn'));
  assert(!state.forkableTurns.has('running'));
});
test('reasoning renders supplied summaries only, while command and MCP output stream', () => {
  const state = newChatState();
  assert.equal(output({ id: 'r', type: 'reasoning', content: ['private'] }), '');
  for (const p of [{ summaryIndex: 0, delta: 'one' }, { summaryIndex: 1, delta: 'two' }]) observe(state, { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', turnId: 't', ...p } });
  assert.equal(output(state.items.get('r')), 'one\n\ntwo');
  for (const delta of ['first', ' second']) observe(state, { method: 'item/commandExecution/outputDelta', params: { itemId: 'c', turnId: 't', delta } });
  assert.equal(output(state.items.get('c')), 'first second');
  observe(state, { method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: 'private' } }); assert.equal(output(state.items.get('r')), 'one\n\ntwo');
});
test('fresh approval events survive an older history response and completion clears them', () => {
  const state = newChatState(), since = state.revision;
  state.approvals.set('101', { id: 101, params: { turnId: 't' } }); state.approvalsRevision = ++state.revision;
  mergeHistory(state, { thread: { turns: [] }, state: { approvals: [], activeTurn: 't' } }, since, false);
  assert.equal(state.approvals.size, 1);
  observe(state, { method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } }); assert.equal(state.approvals.size, 0);
});

test('working start times restore seconds or milliseconds from history without restarting on late snapshots', async () => {
  const { rememberTurnStart } = await import('../src/codex-state.ts');
  const state=newChatState();
  rememberTurnStart(state,{id:'seconds',startedAt:1700000000});assert.equal(state.turnStarts.get('seconds'),1700000000000);
  rememberTurnStart(state,{id:'milliseconds',startedAtMs:1700000000123});assert.equal(state.turnStarts.get('milliseconds'),1700000000123);
  rememberTurnStart(state,{id:'early-ms',startedAtMs:1000});assert.equal(state.turnStarts.get('early-ms'),1000);
  rememberTurnStart(state,{id:'unknown'});assert.equal(state.turnStarts.has('unknown'),false);
  observe(state,{method:'turn/started',params:{turn:{id:'live'}}});const start=state.turnStarts.get('live');
  mergeHistory(state,{thread:{turns:[{id:'live',status:'inProgress',items:[]}]},state:{activeTurn:'live'}},state.revision,false);
  assert.equal(state.turnStarts.get('live'),start);
  observe(state,{method:'turn/completed',params:{turn:{id:'live',status:'completed'}}});assert.equal(state.active,null);
});

test('working progress includes retries, patches, terminal input, hooks and tool outputs while raw reasoning remains hidden',()=>{
 const s=newChatState();observe(s,{method:'turn/started',params:{turn:{id:'live'}}});
 observe(s,{method:'error',params:{turnId:'live',willRetry:true,error:{message:'Reconnecting 1/3'}}});assert.equal(s.activity,'Reconnecting 1/3');assert.match([...s.items.values()].at(-1).text,/재시도/);
 observe(s,{method:'item/fileChange/patchUpdated',params:{turnId:'live',itemId:'patch',changes:[{path:'src/a.ts',diff:'+ added'}]}});assert.equal(s.items.get('patch').changes[0].diff,'+ added');
 observe(s,{method:'item/commandExecution/terminalInteraction',params:{turnId:'live',itemId:'cmd',processId:'42',stdin:'next\n'}});assert.match(output([...s.items.values()].at(-1)),/next/);
 observe(s,{method:'hook/started',params:{threadId:'x',turnId:'live',run:{id:'h',eventName:'PreToolUse',entries:[]}}});assert.equal(s.items.get('hook-h').status,'inProgress');
 assert.match(output({id:'tool',type:'dynamicToolCall',contentItems:[{type:'inputText',text:'dynamic output'}]}),/dynamic output/);
 assert.match(output({id:'mcp',type:'mcpToolCall',result:{content:[{type:'text',text:'MCP output'},{type:'image',data:'SECRET_IMAGE_BYTES'}]}}),/MCP output/);
 assert.doesNotMatch(output({id:'mcp',type:'mcpToolCall',result:{content:[{type:'image',data:'SECRET_IMAGE_BYTES'}]}}),/SECRET_IMAGE_BYTES/);
 assert.equal(output({id:'r',type:'reasoning',summary:[],content:['PRIVATE_RAW_REASONING']}),'');
});

test('completed review markers do not leave a stale Working activity', () => {
  const items=[{id:'review',turnId:'t',type:'enteredReviewMode',status:'inProgress'}];
  assert.equal(queuesDuringTurn(items,'t'),true);
  assert.equal(specificActivity(items,0,'t',''),'Reviewing');
  items.push({id:'end',turnId:'t',type:'exitedReviewMode',status:'completed'});
  assert.equal(queuesDuringTurn(items,'t'),false);
  assert.equal(specificActivity(items,0,'t',''),'');
});
