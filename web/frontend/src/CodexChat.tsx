import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyLiveState, itemText, mergeHistory, newChatState, observe, output, putItem, type CodexItem } from './codex-state';
import './styles/codex-chat.css';

type Session = { id: string; key: string; status: string; connection: { url: string; token: string } };
function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</>;
}
function CodeBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false), [long, setLong] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const node = pre.current; if (!node) return;
    const measure = () => setLong(node.scrollHeight > 280);
    const resize = new ResizeObserver(measure); resize.observe(node); measure(); return () => resize.disconnect();
  }, [text]);
  const toggle = <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '접기' : '전체 펼치기'}</button>;
  return <div className={`codexCode ${expanded ? 'expanded' : ''}`}>{expanded && toggle}<pre ref={pre}><code>{text}</code></pre>{long && toggle}</div>;
}
function Markdown({ text }: { text: string }) {
  return <>{text.split('```').map((part, i) => i % 2 ? <CodeBlock key={i} text={part.includes('\n') ? part.slice(part.indexOf('\n') + 1) : part} /> : <div className="codexProse" key={i}><Inline text={part} /></div>)}</>;
}
function WorkLog({ item }: { item: CodexItem }) {
  const [expanded, setExpanded] = useState(false);
  const full = output(item).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\n+$/, '');
  const lines = full ? full.split('\n') : [], hidden = Math.max(0, lines.length - 3);
  const running = item.status === 'inProgress', failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
  const actions = item.commandActions || [];
  const exploring = actions.length > 0 && actions.every((a: any) => ['read', 'search', 'listFiles'].includes(a.type));
  if (item.type === 'reasoning' && !full.trim()) return null;
  const label = item.type === 'commandExecution' ? (exploring ? running ? '탐색 중' : '탐색함' : running ? '실행 중' : failed ? '실패' : '실행함') : ({ reasoning: '추론 요약', plan: '작업 계획', fileChange: '파일 변경', mcpToolCall: '도구 호출', webSearch: '웹 검색' }[item.type] || item.type);
  const collapse = <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '− 접기' : hidden ? `+ ${hidden}줄 더 보기` : '+ 상세 출력 보기'}</button>;
  return <section className={`codexWork ${running ? 'running' : ''} ${failed ? 'failed' : ''}`} data-item={item.id}>
    <div className="codexWorkHeading"><span className="codexDot" /><strong>{label}</strong>{item.command && <button className="codexCommand" title={item.command} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{item.command.split('\n')[0]}{item.command.includes('\n') ? ' …' : ''}</button>}{failed && item.exitCode != null && <small>exit {item.exitCode}</small>}{expanded && collapse}</div>
    <div className="codexWorkBody">
      {exploring && actions.map((a: any, index: number) => <div className="codexAction" key={index}><span>{a.type === 'read' ? '읽기' : a.type === 'search' ? '검색' : '목록'}</span><span>{a.name || [a.query, a.path].filter(Boolean).join(' ') || a.command}</span></div>)}
      {expanded && item.command && <pre>{item.command}</pre>}
      {(item.changes || []).map((change: any) => <div key={change.path}><div className="codexFile">{change.path}</div>{expanded && change.diff && <pre>{change.diff}</pre>}</div>)}
      {full && (!exploring || expanded) && <pre className={expanded ? '' : 'codexOutputPreview'}>{expanded ? full : lines.slice(-3).join('\n')}</pre>}
      {running && !full && !exploring && <small>출력을 기다리고 있습니다…</small>}
      {(expanded || hidden > 0 || exploring || item.changes?.length > 0) && collapse}
    </div>
  </section>;
}
function Approval({ request, item, reply }: { request: any; item?: CodexItem; reply: (body: any) => Promise<any> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const p = request.params, question = request.method === 'item/tool/requestUserInput';
  async function submit(body: any) { setBusy(true); setError(''); try { await reply({ op: 'reply', requestId: request.id, ...body }); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  const choices = ['accept', 'decline', 'cancel'].filter(choice => !p.availableDecisions || p.availableDecisions.includes(choice));
  return <section className="codexApproval"><strong>{question ? 'Codex가 확인을 요청했습니다' : '실행 전 승인이 필요합니다'}</strong>
    {p.reason && <p>{p.reason}</p>}{p.command && <CodeBlock text={p.command} />}
    {p.cwd && <small>{p.cwd}</small>}
    {request.method === 'item/fileChange/requestApproval' && (item?.changes || []).map((change: any) => <div key={change.path}><strong>{change.path}</strong>{change.diff && <CodeBlock text={change.diff} />}</div>)}
    {question ? <form onSubmit={event => { event.preventDefault(); void submit({ answers }); }}>{(p.questions || []).map((q: any) => <label key={q.id}>{q.question}<input type={q.isSecret ? 'password' : 'text'} required maxLength={10000} value={answers[q.id] || ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />{q.options?.map((option: any) => <button key={option.label} type="button" title={option.description} onClick={() => setAnswers({ ...answers, [q.id]: option.label })}>{option.label}</button>)}</label>)}<button disabled={busy}>응답 보내기</button></form> : <div className="codexApprovalActions">{choices.map(decision => <button key={decision} disabled={busy} onClick={() => void submit({ decision })}>{decision === 'accept' ? '이번만 허용' : decision === 'decline' ? '거부' : '취소'}</button>)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function CodexChat({ session }: { session: Session }) {
  const state = useRef(newChatState()), socket = useRef<WebSocket | null>(null), counter = useRef(0);
  const pending = useRef(new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; since: number; op: string; older: boolean; timer: number }>());
  const [version, setVersion] = useState(0), [epoch, setEpoch] = useState(0), [connection, setConnection] = useState('connecting');
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [historyBusy, setHistoryBusy] = useState(false), [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null), following = useRef(true), [showLatest, setShowLatest] = useState(false);
  const refresh = () => setVersion(v => v + 1);
  function request(body: any): Promise<any> {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex connection is not ready'));
    const id = ++counter.current;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { pending.current.delete(id); reject(new Error('요청 확인 시간이 초과되었습니다. 대화 이력을 확인한 뒤 다시 시도하세요.')); }, 120000);
      pending.current.set(id, { resolve, reject, since: state.current.revision, op: body.op, older: !!body.cursor, timer });
      ws.send(JSON.stringify({ ...body, id }));
    });
  }
  useEffect(() => {
    let disposed = false; setConnection('connecting'); setError('');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/api/v1/sessions/${encodeURIComponent(session.id)}/codex?token=${encodeURIComponent(session.connection.token)}&orbitd=${encodeURIComponent(session.connection.url)}`);
    socket.current = ws;
    ws.onmessage = event => {
      if (disposed) return;
      let message: any; try { message = JSON.parse(event.data); } catch { return; }
      const s = state.current;
      if (message.type === 'ready') {
        applyLiveState(s, message.state, s.revision);
        void request({ op: 'history' }).then(() => { if (!disposed) setConnection('ready'); }).catch(e => { if (!disposed) setError(String(e)); });
      } else if (message.type === 'result' || message.type === 'error') {
        const entry = pending.current.get(message.id);
        if (entry) {
          clearTimeout(entry.timer); pending.current.delete(message.id);
          if (message.type === 'error') entry.reject(new Error(message.error));
          else {
            if (entry.op === 'history') mergeHistory(s, message.result, entry.since, entry.older);
            entry.resolve(message.result);
          }
        } else if (message.type === 'error') setError(message.error);
      } else if (message.type === 'notification') observe(s, message.message);
      else if (message.type === 'request') { s.approvals.set(JSON.stringify(message.message.id), message.message); s.approvalsRevision = ++s.revision; }
      else if (message.type === 'resolved') { s.approvals.delete(JSON.stringify(message.requestId)); s.approvalsRevision = ++s.revision; }
      else if (message.type === 'resync') {
        void request({ op: 'history' }).catch(e => { if (!disposed) setError(String(e)); });
      } else if (message.type === 'disconnected') { setError(message.error); setConnection('offline'); }
      refresh();
    };
    ws.onerror = () => { if (!disposed) setError('Codex 연결에 실패했습니다. 실행 호스트의 orbitd와 Codex 데몬을 확인하세요.'); };
    ws.onclose = () => {
      if (disposed) return;
      for (const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error('연결이 종료되었습니다. 전송 여부는 대화 이력에서 확인하세요.')); }
      pending.current.clear();
      if (!disposed) setConnection('offline');
    };
    return () => {
      disposed = true;
      for (const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error('세션 연결을 닫았습니다.')); }
      pending.current.clear(); ws.close(); if (socket.current === ws) socket.current = null;
    };
  }, [session.key, epoch]);
  useLayoutEffect(() => { if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [version, connection]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!draft.trim() || sending || state.current.active || session.status !== 'running' || connection !== 'ready') return;
    setSending(true); setError(''); const text = draft;
    try {
      const result = await request({ op: 'send', text });
      for (const item of result.turn.items || []) if (!state.current.items.has(item.id)) putItem(state.current, { ...item, turnId: result.turn.id });
      if (result.turn.status === 'inProgress' && !state.current.completed.has(result.turn.id)) state.current.active = result.turn.id;
      setDraft(value => value === text ? '' : value); following.current = true; setShowLatest(false); refresh();
    } catch (e) { setError(String(e)); } finally { setSending(false); }
  }
  async function older() {
    const node = scroller.current; if (!node || historyBusy) return;
    const height = node.scrollHeight, top = node.scrollTop;
    setHistoryBusy(true); following.current = false;
    try { await request({ op: 'history', cursor: state.current.nextCursor }); refresh(); requestAnimationFrame(() => { node.scrollTop = top + node.scrollHeight - height; }); }
    catch (e) { setError(String(e)); } finally { setHistoryBusy(false); }
  }
  const s = state.current, running = !!s.active;
  const current = [...s.items.values()].reverse().find(item => item.status === 'inProgress' && !['userMessage', 'plan'].includes(item.type));
  const working = s.approvals.size ? '승인 또는 응답 대기 중' : current?.type === 'commandExecution' ? '명령 실행 중' : current?.type === 'fileChange' ? '파일 수정 중' : 'Codex가 작업하고 있습니다';
  return <div className="codexChat">
    <div className="codexConnection"><span>{connection === 'ready' ? session.status === 'running' ? 'Codex 연결됨' : '종료된 세션 · 이력 조회' : connection === 'connecting' ? '연결 중…' : '연결 끊김'}</span>{connection !== 'ready' && <button onClick={() => setEpoch(v => v + 1)}>다시 연결</button>}</div>
    <div className="codexMessages" ref={scroller} onScroll={() => { const n = scroller.current!; following.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; setShowLatest(!following.current); }}>
      {s.nextCursor && <button disabled={historyBusy} className="codexOlder" onClick={() => void older()}>이전 대화 불러오기</button>}
      {!s.order.length && connection === 'ready' && <p className="codexEmpty">이 세션에서 Codex와 대화를 시작하세요.</p>}
      {s.order.map(id => { const item = s.items.get(id)!; return item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'system' ? <article className={`codexMessage ${item.type}`} key={id}>{item.type === 'agentMessage' && <small>Codex</small>}<Markdown text={itemText(item)} /></article> : <WorkLog key={id} item={item} />; })}
      {running && <div className="codexWorking"><span className="codexDot" />{working}</div>}
    </div>
    <div className="codexComposerArea">
      {showLatest && <button className="codexLatest" onClick={() => { following.current = true; setShowLatest(false); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }}>↓ 최신 작업으로 이동</button>}
      {[...s.approvals.values()].map(r => <Approval key={JSON.stringify(r.id)} request={r} item={s.items.get(r.params.itemId)} reply={request} />)}
      {error && <div className="codexError" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}
      <form className="codexComposer" onSubmit={event => void submit(event)}>
        <textarea aria-label="Codex 메시지" placeholder={running ? '작업이 끝나면 전송할 내용을 작성하세요…' : 'Codex에게 작업을 맡겨보세요…'} value={draft} maxLength={100000} onChange={e => setDraft(e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div>{running && <button type="button" disabled={connection !== 'ready'} onClick={() => { void request({ op: 'interrupt' }).catch(e => setError(String(e))); }}>■ 중단</button>}<button disabled={session.status !== 'running' || running || sending || connection !== 'ready' || !draft.trim()}>전송 ↑</button></div>
      </form><small>Enter 전송 · Shift+Enter 줄바꿈</small>
    </div>
  </div>;
}
