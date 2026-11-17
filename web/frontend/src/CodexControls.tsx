import React, { useEffect, useState } from 'react';

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
export function CodexControls(props: Props) {
  const { result, busy, running, readOnly, run } = props;
  const [confirmFull, setConfirmFull] = useState(false);
  const state = result.state || {}, settings = state.settings || {};
  const titles: Record<string, string> = { status: '세션 상태', model: '모델 및 추론 강도', permissions: '작업 권한', fast: 'Fast 모드', usage: '계정 사용량', plan: 'Plan 모드', help: '대화 명령', skills: '스킬', mcp: 'MCP 서버', ps: '백그라운드 터미널', rename: '대화 이름', pwd: '작업 폴더' };
  return <div className="codexControlsBackdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) props.close(); }}><section className="codexControls" role="dialog" onKeyDown={event => { if (event.key === 'Escape' && !busy) props.close(); }} aria-modal="true" aria-label={titles[result.type] || '명령 결과'}>
    <header><strong>/{result.type} · {titles[result.type] || '명령 결과'}</strong><button type="button" autoFocus aria-label="명령 창 닫기" onClick={props.close}>×</button></header>
    {running && ['model', 'permissions', 'fast'].includes(result.type) && <p className="codexControlsNotice">현재 작업은 계속 진행하며 변경 사항은 이후 턴에 적용됩니다.</p>}
    {result.type === 'status' && <><Fields rows={[
      ['모델', settings.model], ['공급자', settings.modelProvider], ['추론 강도', settings.effort], ['속도', settings.serviceTier || 'default'],
      ['권한', settings.sandboxPolicy?.type], ['승인 정책', settings.approvalPolicy], ['대화 모드', settings.collaborationMode?.mode], ['작업 폴더', settings.cwd], ['Codex thread', result.threadId], ['실행 상태', state.activeTurn ? '작업 중' : '대기 중'], ['대기 메시지', state.queue?.items?.length || 0]
    ]} /><h4>토큰 사용량</h4>{state.tokenUsage ? <Fields rows={Object.entries(state.tokenUsage.total || {}).map(([key, value]) => [key, value])} /> : <p>아직 토큰 사용량을 받지 못했습니다.</p>}</>}
    {result.type === 'model' && <ModelPicker {...props} />}
    {result.type === 'permissions' && <><Fields rows={ [['현재 권한', settings.sandboxPolicy?.type], ['승인 정책', settings.approvalPolicy]] } />
      <div className="codexControlChoices"><button disabled={busy || readOnly} onClick={() => void run('/permissions read-only')}>읽기 전용</button><button disabled={busy || readOnly} onClick={() => void run('/permissions workspace-write')}>작업 폴더 수정</button></div>
      <label className="codexFullConfirm"><input type="checkbox" checked={confirmFull} onChange={e => setConfirmFull(e.target.checked)} />작업 폴더 밖의 파일과 네트워크에도 승인 없이 접근할 수 있음을 확인했습니다.</label><button disabled={busy || readOnly || !confirmFull} onClick={() => { setConfirmFull(false); void run('/permissions full-access', { confirmFullAccess: true }); }}>전체 접근 적용</button></>}
    {result.type === 'fast' && <><Fields rows={ [['현재 속도', settings.serviceTier || 'default'], ['모델 지원', result.supported ? '지원함' : '지원하지 않음']] } /><p>Fast는 추론 강도와 별개이며 사용량이 더 많이 차감될 수 있습니다.</p><div className="codexControlChoices"><button disabled={busy || readOnly || !result.supported} onClick={() => void run('/fast on')}>Fast 켜기</button><button disabled={busy || readOnly} onClick={() => void run('/fast off')}>Standard 사용</button></div></>}
    {result.type === 'plan' && <><Fields rows={ [['현재 모드', settings.collaborationMode?.mode || '기본']] } /><div className="codexControlChoices"><button disabled={busy || readOnly || running} onClick={() => void run('/plan on')}>Plan 모드</button><button disabled={busy || readOnly || running} onClick={() => void run('/plan off')}>기본 모드</button></div></>}
    {result.type === 'usage' && Object.entries(result.rateLimitsByLimitId || { codex: result.rateLimits }).map(([name, value]: [string, any]) => <section key={name}><h4>{value?.limitName || name}</h4>{value ? <>{['primary', 'secondary'].map(key => { const window = value[key]; return window && <div className="codexQuota" key={key}><span>{key === 'primary' ? '단기 한도' : '장기 한도'} · {Math.max(0, 100 - window.usedPercent).toFixed(0)}% 남음</span><meter min="0" max="100" value={Math.max(0, 100 - window.usedPercent)} />{window.resetsAt && <small>갱신: {new Date(window.resetsAt * 1000).toLocaleString()}</small>}</div>; })}{value.credits && <Fields rows={ [['크레딧', value.credits.unlimited ? '무제한' : value.credits.balance]] } />}</> : <p>사용량 정보를 제공받지 못했습니다.</p>}</section>)}
    {result.type === 'help' && <><p>Enter는 입력 또는 실행 중 즉시 반영, Tab은 다음 턴 예약입니다. 명령 이름에서 Tab을 누르면 자동완성합니다.</p><div className="codexCommandList">{result.commands.map((command: any) => <button key={command.name} disabled={busy || (running && !command.duringTask)} onClick={() => props.insert(`/${command.name}${command.usage ? ' ' : ''}`)}><strong>/{command.name}</strong><span>{command.description}</span>{running && !command.duringTask && <small>작업 후 실행</small>}</button>)}</div></>}
    {result.type === 'skills' && (result.data || []).map((entry: any, i: number) => <section key={i}><h4>{entry.cwd}</h4>{(entry.skills || []).map((skill: any) => <button className="codexSkill" key={skill.path} onClick={() => props.insert(`$${skill.name} `)}><strong>{skill.name}</strong><span>{skill.description || skill.shortDescription}</span></button>)}{entry.errors?.length > 0 && <pre>{JSON.stringify(entry.errors, null, 2)}</pre>}</section>)}
    {result.type === 'mcp' && <>{(result.data || []).map((server: any) => <section key={server.name}><h4>{server.name}</h4><Fields rows={ [['인증', server.authStatus], ['도구', Object.keys(server.tools || {}).join(', ') || '없음']] } /></section>)}{!result.data?.length && <p>연결된 MCP 서버가 없습니다.</p>}{result.nextCursor && <p>서버 목록 일부를 표시했습니다.</p>}</>}
    {result.type === 'ps' && <pre>{JSON.stringify(result.data, null, 2)}</pre>}
    {result.type === 'pwd' && <p className="codexPath">{result.cwd}</p>}
    {result.type === 'rename' && <p>대화 이름을 “{result.name}”으로 변경했습니다.</p>}
    {result.message && <p role="status">{result.message}</p>}
    {busy && <p role="status">명령 처리 중…</p>}
  </section></div>;
}
