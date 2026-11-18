import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { config } from "./config.js";
import { terminalModePrefix } from "./terminal-state.js";

const app = Fastify({ logger: {
  serializers: { req: (req: any) => ({
    method: req.method,
    url: String(req.url).replace(/([?&]token=)[^&]*/g, "$1[REDACTED]"),
    host: req.headers.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort
  }) }
} });
await app.register(cors, { origin: true });
await app.register(websocket);
app.addContentTypeParser(/^image\/(png|jpeg|webp|gif)$/, { parseAs: "buffer" }, (_req, body, done) => done(null, body));

function orbitdBase(req: any) {
  const value = req.headers["x-orbitd-url"] || req.query?.orbitd || config.orbitd;
  const raw = Array.isArray(value) ? value[0] : String(value ?? "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("invalid orbitd url");
  }
}

function authHeader(req: any) {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || req.query?.token || config.token;
  return { Authorization: `Bearer ${token}` };
}

async function isAuthed(req: any) {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions?status=running`, { headers: authHeader(req) });
  await res.arrayBuffer();
  return res.ok;
}

function queryString(req: any) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === "token" || key === "orbitd" || value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function forwardJSON(reply: any, res: Response) {
  const text = await res.text();
  reply.code(res.status);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

app.get("/healthz", async () => ({ ok: true }));

app.get("/api/v1/auth/check", async (req: any, reply) => {
  try {
    const ok = await isAuthed(req);
    if (!ok) {
      reply.code(401);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    reply.code(400);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.get("/api/v1/fs/dirs", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/fs/dirs${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/fs/dirs", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/fs/dirs`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/fs/entries", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/fs/entries${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/fs/files", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/fs/files${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/fs/raw", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/fs/raw${queryString(req)}`, {
    headers: authHeader(req)
  });
  if (!res.ok) {
    reply.code(res.status);
    return { error: await res.text() };
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  reply.header("content-type", contentType);
  return reply.send(Buffer.from(await res.arrayBuffer()));
});

app.route({
  method: ["POST", "PUT"],
  url: "/api/v1/fs/files",
  handler: async (req, reply) => {
    const res = await fetch(`${orbitdBase(req)}/api/v1/fs/files`, {
      method: req.method,
      headers: { ...authHeader(req), "content-type": "application/json" },
      body: JSON.stringify(req.body)
    });
    return forwardJSON(reply, res);
  }
});

app.get("/api/v1/sessions", async (req, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions${queryString(req)}`, { headers: authHeader(req) });
  return forwardJSON(reply, res);
});

// Binary uploads go to the selected execution host, never the API container's /tmp.
app.post("/api/v1/sessions/:id/images", { bodyLimit: 50 * 1024 * 1024 }, async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}/images`, {
    method: "POST", headers: { ...authHeader(req), "content-type": req.headers["content-type"] || "application/octet-stream" }, body: req.body
  });
  return forwardJSON(reply, res);
});
app.get("/api/v1/sessions/:id/images/:image", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}/images/${encodeURIComponent(req.params.image)}`, { headers: authHeader(req) });
  reply.code(res.status).header("content-type", res.headers.get("content-type") || "application/octet-stream").header("x-content-type-options", "nosniff").header("cache-control", "private, no-store");
  return reply.send(Buffer.from(await res.arrayBuffer()));
});

app.get("/api/v1/backends", async (req, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/backends`, { headers: authHeader(req) });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/sessions", async (req, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/sessions/:id/stop", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}/stop`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body ?? {})
  });
  return forwardJSON(reply, res);
});

app.delete("/api/v1/sessions/:id", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}`, {
    method: "DELETE",
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id/logs", async (req: any, reply) => {
  const res = await fetch(`${orbitdBase(req)}/api/v1/sessions/${encodeURIComponent(req.params.id)}/logs${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id/attach", { websocket: true }, (socket, req: any) => {
  let base: string;
  try {
    base = orbitdBase(req);
  } catch {
    socket.close(1008, "invalid orbitd url");
    return;
  }
  let upstream: WebSocket | null = null;
  let upstreamOpen = false;
  const pending: WebSocket.RawData[] = [];

  socket.on("message", (data) => {
    if (upstreamOpen && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(data.toString());
    } else {
      pending.push(data);
    }
  });
  socket.on("error", (err) => {
    req.log.warn({ err, sessionId: req.params.id }, "attach client websocket failed");
    upstream?.close();
  });
  socket.on("close", () => upstream?.close());
  void (async () => {
    try {
      const prefix = await terminalModePrefix(base, req.params.id, authHeader(req));
      if (socket.readyState !== WebSocket.OPEN) return;
      if (prefix) socket.send(JSON.stringify({ type: "stdout", data: Buffer.from(prefix).toString("base64") }));
    } catch (err) {
      req.log.warn({ err, sessionId: req.params.id }, "terminal mode recovery failed; using PTY replay");
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    const remote = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/sessions/${encodeURIComponent(req.params.id)}/attach`, {
      headers: authHeader(req)
    });
    upstream = remote;
    remote.on("open", () => {
      upstreamOpen = true;
      for (const data of pending.splice(0)) remote.send(data.toString());
    });
    remote.on("message", (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
    });
    remote.on("error", (err) => {
      req.log.warn({ err, sessionId: req.params.id }, "attach upstream websocket failed");
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "attach upstream failed");
    });
    remote.on("close", () => {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });
  })();
});

// Structured Codex traffic follows the selected orbitd, just like PTY attach.
app.get("/api/v1/sessions/:id/codex", { websocket: true }, (socket, req: any) => {
  let base: string;
  try { base = orbitdBase(req); } catch { socket.close(1008, "invalid orbitd url"); return; }
  const remote = new WebSocket(`${base.replace(/^http/, "ws")}/api/v1/sessions/${encodeURIComponent(req.params.id)}/codex`, { headers: authHeader(req) });
  const pending: string[] = [];
  socket.on("message", data => {
    const text = data.toString();
    if (text.length > 256_000) { socket.close(1009, "message too large"); return; }
    if (remote.readyState === WebSocket.OPEN) remote.send(text);
    else if (remote.readyState === WebSocket.CONNECTING && pending.length < 32) pending.push(text);
    else socket.close(1013, "upstream unavailable");
  });
  remote.on("open", () => {
    if (socket.readyState !== WebSocket.OPEN) { remote.close(); return; }
    for (const text of pending.splice(0)) remote.send(text);
  });
  remote.on("message", data => { if (socket.readyState === WebSocket.OPEN) socket.send(data.toString()); });
  remote.on("error", () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "error", error: "Cannot open Codex Web on this orbitd. Check its version, session mode and Codex daemon connection." }));
      socket.close(1011, "Codex upstream unavailable");
    }
  });
  remote.on("close", () => { if (socket.readyState === WebSocket.OPEN) socket.close(); });
  socket.on("close", () => remote.close());
  socket.on("error", () => remote.close());
});

await app.listen({ port: config.port, host: "0.0.0.0" });
