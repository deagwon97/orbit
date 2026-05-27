import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronDown, ChevronRight, ChevronUp, CircleStop, FilePen, FileText, FolderOpen, Home, LogOut, PlugZap, RefreshCcw, Save, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import "./styles/app.css";

type Session = {
  id: string;
  name: string;
  tool: string;
  status: string;
  pid?: number;
  cwd: string;
  created_at?: string;
  last_attached_at?: string | null;
  exit_code?: number | null;
};

type LogLine = { timestamp: string; content: string };
type LogsResponse = { lines: LogLine[] };
type AgentBackend = { id: string; name: string; command: string; args: string[] };
type DirListing = {
  cwd: string;
  home: string;
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
};

type FsEntry = { name: string; path: string; kind: "dir" | "file" };
type ListEntriesResponse = {
  path: string;
  parent: string | null;
  home: string;
  entries: FsEntry[];
};
type OpenedFile = { path: string; content: string; savedContent: string };
type EntryTree = Record<string, FsEntry[]>;

const defaultBackends: AgentBackend[] = [
  { id: "codex", name: "Codex", command: "codex", args: [] },
  { id: "claude", name: "Claude Code", command: "claude", args: [] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: [] },
  { id: "pi", name: "pi", command: "pi", args: [] }
];

function token() {
  return localStorage.getItem("orbit.token") || "";
}

