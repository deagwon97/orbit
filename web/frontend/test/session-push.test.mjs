import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('push displays a completion notification and only opens an Orbit URL', async () => {
  const handlers = new Map();
  const notifications = [];
  const opened = [];
  const origin = 'https://orbit.example.com';
  runInNewContext(readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8'), {
    URL,
    self: {
      location: { origin },
      addEventListener: (type, handler) => handlers.set(type, handler),
      registration: { showNotification: async (title, options) => notifications.push({ title, ...options }) },
      clients: { matchAll: async () => [], openWindow: async href => opened.push(href) },
    },
  });
  async function dispatch(type, event) {
    let pending;
    handlers.get(type)({ ...event, waitUntil: value => { pending = value; } });
    await pending;
  }
  const path = '/?orbitSession=demo&orbitConnection=local';
  await dispatch('push', { data: { json: () => ({ tag: 'demo-turn', path }) } });
  assert.equal(notifications[0].title, 'Orbit · 작업 완료');
  assert.equal(notifications[0].tag, 'demo-turn');
  assert.equal(notifications[0].data.path, path);
  await dispatch('notificationclick', { notification: { close() {}, data: notifications[0].data } });
  await dispatch('notificationclick', { notification: { close() {}, data: { path: 'https://elsewhere.example/' } } });
  await dispatch('notificationclick', { notification: { close() {}, data: { path: 'https://[' } } });
  assert.deepEqual(opened, [origin + path, origin + '/', origin + '/']);
});
