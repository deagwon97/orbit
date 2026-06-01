import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, FolderOpen, Home, Image as ImageIcon, LogOut, Menu, Plus, PlugZap, RefreshCcw, Save, Server, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { marked } from "marked";
import { basicSetup, EditorView } from "codemirror";
import { search } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { css as langCss } from "@codemirror/lang-css";
import { html as langHtml } from "@codemirror/lang-html";
import { json as langJson } from "@codemirror/lang-json";
import { markdown as langMarkdown } from "@codemirror/lang-markdown";
import { sql as langSql } from "@codemirror/lang-sql";
import { xml as langXml } from "@codemirror/lang-xml";
import { sass as langSass } from "@codemirror/lang-sass";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r as rMode } from "@codemirror/legacy-modes/mode/r";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import "xterm/css/xterm.css";
import "./styles/app.css";

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("service worker registration failed", err);
    });
  });
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "ico", "avif", "tiff", "tif"]);
const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);

function fileExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

type FileViewKind = "image" | "markdown" | "code";

function getFileViewKind(path: string): FileViewKind {
  const ext = fileExt(path);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  return "code";
}

function rawFileUrl(path: string, connection: OrbitConnection): string {
  return `/api/v1/fs/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(connection.token)}&orbitd=${encodeURIComponent(connection.url)}`;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  sh: "bash", zsh: "bash", bash: "bash",
  yaml: "yaml", yml: "yaml",
  json: "json",
  toml: "toml",
  html: "xml", htm: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  md: "markdown",
  dockerfile: "dockerfile",
  lua: "lua",
  r: "r",
};

function getLang(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  return EXT_LANG[fileExt(path)];
}


function getCmLanguage(path: string) {
  const lang = getLang(path);
  switch (lang) {
    case "typescript": return javascript({ typescript: true, jsx: path.endsWith(".tsx") });
    case "javascript": return javascript({ jsx: path.endsWith(".jsx") });
    case "python":     return python();
    case "rust":       return rust();
    case "go":         return go();
    case "java":       return java();
    case "c":
    case "cpp":        return cpp();
    case "css":        return langCss();
    case "scss":       return langSass({ indented: false });
    case "html":       return langHtml();
    case "xml":        return langXml();
    case "json":       return langJson();
    case "sql":        return langSql();
    case "markdown":   return langMarkdown();
    case "yaml":       return StreamLanguage.define(yaml);
    case "bash":       return StreamLanguage.define(shell);
    case "ruby":       return StreamLanguage.define(ruby);
    case "lua":        return StreamLanguage.define(lua);
    case "r":          return StreamLanguage.define(rMode);
    case "toml":       return StreamLanguage.define(toml);
    case "swift":      return StreamLanguage.define(swift);
    case "kotlin":     return StreamLanguage.define(kotlin);
    case "csharp":     return StreamLanguage.define(csharp);
    case "dockerfile": return StreamLanguage.define(dockerFile);
    default:           return [];
  }
}

const cmTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#fff", fontSize: "13px" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "#172026", padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#172026" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#add6ff" },
  ".cm-gutters": {
    backgroundColor: "#f8fafb",
    color: "#858585",
    border: "none",
    borderRight: "1px solid #e7ecef",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "36px", textAlign: "right" },
  ".cm-activeLine": { backgroundColor: "#f4f9f7" },
  ".cm-activeLineGutter": { backgroundColor: "#eaf2ef", color: "#567a6e" },
  ".cm-foldPlaceholder": { backgroundColor: "#e7ecef", border: "1px solid #c9d2d8", color: "#41515a", borderRadius: "3px", padding: "0 4px", margin: "0 2px" },
  ".cm-panels": { backgroundColor: "#f8fafb", zIndex: "10" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid #d8e0e5" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #d8e0e5" },
  ".cm-search": { display: "flex", gap: "6px", alignItems: "center", padding: "5px 10px", flexWrap: "wrap" },
  ".cm-search input[type=text]": {
    height: "24px", padding: "0 6px",
    border: "1px solid #c9d2d8", borderRadius: "3px",
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px", minWidth: "150px",
  },
  ".cm-search input[type=text]:focus": { borderColor: "#8db7a9", boxShadow: "0 0 0 2px #d4ede7" },
  ".cm-search input[type=checkbox]": { margin: "0", width: "14px", height: "14px", cursor: "pointer" },
  ".cm-search button": {
    height: "24px", padding: "0 8px",
    border: "1px solid #c9d2d8", borderRadius: "3px",
    cursor: "pointer", backgroundColor: "white",
    fontSize: "12px", fontFamily: "system-ui, sans-serif", whiteSpace: "nowrap",
  },
  ".cm-search button:hover": { backgroundColor: "#eef6f3", borderColor: "#8db7a9" },
  ".cm-search button[name=close]": { border: "none", background: "none", padding: "0 4px", fontSize: "16px", color: "#66737b" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "12px", color: "#41515a", cursor: "pointer", userSelect: "none" },
  ".cm-searchMatch": { backgroundColor: "#fff3a3", outline: "1px solid #f9c200", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#ff9632", outline: "1px solid #f36d10" },
  ".cm-tooltip": { border: "1px solid #c9d2d8", borderRadius: "4px", backgroundColor: "#fff", boxShadow: "0 4px 12px rgba(15,22,27,.12)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#e7f1ee", color: "inherit" },
}, { dark: false });

