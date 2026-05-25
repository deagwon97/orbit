import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { config } from "./config.js";
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);
function authHeader(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") || req.query?.token || config.token;
    return { Authorization: `Bearer ${token}` };
}
async function forwardJSON(reply, res) {
    const text = await res.text();
    reply.code(res.status);
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return { error: text };
    }
}
app.get("/healthz", async () => ({ ok: true }));
app.get("/api/v1/sessions", async (req, reply) => {
    const res = await fetch(`${config.orbitd}/api/v1/sessions`, { headers: authHeader(req) });
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
app.post("/api/v1/sessions/:id/stop", async (req, reply) => {
    const res = await fetch(`${config.orbitd}/api/v1/sessions/${req.params.id}/stop`, {
        method: "POST",
        headers: { ...authHeader(req), "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {})
    });
    return forwardJSON(reply, res);
});
app.delete("/api/v1/sessions/:id", async (req, reply) => {
    const res = await fetch(`${config.orbitd}/api/v1/sessions/${req.params.id}`, {
        method: "DELETE",
        headers: authHeader(req)
    });
    return forwardJSON(reply, res);
});
app.get("/api/v1/sessions/:id/attach", { websocket: true }, (socket, req) => {
    const upstream = new WebSocket(`${config.orbitd.replace(/^http/, "ws")}/api/v1/sessions/${req.params.id}/attach`, {
        headers: authHeader(req)
    });
    let upstreamOpen = false;
    const pending = [];
    upstream.on("open", () => {
        upstreamOpen = true;
        for (const data of pending.splice(0))
            upstream.send(data);
    });
    socket.on("message", (data) => {
        if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
            upstream.send(data);
        }
        else {
            pending.push(data);
        }
    });
    upstream.on("message", (data) => {
        if (socket.readyState === WebSocket.OPEN)
            socket.send(data);
    });
    upstream.on("error", (err) => {
        req.log.warn({ err, sessionId: req.params.id }, "attach upstream websocket failed");
        if (socket.readyState === WebSocket.OPEN)
            socket.close(1011, "attach upstream failed");
    });
    socket.on("error", (err) => {
        req.log.warn({ err, sessionId: req.params.id }, "attach client websocket failed");
        upstream.close();
    });
    socket.on("close", () => upstream.close());
    upstream.on("close", () => {
        if (socket.readyState === WebSocket.OPEN)
            socket.close();
    });
});
await app.listen({ port: config.port, host: "0.0.0.0" });
