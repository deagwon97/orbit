import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { TerminalModes, terminalModePrefix } from "../dist/terminal-state.js";

test("recovers screen and mouse modes across every chunk boundary without replaying text", () => {
  const output = "private text\x1b[?1049h\x1b[?1000;1002;1003h\x1b[?1006h";
  for (let split = 1; split < output.length; split++) {
    const state = new TerminalModes();
    state.write(output.slice(0, split));
    state.write(output.slice(split));
    assert.ok(state.prefix().includes("\x1b[?1049h"));
    assert.ok(state.prefix().includes("\x1b[?1003h"));
    assert.ok(state.prefix().includes("\x1b[?1006h"));
    assert.ok(!state.prefix().includes("private text"));
  }
});

test("leaving an application and resetting the terminal discard stale enabled modes", () => {
  const state = new TerminalModes();
  state.write("\x1b[?1049h\x1b[?1000;1002;1003h\x1b[?1006h");
  state.write("\x1b[?1049l\x1b[?1003l\x1b[?1006l");
  assert.ok(!state.prefix().includes("\x1b[?1049h"));
  assert.ok(!state.prefix().includes("\x1b[?1002h"));
  assert.ok(!state.prefix().includes("\x1b[?1003h"));
  state.write("\x1b[?1049h\x1bc");
  assert.ok(!state.prefix().includes("\x1b[?1049h"));
});

test("scans a bounded log snapshot, resumes incrementally, and checks credentials on cache hits", async () => {
  const lines = ["\x1b[", "?1049h\x1b[?1003h", "\x1b[?1006h"].map((text, i) => ({
    id: i + 1, content: Buffer.from(text).toString("base64")
  }));
  const queries = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer valid") { res.writeHead(401).end(); return; }
    const url = new URL(req.url, "http://localhost");
    const after = Number(url.searchParams.get("after"));
    const until = Number(url.searchParams.get("until") ?? lines.at(-1).id);
    queries.push({ after, until });
    const remaining = lines.filter(line => line.id > after && line.id <= until);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ lines: remaining.slice(0, 2), snapshot_last_id: until, has_more: remaining.length > 2 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: "Bearer valid" };
    assert.ok((await terminalModePrefix(base, "session", headers)).includes("\x1b[?1049h"));
    assert.deepEqual(queries, [{ after: 0, until: 3 }, { after: 2, until: 3 }]);
    lines.push({ id: 4, content: Buffer.from("\x1b[?1049l\x1b[?1003l").toString("base64") });
    assert.ok(!(await terminalModePrefix(base, "session", headers)).includes("\x1b[?1049h"));
    assert.deepEqual(queries.at(-1), { after: 3, until: 4 });
    await assert.rejects(terminalModePrefix(base, "session", { Authorization: "Bearer invalid" }), /HTTP 401/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
