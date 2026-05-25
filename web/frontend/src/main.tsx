import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCcw, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import "./styles/app.css";

type Session = { id: string; name: string; tool: string; status: string; pid?: number; cwd: string };

function token() {
  return localStorage.getItem("orbit.token") || "";
}

async function api(path: string, init: RequestInit = {}) {
  return fetch(path, { ...init, headers: { Authorization: `Bearer ${token()}`, "content-type": "application/json", ...(init.headers || {}) } });
}

function App() {
  const [authed, setAuthed] = useState(Boolean(token()));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);
  const [newTool, setNewTool] = useState("codex");

  async function load() {
    const res = await api("/api/v1/sessions");
    if (res.ok) setSessions(await res.json());
  }
  useEffect(() => { if (authed) void load(); }, [authed]);
  useEffect(() => {
    if (!selected) return;
    const current = sessions.find((session) => session.id === selected.id);
    if (current) {
      if (current !== selected) setSelected(current);
      return;
    }
    setSelected(null);
  }, [sessions, selected]);

  if (!authed) return <Login onLogin={(t) => { localStorage.setItem("orbit.token", t); setAuthed(true); }} />;

  return <main className="app">
    <section className="toolbar">
      <strong>Orbit</strong>
      <select value={newTool} onChange={(e) => setNewTool(e.target.value)}>
        <option value="codex">codex</option><option value="claude-code">claude-code</option><option value="opencode">opencode</option><option value="pi">pi</option>
      </select>
      <button onClick={async () => { await api("/api/v1/sessions", { method: "POST", body: JSON.stringify({ tool: newTool }) }); await load(); }}>Run</button>
      <button title="Refresh" onClick={load}><RefreshCcw size={16}/></button>
    </section>
    <section className="layout">
      <div className="sessions">
        {sessions.map((s) => <button className={selected?.id === s.id ? "row active" : "row"} key={s.id} onClick={() => setSelected(s)}>
          <span>{s.id}</span><span>{s.name}</span><span>{s.tool}</span><span>{s.status}</span>
        </button>)}
      </div>
      <div className="terminalPane">
        {selected ? <Terminal session={selected} reload={load}/> : <div className="empty"><TerminalIcon/>Select a session</div>}
      </div>
    </section>
  </main>;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  return <main className="login"><form onSubmit={(e) => { e.preventDefault(); onLogin(value); }}>
    <h1>Orbit</h1><input autoFocus placeholder="Bearer token" value={value} onChange={(e) => setValue(e.target.value)}/><button>Connect</button>
  </form></main>;
}

function Terminal({ session, reload }: { session: Session; reload: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/v1/sessions/${session.id}/attach?token=${encodeURIComponent(token())}`);
    const sendResize = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    const onWindowResize = () => { fit.fit(); sendResize(); };
    const input = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(data);
      let binary = "";
      bytes.forEach((byte) => binary += String.fromCharCode(byte));
      ws.send(JSON.stringify({ type: "stdin", data: btoa(binary) }));
    });
    ws.addEventListener("open", () => {
      sendResize();
      window.addEventListener("resize", onWindowResize);
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "stdout") {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        term.write(new TextDecoder().decode(bytes));
      }
    });
    ws.addEventListener("error", () => term.write("\r\n[attach failed]\r\n"));
    ws.addEventListener("close", (event) => {
      const reason = event.reason ? `: ${event.reason}` : "";
      term.write(`\r\n[detached${reason}]\r\n`);
    });
    return () => {
      window.removeEventListener("resize", onWindowResize);
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [session.id]);

  return <div className="terminalBox">
    <div className="terminalTop"><span>{session.name}</span><button onClick={async()=>{await api(`/api/v1/sessions/${session.id}`, {method:"DELETE"}); await reload();}}><Trash2 size={14}/></button></div>
    <div className="xtermHost" ref={ref}/>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
