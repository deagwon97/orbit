import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import webPush from 'web-push';
import { WebSocketServer } from 'ws';
import { registerSessionPush } from '../dist/session-push.js';

test('completion push watches the configured server, waits for the queue, and survives backend restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-push-test-'));
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ mode: 'web', status: 'running' }));
  });
  const sockets = new WebSocketServer({ server });
  let app = Fastify();
  const delivered = [];
  const send = webPush.sendNotification;
  webPush.sendNotification = async (subscription, message) => {
    delivered.push({ subscription, ...JSON.parse(message) });
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const upstream = `http://127.0.0.1:${server.address().port}`;
    const origin = 'https://orbit.example.com';
    const options = { file: join(directory, 'push.json'), origin, subject: origin, upstream, token: 'test-token' };
    const url = '/api/v1/push/sessions/session-id';
    const headers = { origin, 'x-orbit-push-device': 'b'.repeat(64), 'x-orbitd-url': upstream };
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/testing',
      keys: { p256dh: webPush.generateVAPIDKeys().publicKey, auth: Buffer.alloc(16, 1).toString('base64url') },
    };
    registerSessionPush(app, options);
    const before = (await app.inject({ method: 'GET', url, headers })).json();
    assert.equal(before.enabled, false);
    const payload = { connection: 'default-server', subscription };
    assert.equal((await app.inject({ method: 'PUT', url, headers: { ...headers, origin: 'https://elsewhere.example' }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url, headers, payload: {
      ...payload, subscription: { ...subscription, endpoint: 'https://127.0.0.1/push' },
    } })).statusCode, 400);
    const watching = once(sockets, 'connection');
    assert.equal((await app.inject({ method: 'PUT', url, headers, payload })).statusCode, 204);
    const [socket] = await watching;
    const state = (activeTurn, items, type = 'state') =>
      socket.send(JSON.stringify({ type, state: { activeTurn, queue: { items } } }));
    const turn = (method, id, status) =>
      socket.send(JSON.stringify({ type: 'notification', message: { method: `turn/${method}`, params: { turn: { id, status } } } }));
    state('first', ['queued'], 'ready');
    turn('completed', 'first', 'completed');
    state(null, ['queued']);
    await delay(600);
    assert.equal(delivered.length, 0);
    turn('started', 'second', 'inProgress');
    state('second', []);
    turn('completed', 'second', 'completed');
    state(null, []);
    await delay(650);
    assert.deepEqual(delivered, [{
      subscription, tag: 'orbit-session-id-second', path: '/?orbitSession=session-id&orbitConnection=default-server',
    }]);
    turn('completed', 'second', 'completed');
    state(null, []);
    await delay(600);
    assert.equal(delivered.length, 1);
    await app.close();
    app = Fastify();
    registerSessionPush(app, options);
    const restored = (await app.inject({ method: 'GET', url, headers })).json();
    assert.deepEqual(restored, { publicKey: before.publicKey, enabled: true });
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url, headers })).json().enabled, false);
  } finally {
    webPush.sendNotification = send;
    await app.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
