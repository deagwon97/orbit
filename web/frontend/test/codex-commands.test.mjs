import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestions, isCommand } from '../src/codex-command-input.ts';
import { newChatState, applyLiveState } from '../src/codex-state.ts';
test('slash autocomplete does not intercept prose or argument input', () => {
  const commands = [{name:'status'}, {name:'model'}, {name:'mcp'}];
  assert.deepEqual(suggestions('/m',commands).map(c=>c.name),['model','mcp']);
  assert.deepEqual(suggestions('/model small',commands),[]); assert.deepEqual(suggestions('hello /model',commands),[]);
  assert.equal(isCommand('  /status'),true); assert.equal(isCommand('hello'),false);
});
test('late queue snapshots cannot resurrect dispatched entries and state events do not reset lifecycle', () => {
  const s = newChatState(); s.active='running';
  applyLiveState(s,{settings:{model:'new'},queue:{version:4,items:[],paused:false}},-1);
  applyLiveState(s,{queue:{version:3,items:[{id:'old'}],paused:false}},-1);
  assert.deepEqual(s.queue.items,[]); assert.equal(s.active,'running'); assert.equal(s.settings.model,'new');
});