const cmHighlight = HighlightStyle.define([
  { tag: tags.keyword,                   color: "#0000ff" },
  { tag: tags.controlKeyword,            color: "#af00db" },
  { tag: tags.operatorKeyword,           color: "#0000ff" },
  { tag: tags.definitionKeyword,         color: "#0000ff" },
  { tag: tags.moduleKeyword,             color: "#0000ff" },
  { tag: tags.comment,                   color: "#008000" },
  { tag: tags.lineComment,               color: "#008000" },
  { tag: tags.blockComment,              color: "#008000" },
  { tag: tags.docComment,                color: "#008000" },
  { tag: tags.string,                    color: "#a31515" },
  { tag: tags.special(tags.string),      color: "#e07400" },
  { tag: tags.regexp,                    color: "#811f3f" },
  { tag: tags.number,                    color: "#098658" },
  { tag: tags.bool,                      color: "#0000ff" },
  { tag: tags.null,                      color: "#0000ff" },
  { tag: tags.typeName,                  color: "#267f99" },
  { tag: tags.className,                 color: "#267f99" },
  { tag: tags.typeOperator,              color: "#0000ff" },
  { tag: tags.function(tags.variableName), color: "#795e26" },
  { tag: tags.function(tags.propertyName), color: "#795e26" },
  { tag: tags.definition(tags.variableName), color: "#001080" },
  { tag: tags.definition(tags.propertyName), color: "#001080" },
  { tag: tags.propertyName,              color: "#001080" },
  { tag: tags.variableName,              color: "#001080" },
  { tag: tags.namespace,                 color: "#267f99" },
  { tag: tags.operator,                  color: "#000000" },
  { tag: tags.punctuation,               color: "#000000" },
  { tag: tags.bracket,                   color: "#000000" },
  { tag: tags.tagName,                   color: "#800000" },
  { tag: tags.attributeName,             color: "#e50000" },
  { tag: tags.attributeValue,            color: "#0000ff" },
  { tag: tags.meta,                      color: "#808080" },
  { tag: tags.heading,                   color: "#800000", fontWeight: "bold" },
  { tag: tags.strong,                    fontWeight: "bold" },
  { tag: tags.emphasis,                  fontStyle: "italic" },
  { tag: tags.link,                      color: "#0563c1", textDecoration: "underline" },
  { tag: tags.strikethrough,             textDecoration: "line-through" },
  { tag: tags.inserted,                  color: "#22863a" },
  { tag: tags.deleted,                   color: "#b31d28" },
  { tag: tags.invalid,                   textDecoration: "underline wavy red" },
]);

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

type AgentBackend = { id: string; name: string; command: string; args: string[] };
type OrbitConnection = { id: string; label: string; url: string; token: string };
type ConnectedSession = Session & { connection: OrbitConnection; key: string };
type LogLine = { id: number; timestamp: string; content: string };
type LogsResponse = {
  lines: LogLine[];
  next_after: number | null;
  snapshot_last_id: number | null;
  has_more: boolean;
};
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
type TerminalModifier = "shift" | "ctrl" | "cmd" | "alt";

const DEFAULT_MASTER_PANE_WIDTH = 600;
const MIN_MASTER_PANE_WIDTH = 600;
const MAX_MASTER_PANE_WIDTH = 860;
const MASTER_PANE_WIDTH_KEY = "orbit.masterPaneWidth";
const CONNECTION_FAILED_MESSAGE_SUFFIX = " orbitd connection failed";

const defaultBackends: AgentBackend[] = [
  { id: "codex", name: "Codex", command: "codex", args: [] },
  { id: "claude", name: "Claude Code", command: "claude", args: [] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: [] },
  { id: "pi", name: "pi", command: "pi", args: [] }
];

function normalizeOrbitdUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function makeId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function connectionKey(connectionId: string, sessionId: string) {
  return `${connectionId}:${sessionId}`;
}

function savedConnections() {
  const raw = localStorage.getItem("orbit.connections");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as OrbitConnection[];
      return parsed.filter((item) => item.id && item.url && typeof item.token === "string");
    } catch {
      return [];
    }
  }
  const token = localStorage.getItem("orbit.token") || "";
  if (!token) return [];
  return [{
    id: makeId(),
    label: "Default",
    url: "http://127.0.0.1:7777",
    token
  }];
}

function persistConnections(connections: OrbitConnection[]) {
  localStorage.setItem("orbit.connections", JSON.stringify(connections));
  localStorage.removeItem("orbit.token");
}

async function api(path: string, init: RequestInit = {}, connection?: OrbitConnection) {
  if (!connection) throw new Error("No orbitd connection selected");
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    "x-orbitd-url": connection.url,
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.headers || {})
  };
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

function findScrollableParent(target: EventTarget | null) {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    if (canScroll) return node;
    node = node.parentElement;
  }
  return null;
}

function isCoarsePointer() {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

function clampMasterPaneWidth(value: number, containerWidth = window.innerWidth) {
  const maxByViewport = Math.max(MIN_MASTER_PANE_WIDTH, containerWidth - 360);
  return Math.round(Math.max(MIN_MASTER_PANE_WIDTH, Math.min(value, MAX_MASTER_PANE_WIDTH, maxByViewport)));
}

function savedMasterPaneWidth() {
  const value = Number(localStorage.getItem(MASTER_PANE_WIDTH_KEY));
  return Number.isFinite(value) ? clampMasterPaneWidth(value) : DEFAULT_MASTER_PANE_WIDTH;
}

function useMobileViewportGuards() {
  useEffect(() => {
    let startX = 0;
    let startY = 0;

    const updateViewport = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const keyboardInset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
      document.documentElement.style.setProperty("--visual-viewport-height", `${height}px`);
      document.documentElement.style.setProperty("--visual-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
    };

    const onTouchStart = (event: TouchEvent) => {
      startX = event.touches[0]?.clientX ?? 0;
      startY = event.touches[0]?.clientY ?? 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest(".xtermHost")) return;

      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaY) <= Math.abs(deltaX)) return;

      const scrollable = findScrollableParent(event.target);
      if (!scrollable) {
        event.preventDefault();
        return;
      }

      const atTop = scrollable.scrollTop <= 0;
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;
      if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) event.preventDefault();
    };

    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.documentElement.style.removeProperty("--visual-viewport-height");
      document.documentElement.style.removeProperty("--visual-viewport-top");
      document.documentElement.style.removeProperty("--keyboard-inset");
    };
  }, []);
}

