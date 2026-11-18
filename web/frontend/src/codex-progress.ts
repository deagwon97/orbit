import type { CodexItem } from './codex-state';
export function progressCaption(item:CodexItem) {
  if(item.type==='mcpToolCall')return [item.server,item.tool].filter(Boolean).join(' / ');
  if(['dynamicToolCall','functionCallOutput'].includes(item.type))return [item.namespace,item.tool||item.name].filter(Boolean).join('.');
  if(item.type==='webSearch')return item.query||item.action?.query||item.action?.queries?.join(', ')||item.action?.url||'';
  if(item.type==='collabAgentToolCall')return [item.tool,item.model,(item.receiverThreadIds||[]).join(', ')].filter(Boolean).join(' · ');
  if(item.type==='subAgentActivity')return [item.kind,item.agentPath||item.agentThreadId,item.model].filter(Boolean).join(' · ');
  if(item.type==='imageView')return item.path||'';
  if(item.type==='hook')return item.eventName||'';
  if(item.type==='sleep')return item.durationMs?`${Math.round(item.durationMs/1000)}s`:'';
  if(item.type==='terminalInteraction')return `process ${item.processId||''}`;
  return item.command||'';
}
export function progressLabel(item:CodexItem) {
  const running=item.status==='inProgress',failed=item.status==='failed'||item.success===false||(item.exitCode!=null&&item.exitCode!==0);
  if(item.type==='commandExecution'){
    const actions=item.commandActions||[],exploring=actions.length>0&&actions.every((a:any)=>['read','search','listFiles'].includes(a.type));
    return exploring?(running?'Exploring':'Explored'):(running?'Running':failed?'Failed':'Ran');
  }
  return ({reasoning:'추론 요약',plan:'작업 계획',fileChange:running?'파일 수정 중':'파일 변경',mcpToolCall:running?'Calling':'Called',dynamicToolCall:running?'Calling':'Called',functionCallOutput:'도구 결과',webSearch:running?'Searching':'Searched',collabAgentToolCall:'에이전트 작업',subAgentActivity:'에이전트 활동',contextCompaction:running?'Compacting context':'Context compacted',enteredReviewMode:'Review started',exitedReviewMode:'Review completed',terminalInteraction:'터미널 입력',imageView:'이미지 확인',imageGeneration:'이미지 생성',sleep:'Waiting',hook:running?'Hook running':'Hook completed',progressNotice:'진행 안내'} as Record<string,string>)[item.type]||item.type;
}
export function queuesDuringTurn(items:CodexItem[],active:string|null) {
  if(!active)return false;
  const turn=items.filter(i=>i.turnId===active);
  const review=turn.filter(i=>['enteredReviewMode','exitedReviewMode'].includes(i.type)).at(-1);
  return review?.type==='enteredReviewMode'||turn.some(i=>i.type==='contextCompaction'&&i.status==='inProgress');
}
export function specificActivity(items:CodexItem[],approvals:number,active:string|null,notice:string) {
  if(approvals)return '승인 또는 응답 대기 중';
  if(notice)return notice;
  const current=items.filter(i=>i.turnId===active&&i.status==='inProgress'&&!['userMessage','agentMessage','reasoning'].includes(i.type)).at(-1);
  return current?[progressLabel(current),progressCaption(current)].filter(Boolean).join(' · '):'';
}
