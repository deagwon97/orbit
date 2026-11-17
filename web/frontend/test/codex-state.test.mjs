import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newChatState, observe, mergeHistory, output, putItem } from '../src/codex-state.ts';

test('late history snapshots preserve streamed output and completed lifecycle state', () => {
  const state = newChatState(), since = state.revision;
  observe(state, { method: 'turn/started', params: { turn: { id: 't' } } });
  observe(state, { method: 'item/agentMessage/delta', params: { itemId: 'a', turnId: 't', delta: 'new answer' } });
  observe(state, { method: 'turn/completed', params: { turn: { id: 't', status: 'completed' } } });
  mergeHistory(state, { thread: { turns: [{ id: 't', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text: 'stale' }] }] }, state: { activeTurn: 't', approvals: [] } }, since, false);
  assert.equal(state.items.get('a').text, 'new answer'); assert.equal(state.active, null);
});
test('older history prepends without replacing newer items or losing newer lifecycle state', () => {
  const state = newChatState(); putItem(state, { id: 'new', type: 'agentMessage', text: 'latest' }); state.active = 'running';
  mergeHistory(state, { thread: { turns: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'older' }] }] }, state: { activeTurn: null }, nextCursor: 'next' }, state.revision, true);
  assert.deepEqual(state.order, ['old', 'new']); assert.equal(state.active, 'running'); assert.equal(state.nextCursor, 'next');
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
