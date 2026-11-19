import React, { useEffect, useState } from 'react';
export function elapsedLabel(milliseconds: number) {
  const total=Math.max(0,Math.floor(milliseconds/1000)),seconds=total%60,minutes=Math.floor(total/60)%60,hours=Math.floor(total/3600);
  return hours?`${hours}h ${minutes}m ${seconds}s`:total>=60?`${Math.floor(total/60)}m ${seconds}s`:`${seconds}s`;
}
export function CodexWorking({sessionKey,turnId,startedAt,activity,interrupt}:{sessionKey:string;turnId:string;startedAt:number|null;activity:string;interrupt:()=>void}) {
  const [clock,setClock]=useState(()=>{
    const key=`orbit.working.${sessionKey}`;let saved:any;try{saved=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    const at=startedAt || (saved?.turnId===turnId&&typeof saved.at==='number'?saved.at:Date.now());
    return {at,estimated:!startedAt};
  }),[now,setNow]=useState(Date.now);
  useEffect(()=>{if(startedAt)setClock({at:startedAt,estimated:false});},[startedAt]);
  useEffect(()=>{try{sessionStorage.setItem(`orbit.working.${sessionKey}`,JSON.stringify({turnId,at:clock.at}));}catch{}},[sessionKey,turnId,clock.at]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  return <div className="codexWorking" role="status" aria-live="off"><div className="codexWorkingLine"><span className="codexDot"/><strong>Working</strong><time title={clock.estimated?'Estimated from when the web client first saw this turn.':'Elapsed time for this turn'}>{clock.estimated?'Since connection: ':''}{elapsedLabel(now-clock.at)}</time><button type="button" aria-label="Interrupt current task" onClick={interrupt}>Interrupt</button></div>{activity&&<small>{activity}</small>}</div>;
}
