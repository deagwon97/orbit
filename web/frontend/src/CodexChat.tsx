import { ArrowUp, ChevronDown, ChevronLeft, GitFork, Info, ListPlus, RefreshCcw, Server, Slash, SlidersHorizontal, Square } from 'lucide-react';
import { Marked, Tokenizer, type Token, type Tokens } from 'marked';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyLiveState, itemText, mergeHistory, newChatState, observe, output, putItem, rememberTurnStart, type CodexItem } from './codex-state';
import './styles/codex-chat.css';
import { ImageDrafts, ImagePicker, MessageImages, useImages } from './CodexImages';
import { progressCaption, progressLabel, queuesDuringTurn, specificActivity } from './codex-progress';
import { CodexWorking } from './CodexWorking';
import { CodexControls } from './CodexControls';
import { suggestions, isCommand, type ConversationCommand } from './codex-command-input';
import type { Session as OrbitSession } from './main';

type Session = { id: string; key: string; name: string; cwd: string; status: string; codex_thread_id?: string | null; connection: { label: string; url: string; token: string } };
const chatMarkdown = new Marked({
  tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      if (!src.startsWith('**')) return false;
      // Let bold punctuation close before a Korean particle. The lexer mask
      // protects escapes, code spans and link destinations from delimiter matching.
      const mask = maskedSrc.slice(-src.length);
      const span = /^\*\*[^*\n]+(?<=[\p{P}\p{S}])\*\*(?=\p{Script=Hangul})/u.exec(mask)?.[0];
      if (!span) return false;
      const before = prevChar && /\p{Script=Hangul}/u.test(prevChar) ? '' : prevChar;
      const token = Tokenizer.prototype.emStrong.call(this, src.slice(0, span.length), span, before);
      return token?.type === 'strong' && token.raw.length === span.length ? token : false;
    },
  },
});

