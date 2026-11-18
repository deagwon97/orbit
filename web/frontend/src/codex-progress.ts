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
  return ({reasoning:'Reasoning summary',plan:'Plan',fileChange:running?'Editing files':'File changes',mcpToolCall:running?'Calling':'Called',dynamicToolCall:running?'Calling':'Called',functionCallOutput:'Tool result',webSearch:running?'Searching':'Searched',collabAgentToolCall:'Agent task',subAgentActivity:'Agent activity',contextCompaction:running?'Compacting context':'Context compacted',enteredReviewMode:'Review started',exitedReviewMode:'Review completed',terminalInteraction:'Terminal input',imageView:'Viewed image',imageGeneration:'Generated image',sleep:'Waiting',hook:running?'Hook running':'Hook completed',progressNotice:'Progress update'} as Record<string,string>)[item.type]||item.type;
}
export function queuesDuringTurn(items:CodexItem[],active:string|null) {
  if(!active)return false;
  const turn=items.filter(i=>i.turnId===active);
  const review=turn.filter(i=>['enteredReviewMode','exitedReviewMode'].includes(i.type)).at(-1);
  return review?.type==='enteredReviewMode'||turn.some(i=>i.type==='contextCompaction'&&i.status==='inProgress');
}
export function specificActivity(items:CodexItem[],approvals:number,active:string|null,notice:string) {
  if(approvals)return 'Waiting for approval or a response';
  if(notice)return notice;
  const review=items.filter(i=>i.turnId===active&&['enteredReviewMode','exitedReviewMode'].includes(i.type)).at(-1);
  if(review?.type==='enteredReviewMode')return 'Reviewing';
  const current=items.filter(i=>i.turnId===active&&i.status==='inProgress'&&!['userMessage','agentMessage','reasoning','enteredReviewMode','exitedReviewMode'].includes(i.type)).at(-1);
  return current?[progressLabel(current),progressCaption(current)].filter(Boolean).join(' · '):'';
}
