import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import webPush from 'web-push';
import { WebSocket } from 'ws';

type Registration = {
  device: string;
  session: string;
  connection: string;
  subscription: webPush.PushSubscription;
};
type Storage = { keys: ReturnType<typeof webPush.generateVAPIDKeys>; registrations: Registration[] };
type Snapshot = { activeTurn: string | null; queue: { items: unknown[] } };
type PushOptions = { file: string; origin: string; subject: string; upstream: string; token: string };

function validSubscription(input: unknown): input is webPush.PushSubscription {
  if (!input || typeof input !== 'object') return false;
  const { endpoint, keys } = input as webPush.PushSubscription;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 ||
      !/^[\w-]{87}$/.test(keys?.p256dh ?? '') || !/^[\w-]{22}$/.test(keys?.auth ?? '')) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      !url.hash && (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
      host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com'));
  } catch {
    return false;
  }
}

export function registerSessionPush(app: FastifyInstance, options: PushOptions) {
  const upstream = options.upstream.replace(/\/+$/, '');
  const origin = new URL(options.origin).origin;
  const upstreamHeaders = { Authorization: `Bearer ${options.token}` };
  const watchers = new Map<string, () => void>();
  function write(storage: Storage) {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${options.file}.next`, JSON.stringify(storage), { mode: 0o600 });
    renameSync(`${options.file}.next`, options.file);
  }
  function restore(): Storage {
    try {
      return JSON.parse(readFileSync(options.file, 'utf8')) as Storage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const storage = { keys: webPush.generateVAPIDKeys(), registrations: [] };
      write(storage);
      return storage;
    }
  }
  let storage = restore();
  function update(registrations: Registration[]) {
    const next = { ...storage, registrations };
    write(next);
    storage = next;
    syncWatchers();
  }
  function expire(endpoint: string) {
    update(storage.registrations.filter(entry => entry.subscription.endpoint !== endpoint));
  }

  async function notify(session: string, turn: string) {
    const targets = storage.registrations.filter(entry => entry.session === session);
    await Promise.all(targets.map(async ({ connection, subscription }) => {
      if (!validSubscription(subscription)) return;
      const query = new URLSearchParams({ orbitSession: session, orbitConnection: connection });
      try {
        await webPush.sendNotification(subscription, JSON.stringify({
          tag: `orbit-${session}-${turn}`, path: `/?${query}`,
        }), {
          TTL: 3600,
          timeout: 10_000,
          vapidDetails: { subject: options.subject, ...storage.keys },
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          expire(subscription.endpoint);
        } else {
          app.log.warn({ status }, 'Completion push delivery failed');
        }
      }
    }));
  }

  function watch(session: string) {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let snapshot: Snapshot | undefined;
    let completed: string | undefined;
    const delivered = new Set<string>();
    const apiPath = `/api/v1/sessions/${encodeURIComponent(session)}`;

    function schedule() {
      clearTimeout(settle);
      if (!completed || !snapshot || snapshot.activeTurn || snapshot.queue.items.length) return;
      settle = setTimeout(() => {
        if (closed || !completed) return;
        const turn = completed;
        completed = undefined;
        if (delivered.has(turn)) return;
        delivered.add(turn);
        if (delivered.size > 128) delivered.delete(delivered.values().next().value!);
        void notify(session, turn).catch(() => app.log.warn('Could not update push subscriptions'));
      }, 500);
    }
    async function connect() {
      try {
        const response = await fetch(upstream + apiPath, {
          headers: upstreamHeaders, signal: AbortSignal.timeout(5000), redirect: 'error',
        });
        if (closed) return;
        if (response.status === 404) {
          update(storage.registrations.filter(entry => entry.session !== session));
          return;
        }
        if (!response.ok) throw new Error('Session unavailable');
        const target = await response.json() as { mode?: string; status?: string };
        if (closed) return;
        if (target.mode !== 'web' || target.status !== 'running') {
          retry = setTimeout(() => void connect(), 30_000);
          return;
        }
        socket = new WebSocket(upstream.replace(/^http/, 'ws') + apiPath + '/codex', {
          headers: upstreamHeaders, handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024,
        });
        socket.on('error', () => socket?.terminate());
        socket.on('close', () => {
          clearTimeout(settle);
          snapshot = undefined;
          if (!closed) retry = setTimeout(() => void connect(), 5000);
        });
        socket.on('message', data => {
          try {
            const event = JSON.parse(data.toString());
            if (event.type === 'ready' || event.type === 'state') {
              if (!Array.isArray(event.state?.queue?.items)) return;
              snapshot = event.state as Snapshot;
            } else if (event.type === 'notification' && snapshot) {
              const turn = event.message?.params?.turn;
              if (!turn || typeof turn.id !== 'string') return;
              if (event.message.method === 'turn/started') {
                snapshot = { ...snapshot, activeTurn: turn.id };
                completed = undefined;
              } else if (event.message.method === 'turn/completed') {
                // orbitd publishes a fresh state after processing the completion and queue.
                snapshot = { ...snapshot, activeTurn: turn.id };
                completed = turn.status === 'completed' ? turn.id : undefined;
              }
            } else if (event.type === 'error' || event.type === 'disconnected') {
              socket?.close();
            }
            schedule();
          } catch {
            // Ignore malformed upstream events.
          }
        });
      } catch {
        if (!closed) retry = setTimeout(() => void connect(), 5000);
      }
    }
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(settle);
      socket?.terminate();
    };
  }

  function syncWatchers() {
    const sessions = new Set(storage.registrations.map(entry => entry.session));
    for (const [session, stop] of watchers) {
      if (!sessions.has(session)) {
        stop();
        watchers.delete(session);
      }
    }
    for (const session of sessions) if (!watchers.has(session)) watchers.set(session, watch(session));
  }
  app.addHook('onReady', async () => syncWatchers());
  app.addHook('onClose', async () => {
    for (const stop of watchers.values()) stop();
    watchers.clear();
  });

  app.route<{ Params: { id: string }; Body: { connection?: unknown; subscription?: unknown } }>({
    method: ['GET', 'PUT', 'DELETE'],
    url: '/api/v1/push/sessions/:id',
    bodyLimit: 4096,
    async handler(request, reply) {
      const { id } = request.params;
      const device = request.headers['x-orbit-push-device'];
      const host = request.headers['x-orbitd-url'];
      if (typeof host !== 'string' || host.replace(/\/+$/, '') !== upstream) return reply.code(404).send();
      if (typeof device !== 'string' || !/^[0-9a-f]{64}$/.test(device) || !/^[\w-]{1,100}$/.test(id)) {
        return reply.code(400).send({ error: 'Invalid push registration' });
      }
      if (request.method !== 'GET' && request.headers.origin !== origin) return reply.code(403).send();
      const suppliedToken = request.headers.authorization?.replace(/^Bearer\s*/i, '').trim();
      if (suppliedToken && suppliedToken !== options.token) return reply.code(403).send();
      reply.header('Cache-Control', 'no-store');
      const previous = storage.registrations.find(entry => entry.device === device && entry.session === id);
      if (request.method === 'GET') return { publicKey: storage.keys.publicKey, enabled: !!previous };
      if (request.method === 'DELETE') {
        if (previous) update(storage.registrations.filter(entry => entry !== previous));
        return reply.code(204).send();
      }
      const { connection, subscription } = request.body ?? {};
      if (typeof connection !== 'string' || !/^[\w-]{1,100}$/.test(connection) || !validSubscription(subscription)) {
        return reply.code(400).send({ error: 'Invalid browser push subscription' });
      }
      const session = await fetch(`${upstream}/api/v1/sessions/${encodeURIComponent(id)}`, {
        headers: upstreamHeaders, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!session.ok) return reply.code(404).send();
      const target = await session.json() as { mode?: string; status?: string };
      if (target.mode !== 'web' || target.status !== 'running') return reply.code(409).send();
      const other = storage.registrations.filter(entry => entry.session !== id ||
        (entry.device !== device && entry.subscription.endpoint !== subscription.endpoint));
      if (other.length >= 128) return reply.code(429).send({ error: 'Too many push subscriptions' });
      update([...other, { device, session: id, connection, subscription }]);
      return reply.code(204).send();
    },
  });
}
