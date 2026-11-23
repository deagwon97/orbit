import React, { useEffect, useState } from 'react';

import { ModalBackdrop } from './dialog-dismiss';
import { CodexStatus, QuotaPanels } from './CodexStatus';

type Props = { result: any; busy: boolean; running: boolean; readOnly: boolean; run: (command: string, extra?: any) => Promise<void>; close: () => void; insert: (text: string) => void };
const pretty = (value: any) => value == null ? '제공되지 않음' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
function Fields({ rows }: { rows: [string, any][] }) {
  return <dl className="codexFields">{rows.map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{pretty(value)}</dd></React.Fragment>)}</dl>;
}
function ModelPicker({ result, busy, readOnly, run }: Pick<Props, 'result' | 'busy' | 'readOnly' | 'run'>) {
  const current = result.state.settings || {}, [model, setModel] = useState(current.model || ''), [effort, setEffort] = useState(current.effort || '');
  useEffect(() => { setModel(current.model || ''); setEffort(current.effort || ''); }, [result]);
  const selected = (result.models || []).find((m: any) => m.model === model);
  const efforts = selected?.supportedReasoningEfforts || [];
  return <form onSubmit={e => { e.preventDefault(); void run(`/model ${model}${effort ? ' ' + effort : ''}`); }}>
    <label>모델<select aria-label="모델 선택" value={model} disabled={busy || readOnly} onChange={e => { const next = result.models.find((m: any) => m.model === e.target.value); setModel(e.target.value); setEffort(next.defaultReasoningEffort || ''); }}>{result.models.map((m: any) => <option key={m.id} value={m.model}>{m.displayName || m.model}</option>)}</select></label>
    {selected?.description && <p>{selected.description}</p>}
    <label>추론 강도<select aria-label="추론 강도 선택" value={effort} disabled={busy || readOnly} onChange={e => setEffort(e.target.value)}><option value="">모델 기본값</option>{efforts.map((entry: any) => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{entry.reasoningEffort} · {entry.description}</option>)}</select></label>
    <button disabled={busy || readOnly || !model}>적용</button>
  </form>;
}
function ResumePicker({result,busy,running,run}: Pick<Props,'result'|'busy'|'running'|'run'>) {
  const [search,setSearch]=useState(result.search || ''),[all,setAll]=useState(!!result.allWorkspaces);
  useEffect(()=>{setSearch(result.search || '');setAll(!!result.allWorkspaces);},[result.search,result.allWorkspaces]);
  return <><p>현재 Orb 세션에서 선택한 대화로 전환합니다. 저장된 작업 폴더와 설정을 이어받습니다.</p>
    {running && <p className="codexControlsNotice">현재 작업을 마치거나 중단하고 대기 메시지를 정리한 뒤 전환하세요.</p>}
    <form className="codexResumeSearch" onSubmit={event=>{event.preventDefault();void run(`/resume${search.trim() ? ' '+search.trim() : ''}`,{allWorkspaces:all});}}><input aria-label="이전 대화 검색" placeholder="대화 이름 검색 또는 대화 ID" maxLength={200} value={search} onChange={e=>setSearch(e.target.value)}/><button disabled={busy}>검색</button><label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>모든 작업 폴더</label></form>
    <div className="codexResumeList">{(result.data || []).map((thread:any)=><button type="button" key={thread.id} disabled={busy || running || thread.id===result.currentThreadId || thread.status?.type==='active'} onClick={()=>void run(`/resume ${thread.id}`)}><strong>{thread.name || thread.preview?.split('\n')[0] || '이름 없는 대화'}</strong><span>{thread.cwd}</span><small>{thread.id} · {thread.updatedAt ? new Date(thread.updatedAt*1000).toLocaleString() : ''}{thread.id===result.currentThreadId ? ' · 현재 대화' : thread.status?.type==='active' ? ' · 작업 중' : ''}</small></button>)}</div>
    {!result.data?.length && <p>일치하는 대화가 없습니다. 검색어나 작업 폴더 범위를 변경하세요.</p>}
    {result.nextCursor && <button disabled={busy} onClick={()=>void run(`/resume${result.search ? ' '+result.search : ''}`,{cursor:result.nextCursor,allWorkspaces:result.allWorkspaces})}>이전 대화 더 보기</button>}
  </>;
}
function RenamePicker({ result, busy, readOnly, run }: Pick<Props, 'result' | 'busy' | 'readOnly' | 'run'>) {
  const [name, setName] = useState(result.suggestion ?? result.currentName ?? '');
  const nextName = name.trim();
  const tooLong = new TextEncoder().encode(nextName).length > 200;
  return <form onSubmit={event => {
    event.preventDefault();
    if (!busy && !readOnly && nextName && !tooLong) void run(`/rename ${nextName}`);
  }}>
    {result.currentName && <Fields rows={ [['현재 이름', result.currentName]] } />}
    <label>{result.suggestion ? '추천 이름' : '새 이름'}
      <input value={name} maxLength={200} onChange={event => setName(event.target.value)} />
    </label>
    {tooLong && <p role="status">이름을 200바이트 이내로 줄이세요.</p>}
    <button disabled={busy || readOnly || !nextName || tooLong}>이름 적용</button>
  </form>;
}
export function CodexControls(props: Props) {
  const { result, busy, running, readOnly, run } = props;
  const [confirmFull, setConfirmFull] = useState(false);
  const state = result.state || {}, settings = state.settings || {};
  const titles: Record<string, string> = { resume: '이전 대화 이어가기', status: '세션 상태', model: '모델 및 추론 강도', permissions: '작업 권한', fast: 'Fast 모드', usage: '계정 사용량', plan: 'Plan 모드', help: '대화 명령', skills: '스킬', mcp: 'MCP 서버', ps: '백그라운드 터미널', rename: '대화 이름', pwd: '작업 폴더' };
  return <ModalBackdrop className="codexControlsBackdrop" close={props.close} locked={busy} label={titles[result.type] || '명령 결과'}>
    <section className={`codexControls${result.type === 'status' ? ' codexStatusDialog' : ''}`}>
    <header><strong>/{result.type} · {titles[result.type] || '명령 결과'}</strong><button type="button" autoFocus aria-label="명령 창 닫기" onClick={props.close}>×</button></header>
    {running && ['model', 'permissions', 'fast'].includes(result.type) && <p className="codexControlsNotice">현재 작업은 계속 진행하며 변경 사항은 이후 턴에 적용됩니다.</p>}
    {result.type === 'resume' && <ResumePicker {...props} />}
    {result.type === 'status' && <CodexStatus result={result}/>}
    {result.type === 'model' && <ModelPicker {...props} />}
    {result.type === 'permissions' && <><Fields rows={ [['현재 권한', settings.sandboxPolicy?.type], ['승인 정책', settings.approvalPolicy]] } />
      <div className="codexControlChoices"><button disabled={busy || readOnly} onClick={() => void run('/permissions read-only')}>읽기 전용</button><button disabled={busy || readOnly} onClick={() => void run('/permissions workspace-write')}>작업 폴더 수정</button></div>
      <label className="codexFullConfirm"><input type="checkbox" checked={confirmFull} onChange={e => setConfirmFull(e.target.checked)} />작업 폴더 밖의 파일과 네트워크에도 승인 없이 접근할 수 있음을 확인했습니다.</label><button disabled={busy || readOnly || !confirmFull} onClick={() => { setConfirmFull(false); void run('/permissions full-access', { confirmFullAccess: true }); }}>전체 접근 적용</button></>}
    {result.type === 'fast' && <><Fields rows={ [['현재 속도', settings.serviceTier || 'default'], ['모델 지원', result.supported ? '지원함' : '지원하지 않음']] } /><p>Fast는 추론 강도와 별개이며 사용량이 더 많이 차감될 수 있습니다.</p><div className="codexControlChoices"><button disabled={busy || readOnly || !result.supported} onClick={() => void run('/fast on')}>Fast 켜기</button><button disabled={busy || readOnly} onClick={() => void run('/fast off')}>Standard 사용</button></div></>}
    {result.type === 'plan' && <><Fields rows={ [['현재 모드', settings.collaborationMode?.mode || '기본']] } /><div className="codexControlChoices"><button disabled={busy || readOnly || running} onClick={() => void run('/plan on')}>Plan 모드</button><button disabled={busy || readOnly || running} onClick={() => void run('/plan off')}>기본 모드</button></div></>}
    {result.type === 'usage' && <QuotaPanels usage={result}/>}
    {result.type === 'help' && <><p>넓은 화면에서 Enter는 전송, 좁은 화면에서는 줄바꿈입니다. Ctrl+Enter는 항상 전송하고 Shift+Enter는 줄바꿈합니다. Tab은 다음 턴에 예약하거나 명령 이름을 자동완성합니다.</p><div className="codexCommandList">{result.commands.map((command: any) => <button key={command.name} disabled={busy || (running && !command.duringTask)} onClick={() => props.insert(`/${command.name}${command.usage ? ' ' : ''}`)}><strong>/{command.name}</strong><span>{command.description}</span>{running && !command.duringTask && <small>작업 후 실행</small>}</button>)}</div></>}
    {result.type === 'skills' && (result.data || []).map((entry: any, i: number) => <section key={i}><h4>{entry.cwd}</h4>{(entry.skills || []).map((skill: any) => <button className="codexSkill" key={skill.path} onClick={() => props.insert(`$${skill.name} `)}><strong>{skill.name}</strong><span>{skill.description || skill.shortDescription}</span></button>)}{entry.errors?.length > 0 && <pre>{JSON.stringify(entry.errors, null, 2)}</pre>}</section>)}
    {result.type === 'mcp' && <>{(result.data || []).map((server: any) => <section key={server.name}><h4>{server.name}</h4><Fields rows={ [['인증', server.authStatus], ['도구', Object.keys(server.tools || {}).join(', ') || '없음']] } /></section>)}{!result.data?.length && <p>연결된 MCP 서버가 없습니다.</p>}{result.nextCursor && <p>서버 목록 일부를 표시했습니다.</p>}</>}
    {result.type === 'ps' && <pre>{JSON.stringify(result.data, null, 2)}</pre>}
    {result.type === 'pwd' && <p className="codexPath">{result.cwd}</p>}
    {result.type === 'rename' && (result.name
      ? <p role="status">대화 이름을 “{result.name}”으로 변경했습니다.</p>
      : <RenamePicker {...props} />)}
    {result.message && <p role="status">{result.message}</p>}
    {busy && <p role="status">명령 처리 중…</p>}
  </section></ModalBackdrop>;
}