function Inline({ tokens = [] }: { tokens?: Token[] }) {
  return <>{tokens.map((token, i) => {
    switch (token.type) {
      case 'strong': return <strong key={i}><Inline tokens={token.tokens} /></strong>;
      case 'em': return <em key={i}><Inline tokens={token.tokens} /></em>;
      case 'del': return <del key={i}><Inline tokens={token.tokens} /></del>;
      case 'codespan': return <code key={i}>{token.text}</code>;
      case 'br': return <br key={i} />;
      case 'checkbox': return <input key={i} className="codexTaskCheckbox" type="checkbox" checked={token.checked} disabled />;
      case 'link':
        if (/^(https?:|mailto:|#)/i.test(token.href)) {
          return <a key={i} href={token.href} title={token.title ?? undefined} target="_blank" rel="noreferrer"><Inline tokens={token.tokens} /></a>;
        }
        break;
    }
    if ('tokens' in token && token.tokens) return <Inline key={i} tokens={token.tokens} />;
    return <React.Fragment key={i}>{'text' in token ? token.text : token.raw}</React.Fragment>;
  })}</>;
}
function CodeBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false), [long, setLong] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const node = pre.current; if (!node) return;
    const measure = () => setLong(node.scrollHeight > 280);
    const resize = new ResizeObserver(measure); resize.observe(node); measure(); return () => resize.disconnect();
  }, [text]);
  const toggle = <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse' : 'Expand'}</button>;
  return <div className={`codexCode ${expanded ? 'expanded' : ''}`}>{expanded && toggle}<pre ref={pre}><code>{text}</code></pre>{long && toggle}</div>;
}
function Markdown({ text }: { text: string }) {
  function blocks(tokens: Token[] = [], tightList = false): React.ReactNode {
    return tokens.map((token, i) => {
      switch (token.type) {
        case 'space':
        case 'def': return null;
        case 'code': return <CodeBlock key={i} text={token.text} />;
        case 'heading': return React.createElement(`h${token.depth}`, { key: i }, <Inline tokens={token.tokens} />);
        case 'paragraph': return <p key={i}><Inline tokens={token.tokens} /></p>;
        case 'text': {
          const content = <Inline tokens={token.tokens ?? [token]} />;
          return tightList ? <React.Fragment key={i}>{content}</React.Fragment> : <p key={i}>{content}</p>;
        }
        case 'list': {
          const Tag = token.ordered ? 'ol' : 'ul';
          return <Tag key={i} start={token.ordered ? Number(token.start) : undefined}>{token.items.map((item: Tokens.ListItem, j: number) =>
            <li key={j} className={item.task ? 'codexTaskItem' : undefined}>{blocks(item.tokens, !token.loose)}</li>
          )}</Tag>;
        }
        case 'checkbox': return <Inline key={i} tokens={[token]} />;
        case 'blockquote': return <blockquote key={i}>{blocks(token.tokens)}</blockquote>;
        case 'hr': return <hr key={i} />;
        case 'table': {
          const renderRow = (cells: Tokens.TableCell[], header = false) => {
            const Cell = header ? 'th' : 'td';
            return cells.map((cell, j) => <Cell key={j} style={{ textAlign: cell.align ?? undefined }}><Inline tokens={cell.tokens} /></Cell>);
          };
          return <div className="codexTable" key={i}><table>
            <thead><tr>{renderRow(token.header, true)}</tr></thead>
            <tbody>{token.rows.map((row: Tokens.TableCell[], j: number) => <tr key={j}>{renderRow(row)}</tr>)}</tbody>
          </table></div>;
        }
        default: return <p key={i}>{token.raw}</p>;
      }
    });
  }
  return <div className="codexProse">{blocks(chatMarkdown.lexer(text))}</div>;
}
function WorkLog({ item }: { item: CodexItem }) {
  const [expanded, setExpanded] = useState(false);
  const full = output(item).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\n+$/, '');
  const lines = full ? full.split('\n') : [], hidden = Math.max(0, lines.length - 3);
  const running = item.status === 'inProgress', failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
  const actions = item.commandActions || [];
  const exploring = actions.length > 0 && actions.every((a: any) => ['read', 'search', 'listFiles'].includes(a.type));
  if (item.type === 'reasoning' && !full.trim()) return null;
  const label = progressLabel(item), caption=progressCaption(item);
  const collapse = <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '− Collapse' : hidden ? `+ ${hidden} more ${hidden === 1 ? 'line' : 'lines'}` : '+ Show details'}</button>;
  return <section className={`codexWork ${running ? 'running' : ''} ${failed ? 'failed' : ''}`} data-item={item.id}>
    <div className="codexWorkHeading"><span className="codexDot" /><strong>{label}</strong>{caption && <button className="codexCommand" title={caption} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{caption.split('\n')[0]}{caption.includes('\n') ? ' …' : ''}</button>}{failed && item.exitCode != null && <small>exit {item.exitCode}</small>}{expanded && collapse}</div>
    <div className="codexWorkBody">
      {exploring && actions.map((a: any, index: number) => <div className="codexAction" key={index}><span>{a.type === 'read' ? 'Read' : a.type === 'search' ? 'Search' : 'List files'}</span><span>{a.name || [a.query, a.path].filter(Boolean).join(' ') || a.command}</span></div>)}
      {expanded && caption && <pre>{caption}</pre>}
      {expanded && item.arguments!=null && <pre>{JSON.stringify(item.arguments,null,2)}</pre>}
      {(item.changes || []).map((change: any) => <div key={change.path}><div className="codexFile">{change.path}</div>{expanded && change.diff && <pre>{change.diff}</pre>}</div>)}
      {full && (!exploring || expanded) && <pre className={expanded ? '' : 'codexOutputPreview'}>{expanded ? full : lines.slice(-3).join('\n')}</pre>}
      {running && !full && !exploring && ['commandExecution','mcpToolCall','dynamicToolCall'].includes(item.type) && <small>Waiting for output…</small>}
      {(expanded || hidden > 0 || exploring || item.changes?.length > 0 || item.arguments!=null) && collapse}
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
export function CodexChat({ session, onSessionChange, onSessionFork, onBack, sessionDetails }: {
  session: Session;
  onSessionChange: (session: OrbitSession) => void;
  onSessionFork: (session: OrbitSession, open: boolean) => void;
  onBack: () => void;
  sessionDetails: React.ReactNode;
}) {
  const state = useRef(newChatState()), socket = useRef<WebSocket | null>(null), counter = useRef(0);
  const pending = useRef(new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; since: number; op: string; older: boolean; timer: number }>());
  const [version, setVersion] = useState(0), [epoch, setEpoch] = useState(0), [connection, setConnection] = useState('connecting');
  const [draft, setDraftValue] = useState(''), [historyBusy, setHistoryBusy] = useState(false), [error, setError] = useState('');
  const inputHistory = useRef<{ entries: string[]; index: number; draft: string } | null>(null);
  function setDraft(value: React.SetStateAction<string>) {
    inputHistory.current = null;
    setDraftValue(value);
  }
  const [forkingTurn, setForkingTurn] = useState<string | null>(null);
  const [commands, setCommands] = useState<ConversationCommand[]>([]), [commandResult, setCommandResult] = useState<any>(null), [commandBusy, setCommandBusy] = useState(false), [selectedCommand, setSelectedCommand] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null), commandView = useRef(0);
  function closeControls() { commandView.current++;setCommandResult(null); }
  const reservedImages=useRef(new Set<string>()),inFlight=useRef(0);
  const submissionKey=`orbit.submissions.${session.key}:${session.codex_thread_id||''}`;
  type Submission={id:string;text:string;images:{id:string;path:string;name:string}[];status:'sending'|'failed';error?:string};
  const [submissions,setSubmissions]=useState<Submission[]>(()=>{try{return JSON.parse(sessionStorage.getItem(submissionKey)||'[]').filter((entry:any)=>typeof entry.text==='string').map((entry:any)=>({...entry,status:'failed',error:'전송 여부를 대화 이력에서 확인한 뒤 복원하세요.'}));}catch{return [];}});
  const submissionsRef=useRef(submissions);
  function changeSubmissions(update:(items:Submission[])=>Submission[]){const next=update(submissionsRef.current);submissionsRef.current=next;setSubmissions(next);try{if(next.length)sessionStorage.setItem(submissionKey,JSON.stringify(next));else sessionStorage.removeItem(submissionKey);}catch{}}
  const images = useImages(session, !!state.current.capabilities.images && session.status === 'running' && connection === 'ready', setError);
  const availableImages=images.items.filter(item=>!reservedImages.current.has(item.key));
  const hasUnsentInput = useRef(false);
  hasUnsentInput.current = !!draft || availableImages.length > 0;
  const [dragging,setDragging] = useState(false); const dragDepth=useRef(0);
  const [locationOpen,setLocationOpen] = useState(false), [background,setBackground] = useState<any[]>([]);
  useEffect(()=>{
    if(connection!=='ready'||!state.current.capabilities.commands)return;
    let disposed=false,busy=false;
    const poll=async()=>{if(busy)return;busy=true;try{const result=await request({op:'command',command:'/ps'});if(!disposed)setBackground(Array.isArray(result.data)?result.data:[]);}catch{}finally{busy=false;}};
    void poll();const timer=state.current.active||background.length?window.setInterval(()=>void poll(),5000):undefined;return()=>{disposed=true;clearInterval(timer);};
  },[connection,state.current.active,background.length>0,session.key]);
  useLayoutEffect(() => {
    const input = promptRef.current;
    const composer = input?.form;
    if (!input || !composer) return;
    const actions = composer.querySelector('.codexComposerActions');
    const fit = () => {
      const scrollTop = input.scrollTop;
      // Measure in the compact layout so a wrapped draft stays expanded even
      // when the full-width text area fits it on fewer lines.
      composer.classList.remove('multiline');
      input.style.overflowY = 'hidden';
      input.style.height = '0px';
      const style = getComputedStyle(input);
      const singleLineHeight = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      if (input.value && (input.value.includes('\n') || input.scrollHeight > singleLineHeight + 1)) {
        composer.classList.add('multiline');
      }
      input.style.height = `${input.scrollHeight + 2}px`;
      if (input.scrollHeight > input.clientHeight) {
        input.style.overflowY = 'auto';
        input.scrollTop = scrollTop;
      }
    };
    fit();
    const widths = new Map<Element, number>();
    const observer = new ResizeObserver(entries => {
      const changed = entries.some(({target, contentRect}) => widths.get(target) !== contentRect.width);
      for (const {target, contentRect} of entries) widths.set(target, contentRect.width);
      if (changed) fit();
    });
    observer.observe(composer);
    if (actions) observer.observe(actions);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [draft]);
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
        if (message.session?.id === session.id) onSessionChange(message.session);
        applyLiveState(s, message.state, s.revision);
        void request({ op: 'history' }).then(() => {
          if (disposed) return;
          setConnection('ready');
          if (s.capabilities.commands) {
            void request({ op: 'command', command: '/help' })
              .then(result => { if (!disposed) setCommands(result.commands); })
              .catch(error => { if (!disposed) setError(String(error)); });
          }
        }).catch(error => {
          if (!disposed) {
            setError(String(error));
            setConnection('offline');
            ws.close();
          }
        });
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
    if (commandBusy || connection !== 'ready') return;
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
    const text=draft,attached=availableImages;
    if ((!text.trim() && !attached.length) || session.status !== 'running' || connection !== 'ready') return;
    if (!images.ready) { setError('이미지 업로드가 끝나야 보낼 수 있습니다. 실패한 첨부는 재시도하거나 해제하세요.'); return; }
    if (isCommand(text)) { await runCommand(text.trim(), {}, true); return; }
    if(submissionsRef.current.length>=20){setError('확인 중인 입력이 많습니다. 전송 결과를 확인하거나 실패한 입력을 정리하세요.');return;}
    const op=queue||queueTurn||inFlight.current>0||commandBusy||(!running&&state.current.queue.items.length)?'queue':running?'steer':'send';
    if(op==='steer'&&!state.current.capabilities.steer){setError('실행 중 입력은 orbitd 업데이트 후 사용할 수 있습니다.');return;}
    const id=`submission-${Date.now()}-${++counter.current}`;
    attached.forEach(item=>reservedImages.current.add(item.key));inFlight.current++;setError('');setDraft('');
    changeSubmissions(items=>[...items,{id,text,images:attached.map(item=>({id:item.id!,path:item.path!,name:item.name})),status:'sending'}]);
    try {
      let result;
      try {result=await request({op,text,images:attached.map(item=>item.id)});}
      catch(error){
        const message=String(error);
        if(op==='steer'&&/cannot steer a (review|compact) turn|no active turn to steer|expected active turn id|active turn uses a different output schema/.test(message))result=await request({op:'queue',text,images:attached.map(item=>item.id)});
        else throw error;
      }
      if(result.state)applyLiveState(state.current,result.state,-1);
      if(result.turn){rememberTurnStart(state.current,result.turn,true);for(const item of result.turn.items||[])if(!state.current.items.has(item.id))putItem(state.current,{...item,turnId:result.turn.id});if(result.turn.status==='inProgress'&&!state.current.completed.has(result.turn.id))state.current.active=result.turn.id;}
      changeSubmissions(items=>items.filter(item=>item.id!==id));images.remove(attached.map(item=>item.key));following.current=true;setShowLatest(false);refresh();
    } catch(error){
      changeSubmissions(items=>items.map(item=>item.id===id?{...item,status:'failed',error:String(error)}:item));
    } finally {attached.forEach(item=>reservedImages.current.delete(item.key));inFlight.current--;refresh();}
  }
  async function restoreSubmission(entry:Submission){
    if(draft.trim()){setError('입력 중인 메시지를 먼저 보내거나 비운 뒤 복원하세요.');return;}
    try{await images.restoreUploaded(entry.images||[]);setDraft(entry.text);changeSubmissions(items=>items.filter(item=>item.id!==entry.id));promptRef.current?.focus();}catch(error){setError(String(error));}
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
  async function forkTurn(turnId: string) {
    setForkingTurn(turnId);
    setError('');
    try {
      const result = await request({ op: 'fork', turnId });
      const open = !hasUnsentInput.current || window.confirm(
        'The fork is in your session list. Opening it will discard the draft in this session. Open the fork now?'
      );
      onSessionFork(result.session, open);
    } catch (error) {
      setError(String(error));
    } finally {
      setForkingTurn(null);
    }
  }
  const s = state.current, running = !!s.active;
  const forkBoundaries = new Map<string, string>();
  if (s.capabilities.fork) {
    for (const id of s.order) {
      const turnId = s.items.get(id)?.turnId;
      if (turnId && turnId !== s.active && s.forkableTurns.has(turnId)) forkBoundaries.set(turnId, id);
    }
  }
  function recallInput(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const backwards = event.key === 'ArrowUp';
    const input = event.currentTarget;
    const browsing = inputHistory.current;
    if (input.selectionStart !== input.selectionEnd) return;
    if (input.form?.classList.contains('multiline')) {
      // Keep native vertical cursor movement within a draft or a recalled message.
      const atRecallPosition = browsing && input.selectionStart === draft.length;
      if (!atRecallPosition && (!backwards || input.selectionStart !== 0)) return;
    }
    if (browsing) {
      event.preventDefault();
      const next = Math.min(browsing.entries.length - 1, browsing.index + (backwards ? 1 : -1));
      if (next < 0) setDraft(browsing.draft);
      else {
        browsing.index = next;
        setDraftValue(browsing.entries[next]);
      }
      return;
    }
    if (!backwards) return;
    const entries = [];
    for (const id of s.order) {
      const item = s.items.get(id);
      if (item?.type === 'userMessage') entries.push(itemText(item));
    }
    for (const entry of s.queue.items) {
      if (typeof entry.text === 'string') entries.push(entry.text);
    }
    const recent = entries.filter(text => text.trim()).reverse();
    if (!recent.length) return;
    event.preventDefault();
    inputHistory.current = { entries: recent, index: 0, draft };
    setDraftValue(recent[0]);
  }
  const matches = suggestions(draft, commands);
  const commandInput = isCommand(draft);
  const queueTurn=queuesDuringTurn([...s.items.values()],s.active);
  const working=specificActivity([...s.items.values()],s.approvals.size,s.active,s.activity);
  const host = (() => { try { return new URL(session.connection.url).host; } catch { return session.connection.url; } })();
  const cwd = s.settings.cwd || session.cwd;
  return <div className={`codexChat${dragging ? ' dragging' : ''}`} onDragEnter={event => { if(event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++;setDragging(true); } }} onDragOver={event => { if(event.dataTransfer.types.includes('Files')) { event.preventDefault();event.dataTransfer.dropEffect='copy'; } }} onDragLeave={event => { event.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);} }} onDrop={event => { if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth.current=0;setDragging(false);images.add(Array.from(event.dataTransfer.files)); }}>
    {dragging&&<div className="codexDropOverlay">여기에 이미지를 놓아 첨부하세요</div>}
    <div className="codexConnection">
      <button type="button" className="codexMobileBack" aria-label="세션 목록으로 돌아가기" onClick={onBack}><ChevronLeft size={22} /></button>
      <div className="codexConnectionTitle">
        <strong title={session.name}>{session.name}</strong>
        <span className="codexConnectionState" data-state={connection}>{connection === 'ready' ? session.status === 'running' ? 'Codex 연결됨' : '종료된 세션 · 이력 조회' : connection === 'connecting' ? '연결 중…' : '연결 끊김'}</span>
      </div>
      {connection === 'offline' && <button type="button" className="codexReconnect" onClick={() => setEpoch(v => v + 1)}>다시 연결</button>}
      <button type="button" className="codexMobileCommands" aria-label="대화 명령 열기" disabled={connection !== 'ready' || commandBusy || !s.capabilities.commands} onClick={() => void runCommand('/help')}><SlidersHorizontal size={19} /></button>
      <button type="button" className="codexRefresh" aria-label="대화 새로고침" title="대화 새로고침" disabled={connection === 'connecting'} onClick={() => setEpoch(v => v + 1)}><RefreshCcw size={19} /></button>
    </div>
    <button type="button" className="codexLocationToggle" aria-expanded={locationOpen} aria-controls="codex-execution-location" onClick={()=>setLocationOpen(!locationOpen)}><Server size={13}/><strong>{session.connection.label || host}</strong><span>{cwd?.split('/').filter(Boolean).at(-1) || '/'}</span><ChevronDown size={14}/></button>
    <div id="codex-execution-location" className={`codexSessionContext${locationOpen ? ' expanded' : ''}`} aria-label="현재 세션 실행 위치">
      <span className="codexMode">Web</span><strong title={session.connection.url}>{session.connection.label || host}</strong><span className="codexHost" title={host}>{host}</span><span className="codexCwd" title={cwd}>{cwd}</span>
      <div className="codexSessionDetails">{sessionDetails}</div>
    </div>
    <div className="codexMessages" ref={scroller} onScroll={() => { const n = scroller.current!; following.current = n.scrollHeight - n.scrollTop - n.clientHeight < 60; setShowLatest(!following.current); }}>
      {s.nextCursor && <button disabled={historyBusy} className="codexOlder" onClick={() => void older()}>Load earlier messages</button>}
      {!s.order.length && connection === 'ready' && <div className="codexEmpty"><span className="codexEmptyMark">✳</span><h2>어떤 작업을 시작할까요?</h2></div>}
      {s.order.map(id => {
        const item = s.items.get(id)!;
        const message = ['userMessage', 'agentMessage', 'system'].includes(item.type);
        const canFork = forkBoundaries.get(item.turnId) === id;
        return <React.Fragment key={id}>
          {message ? <article className={`codexMessage ${item.type}`}><MessageImages content={item.content || []} session={session} /><Markdown text={itemText(item)} />{item.type==='agentMessage'&&item.questions?.length>0&&<div className="codexAsyncQuestions">{item.questions.map((question:any,index:number)=><section key={index}><strong>{question.title}</strong>{question.options?.map((option:string)=><button type="button" key={option} onClick={()=>{setDraft(value=>[value,`${question.title}: ${option}`].filter(Boolean).join('\n'));promptRef.current?.focus();}}>{option}</button>)}</section>)}</div>}</article> : <WorkLog item={item} />}
          {canFork && <div className="codexTurnActions">
            <button type="button" disabled={connection !== 'ready' || forkingTurn !== null} onClick={() => void forkTurn(item.turnId)}>
              <GitFork size={14} />{forkingTurn === item.turnId ? 'Forking…' : 'Fork here'}
            </button>
          </div>}
        </React.Fragment>;
      })}

    </div>
    <div className="codexComposerArea">
      {running && <CodexWorking key={s.active!} sessionKey={session.key} turnId={s.active!} startedAt={s.turnStarts.get(s.active!) || null} activity={working} disabled={connection !== 'ready'} interrupt={()=>void request({op:'interrupt'}).catch(e=>setError(String(e)))}/>}
      {background.length>0&&<button type="button" className="codexBackground" onClick={()=>void runCommand('/ps')}>View {background.length} background {background.length === 1 ? 'terminal' : 'terminals'}</button>}
      {submissions.length>0&&<section className="codexSubmissions" aria-label="전송 중인 입력">{submissions.map(entry=><div className={entry.status} key={entry.id}><header><strong>{entry.status==='sending'?'전송 확인 중':'전송 확인 실패'}</strong>{entry.status==='failed'&&<><button type="button" onClick={()=>void restoreSubmission(entry)}>입력으로 복원</button><button type="button" aria-label="입력 기록 닫기" onClick={()=>changeSubmissions(items=>items.filter(item=>item.id!==entry.id))}>×</button></>}</header><p>{entry.text}{entry.images?.length?` · 이미지 ${entry.images.length}개`:''}</p>{entry.error&&<small>{entry.error}</small>}</div>)}</section>}
      {queueTurn&&<div className="codexInputHint">리뷰·문맥 압축 중인 입력은 다음 턴에 전달합니다.</div>}
      {showLatest && <button className="codexLatest" onClick={() => { following.current = true; setShowLatest(false); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }}>↓ Jump to latest</button>}
      {s.queue.items.length > 0 && <section className="codexQueue" aria-label="대기 메시지"><header><strong>대기 메시지 {s.queue.items.length}개{s.queue.paused ? ' · 일시 중지' : ''}</strong>{s.queue.paused && <button disabled={commandBusy || connection !== 'ready' || session.status !== 'running'} onClick={() => void queueAction('queue/resume')}>대기열 다시 시작</button>}</header>{s.queue.error && <p>{s.queue.error}</p>}<ol>{s.queue.items.map(entry => <li key={entry.id}><span title={entry.text}>{entry.images?.length ? `이미지 ${entry.images.length}개 · ` : ''}{entry.text || '이미지 첨부'}</span><button disabled={commandBusy || connection !== 'ready' || session.status !== 'running'} onClick={() => void queueAction('queue/remove', entry.id)}>취소</button></li>)}</ol></section>}
      {[...s.approvals.values()].map(r => <Approval key={JSON.stringify(r.id)} request={r} item={s.items.get(r.params.itemId)} reply={request} />)}
      {error && <div className="codexError" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}
      {matches.length > 0 && <div id="codex-command-list" className="codexSuggestions" role="listbox" aria-label="대화 명령">{matches.map((command, index) => <button type="button" key={command.name} role="option" aria-selected={index === selectedCommand % matches.length} aria-disabled={running && !command.duringTask} onMouseDown={e => e.preventDefault()} onClick={() => { setDraft(`/${command.name}${command.usage ? ' ' : ''}`); promptRef.current?.focus(); }}><strong>/{command.name}</strong><span>{command.description}</span>{running && !command.duringTask && <small>작업 후</small>}</button>)}</div>}
      <ImageDrafts items={availableImages} remove={images.remove} retry={images.retry} report={setError} />
      <form className="codexComposer" onSubmit={event => { event.preventDefault(); if (commandInput) void runCommand(draft.trim(), {}, true); else void sendText(); }}>
        <ImagePicker enabled={!!s.capabilities.images && connection === 'ready' && session.status === 'running'} add={images.add} />
        <textarea rows={1} enterKeyHint="enter" ref={promptRef} aria-label="Codex 메시지" aria-expanded={matches.length > 0} aria-controls="codex-command-list" placeholder={running ? '추가 지시…' : '메시지 입력…'} value={draft} maxLength={100000} onPaste={event => { const files=Array.from(event.clipboardData.files);if(!files.length)return;event.preventDefault();images.add(files);const text=event.clipboardData.getData('text/plain');if(text){const node=event.currentTarget,start=node.selectionStart,end=node.selectionEnd;setDraft(draft.slice(0,start)+text+draft.slice(end));} }} onChange={e => { setDraft(e.target.value); setSelectedCommand(0); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (matches.length) {
              event.preventDefault();
              setSelectedCommand(index => (index + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
            } else recallInput(event);
            return;
          }
          if (event.key === 'Tab' && !event.shiftKey) {
            if (matches.length) { event.preventDefault(); setDraft(`/${matches[selectedCommand % matches.length].name} `); return; }
            if (running && (draft.trim() || availableImages.length) && !commandInput && s.capabilities.queue) { event.preventDefault(); void sendText(true); return; }
          }
          if (event.key === 'Enter') {
            // A touch device can report a mouse as its primary pointer, including in desktop mode.
            const desktopKeyboard = navigator.maxTouchPoints === 0 && window.matchMedia('(pointer: fine) and (hover: hover)').matches;
            if (event.shiftKey || !desktopKeyboard) return;
            event.preventDefault();
            if (matches.length && !matches.some(command => `/${command.name}` === draft)) { void runCommand(`/${matches[selectedCommand % matches.length].name}`, {}, true); return; }
            event.currentTarget.form?.requestSubmit();
          }
          if (event.key === 'Escape') { event.preventDefault();if (commandResult) closeControls();else if(running)void request({op:'interrupt'}).catch(e=>setError(String(e)));else event.currentTarget.blur(); }
        }} />
        <div className="codexComposerActions">
          <button type="button" className="codexIconButton codexSlashButton" title="명령 선택" aria-label="명령 선택" disabled={!s.capabilities.commands} onClick={() => { setDraft('/'); promptRef.current?.focus(); }}><Slash size={19} /></button>
          <span className="codexComposerSpacer" />
          {running && <button type="button" className="codexIconButton codexStopButton" title="Interrupt" aria-label="Interrupt" disabled={connection !== 'ready'} onClick={() => { void request({ op: 'interrupt' }).catch(e => setError(String(e))); }}><Square size={16} fill="currentColor" /></button>}
          {s.capabilities.queue && running && !commandInput && <button type="button" className="codexQueueButton" title="다음 턴 예약 · Tab" aria-label="다음 턴 예약" disabled={(!draft.trim() && !availableImages.length) || !images.ready || session.status !== 'running' || connection !== 'ready'} onClick={() => void sendText(true)}><ListPlus size={18} /><span className="codexQueueLabelFull">다음 턴</span><span className="codexQueueLabelMobile">예약</span></button>}
          <button className="codexSend" aria-label={commandInput ? '명령 실행' : queueTurn ? '다음 턴 예약' : running ? '지금 반영 ↑' : '전송 ↑'} title={commandInput ? '명령 실행' : queueTurn ? '다음 턴 예약' : running ? '지금 반영' : '전송'} disabled={(!commandInput && session.status !== 'running') || (commandInput && commandBusy) || connection !== 'ready' || (!draft.trim() && !availableImages.length) || !images.ready}><ArrowUp size={23} /></button>
        </div>
      </form>
      <div className="codexComposerMeta"><button type="button" disabled={!s.capabilities.commands || commandBusy || connection !== 'ready'} onClick={() => void runCommand('/model')} title="모델 및 추론 강도">{s.settings.model || 'Codex'}{s.settings.effort ? ` · ${s.settings.effort}` : ''}{['fast','priority'].includes(s.settings.serviceTier) ? ' · Fast' : ''}</button>{s.settings.sandboxPolicy?.type === 'dangerFullAccess' && s.settings.approvalPolicy === 'never' && <span className="codexYolo" title="전체 접근 · 승인 안 함">YOLO</span>}<small>Enter {commandInput ? '명령 실행' : queueTurn ? '다음 턴 예약' : running ? '지금 반영' : '전송'} · Shift+Enter 줄바꿈{s.capabilities.queue && running ? ' · Tab 예약' : ''}</small>
        <details className="codexDesktopDetails sessionDetailsDisclosure" onKeyDown={event => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}>
          <summary aria-label="Session details" title="Session details"><Info size={16} /></summary>
          <div className="sessionDetailsPopup">
            <p>{session.connection.label || host} · <code>{cwd}</code></p>
            {sessionDetails}
          </div>
        </details>
      </div>
      {commandResult && <CodexControls result={commandResult} busy={commandBusy} running={running} readOnly={session.status !== 'running'} run={runCommand} close={closeControls} insert={text => { setDraft(text); closeControls(); promptRef.current?.focus(); }} />}

    </div>
  </div>;
}