async function api(path: string, init: RequestInit = {}) {
  const headers = { Authorization: `Bearer ${token()}`, "content-type": "application/json", ...(init.headers || {}) };
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function parseEnv(input: string) {
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLORFGBG: "15;0"
  };
  for (const part of input.trim().split(/\s+/)) {
    if (!part) continue;
    const idx = part.indexOf("=");
    if (idx > 0) env[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return env;
}

function encodeBytes(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function decodeBytes(data: string) {
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
}

async function websocketText(data: MessageEvent["data"]) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

function isDetachInput(data: string) {
  return data === "\x1d"
    || data === "\x1c"
    || data === "\x1b[93;5u"
    || data === "\x1b[92;5u"
    || data === "\x1b[27;5;93~"
    || data === "\x1b[27;5;92~";
}

function App() {
  const [authed, setAuthed] = useState(Boolean(token()));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [backends, setBackends] = useState<AgentBackend[]>(defaultBackends);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tool, setTool] = useState("codex");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [attachAfterRun, setAttachAfterRun] = useState(true);
  const [view, setView] = useState<"terminal" | "logs">("terminal");
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [fileEditorOpen, setFileEditorOpen] = useState(false);

  const selected = useMemo(() => sessions.find((session) => session.id === selectedId) ?? null, [sessions, selectedId]);

  async function loadBackends() {
    try {
      const items = await api("/api/v1/backends") as AgentBackend[];
      if (items.length > 0) setBackends(items);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function load() {
    try {
      const query = showAll ? "" : "?status=running";
      setSessions(await api(`/api/v1/sessions${query}`));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSession() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { tool, env: parseEnv(env) };
      if (name.trim()) body.name = name.trim();
      if (cwd.trim()) body.cwd = cwd.trim();
      const session = await api("/api/v1/sessions", { method: "POST", body: JSON.stringify(body) }) as Session;
      setMessage(`created ${session.id} ${session.name}`);
      setName("");
      setEnv("");
      if (attachAfterRun) {
        setSelectedId(session.id);
        setView("terminal");
      }
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopSession(session: Session) {
    try {
      await api(`/api/v1/sessions/${encodeURIComponent(session.id)}/stop`, { method: "POST", body: "{}" });
      setMessage(`stopped ${session.id}`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteSession(session: Session) {
    try {
      await api(`/api/v1/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      setMessage(`removed ${session.id}`);
      if (selectedId === session.id) setSelectedId(null);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadLogs(session: Session) {
    try {
      const response = await api(`/api/v1/sessions/${encodeURIComponent(session.id)}/logs?tail=500`) as LogsResponse;
      setLogs(response.lines.map((line) => decodeBytes(line.content)).join(""));
      setView("logs");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadDirs(path?: string) {
    setDirBusy(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      setDirListing(await api(`/api/v1/fs/dirs${query}`) as DirListing);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDirBusy(false);
    }
  }

  function openFolderPicker() {
    setFolderOpen(true);
    void loadDirs(cwd.trim() || undefined);
  }

  useEffect(() => { if (authed) void loadBackends(); }, [authed]);
  useEffect(() => { if (authed) void load(); }, [authed, showAll]);
  useEffect(() => {
    if (selectedId && !sessions.some((session) => session.id === selectedId)) setSelectedId(null);
  }, [sessions, selectedId]);
  useEffect(() => {
    if (!backends.some((backend) => backend.id === tool)) setTool(backends[0]?.id ?? "codex");
  }, [backends, tool]);

  if (!authed) return <Login onLogin={(value) => { localStorage.setItem("orbit.token", value); setAuthed(true); }} />;

  return <main className="app">
    <section className="toolbar">
      <strong>Orbit</strong>
      <select value={tool} onChange={(event) => setTool(event.target.value)}>
        {backends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name || backend.id}</option>)}
      </select>
      <input className="nameInput" placeholder="name" value={name} onChange={(event) => setName(event.target.value)} />
      <div className="cwdField">
        <input className="cwdInput" placeholder="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} />
        <button title="Browse folders" onClick={openFolderPicker}><FolderOpen size={16} /></button>
        <button className={fileEditorOpen ? "activeButton" : ""} title="File explorer" onClick={() => setFileEditorOpen((value) => !value)}><FilePen size={16} /></button>
      </div>
      <input className="envInput" placeholder="KEY=VALUE" value={env} onChange={(event) => setEnv(event.target.value)} />
      <label className="check"><input type="checkbox" checked={attachAfterRun} onChange={(event) => setAttachAfterRun(event.target.checked)} />Attach</label>
      <button disabled={busy} onClick={runSession}><PlugZap size={16} />Run</button>
      <button className={showAll ? "activeButton" : ""} onClick={() => setShowAll((value) => !value)}>{showAll ? "All" : "Running"}</button>
      <button title="Refresh" onClick={load}><RefreshCcw size={16} /></button>
      <button title="Logout" onClick={() => { localStorage.removeItem("orbit.token"); setAuthed(false); }}><LogOut size={16} /></button>
    </section>
    {message && <div className="statusLine">{message}</div>}
    <section className="layout">
      <div className="sessions">
        <div className="row header"><span>ID</span><span>Name</span><span>Tool</span><span>Status</span><span>PID</span></div>
        {sessions.map((session) => <button className={selectedId === session.id ? "row active" : "row"} key={session.id} onClick={() => { setSelectedId(session.id); setView("terminal"); }}>
          <span title={session.id}>{session.id}</span>
          <span title={session.name}>{session.name}</span>
          <span>{session.tool}</span>
          <span className={`pill ${session.status}`}>{session.status}</span>
          <span>{session.pid ?? "-"}</span>
        </button>)}
      </div>
      <div className="workPane">
        {fileEditorOpen ? <FileWorkspace
          initialPath={cwd.trim() || undefined}
          onUseCwd={(path) => setCwd(path)}
          onClose={() => setFileEditorOpen(false)}
        /> : selected ? <SessionPane
          session={selected}
          view={view}
          logs={logs}
          onDetach={() => setSelectedId(null)}
          onStop={() => void stopSession(selected)}
          onDelete={() => void deleteSession(selected)}
          onLogs={() => void loadLogs(selected)}
          onTerminal={() => setView("terminal")}
          reload={load}
        /> : <div className="empty"><TerminalIcon />Select a session</div>}
      </div>
    </section>
    {folderOpen && <FolderPicker
      listing={dirListing}
      busy={dirBusy}
      selected={cwd}
      onClose={() => setFolderOpen(false)}
      onLoad={loadDirs}
      onSelect={(path) => { setCwd(path); setFolderOpen(false); }}
    />}
  </main>;
}

function FileWorkspace({ initialPath, onUseCwd, onClose }: { initialPath?: string; onUseCwd: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<ListEntriesResponse | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [tree, setTree] = useState<EntryTree>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [openedFile, setOpenedFile] = useState<OpenedFile | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadEntries(path?: string, options: { root?: boolean } = {}) {
    const key = path ?? "__root__";
    if (options.root) setListBusy(true);
    setLoadingPaths((current) => new Set(current).add(key));
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const response = await api(`/api/v1/fs/entries${query}`) as ListEntriesResponse;
      if (options.root || !listing) setListing(response);
      setTree((current) => ({ ...current, [response.path]: response.entries }));
      setExpanded((current) => {
        const next = new Set(current);
        next.add(response.path);
        return next;
      });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (options.root) setListBusy(false);
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  async function resetRoot(path?: string) {
    setTree({});
    setExpanded(new Set());
    await loadEntries(path, { root: true });
  }

  async function toggleDir(entry: FsEntry) {
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    if (tree[entry.path]) {
      setExpanded((current) => new Set(current).add(entry.path));
      return;
    }
    await loadEntries(entry.path);
  }

  async function openFile(path: string) {
    if (openedFile && editContent !== openedFile.savedContent && !window.confirm("Discard unsaved changes?")) return;
    try {
      const result = await api(`/api/v1/fs/files?path=${encodeURIComponent(path)}`) as { path: string; content: string };
      setOpenedFile({ path: result.path, content: result.content, savedContent: result.content });
      setEditContent(result.content);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveFile() {
    if (!openedFile) return;
    setSaving(true);
    try {
      await api("/api/v1/fs/files", {
        method: "PUT",
        body: JSON.stringify({ path: openedFile.path, content: editContent })
      });
      setOpenedFile({ ...openedFile, savedContent: editContent });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { void resetRoot(initialPath); }, []);

  const isDirty = openedFile !== null && editContent !== openedFile.savedContent;
  const fileName = openedFile?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "No file";
  const lineCount = editContent ? editContent.split("\n").length : 0;
  const rootEntries = listing ? tree[listing.path] ?? [] : [];

  function renderTree(entries: FsEntry[], depth = 0): React.ReactNode[] {
    return entries.flatMap((entry) => {
      const isDir = entry.kind === "dir";
      const isExpanded = expanded.has(entry.path);
      const isLoading = loadingPaths.has(entry.path);
      const children = isDir && isExpanded ? tree[entry.path] ?? [] : [];
      const row = <button
        key={entry.path}
        className={`fileEntryRow${openedFile?.path === entry.path ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => isDir ? void toggleDir(entry) : void openFile(entry.path)}
      >
        {isDir ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}
        {isDir ? <FolderOpen size={14} /> : <FileText size={14} />}
        <span>{entry.name}</span>
      </button>;
      const childRows = isDir && isExpanded ? [
        ...(isLoading ? [<div key={`${entry.path}:loading`} className="fileEntryLoading" style={{ paddingLeft: 40 + depth * 14 }}>Loading...</div>] : []),
        ...renderTree(children, depth + 1)
      ] : [];
      return [row, ...childRows];
    });
  }

  return <div className="fileWorkspace">
    <div className="fileActivityBar">
      <button className="activeDark" title="Explorer"><FolderOpen size={18} /></button>
    </div>
    <aside className="fileExplorer">
      <div className="fileExplorerTop">
        <strong>Explorer</strong>
        <button title="Refresh" disabled={listBusy} onClick={() => void resetRoot(listing?.path)}><RefreshCcw size={14} /></button>
        <button title="Close files" onClick={onClose}><X size={14} /></button>
      </div>
      {error && <div className="folderError">{error}</div>}
      <div className="fileExplorerPath" title={listing?.path}>{listing?.path || "Loading..."}</div>
      <div className="fileExplorerActions">
        <button disabled={!listing?.parent || listBusy} onClick={() => listing?.parent && void resetRoot(listing.parent)}><ChevronUp size={14} />Up</button>
        <button disabled={!listing?.home || listBusy} onClick={() => listing?.home && void resetRoot(listing.home)}><Home size={14} />Home</button>
        <button disabled={!listing?.path || listBusy} onClick={() => listing?.path && onUseCwd(listing.path)}><Check size={14} />Use cwd</button>
      </div>
      <div className="fileExplorerList">
        {listBusy && <div className="folderEmpty">Loading...</div>}
        {!listBusy && rootEntries.length === 0 && <div className="folderEmpty">Empty</div>}
        {!listBusy && renderTree(rootEntries)}
      </div>
    </aside>
    <section className="fileEditorSurface">
      <div className="fileTabs">
        {openedFile ? <div className={`fileTab${isDirty ? " dirty" : ""}`} title={openedFile.path}>
          <FileText size={14} />
          <span>{fileName}</span>
        </div> : <div className="fileTab muted">Welcome</div>}
        <div className="fileTabSpacer" />
        {openedFile && <button disabled={saving || !isDirty} onClick={saveFile}>
          <Save size={14} />{saving ? "Saving..." : isDirty ? "Save" : "Saved"}
        </button>}
      </div>
      {openedFile ? <>
        <div className="fileBreadcrumb" title={openedFile.path}>{openedFile.path}</div>
        <textarea
          className="fileEditorTextarea"
          value={editContent}
          onChange={(event) => setEditContent(event.target.value)}
          spellCheck={false}
        />
        <div className="fileStatusBar">
          <span>{isDirty ? "Unsaved" : "Saved"}</span>
          <span>{lineCount} lines</span>
          <span>UTF-8</span>
        </div>
      </> : <div className="fileEditorEmpty"><FileText size={32} /><span>Select a file from Explorer</span></div>}
    </section>
  </div>;
}

function FolderPicker(props: {
  listing: DirListing | null;
  busy: boolean;
  selected: string;
  onClose: () => void;
  onLoad: (path?: string) => void;
  onSelect: (path: string) => void;
}) {
  const [newFolder, setNewFolder] = useState("");
  const [error, setError] = useState("");
  const current = props.listing?.path ?? props.selected;
  async function createFolder() {
    if (!props.listing?.path || !newFolder.trim()) return;
    try {
      const created = await api("/api/v1/fs/dirs", {
        method: "POST",
        body: JSON.stringify({ parent: props.listing.path, name: newFolder.trim() })
      }) as { path: string };
      setNewFolder("");
      setError("");
      props.onSelect(created.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return <div className="modalBackdrop" role="dialog" aria-modal="true">
    <div className="folderPicker">
      <div className="folderTop">
        <strong>Working directory</strong>
        <button title="Close" onClick={props.onClose}><X size={16} /></button>
      </div>
      <div className="folderPath">{current || "Loading..."}</div>
      <div className="folderActions">
        <button disabled={!props.listing?.parent || props.busy} onClick={() => props.listing?.parent && props.onLoad(props.listing.parent)}><ChevronUp size={16} />Up</button>
        <button disabled={!props.listing?.home || props.busy} onClick={() => props.listing?.home && props.onLoad(props.listing.home)}><Home size={16} />Home</button>
        <button disabled={!props.listing?.cwd || props.busy} onClick={() => props.listing?.cwd && props.onLoad(props.listing.cwd)}><FolderOpen size={16} />Server cwd</button>
        <button disabled={!props.listing?.path || props.busy} onClick={() => props.listing?.path && props.onSelect(props.listing.path)}><Check size={16} />Use</button>
      </div>
      <form className="folderCreate" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
        <input placeholder="new empty folder" value={newFolder} onChange={(event) => setNewFolder(event.target.value)} />
        <button disabled={!props.listing?.path || !newFolder.trim() || props.busy}><FolderOpen size={16} />Create</button>
      </form>
      {error && <div className="folderError">{error}</div>}
      <div className="folderList">
        {props.busy && <div className="folderEmpty">Loading...</div>}
        {!props.busy && props.listing?.dirs.length === 0 && <div className="folderEmpty">No folders</div>}
        {!props.busy && props.listing?.dirs.map((dir) => <button key={dir.path} className="folderRow" onClick={() => props.onLoad(dir.path)}>
          <FolderOpen size={15} />
          <span>{dir.name}</span>
        </button>)}
      </div>
    </div>
  </div>;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  return <main className="login"><form onSubmit={(event) => { event.preventDefault(); onLogin(value); }}>
    <h1>Orbit</h1>
    <input autoFocus placeholder="Bearer token" value={value} onChange={(event) => setValue(event.target.value)} />
    <button>Connect</button>
  </form></main>;
}

function SessionPane(props: {
  session: Session;
  view: "terminal" | "logs";
  logs: string;
  onDetach: () => void;
  onStop: () => void;
  onDelete: () => void;
  onLogs: () => void;
  onTerminal: () => void;
  reload: () => void;
}) {
  return <div className="terminalBox">
    <div className="terminalTop">
      <div className="sessionTitle"><span>{props.session.name}</span><small>{props.session.cwd}</small></div>
      <button className={props.view === "terminal" ? "activeDark" : ""} onClick={props.onTerminal}><TerminalIcon size={14} />Attach</button>
      <button className={props.view === "logs" ? "activeDark" : ""} onClick={props.onLogs}><FileText size={14} />Logs</button>
      <button onClick={props.onStop}><CircleStop size={14} />Stop</button>
      <button onClick={props.onDetach}><LogOut size={14} />Detach</button>
      <button onClick={props.onDelete}><Trash2 size={14} /></button>
    </div>
    {props.view === "terminal"
      ? <Terminal session={props.session} reload={props.reload} />
      : <LogView sessionId={props.session.id} logs={props.logs} />}
  </div>;
}

function Terminal({ session, reload }: { session: Session; reload: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      convertEol: false,
      scrollback: 10000,
      allowProposedApi: false
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    term.focus();

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/v1/sessions/${encodeURIComponent(session.id)}/attach?token=${encodeURIComponent(token())}`);
    let detached = false;
    let autoFollow = true;
    let userScrolled = false;

    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    const sendDetach = () => {
      if (detached) return;
      detached = true;
      send({ type: "detach" });
    };
    const sendResize = () => send({ type: "resize", cols: term.cols, rows: term.rows });
    const resize = () => {
      fit.fit();
      if (autoFollow) term.scrollToBottom();
      sendResize();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(ref.current);

    const isAtBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY;
    const followBottom = () => {
      if (!autoFollow) return;
      requestAnimationFrame(() => term.scrollToBottom());
    };
    const scroll = term.onScroll((viewportY) => {
      if (viewportY >= term.buffer.active.baseY) {
        autoFollow = true;
        userScrolled = false;
      } else if (userScrolled) {
        autoFollow = false;
      }
    });
    const markUserScroll = () => { userScrolled = true; };
    ref.current.addEventListener("wheel", markUserScroll, { passive: true });
    ref.current.addEventListener("touchstart", markUserScroll, { passive: true });
    const input = term.onData((data) => {
      if (isDetachInput(data)) {
        sendDetach();
        ws.close();
        return;
      }
      send({ type: "stdin", data: encodeBytes(data) });
    });

    ws.addEventListener("open", () => {
      sendResize();
      term.write("\x1b[2J\x1b[H", followBottom);
    });
    ws.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(await websocketText(event.data));
        if (msg.type === "stdout") {
          if (isAtBottom()) autoFollow = true;
          term.write(decodeBytes(msg.data), followBottom);
        }
        if (msg.type === "exit") void reload();
        if (msg.type === "error") term.write(`\r\n[${msg.code}] ${msg.message}\r\n`);
      } catch {
        term.write("\r\n[bad websocket message]\r\n");
      }
    });
    ws.addEventListener("error", () => term.write("\r\n[attach failed]\r\n"));
    ws.addEventListener("close", () => {
      term.write("\r\n[detached]\r\n", () => term.scrollToBottom());
      void reload();
    });

    return () => {
      ref.current?.removeEventListener("wheel", markUserScroll);
      ref.current?.removeEventListener("touchstart", markUserScroll);
      resizeObserver.disconnect();
      input.dispose();
      scroll.dispose();
      sendDetach();
      ws.close();
      term.dispose();
    };
  }, [session.id]);

  return <div className="xtermHost" ref={ref} />;
}

function LogView({ sessionId, logs }: { sessionId: string; logs: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      cursorBlink: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      scrollback: 20000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    term.write(logs || "[no logs]", () => term.scrollToBottom());
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(ref.current);
    return () => {
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [sessionId, logs]);

  return <div className="xtermHost" ref={ref} />;
}

createRoot(document.getElementById("root")!).render(<App />);
