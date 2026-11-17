import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';

test('Codex WebSocket proxy routes the selected session and forwards authentication and structured replies', async t => {
  const upstream = createServer(); const wss = new WebSocketServer({ server: upstream });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { wss.clients.forEach(ws => ws.terminate()); wss.close(); upstream.close(); });
  let requestPath, authorization;
  wss.on('connection', (ws, req) => {
    requestPath = req.url; authorization = req.headers.authorization;
    ws.on('message', data => ws.send(JSON.stringify({ type: 'result', echoed: JSON.parse(data) })));
  });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
    if (i === 99) throw new Error('Proxy did not start');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/sessions/session-123/codex?token=example-token&orbitd=${encodeURIComponent(`http://127.0.0.1:${upstream.address().port}`)}`);
  t.after(() => ws.terminate()); await once(ws, 'open');
  const response = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, op: 'history' }));
  assert.deepEqual(JSON.parse((await response)[0].toString()).echoed, { id: 1, op: 'history' });
  assert.equal(requestPath, '/api/v1/sessions/session-123/codex'); assert.equal(authorization, 'Bearer example-token');
  ws.close(); await once(ws, 'close');
});
