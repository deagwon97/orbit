import React from 'react';

export function limitLabel(window: any, key: string) {
  const minutes = Number(window.windowDurationMins);
  if (minutes === 10080) return 'Weekly limit';
  if (minutes > 0 && minutes < 1440) return `${Math.round(minutes / 60 * 10) / 10}h limit`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440 * 10) / 10}d limit`;
  return key === 'primary' ? '단기 한도' : '장기 한도';
}
export function QuotaPanels({ usage }: { usage: any }) {
  const map = usage?.rateLimitsByLimitId;
  const entries: [string, any][] = map && Object.keys(map).length ? Object.entries(map) : usage?.rateLimits ? [['Codex',usage.rateLimits]] : [];
  if (!entries.length) return <p className="codexStatusHint">사용 한도 정보를 가져오지 못했습니다. 잠시 후 다시 조회하세요.</p>;
  return <div className="codexQuotaGroups">{entries.map(([name,value])=><section className="codexQuotaGroup" key={name}><h4>{value?.limitName || name}</h4>{['primary','secondary'].map(key=>{
    const window=value?.[key];if(!window)return null;
    const valid=typeof window.usedPercent==='number'&&Number.isFinite(window.usedPercent),remaining=valid?Math.max(0,Math.min(100,100-window.usedPercent)):null,label=limitLabel(window,key);
    return <div className="codexLimit" key={key}><div className="codexLimitLabel"><strong>{label}</strong><span>{remaining==null?'정보 없음':`${Math.round(remaining)}% 남음`}</span></div>
      {remaining!=null&&<div className={`codexLimitTrack${remaining<=10?' low':''}`} role="meter" aria-label={`${value.limitName || name} ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={`${Math.round(remaining)}% 남음`}><span style={{width:`${remaining}%`}}/></div>}
      {typeof window.resetsAt==='number'&&<small>갱신 · {new Date(window.resetsAt*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small>}
    </div>;
  })}{!value?.primary&&!value?.secondary&&<p className="codexStatusHint">이 모델의 한도 정보가 없습니다.</p>}{value?.credits&&<small className="codexStatusHint">크레딧 · {value.credits.unlimited?'무제한':value.credits.balance ?? '정보 없음'}</small>}</section>)}</div>;
}
function SettingsRows({rows}:{rows:[string,any][]}) {
  return <dl className="codexStatusRows">{rows.map(([label,value])=><React.Fragment key={label}><dt>{label}</dt><dd>{value==null?'정보 없음':typeof value==='object'?JSON.stringify(value):String(value)}</dd></React.Fragment>)}</dl>;
}
export function CodexStatus({result}:{result:any}) {
  const state=result.state||{},settings=state.settings||{},usage=state.tokenUsage,counts=usage?.total;
  const context=usage?.modelContextWindow,last=usage?.last?.totalTokens;
  const remaining=typeof context==='number'&&context>0&&typeof last==='number'?Math.max(0,Math.min(100,100-last/context*100)):null;
  const yolo=settings.sandboxPolicy?.type==='dangerFullAccess'&&settings.approvalPolicy==='never';
  return <div className="codexStatus">
    <section className="codexStatusHero"><small>현재 모델</small><h2>{settings.model || 'Codex'}</h2><div className="codexStatusBadges">{settings.effort&&<span>{settings.effort}</span>}<span>{['fast','priority'].includes(settings.serviceTier)?'Fast':'Standard'}</span>{yolo&&<span className="yolo">YOLO</span>}<span>{state.activeTurn?'Working':'대기 중'}</span></div></section>
    <section className="codexStatusSection"><h3>사용 한도</h3>{result.usageLoading?<p className="codexStatusHint" role="status">사용 한도 불러오는 중…</p>:<QuotaPanels usage={result.usage}/>}</section>
    <section className="codexStatusSection"><h3>세션 설정</h3><SettingsRows rows={[
      ['추론 강도',settings.effort],['권한',settings.sandboxPolicy?.type],['승인 정책',settings.approvalPolicy],['작업 폴더',settings.cwd],['대기 메시지',state.queue?.items?.length||0]
    ]}/></section>
    <section className="codexStatusSection"><h3>토큰 사용량</h3>{remaining!=null&&<div className="codexLimit"><div className="codexLimitLabel"><strong>문맥 여유</strong><span>{Math.round(remaining)}% 남음</span></div><div className="codexLimitTrack" role="meter" aria-label="문맥 여유" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><span style={{width:`${remaining}%`}}/></div></div>}
      {counts?<div className="codexTokenStats">{[['입력',counts.inputTokens],['캐시 입력',counts.cachedInputTokens],['출력',counts.outputTokens],['전체',counts.totalTokens]].map(([label,count])=><div key={String(label)}><small>{label}</small><strong>{typeof count==='number'?count.toLocaleString():'—'}</strong></div>)}</div>:<p className="codexStatusHint">아직 토큰 사용량을 받지 못했습니다.</p>}
    </section>
    <details className="codexStatusDetails"><summary>세부 설정</summary><SettingsRows rows={ [['공급자',settings.modelProvider],['대화 모드',settings.collaborationMode?.mode||'기본'],['Codex thread',result.threadId]] }/></details>
  </div>;
}
