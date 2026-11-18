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
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  upstream.on('request', (req,res) => {
    if (!req.url.includes('/images')) return;
    assert.equal(req.headers.authorization, 'Bearer image-test');
    if(req.method==='POST') {
      assert.equal(req.url,'/api/v1/sessions/image-session/images');
      assert.equal(req.headers['content-type'],'image/png');
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),bytes);res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'image.png',path:'/tmp/example.png'}));});
    } else { assert.equal(req.url,'/api/v1/sessions/image-session/images/image.png');res.setHeader('content-type','image/png');res.end(bytes); }
  });
  const headers={Authorization:'Bearer image-test','x-orbitd-url':`http://127.0.0.1:${upstream.address().port}`};
  const uploaded=await fetch(`http://127.0.0.1:${port}/api/v1/sessions/image-session/images`,{method:'POST',headers:{...headers,'content-type':'image/png'},body:bytes});
  assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).path,'/tmp/example.png');
  const image=await fetch(`http://127.0.0.1:${port}/api/v1/sessions/image-session/images/image.png`,{headers});
  assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
  const fileBytes = Buffer.from([0, 255, 50, 128]);
  upstream.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/v1/sessions/file-session/files')) return;
    assert.equal(req.headers.authorization, 'Bearer image-test');
    if (req.method === 'POST') {
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      assert.equal(url.searchParams.get('name'), '검토 결과.pdf');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), fileBytes);
      res.end(JSON.stringify({ id: 'file-id', path: '/tmp/report.pdf' }));
    } else {
      assert.equal(url.pathname, '/api/v1/sessions/file-session/files/file-id');
      res.end(fileBytes);
    }
  });
  const fileUrl = `http://127.0.0.1:${port}/api/v1/sessions/file-session/files`;
  const fileUpload = await fetch(fileUrl + '?name=' + encodeURIComponent('검토 결과.pdf'), {
    method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: fileBytes
  });
  assert.equal(fileUpload.status, 200);
  assert.equal((await fileUpload.json()).path, '/tmp/report.pdf');
  const downloadedFile = await fetch(fileUrl + '/file-id', { headers });
  assert.equal(downloadedFile.headers.get('content-disposition'), 'attachment');
  assert.equal(downloadedFile.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await downloadedFile.arrayBuffer()), fileBytes);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/sessions/session-123/codex?token=example-token&orbitd=${encodeURIComponent(`http://127.0.0.1:${upstream.address().port}`)}`);
  t.after(() => ws.terminate()); await once(ws, 'open');
  const response = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, op: 'history' }));
  assert.deepEqual(JSON.parse((await response)[0].toString()).echoed, { id: 1, op: 'history' });
  assert.equal(requestPath, '/api/v1/sessions/session-123/codex'); assert.equal(authorization, 'Bearer example-token');
  ws.close(); await once(ws, 'close');
});
