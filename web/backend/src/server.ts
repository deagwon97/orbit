import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  if (!await isAuthed(req)) {
    reply.code(401);
    return { error: "unauthorized" };
  }

  const fallback = process.env.ORBIT_WORKSPACE ?? process.cwd();
  const requested = typeof req.query?.path === "string" && req.query.path.trim() ? req.query.path : fallback;
  const current = await realpath(path.resolve(requested));
  const currentStat = await stat(current);
  if (!currentStat.isDirectory()) {
    reply.code(400);
    return { error: "path is not a directory" };
  }

  const entries = await readdir(current, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: path.join(current, name) }));

  return {
    cwd: process.cwd(),
    home: os.homedir(),
    path: current,
    parent: path.dirname(current) === current ? null : path.dirname(current),
    dirs
  };
});

app.post("/api/v1/fs/dirs", async (req: any, reply) => {
  if (!await isAuthed(req)) {
    reply.code(401);
    return { error: "unauthorized" };
  }

  const body = req.body ?? {};
  const parentInput = typeof body.parent === "string" && body.parent.trim() ? body.parent : process.cwd();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    reply.code(400);
    return { error: "invalid folder name" };
  }

  const parent = await realpath(path.resolve(parentInput));
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    reply.code(400);
    return { error: "parent is not a directory" };
  }

  const created = path.join(parent, name);
  await mkdir(created);
  return { path: await realpath(created) };
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
