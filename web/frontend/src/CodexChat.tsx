import { ArrowUp, ChevronDown, ChevronLeft, Keyboard, ListPlus, Server, Slash, SlidersHorizontal, Square, X } from 'lucide-react';
import { marked } from 'marked';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyLiveState, itemText, mergeHistory, newChatState, observe, output, putItem, rememberTurnStart, type CodexItem } from './codex-state';
import './styles/codex-chat.css';
import { ImageDrafts, ImagePicker, MessageImages, useImages } from './CodexImages';
import { CodexWorking } from './CodexWorking';
import { CodexControls } from './CodexControls';
import { suggestions, isCommand, type ConversationCommand } from './codex-command-input';

type Session = { id: string; key: string; name: string; cwd: string; status: string; connection: { label: string; url: string; token: string } };
function Inline({ text }: { text: string }) {
  function render(tokens: any[]): React.ReactNode {
    return tokens.map((t, i) => t.type === 'strong' ? <strong key={i}>{render(t.tokens)}</strong> : t.type === 'em' ? <em key={i}>{render(t.tokens)}</em> : t.type === 'codespan' ? <code key={i}>{t.text}</code> : t.type === 'del' ? <del key={i}>{render(t.tokens)}</del> : t.type === 'br' ? <br key={i} /> : t.type === 'link' && /^(https?:|mailto:|#)/i.test(t.href) ? <a key={i} href={t.href} target="_blank" rel="noreferrer">{render(t.tokens)}</a> : <React.Fragment key={i}>{t.tokens ? render(t.tokens) : t.text || t.raw}</React.Fragment>);
  }
  return <>{render(marked.Lexer.lexInline(text))}</>;
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
  function blocks(tokens: any[]): React.ReactNode {
    return tokens.map((t, i) => {
      if (t.type === 'space') return null;
      if (t.type === 'code') return <CodeBlock key={i} text={t.text} />;
      if (t.type === 'heading') return React.createElement(`h${t.depth}`, { key: i }, <Inline text={t.text} />);
      if (t.type === 'list') { const Tag = t.ordered ? 'ol' : 'ul'; return <Tag key={i} start={t.ordered ? t.start : undefined}>{t.items.map((item: any, j: number) => <li key={j}>{blocks(item.tokens)}</li>)}</Tag>; }
      if (t.type === 'blockquote') return <blockquote key={i}>{blocks(t.tokens)}</blockquote>;
      if (t.type === 'hr') return <hr key={i} />;
      if (t.type === 'table') return <div className="codexTable" key={i}><table><thead><tr>{t.header.map((cell: any,j: number)=><th key={j}><Inline text={cell.text} /></th>)}</tr></thead><tbody>{t.rows.map((row: any[],j: number)=><tr key={j}>{row.map((cell,k)=><td key={k}><Inline text={cell.text} /></td>)}</tr>)}</tbody></table></div>;
      return <p key={i}><Inline text={t.text || t.raw} /></p>;
    });
  }
  return <div className="codexProse">{blocks(marked.lexer(text))}</div>;
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
export function CodexChat({ session, onSessionChange, onBack }: { session: Session; onSessionChange: (session: any) => void; onBack: () => void }) {
  const state = useRef(newChatState()), socket = useRef<WebSocket | null>(null), counter = useRef(0);
  const pending = useRef(new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; since: number; op: string; older: boolean; timer: number }>());
  const [version, setVersion] = useState(0), [epoch, setEpoch] = useState(0), [connection, setConnection] = useState('connecting');
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [historyBusy, setHistoryBusy] = useState(false), [error, setError] = useState('');
  const [commands, setCommands] = useState<ConversationCommand[]>([]), [commandResult, setCommandResult] = useState<any>(null), [commandBusy, setCommandBusy] = useState(false), [selectedCommand, setSelectedCommand] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null), commandView = useRef(0);
  function closeControls() { commandView.current++;setCommandResult(null); }
  const images = useImages(session, !!state.current.capabilities.images && session.status === 'running' && connection === 'ready' && !sending, setError);
  const [dragging,setDragging] = useState(false); const dragDepth=useRef(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false), [locationOpen,setLocationOpen] = useState(false);
  useLayoutEffect(() => { const node = promptRef.current; if (node) { node.style.height = window.matchMedia('(max-width:820px)').matches ? '0px' : 'auto'; node.style.height = `${Math.min(node.scrollHeight, 160)}px`; } }, [draft]);
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
        void request({ op: 'history' }).then(() => { if (!disposed) { setConnection('ready'); if (s.capabilities.commands) void request({ op: 'command', command: '/help' }).then(result => { if (!disposed) setCommands(result.commands); }).catch(e => { if (!disposed) setError(String(e)); }); } }).catch(e => { if (!disposed) setError(String(e)); });
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
      } else if (message.type === 'state') applyLiveState(s, message.state, -1);
      else if (message.type === 'notification') observe(s, message.message);
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
  async function runCommand(command: string, extra: any = {}, consumeDraft = false) {
    if (commandBusy || sending || connection !== 'ready') return;
    if ((consumeDraft || /^\/resume\s+[0-9a-f-]{36}$/i.test(command.trim())) && images.items.length) { setError('이미지가 첨부되어 있습니다. 슬래시 명령을 실행하려면 첨부를 해제하거나 일반 메시지로 보내세요.'); return; }
    if (!state.current.capabilities.commands) { setError('현재 orbitd는 대화 명령을 지원하지 않습니다. 새 바이너리로 교체하고 다시 연결하세요.'); return; }
    if (/^\/permissions?\s+full-access$/.test(command.trim()) && !extra.confirmFullAccess) command = '/permissions';
    setCommandBusy(true); setError(''); const before = draft, view = commandView.current;
    try {
      let result = await request({ op: 'command', command, ...extra });
      if (result.type === 'resumeOpened') { setDraft('');onSessionChange(result.session);return; }
      if (result.state) applyLiveState(state.current, result.state, -1);
      if (result.type === 'status') {
        if(view===commandView.current)setCommandResult({...result,usageLoading:true});
        let deadline:number|undefined;
        try { result = { ...result, usage: await Promise.race([request({op:'command',command:'/usage'}),new Promise((_,reject)=>{deadline=window.setTimeout(()=>reject(Error('Quota timeout')),6000);})]) }; }
        catch { result = { ...result, usage: null }; }
        finally { clearTimeout(deadline); }
      }
      if (result.type === 'copy') {
        const last = [...state.current.order].reverse().map(id => state.current.items.get(id)!).find(item => item.type === 'agentMessage');
        if (!last) throw Error('복사할 답변이 없습니다.');
        await navigator.clipboard.writeText(itemText(last)); result = { type: 'copy', message: '마지막 답변을 복사했습니다.' };
      }
      if (result.type === 'export') {
        const seen = new Set<string>();
        while (state.current.nextCursor) {
          const cursor = state.current.nextCursor; if (seen.has(cursor)) throw Error('이력 커서가 반복됩니다.'); seen.add(cursor);
          await request({ op: 'history', cursor });
        }
        const text = state.current.order.map(id => state.current.items.get(id)!).filter(item => ['userMessage','agentMessage'].includes(item.type)).map(item => `## ${item.type === 'userMessage' ? 'User' : 'Codex'}\n\n${[itemText(item), ...(item.content || []).filter((content: any) => content.type === 'localImage').map((content: any) => `첨부 이미지: ${content.path}`)].filter(Boolean).join('\n\n')}`).join('\n\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `codex-${session.id}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        result = { type: 'export', message: '대화 전체를 Markdown으로 다운로드했습니다.' };
      }
      if (view === commandView.current) setCommandResult((previous: any) => result.type === 'resume' && extra.cursor && previous?.type === 'resume' ? { ...result, data: [...new Map([...previous.data,...result.data].map((thread: any) => [thread.id,thread])).values()] } : result);
      if (consumeDraft) setDraft(value => value === before ? '' : value);
      refresh();
    } catch (e) { setError(String(e)); } finally { setCommandBusy(false); }
  }
  async function sendText(queue = false) {
    if ((!draft.trim() && !images.items.length) || sending || commandBusy || session.status !== 'running' || connection !== 'ready') return;
    if (!images.ready) { setError('이미지 업로드가 끝나야 보낼 수 있습니다. 실패한 첨부는 재시도하거나 해제하세요.'); return; }
    if (isCommand(draft)) { await runCommand(draft.trim(), {}, true); return; }
    if (running && !queue && !state.current.capabilities.steer) { setError('실행 중 입력은 orbitd 업데이트 후 사용할 수 있습니다.'); return; }
    setSending(true); setError(''); const text = draft, attached = images.items;
    try {
      const op = queue || (!running && state.current.queue.items.length) ? 'queue' : running ? 'steer' : 'send';
      const result = await request({ op, text, images: attached.map(item => item.id) });
      if (result.state) applyLiveState(state.current, result.state, -1);
      if (result.turn) {
        rememberTurnStart(state.current,result.turn,true);
        for (const item of result.turn.items || []) if (!state.current.items.has(item.id)) putItem(state.current, { ...item, turnId: result.turn.id });
        if (result.turn.status === 'inProgress' && !state.current.completed.has(result.turn.id)) state.current.active = result.turn.id;
      }
      setDraft(value => value === text ? '' : value); images.remove(attached.map(item => item.key)); following.current = true; setShowLatest(false); refresh();
    } catch (e) { setError(String(e)); } finally { setSending(false); }
  }
  async function queueAction(op: string, entryId?: string) {
    setCommandBusy(true); setError('');
    try { const result = await request({ op, entryId }); applyLiveState(state.current, result, -1); refresh(); }
    catch (e) { setError(String(e)); } finally { setCommandBusy(false); }
  }
  async function older() {
    const node = scroller.current; if (!node || historyBusy) return;
    const height = node.scrollHeight, top = node.scrollTop;
    setHistoryBusy(true); following.current = false;
    try { await request({ op: 'history', cursor: state.current.nextCursor }); refresh(); requestAnimationFrame(() => { node.scrollTop = top + node.scrollHeight - height; }); }
    catch (e) { setError(String(e)); } finally { setHistoryBusy(false); }
  }
  const s = state.current, running = !!s.active;
  const matches = suggestions(draft, commands);
  const commandInput = isCommand(draft);
  const current = [...s.items.values()].reverse().find(item => item.status === 'inProgress' && !['userMessage', 'plan'].includes(item.type));
  const working = s.approvals.size ? '승인 또는 응답 대기 중' : current?.type === 'commandExecution' ? '명령 실행 중' : current?.type === 'fileChange' ? '파일 수정 중' : 'Codex가 작업하고 있습니다';
  const host = (() => { try { return new URL(session.connection.url).host; } catch { return session.connection.url; } })();
  const cwd = s.settings.cwd || session.cwd;
  return <div className={`codexChat${dragging ? ' dragging' : ''}`} onDragEnter={event => { if(event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++;setDragging(true); } }} onDragOver={event => { if(event.dataTransfer.types.includes('Files')) { event.preventDefault();event.dataTransfer.dropEffect='copy'; } }} onDragLeave={event => { event.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);} }} onDrop={event => { if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth.current=0;setDragging(false);images.add(Array.from(event.dataTransfer.files)); }}>
    {dragging&&<div className="codexDropOverlay">여기에 이미지를 놓아 첨부하세요</div>}
    <div className="codexConnection"><button type="button" className="codexMobileBack" aria-label="세션 목록으로 돌아가기" onClick={onBack}><ChevronLeft size={22}/></button><div className="codexConnectionTitle"><strong title={session.name}>{session.name}</strong><span className="codexConnectionState" data-state={connection}>{connection === 'ready' ? session.status === 'running' ? 'Codex 연결됨' : '종료된 세션 · 이력 조회' : connection === 'connecting' ? '연결 중…' : '연결 끊김'}</span></div><button type="button" className="codexMobileCommands" aria-label="대화 명령 열기" disabled={connection !== 'ready' || commandBusy || !s.capabilities.commands} onClick={() => void runCommand('/help')}><SlidersHorizontal size={19}/></button><div className="codexToolbar">{s.capabilities.resume && <button disabled={connection !== 'ready' || commandBusy} onClick={() => void runCommand('/resume')}>/resume</button>}<button title={s.capabilities.commands ? undefined : 'orbitd 업데이트 후 사용할 수 있습니다.'} disabled={connection !== 'ready' || commandBusy || !s.capabilities.commands} onClick={() => void runCommand('/status')}>/status</button><button title={s.capabilities.commands ? undefined : 'orbitd 업데이트 후 사용할 수 있습니다.'} disabled={connection !== 'ready' || commandBusy || !s.capabilities.commands} onClick={() => void runCommand('/model')}>{s.settings.model || '/model'}</button><button title={s.capabilities.commands ? undefined : 'orbitd 업데이트 후 사용할 수 있습니다.'} disabled={connection !== 'ready' || commandBusy || !s.capabilities.commands} onClick={() => void runCommand('/help')}>/help</button>{connection !== 'ready' && <button onClick={() => setEpoch(v => v + 1)}>다시 연결</button>}</div></div>
    <button type="button" className="codexLocationToggle" aria-expanded={locationOpen} aria-controls="codex-execution-location" onClick={()=>setLocationOpen(!locationOpen)}><Server size={13}/><strong>{session.connection.label || host}</strong><span>{cwd?.split('/').filter(Boolean).at(-1) || '/'}</span><ChevronDown size={14}/></button>
    <div id="codex-execution-location" className={`codexSessionContext${locationOpen ? ' expanded' : ''}`} aria-label="현재 세션 실행 위치"><span className="codexMode">Web</span><strong title={session.connection.url}>{session.connection.label || host}</strong><span className="codexHost" title={host}>{host}</span><span className="codexCwd" title={cwd}>{cwd}</span></div>
    <div className="codexMessages" ref={scroller} onScroll={() => { const n = scroller.current!; following.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; setShowLatest(!following.current); }}>
      {s.nextCursor && <button disabled={historyBusy} className="codexOlder" onClick={() => void older()}>이전 대화 불러오기</button>}
      {!s.order.length && connection === 'ready' && <div className="codexEmpty"><span className="codexEmptyMark">✳</span><h2>어떤 작업을 시작할까요?</h2><p>이 세션에서 Codex와 대화를 시작하세요.</p><small>{session.name}</small></div>}
      {s.order.map(id => { const item = s.items.get(id)!; return item.type === 'userMessage' || item.type === 'agentMessage' || item.type === 'system' ? <article className={`codexMessage ${item.type}`} key={id}>{item.type === 'agentMessage' && <small>Codex</small>}<MessageImages content={item.content || []} session={session} /><Markdown text={itemText(item)} /></article> : <WorkLog key={id} item={item} />; })}

    </div>
    <div className="codexComposerArea">
      {running && <CodexWorking key={s.active!} sessionKey={session.key} turnId={s.active!} startedAt={s.turnStarts.get(s.active!) || null} activity={working} disabled={connection !== 'ready'} interrupt={()=>void request({op:'interrupt'}).catch(e=>setError(String(e)))}/>}
      {showLatest && <button className="codexLatest" onClick={() => { following.current = true; setShowLatest(false); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }}>↓ 최신 작업으로 이동</button>}
      {s.queue.items.length > 0 && <section className="codexQueue" aria-label="대기 메시지"><header><strong>대기 메시지 {s.queue.items.length}개{s.queue.paused ? ' · 일시 중지' : ''}</strong>{s.queue.paused && <button disabled={commandBusy || connection !== 'ready' || session.status !== 'running'} onClick={() => void queueAction('queue/resume')}>대기열 다시 시작</button>}</header>{s.queue.error && <p>{s.queue.error}</p>}<ol>{s.queue.items.map(entry => <li key={entry.id}><span title={entry.text}>{entry.images?.length ? `이미지 ${entry.images.length}개 · ` : ''}{entry.text || '이미지 첨부'}</span><button disabled={commandBusy || connection !== 'ready' || session.status !== 'running'} onClick={() => void queueAction('queue/remove', entry.id)}>취소</button></li>)}</ol></section>}
      {[...s.approvals.values()].map(r => <Approval key={JSON.stringify(r.id)} request={r} item={s.items.get(r.params.itemId)} reply={request} />)}
      {error && <div className="codexError" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}
      {matches.length > 0 && <div id="codex-command-list" className="codexSuggestions" role="listbox" aria-label="대화 명령">{matches.map((command, index) => <button type="button" key={command.name} role="option" aria-selected={index === selectedCommand % matches.length} aria-disabled={running && !command.duringTask} onMouseDown={e => e.preventDefault()} onClick={() => { setDraft(`/${command.name}${command.usage ? ' ' : ''}`); promptRef.current?.focus(); }}><strong>/{command.name}</strong><span>{command.description}</span>{running && !command.duringTask && <small>작업 후</small>}</button>)}</div>}
      <ImageDrafts items={images.items} remove={images.remove} retry={images.retry} report={setError} />
      <form className="codexComposer" onSubmit={event => { event.preventDefault(); if (commandInput) void runCommand(draft.trim(), {}, true); else void sendText(); }}>
        <textarea ref={promptRef} aria-label="Codex 메시지" aria-expanded={matches.length > 0} aria-controls="codex-command-list" placeholder={running ? '추가 지시를 입력하세요…' : '메시지를 입력하세요… · /명령'} value={draft} maxLength={100000} onPaste={event => { const files=Array.from(event.clipboardData.files);if(!files.length)return;event.preventDefault();images.add(files);const text=event.clipboardData.getData('text/plain');if(text){const node=event.currentTarget,start=node.selectionStart,end=node.selectionEnd;setDraft(draft.slice(0,start)+text+draft.slice(end));} }} onChange={e => { setDraft(e.target.value); setSelectedCommand(0); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (matches.length && ['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); setSelectedCommand(index => (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length); return; }
          if (event.key === 'Tab' && !event.shiftKey) {
            if (matches.length) { event.preventDefault(); setDraft(`/${matches[selectedCommand % matches.length].name} `); return; }
            if (running && (draft.trim() || images.items.length) && !commandInput && s.capabilities.queue) { event.preventDefault(); void sendText(true); return; }
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (matches.length && !matches.some(command => `/${command.name}` === draft)) { void runCommand(`/${matches[selectedCommand % matches.length].name}`, {}, true); return; }
            event.currentTarget.form?.requestSubmit();
          }
          if (event.key === 'Escape') { event.preventDefault();if (commandResult) closeControls();else if(running)void request({op:'interrupt'}).catch(e=>setError(String(e)));else event.currentTarget.blur(); }
        }} />
        <div className="codexComposerActions">
          <ImagePicker enabled={!!s.capabilities.images && connection === 'ready' && session.status === 'running' && !sending} add={images.add} />
          <button type="button" className="codexIconButton codexSlashButton" title="명령 선택" aria-label="명령 선택" disabled={!s.capabilities.commands} onClick={() => { setDraft('/'); promptRef.current?.focus(); }}><Slash size={19} /></button>
          <button type="button" className="codexIconButton" title="키보드와 단축키" aria-label="키보드와 단축키" aria-expanded={shortcutsOpen} onClick={() => { setShortcutsOpen(value => !value); promptRef.current?.focus(); }}><Keyboard size={20} /></button>
          <span className="codexComposerSpacer" />
          {running && <button type="button" className="codexIconButton" title="작업 중단" aria-label="작업 중단" disabled={connection !== 'ready'} onClick={() => { void request({ op: 'interrupt' }).catch(e => setError(String(e))); }}><Square size={16} fill="currentColor" /></button>}
          {s.capabilities.queue && running && !commandInput && <button type="button" className="codexQueueButton" title="다음 턴 예약 · Tab" aria-label="다음 턴 예약" disabled={sending || commandBusy || (!draft.trim() && !images.items.length) || !images.ready || session.status !== 'running' || connection !== 'ready'} onClick={() => void sendText(true)}><ListPlus size={18} /><span className="codexQueueLabelFull">다음 턴</span><span className="codexQueueLabelMobile">예약</span></button>}
          <button className="codexSend" aria-label={commandInput ? '명령 실행' : running ? '지금 반영 ↑' : '전송 ↑'} title={commandInput ? '명령 실행' : running ? '지금 반영' : '전송'} disabled={(!commandInput && session.status !== 'running') || sending || commandBusy || connection !== 'ready' || (!draft.trim() && !images.items.length) || !images.ready}><ArrowUp size={23} /></button>
        </div>
      </form>
      {shortcutsOpen && <div className="codexShortcutBar" aria-label="대화 키보드 버튼">
        <button type="button" onClick={() => { if (matches.length) setDraft(`/${matches[selectedCommand % matches.length].name} `); else if (running && (draft.trim() || images.items.length) && !commandInput && s.capabilities.queue) void sendText(true); promptRef.current?.focus(); }}>Tab</button>
        <button type="button" onClick={() => { const node = promptRef.current; if (!node) return; const start = node.selectionStart, end = node.selectionEnd; setDraft(draft.slice(0,start) + '\n' + draft.slice(end)); node.focus(); requestAnimationFrame(() => node.setSelectionRange(start+1,start+1)); }}>줄바꿈</button>
        <button type="button" onClick={() => { setDraft('/'); promptRef.current?.focus(); }}>/ 명령</button>
        <button type="button" onClick={() => { if (commandResult) closeControls(); else if(running) { void request({op:'interrupt'}).catch(e=>setError(String(e))); } else { promptRef.current?.blur(); setShortcutsOpen(false); } }}>Esc</button>
        <button type="button" aria-label="키보드 버튼 닫기" onClick={() => setShortcutsOpen(false)}><X size={16} /></button>
      </div>}
      <div className="codexComposerMeta"><button type="button" disabled={!s.capabilities.commands || commandBusy || connection !== 'ready'} onClick={() => void runCommand('/model')} title="모델 및 추론 강도">{s.settings.model || 'Codex'}{s.settings.effort ? ` · ${s.settings.effort}` : ''}{['fast','priority'].includes(s.settings.serviceTier) ? ' · Fast' : ''}</button>{s.settings.sandboxPolicy?.type === 'dangerFullAccess' && s.settings.approvalPolicy === 'never' && <span className="codexYolo" title="전체 접근 · 승인 안 함">YOLO</span>}<small>Enter {commandInput ? '명령 실행' : running ? '지금 반영' : '전송'} · Shift+Enter 줄바꿈{s.capabilities.queue && running ? ' · Tab 예약' : ''}</small></div>
      {commandResult && <CodexControls result={commandResult} busy={commandBusy} running={running} readOnly={session.status !== 'running'} run={runCommand} close={closeControls} insert={text => { setDraft(text); closeControls(); promptRef.current?.focus(); }} />}

    </div>
  </div>;
}
