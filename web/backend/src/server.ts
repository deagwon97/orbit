import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { config } from "./config.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

function authHeader(req: any) {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || req.query?.token || config.token;
  return { Authorization: `Bearer ${token}` };
}

async function isAuthed(req: any) {
  const res = await fetch(`${config.orbitd}/api/v1/sessions?status=running`, { headers: authHeader(req) });
  await res.arrayBuffer();
  return res.ok;
}

function queryString(req: any) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === "token" || value == null) continue;
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

app.get("/api/v1/fs/dirs", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/fs/dirs${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/fs/dirs", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/fs/dirs`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/fs/entries", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/fs/entries${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/fs/files", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/fs/files${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.put("/api/v1/fs/files", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/fs/files`, {
    method: "PUT",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions", async (req, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions${queryString(req)}`, { headers: authHeader(req) });
  return forwardJSON(reply, res);
});

app.get("/api/v1/backends", async (req, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/backends`, { headers: authHeader(req) });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions/${encodeURIComponent(req.params.id)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/sessions", async (req, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return forwardJSON(reply, res);
});

app.post("/api/v1/sessions/:id/stop", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions/${encodeURIComponent(req.params.id)}/stop`, {
    method: "POST",
    headers: { ...authHeader(req), "content-type": "application/json" },
    body: JSON.stringify(req.body ?? {})
  });
  return forwardJSON(reply, res);
});

app.delete("/api/v1/sessions/:id", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions/${encodeURIComponent(req.params.id)}`, {
    method: "DELETE",
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id/logs", async (req: any, reply) => {
  const res = await fetch(`${config.orbitd}/api/v1/sessions/${encodeURIComponent(req.params.id)}/logs${queryString(req)}`, {
    headers: authHeader(req)
  });
  return forwardJSON(reply, res);
});

app.get("/api/v1/sessions/:id/attach", { websocket: true }, (socket, req: any) => {
  const upstream = new WebSocket(`${config.orbitd.replace(/^http/, "ws")}/api/v1/sessions/${encodeURIComponent(req.params.id)}/attach`, {
    headers: authHeader(req)
  });
  let upstreamOpen = false;
  const pending: WebSocket.RawData[] = [];

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const data of pending.splice(0)) upstream.send(data.toString());
  });
  socket.on("message", (data) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data.toString());
    } else {
      pending.push(data);
    }
  });
  upstream.on("message", (data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
  });
  upstream.on("error", (err) => {
    req.log.warn({ err, sessionId: req.params.id }, "attach upstream websocket failed");
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "attach upstream failed");
  });
  socket.on("error", (err) => {
    req.log.warn({ err, sessionId: req.params.id }, "attach client websocket failed");
    upstream.close();
  });
  socket.on("close", () => upstream.close());
  upstream.on("close", () => {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  });
});

await app.listen({ port: config.port, host: "0.0.0.0" });