function App() {
  useMobileViewportGuards();

  const [connections, setConnections] = useState<OrbitConnection[]>(() => savedConnections());
  const [masterPaneWidth, setMasterPaneWidth] = useState(savedMasterPaneWidth);
  const [activeConnectionId, setActiveConnectionId] = useState(() => localStorage.getItem("orbit.activeConnection") || "");
  const [sessions, setSessions] = useState<ConnectedSession[]>([]);
  const [backends, setBackends] = useState<AgentBackend[]>(defaultBackends);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tool, setTool] = useState("codex");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [attachAfterRun, setAttachAfterRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [mobileChromeOpen, setMobileChromeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);

  const authed = connections.length > 0;
  const detailOpenRef = useRef(detailOpen);
  const mobileDetailHistoryRef = useRef(false);
  const activeConnection = useMemo(() => {
    return connections.find((connection) => connection.id === activeConnectionId) ?? connections[0] ?? null;
  }, [connections, activeConnectionId]);
  const selected = useMemo(() => sessions.find((session) => session.key === selectedKey) ?? null, [sessions, selectedKey]);
  const layoutStyle = { "--master-pane-width": `${masterPaneWidth}px` } as React.CSSProperties;

  function saveConnectionList(next: OrbitConnection[]) {
    setConnections(next);
    persistConnections(next);
    const nextActive = next.find((connection) => connection.id === activeConnectionId)?.id ?? next[0]?.id ?? "";
    setActiveConnectionId(nextActive);
    if (nextActive) localStorage.setItem("orbit.activeConnection", nextActive);
    else localStorage.removeItem("orbit.activeConnection");
  }

  async function addConnection(input: { label: string; url: string; token: string }) {
    const connection: OrbitConnection = {
      id: makeId(),
      label: input.label.trim() || normalizeOrbitdUrl(input.url),
      url: normalizeOrbitdUrl(input.url),
      token: input.token
    };
    await api("/api/v1/auth/check", {}, connection);
    const next = [...connections, connection];
    setConnections(next);
    persistConnections(next);
    setActiveConnectionId(connection.id);
    localStorage.setItem("orbit.activeConnection", connection.id);
  }

  function removeConnection(id: string) {
    const next = connections.filter((connection) => connection.id !== id);
    saveConnectionList(next);
    setSessions((current) => current.filter((session) => session.connection.id !== id));
    if (selected?.connection.id === id) setSelectedKey(null);
    if (next.length === 0) setConnectionsOpen(false);
  }

  function selectActiveConnection(id: string) {
    setActiveConnectionId(id);
    if (id) localStorage.setItem("orbit.activeConnection", id);
  }

  async function loadBackends() {
    if (!activeConnection) return;
    try {
      const items = await api("/api/v1/backends", {}, activeConnection) as AgentBackend[];
      if (items.length > 0) setBackends(items);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function load() {
    if (connections.length === 0) return [] as ConnectedSession[];
    try {
      const query = showAll ? "" : "?status=running";
      const results = await Promise.allSettled(connections.map(async (connection) => {
        try {
          const items = await api(`/api/v1/sessions${query}`, {}, connection) as Session[];
          return {
            connection,
            sessions: items.map((session) => ({
              ...session,
              connection,
              key: connectionKey(connection.id, session.id)
            }))
          };
        } catch (err) {
          return {
            connection,
            sessions: [] as ConnectedSession[],
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }));
      const loaded = results
        .filter((result): result is PromiseFulfilledResult<{ connection: OrbitConnection; sessions: ConnectedSession[]; error?: string }> => result.status === "fulfilled")
        .map((result) => result.value);
      const nextSessions = loaded.flatMap((result) => result.sessions);
      setSessions(nextSessions);
      const failures = loaded.filter((result) => result.error);
      if (failures.length > 0) {
        setMessage(`${failures.length}${CONNECTION_FAILED_MESSAGE_SUFFIX}`);
      } else {
        setMessage((current) => current.endsWith(CONNECTION_FAILED_MESSAGE_SUFFIX) ? "" : current);
      }
      return nextSessions;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      return [] as ConnectedSession[];
    }
  }

  async function runSession() {
    if (!activeConnection) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { tool, env: parseEnv(env) };
      if (name.trim()) body.name = name.trim();
      if (cwd.trim()) body.cwd = cwd.trim();
      const session = await api("/api/v1/sessions", { method: "POST", body: JSON.stringify(body) }, activeConnection) as Session;
      setMessage(`created ${session.id} ${session.name}`);
      setName("");
      setEnv("");
      setCreateOpen(false);
      const nextSessions = await load();
      if (attachAfterRun) {
        const nextKey = connectionKey(activeConnection.id, session.id);
        if (nextSessions.some((item) => item.key === nextKey)) {
          setSelectedKey(nextKey);
        }
        setFileEditorOpen(false);
        setDetailOpen(true);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(session: ConnectedSession) {
    try {
      await api(`/api/v1/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }, session.connection);
      setMessage(`removed ${session.id}`);
      if (selectedKey === session.key) {
        setSelectedKey(null);
        setDetailOpen(false);
        setMobileChromeOpen(false);
      }
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadDirs(path?: string) {
    if (!activeConnection) return;
    setDirBusy(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const listing = await api(`/api/v1/fs/dirs${query}`, {}, activeConnection) as DirListing;
      if (!path && listing.home && listing.path !== listing.home) {
        setDirListing(await api(`/api/v1/fs/dirs?path=${encodeURIComponent(listing.home)}`, {}, activeConnection) as DirListing);
      } else {
        setDirListing(listing);
      }
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

  useEffect(() => {
    if (!activeConnectionId && connections[0]) setActiveConnectionId(connections[0].id);
  }, [activeConnectionId, connections]);
  useEffect(() => { if (authed) void loadBackends(); }, [authed, activeConnection?.id]);
  useEffect(() => { if (authed) void load(); }, [authed, showAll, connections]);
  useEffect(() => {
    if (selectedKey && !sessions.some((session) => session.key === selectedKey)) setSelectedKey(null);
  }, [sessions, selectedKey]);
  useEffect(() => {
    if (!backends.some((backend) => backend.id === tool)) setTool(backends[0]?.id ?? "codex");
  }, [backends, tool]);
  useEffect(() => {
    if (detailOpen) setMobileChromeOpen(false);
  }, [detailOpen, selectedKey, fileEditorOpen]);
  useEffect(() => {
    detailOpenRef.current = detailOpen;
  }, [detailOpen]);
  useEffect(() => {
    const isMobile = () => window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;
    if (detailOpen && isMobile() && !mobileDetailHistoryRef.current) {
      history.pushState({ orbitDetail: true }, "", location.href);
      mobileDetailHistoryRef.current = true;
    }
    if (!detailOpen) mobileDetailHistoryRef.current = false;
  }, [detailOpen]);
  useEffect(() => {
    const onPopState = () => {
      if (!detailOpenRef.current || !window.matchMedia("(max-width: 820px), (pointer: coarse)").matches) return;
      mobileDetailHistoryRef.current = false;
      setDetailOpen(false);
      setMobileChromeOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    localStorage.setItem(MASTER_PANE_WIDTH_KEY, String(masterPaneWidth));
  }, [masterPaneWidth]);
  useEffect(() => {
    const onResize = () => {
      setMasterPaneWidth((width) => clampMasterPaneWidth(width));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!authed) return <Login onLogin={addConnection} />;

  return <main className={`app${detailOpen ? " mobileDetailOpen" : ""}${mobileChromeOpen ? " mobileChromeOpen" : ""}`}>
    {detailOpen && <button className="mobileChromeToggle" title="Show navigation" onClick={() => setMobileChromeOpen((value) => !value)}>
      {mobileChromeOpen ? <X size={18} /> : <Menu size={18} />}
    </button>}
    <section className="toolbar">
      <strong>Orbit</strong>
      <div className="toolbarActions">
        <button
          className={connectionsOpen ? "activeButton" : ""}
          title="Orbitd"
          onClick={() => { setConnectionsOpen(true); setFileEditorOpen(false); setDetailOpen(false); }}
        >
          <Server size={16} />
        </button>
        <button title="Refresh" onClick={load}><RefreshCcw size={16} /></button>
      </div>
    </section>
    {message && <div className="statusLine">{message}</div>}
    <section className={`layout${detailOpen ? " showDetail" : ""}`} style={layoutStyle}>
      {connectionsOpen ? <ConnectionsWorkspace
          connections={connections}
          activeConnectionId={activeConnection?.id ?? ""}
          onSelect={selectActiveConnection}
          onRemove={removeConnection}
          onAdd={() => setConnectionOpen(true)}
          onSessions={() => { setConnectionsOpen(false); setFileEditorOpen(false); setDetailOpen(false); }}
          onFiles={() => { setConnectionsOpen(false); setFileEditorOpen(true); setDetailOpen(false); }}
        /> : fileEditorOpen && activeConnection ? <FileWorkspace
          connection={activeConnection}
          onSessions={() => { setFileEditorOpen(false); setDetailOpen(false); }}
          detailOpen={detailOpen}
          masterPaneWidth={masterPaneWidth}
          onMasterPaneWidth={setMasterPaneWidth}
          onDetailOpen={() => setDetailOpen(true)}
          onBack={() => setDetailOpen(false)}
        /> : <>
        <div className="masterPane">
          <div className="paneTabs">
            <button className="activeButton"><TerminalIcon size={14} />Sessions</button>
            <button onClick={() => { setFileEditorOpen(true); setDetailOpen(false); }}><FolderOpen size={14} />Files</button>
            <button className={`sessionFilterButton${showAll ? " activeButton" : ""}`} onClick={() => setShowAll((value) => !value)}>{showAll ? "All" : "Running"}</button>
            <button className="iconButton" title="New session" disabled={busy} onClick={() => setCreateOpen(true)}><Plus size={16} /></button>
          </div>
          <div className="sessions">
            <div className="row header"><span>Server</span><span>ID</span><span>Name</span><span>Tool</span><span>Status</span><span>PID</span></div>
            {sessions.map((session) => <button className={selectedKey === session.key ? "row active" : "row"} key={session.key} onClick={() => { setSelectedKey(session.key); setDetailOpen(true); }}>
              <span title={session.connection.label}>{session.connection.label}</span>
              <span title={session.id}>{session.id}</span>
              <span title={session.name}>{session.name}</span>
              <span>{session.tool}</span>
              <span className={`pill ${session.status}`}>{session.status}</span>
              <span>{session.pid ?? "-"}</span>
            </button>)}
          </div>
        </div>
        <PaneResizer width={masterPaneWidth} onWidthChange={setMasterPaneWidth} />
        <div className="workPane">
          <button className="mobileBackButton" onClick={() => setDetailOpen(false)}><ChevronLeft size={16} />Sessions</button>
          {selected ? <SessionPane
            session={selected}
            onDetach={() => { setSelectedKey(null); setDetailOpen(false); }}
            onDelete={() => void deleteSession(selected)}
            reload={load}
          /> : <div className="empty"><TerminalIcon />Select a session</div>}
        </div>
      </>}
    </section>
    {createOpen && activeConnection && <NewSessionModal
      connection={activeConnection}
      backends={backends}
      tool={tool}
      name={name}
      cwd={cwd}
      env={env}
      attachAfterRun={attachAfterRun}
      busy={busy}
      onTool={setTool}
      onName={setName}
      onCwd={setCwd}
      onEnv={setEnv}
      onAttachAfterRun={setAttachAfterRun}
      onBrowse={openFolderPicker}
      onClose={() => setCreateOpen(false)}
      onRun={() => void runSession()}
    />}
    {folderOpen && activeConnection && <FolderPicker
      connection={activeConnection}
      listing={dirListing}
      busy={dirBusy}
      selected={cwd}
      onClose={() => setFolderOpen(false)}
      onLoad={loadDirs}
      onSelect={(path) => { setCwd(path); setFolderOpen(false); }}
    />}
    {connectionOpen && <ConnectionModal
      onClose={() => setConnectionOpen(false)}
      onConnect={async (input) => {
        await addConnection(input);
        setConnectionOpen(false);
        setMessage(`connected ${input.label || input.url}`);
      }}
    />}
  </main>;
}

function PaneResizer({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    return () => {
      document.body.classList.remove("paneResizing");
    };
  }, []);

  function commitWidth(value: number) {
    onWidthChange(clampMasterPaneWidth(value));
  }

  return <div
    className="paneResizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize panes"
    aria-valuemin={MIN_MASTER_PANE_WIDTH}
    aria-valuemax={MAX_MASTER_PANE_WIDTH}
    aria-valuenow={width}
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitWidth(width - (event.shiftKey ? 80 : 20));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        commitWidth(width + (event.shiftKey ? 80 : 20));
      }
      if (event.key === "Home") {
        event.preventDefault();
        commitWidth(MIN_MASTER_PANE_WIDTH);
      }
      if (event.key === "End") {
        event.preventDefault();
        commitWidth(MAX_MASTER_PANE_WIDTH);
      }
    }}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add("paneResizing");
    }}
    onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      commitWidth(drag.startWidth + event.clientX - drag.startX);
    }}
    onPointerUp={(event) => {
      const drag = dragRef.current;
      if (drag?.pointerId === event.pointerId) {
        dragRef.current = null;
        document.body.classList.remove("paneResizing");
      }
    }}
    onPointerCancel={() => {
      dragRef.current = null;
      document.body.classList.remove("paneResizing");
    }}
  />;
}

function ConnectionsWorkspace(props: {
  connections: OrbitConnection[];
  activeConnectionId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onSessions: () => void;
  onFiles: () => void;
}) {
  return <div className="connectionWorkspace">
    <div className="paneTabs">
      <button onClick={props.onSessions}><TerminalIcon size={14} />Sessions</button>
      <button onClick={props.onFiles}><FolderOpen size={14} />Files</button>
      <button className="iconButton connectionAddButton" title="Add orbitd" onClick={props.onAdd}><Plus size={16} /></button>
    </div>
    <div className="connectionList">
      <div className="connectionRow connectionHeader">
        <span>Name</span>
        <span>URL</span>
        <span>Status</span>
        <span />
      </div>
      {props.connections.map((connection) => {
        const active = connection.id === props.activeConnectionId;
        return <div className={`connectionRow${active ? " active" : ""}`} key={connection.id}>
          <button className="connectionSelectButton" onClick={() => props.onSelect(connection.id)}>
            <span title={connection.label}>{connection.label}</span>
          </button>
          <span className="connectionUrlCell" title={connection.url}>{connection.url}</span>
          <span className={`pill ${active ? "running" : ""}`}>{active ? "active" : "saved"}</span>
          <button className="iconButton" title="Remove orbitd" onClick={() => props.onRemove(connection.id)}><Trash2 size={16} /></button>
        </div>;
      })}
    </div>
  </div>;
}

function NewSessionModal(props: {
  connection: OrbitConnection;
  backends: AgentBackend[];
  tool: string;
  name: string;
  cwd: string;
  env: string;
  attachAfterRun: boolean;
  busy: boolean;
  onTool: (value: string) => void;
  onName: (value: string) => void;
  onCwd: (value: string) => void;
  onEnv: (value: string) => void;
  onAttachAfterRun: (value: boolean) => void;
  onBrowse: () => void;
  onClose: () => void;
  onRun: () => void;
}) {
  return <div className="modalBackdrop" role="dialog" aria-modal="true">
    <form className="sessionModal" onSubmit={(event) => { event.preventDefault(); props.onRun(); }}>
      <div className="modalTop">
        <strong>New session</strong>
        <button type="button" title="Close" onClick={props.onClose}><X size={16} /></button>
      </div>
      <div className="modalContext" title={props.connection.url}>{props.connection.label} · {props.connection.url}</div>
      <label className="fieldLabel">
        <span>Backend</span>
        <select value={props.tool} onChange={(event) => props.onTool(event.target.value)}>
          {props.backends.map((backend) => <option value={backend.id} key={backend.id}>{backend.name || backend.id}</option>)}
        </select>
      </label>
      <label className="fieldLabel">
        <span>Name</span>
        <input placeholder="optional session name" value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <label className="fieldLabel">
        <span>Working directory</span>
        <div className="cwdField">
          <input placeholder="cwd" value={props.cwd} onChange={(event) => props.onCwd(event.target.value)} />
          <button type="button" title="Browse folders" onClick={props.onBrowse}><FolderOpen size={16} /></button>
        </div>
      </label>
      <label className="fieldLabel">
        <span>Environment</span>
        <input placeholder="KEY=VALUE" value={props.env} onChange={(event) => props.onEnv(event.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={props.attachAfterRun} onChange={(event) => props.onAttachAfterRun(event.target.checked)} />Attach after run</label>
      <div className="modalActions">
        <button type="button" onClick={props.onClose}>Cancel</button>
        <button disabled={props.busy}><PlugZap size={16} />Run</button>
      </div>
    </form>
  </div>;
}

function FileWorkspace(props: {
  connection: OrbitConnection;
  initialPath?: string;
  onSessions: () => void;
  detailOpen: boolean;
  masterPaneWidth: number;
  onMasterPaneWidth: (width: number) => void;
  onDetailOpen: () => void;
  onBack: () => void;
}) {
  const { connection, initialPath, onSessions, detailOpen, masterPaneWidth, onMasterPaneWidth, onDetailOpen, onBack } = props;
  const [listing, setListing] = useState<ListEntriesResponse | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [tree, setTree] = useState<EntryTree>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [openedFile, setOpenedFile] = useState<OpenedFile | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"edit" | "view">("edit");

  async function loadEntries(path?: string, options: { root?: boolean } = {}) {
    const key = path ?? "__root__";
    if (options.root) setListBusy(true);
    setLoadingPaths((current) => new Set(current).add(key));
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const response = await api(`/api/v1/fs/entries${query}`, {}, connection) as ListEntriesResponse;
      if (options.root || !listing) setListing(response);
      setTree((current) => ({ ...current, [response.path]: response.entries }));
      setExpanded((current) => {
        const next = new Set(current);
        next.add(response.path);
        return next;
      });
      setError("");
      return response;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
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

  async function resetHome() {
    setTree({});
    setExpanded(new Set());
    const response = await loadEntries(undefined, { root: true });
    if (response?.home && response.home !== response.path) {
      await resetRoot(response.home);
    }
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
    const kind = getFileViewKind(path);
    if (kind === "image") {
      setOpenedFile({ path, content: "", savedContent: "" });
      setEditContent("");
      setViewMode("edit");
      onDetailOpen();
      setError("");
      return;
    }
    try {
      const result = await api(`/api/v1/fs/files?path=${encodeURIComponent(path)}`, {}, connection) as { path: string; content: string };
      setOpenedFile({ path: result.path, content: result.content, savedContent: result.content });
      setEditContent(result.content);
      setViewMode("edit");
      onDetailOpen();
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
      }, connection);
      setOpenedFile({ ...openedFile, savedContent: editContent });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { initialPath ? void resetRoot(initialPath) : void resetHome(); }, []);

  const isDirty = openedFile !== null && editContent !== openedFile.savedContent;
  const fileName = openedFile?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "No file";
  const lineCount = editContent ? editContent.split("\n").length : 0;
  const rootEntries = listing ? tree[listing.path] ?? [] : [];
  const viewKind = openedFile ? getFileViewKind(openedFile.path) : null;

  const renderedMarkdown = useMemo(() => {
    if (!openedFile || viewKind !== "markdown" || viewMode !== "view") return "";
    return marked(editContent) as string;
  }, [editContent, openedFile?.path, viewMode, viewKind]);

  function renderTree(entries: FsEntry[], depth = 0): React.ReactNode[] {
    return entries.flatMap((entry) => {
      const isDir = entry.kind === "dir";
      const isExpanded = expanded.has(entry.path);
      const isLoading = loadingPaths.has(entry.path);
      const children = isDir && isExpanded ? tree[entry.path] ?? [] : [];
      const entryIcon = isDir
        ? <FolderOpen size={14} />
        : getFileViewKind(entry.path) === "image"
          ? <ImageIcon size={14} />
          : <FileText size={14} />;
      const row = <button
        key={entry.path}
        className={`fileEntryRow${openedFile?.path === entry.path ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => isDir ? void toggleDir(entry) : void openFile(entry.path)}
      >
        {isDir ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}
        {entryIcon}
        <span>{entry.name}</span>
      </button>;
      const childRows = isDir && isExpanded ? [
        ...(isLoading ? [<div key={`${entry.path}:loading`} className="fileEntryLoading" style={{ paddingLeft: 40 + depth * 14 }}>Loading...</div>] : []),
        ...renderTree(children, depth + 1)
      ] : [];
      return [row, ...childRows];
    });
  }

  return <div className={`fileWorkspace${detailOpen ? " showDetail" : ""}`}>
    <aside className="masterPane fileExplorer">
      <div className="paneTabs">
        <button onClick={onSessions}><TerminalIcon size={14} />Sessions</button>
        <button className="activeButton"><FolderOpen size={14} />Files</button>
      </div>
      {error && <div className="folderError">{error}</div>}
      <div className="fileExplorerPath" title={listing?.path}>{listing?.path || "Loading..."}</div>
      <div className="fileExplorerActions">
        <button disabled={!listing?.parent || listBusy} onClick={() => listing?.parent && void resetRoot(listing.parent)}><ChevronUp size={14} />Up</button>
        <button disabled={!listing?.home || listBusy} onClick={() => listing?.home && void resetRoot(listing.home)}><Home size={14} />Home</button>
        <button className="fileRefreshButton" title="Refresh" disabled={listBusy} onClick={() => void resetRoot(listing?.path)}><RefreshCcw size={14} /></button>
      </div>
      <div className="fileExplorerList">
        {listBusy && <div className="folderEmpty">Loading...</div>}
        {!listBusy && rootEntries.length === 0 && <div className="folderEmpty">Empty</div>}
        {!listBusy && renderTree(rootEntries)}
      </div>
    </aside>
    <PaneResizer width={masterPaneWidth} onWidthChange={onMasterPaneWidth} />
    <section className="workPane fileEditorSurface">
      <div className="fileTabs">
        <button className="mobileBackButton" onClick={onBack}><ChevronLeft size={16} />Explorer</button>
        {openedFile ? <div className={`fileTab${isDirty ? " dirty" : ""}`} title={openedFile.path}>
          {viewKind === "image" ? <ImageIcon size={14} /> : <FileText size={14} />}
          <span>{fileName}</span>
        </div> : <div className="fileTab muted">Welcome</div>}
        <div className="fileTabSpacer" />
        {openedFile && viewKind === "markdown" && <>
          <button className={viewMode === "edit" ? "activeButton" : ""} onClick={() => setViewMode("edit")}>Edit</button>
          <button className={viewMode === "view" ? "activeButton" : ""} onClick={() => setViewMode("view")}>Preview</button>
        </>}
        {openedFile && viewKind !== "image" && <button disabled={saving || !isDirty} onClick={saveFile}>
          <Save size={14} />{saving ? "Saving..." : isDirty ? "Save" : "Saved"}
        </button>}
      </div>
      {openedFile ? <>
        <div className="fileBreadcrumb" title={openedFile.path}>{openedFile.path}</div>
        {viewKind === "image" ? (
          <div className="fileImageViewer">
            <img src={rawFileUrl(openedFile.path, connection)} alt={fileName} />
          </div>
        ) : viewKind === "markdown" && viewMode === "view" ? (
          <div className="fileMarkdownPreview" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
        ) : viewKind === "code" ? (
          <CodeEditor value={editContent} path={openedFile.path} onChange={setEditContent} />
        ) : (
          <textarea
            className="fileEditorTextarea"
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            spellCheck={false}
          />
        )}
        <div className="fileStatusBar">
          {viewKind !== "image" && <span>{isDirty ? "Unsaved" : "Saved"}</span>}
          {viewKind !== "image" && <span>{lineCount} lines</span>}
          <span className="fileStatusLang">{viewKind === "image" ? "Image" : viewKind === "markdown" ? "Markdown" : (getLang(openedFile.path) ?? "Text")}</span>
        </div>
      </> : <div className="fileEditorEmpty"><FileText size={32} /><span>Select a file from Explorer</span></div>}
    </section>
  </div>;
}

function CodeEditor({ value, path, onChange }: {
  value: string;
  path: string;
  onChange: (v: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const skipRef = useRef(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        getCmLanguage(path),
        cmTheme,
        syntaxHighlighting(cmHighlight, { fallback: false }),
        search({ top: true }),
        EditorView.contentAttributes.of({ autocorrect: "off", autocapitalize: "off", spellcheck: "false" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !skipRef.current) onChangeRef.current(u.state.doc.toString());
        }),
      ],
      parent: hostRef.current,
    });
    viewRef.current = view;
    view.focus();
    return () => { view.destroy(); viewRef.current = null; };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    skipRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    skipRef.current = false;
  }, [value]);

  return <div ref={hostRef} className="codeEditorWrapper" />;
}

function FolderPicker(props: {
  connection: OrbitConnection;
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
      }, props.connection) as { path: string };
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

function Login({ onLogin }: { onLogin: (input: { label: string; url: string; token: string }) => Promise<void> }) {
  const [label, setLabel] = useState("Local orbitd");
  const [url, setUrl] = useState("http://127.0.0.1:7777");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await onLogin({ label, url, token });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return <main className="login"><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h1>Orbit</h1>
    <input autoFocus placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} />
    <input placeholder="orbitd URL" value={url} onChange={(event) => setUrl(event.target.value)} />
    <input placeholder="Bearer token" value={token} onChange={(event) => setToken(event.target.value)} />
    {error && <div className="loginError">{error}</div>}
    <button disabled={busy || !url.trim()}>{busy ? "Connecting..." : "Connect"}</button>
  </form></main>;
}

function ConnectionModal(props: {
  onClose: () => void;
  onConnect: (input: { label: string; url: string; token: string }) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("http://127.0.0.1:7777");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    try {
      await props.onConnect({ label, url, token });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modalBackdrop" role="dialog" aria-modal="true">
    <form className="sessionModal" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="modalTop">
        <strong>Add orbitd</strong>
        <button type="button" title="Close" onClick={props.onClose}><X size={16} /></button>
      </div>
      <label className="fieldLabel">
        <span>Name</span>
        <input autoFocus placeholder="server name" value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label className="fieldLabel">
        <span>URL</span>
        <input placeholder="http://host:7777" value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label className="fieldLabel">
        <span>Token</span>
        <input placeholder="Bearer token" value={token} onChange={(event) => setToken(event.target.value)} />
      </label>
      {error && <div className="folderError">{error}</div>}
      <div className="modalActions">
        <button type="button" onClick={props.onClose}>Cancel</button>
        <button disabled={busy || !url.trim()}><PlugZap size={16} />{busy ? "Connecting..." : "Connect"}</button>
      </div>
    </form>
  </div>;
}

function SessionPane(props: {
  session: ConnectedSession;
  onDetach: () => void;
  onDelete: () => void;
  reload: () => void;
}) {
  const [mode, setMode] = useState<"attach" | "logs">("attach");

  useEffect(() => {
    setMode("attach");
  }, [props.session.key]);

  return <div className="terminalBox">
    <div className="terminalTop">
      <div className="sessionTitle"><span>{props.session.name}</span><small>{props.session.cwd}</small></div>
      <button className={mode === "attach" ? "activeDark" : ""} onClick={() => setMode("attach")}><TerminalIcon size={14} />Attach</button>
      <button className={mode === "logs" ? "activeDark" : ""} onClick={() => setMode("logs")}><FileText size={14} />Logs</button>
      <button onClick={props.onDetach}><LogOut size={14} />Detach</button>
      <button onClick={props.onDelete}><Trash2 size={14} /></button>
    </div>
    {mode === "attach" ? <Terminal session={props.session} reload={props.reload} /> : <SessionLogs session={props.session} />}
  </div>;
}

function SessionLogs({ session }: { session: ConnectedSession }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [nextAfter, setNextAfter] = useState<number | null>(0);
  const [snapshotLastId, setSnapshotLastId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadPage(reset = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const after = reset ? 0 : nextAfter ?? 0;
      const params = new URLSearchParams({ after: String(after), limit: "200" });
      const until = reset ? null : snapshotLastId;
      if (until != null) params.set("until", String(until));
      const response = await api(`/api/v1/sessions/${encodeURIComponent(session.id)}/logs?${params.toString()}`, {}, session.connection) as LogsResponse;
      setLines((current) => reset ? response.lines : [...current, ...response.lines]);
      setNextAfter(response.next_after);
      setSnapshotLastId(response.snapshot_last_id);
      setHasMore(response.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setLines([]);
    setNextAfter(0);
    setSnapshotLastId(null);
    setHasMore(true);
    setError("");
    void loadPage(true);
  }, [session.key]);

  const text = useMemo(() => lines.map((line) => decodeBytes(line.content)).join(""), [lines]);

  return <div className="logPane">
    <pre className="logBody">{text || (busy ? "Loading..." : "No logs")}</pre>
    <div className="logActions">
      {error && <span className="logError">{error}</span>}
      <span>{lines.length} chunks</span>
      <button disabled={busy || !hasMore} onClick={() => void loadPage()}>{busy ? "Loading..." : hasMore ? "More" : "End"}</button>
    </div>
  </div>;
}

function Terminal({ session, reload }: { session: ConnectedSession; reload: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const autoFollowRef = useRef(true);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const [modifiers, setModifiers] = useState<Record<TerminalModifier, boolean>>({
    shift: false,
    ctrl: false,
    cmd: false,
    alt: false
  });
  const [scrollInfo, setScrollInfo] = useState({ top: 1, size: 1, scrollable: false });

  function updateScrollInfo(term: XTerm) {
    const totalRows = term.buffer.active.baseY + term.rows;
    const scrollable = term.buffer.active.baseY > 0;
    const top = scrollable ? term.buffer.active.viewportY / term.buffer.active.baseY : 1;
    const size = scrollable ? Math.max(0.12, Math.min(1, term.rows / totalRows)) : 1;
    setScrollInfo({ top: Math.max(0, Math.min(1, top)), size, scrollable });
  }

  function scrollToRatio(clientY: number, target: HTMLElement) {
    const term = termRef.current;
    if (!term) return;
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const maxLine = term.buffer.active.baseY;
    const targetLine = Math.round(maxLine * ratio);
    term.scrollToLine(targetLine);
    autoFollowRef.current = maxLine - targetLine <= 1;
    updateScrollInfo(term);
  }

  useEffect(() => {
    if (!ref.current) return;
    const host = ref.current;
    const coarsePointer = isCoarsePointer();
    const term = new XTerm({
      cursorBlink: !coarsePointer,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      convertEol: false,
      scrollback: 10000,
      allowProposedApi: false
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const attachUrl = `${protocol}://${location.host}/api/v1/sessions/${encodeURIComponent(session.id)}/attach?token=${encodeURIComponent(session.connection.token)}&orbitd=${encodeURIComponent(session.connection.url)}`;
    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 1000;
    autoFollowRef.current = true;
    let userScrollIntent = false;
    let userScrollTimer: number | undefined;

    const send = (payload: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };
    sendInputRef.current = (data: string) => send({ type: "stdin", data: encodeBytes(data) });
    const sendDetach = () => {
      send({ type: "detach" });
    };
    const sendResize = () => send({ type: "resize", cols: term.cols, rows: term.rows });
    const resize = () => {
      fit.fit();
      if (autoFollowRef.current) term.scrollToBottom();
      sendResize();
      updateScrollInfo(term);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const isAtBottom = () => term.buffer.active.baseY - term.buffer.active.viewportY <= 1;
    const followBottom = () => {
      if (!autoFollowRef.current) return;
      requestAnimationFrame(() => term.scrollToBottom());
    };
    const scroll = term.onScroll((viewportY) => {
      updateScrollInfo(term);
      if (term.buffer.active.baseY - viewportY <= 1) {
        autoFollowRef.current = true;
      } else if (userScrollIntent) {
        autoFollowRef.current = false;
      }
    });
    const markUserScroll = (event: Event) => {
      userScrollIntent = true;
      if (event instanceof WheelEvent && event.deltaY < 0) autoFollowRef.current = false;
      window.clearTimeout(userScrollTimer);
      userScrollTimer = window.setTimeout(() => { userScrollIntent = false; }, 800);
    };
    let touchLastY = 0;
    let touchScrollRemainder = 0;
    const onTerminalTouchStart = (event: TouchEvent) => {
      touchLastY = event.touches[0]?.clientY ?? 0;
      touchScrollRemainder = 0;
      markUserScroll(event);
    };
    const onTerminalTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? touchLastY;
      const delta = touchLastY - currentY;
      if (Math.abs(delta) < 1) return;

      event.preventDefault();
      userScrollIntent = true;
      touchLastY = currentY;

      const rowHeight = host.clientHeight > 0 && term.rows > 0 ? host.clientHeight / term.rows : 16;
      touchScrollRemainder += delta / Math.max(1, rowHeight);
      const lines = Math.trunc(touchScrollRemainder);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchScrollRemainder -= lines;
        if (!isAtBottom()) autoFollowRef.current = false;
        updateScrollInfo(term);
      }
      window.clearTimeout(userScrollTimer);
      userScrollTimer = window.setTimeout(() => { userScrollIntent = false; }, 800);
    };
    host.addEventListener("wheel", markUserScroll, { passive: true });
    host.addEventListener("touchstart", onTerminalTouchStart, { passive: true });
    host.addEventListener("touchmove", onTerminalTouchMove, { passive: false });
    host.addEventListener("pointerdown", markUserScroll, { passive: true });
    const input = term.onData((data) => {
      if (isDetachInput(data)) {
        sendDetach();
        ws?.close();
        return;
      }
      sendInputRef.current(data);
    });

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(attachUrl);
      ws.addEventListener("open", () => {
        reconnectDelay = 1000;
        sendResize();
        term.write("\x1b[2J\x1b[H", followBottom);
      });
      ws.addEventListener("message", async (event) => {
        try {
          const msg = JSON.parse(await websocketText(event.data));
          if (msg.type === "stdout") {
            if (isAtBottom()) autoFollowRef.current = true;
            term.write(decodeBytes(msg.data), () => {
              followBottom();
              updateScrollInfo(term);
            });
          }
          if (msg.type === "exit") void reload();
          if (msg.type === "error") term.write(`\r\n[${msg.code}] ${msg.message}\r\n`);
        } catch {
          term.write("\r\n[bad websocket message]\r\n");
        }
      });
      ws.addEventListener("error", () => {
        if (!disposed) term.write("\r\n[attach failed]\r\n");
      });
      ws.addEventListener("close", () => {
        if (disposed) return;
        term.write("\r\n[detached, retrying attach]\r\n", () => term.scrollToBottom());
        void reload();
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      });
    };
    connect();

    return () => {
      disposed = true;
      host.removeEventListener("wheel", markUserScroll);
      host.removeEventListener("touchstart", onTerminalTouchStart);
      host.removeEventListener("touchmove", onTerminalTouchMove);
      host.removeEventListener("pointerdown", markUserScroll);
      resizeObserver.disconnect();
      window.clearTimeout(userScrollTimer);
      window.clearTimeout(reconnectTimer);
      input.dispose();
      scroll.dispose();
      sendInputRef.current = () => {};
      sendDetach();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [session.id]);

  function toggleModifier(modifier: TerminalModifier) {
    setModifiers((current) => ({ ...current, [modifier]: !current[modifier] }));
    termRef.current?.focus();
  }

  function arrowSequence(direction: "left" | "up" | "down" | "right") {
    const code = {
      up: "A",
      down: "B",
      right: "C",
      left: "D"
    }[direction];
    const modifierValue = 1
      + (modifiers.shift ? 1 : 0)
      + (modifiers.alt ? 2 : 0)
      + (modifiers.ctrl ? 4 : 0)
      + (modifiers.cmd ? 8 : 0);
    return modifierValue === 1 ? `\x1b[${code}` : `\x1b[1;${modifierValue}${code}`;
  }

  function sendShortcut(key: "tab" | "left" | "up" | "down" | "right") {
    const data = key === "tab"
      ? `${modifiers.alt || modifiers.cmd ? "\x1b" : ""}${modifiers.shift ? "\x1b[Z" : "\t"}`
      : arrowSequence(key);
    sendInputRef.current(data);
    termRef.current?.focus();
  }

  return <div className="xtermShell">
    <div className="xtermSurface">
      <div className="xtermHost" ref={ref} />
      <div className={`terminalScrollOverlay${scrollInfo.scrollable ? "" : " disabled"}`} aria-hidden={!scrollInfo.scrollable}>
        <div
          className="terminalScrollRail"
          onPointerDown={(event) => {
            if (!scrollInfo.scrollable) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            scrollToRatio(event.clientY, event.currentTarget);
          }}
          onPointerMove={(event) => {
            if (!scrollInfo.scrollable || event.buttons !== 1) return;
            event.preventDefault();
            scrollToRatio(event.clientY, event.currentTarget);
          }}
        >
          <div
            className="terminalScrollThumb"
            style={{
              height: `${scrollInfo.size * 100}%`,
              top: `${scrollInfo.top * (1 - scrollInfo.size) * 100}%`
            }}
          />
        </div>
      </div>
    </div>
    <div className="terminalKeyBar" aria-label="Terminal shortcut keys">
      <button type="button" onClick={() => sendShortcut("tab")}>Tab</button>
      <button type="button" className={modifiers.shift ? "activeKey" : ""} onClick={() => toggleModifier("shift")}>Shift</button>
      <button type="button" className={modifiers.ctrl ? "activeKey" : ""} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
      <button type="button" className={modifiers.cmd ? "activeKey" : ""} onClick={() => toggleModifier("cmd")}>Cmd</button>
      <button type="button" className={modifiers.alt ? "activeKey" : ""} onClick={() => toggleModifier("alt")}>Alt</button>
      <button type="button" onClick={() => sendShortcut("left")}><ChevronLeft size={16} /></button>
      <button type="button" onClick={() => sendShortcut("up")}><ChevronUp size={16} /></button>
      <button type="button" onClick={() => sendShortcut("down")}><ChevronDown size={16} /></button>
      <button type="button" onClick={() => sendShortcut("right")}><ChevronRight size={16} /></button>
    </div>
  </div>;
}

registerServiceWorker();
createRoot(document.getElementById("root")!).render(<App />);
