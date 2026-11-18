import React, { useEffect, useState } from 'react';
export function elapsedLabel(milliseconds: number) {
  const total=Math.max(0,Math.floor(milliseconds/1000)),seconds=total%60,minutes=Math.floor(total/60)%60,hours=Math.floor(total/3600);
  return hours?`${hours}h ${minutes}m ${seconds}s`:total>=60?`${Math.floor(total/60)}m ${seconds}s`:`${seconds}s`;
}
export function CodexWorking({sessionKey,turnId,startedAt,activity,interrupt,disabled}:{sessionKey:string;turnId:string;startedAt:number|null;activity:string;interrupt:()=>void;disabled:boolean}) {
  const [clock,setClock]=useState(()=>{
    const key=`orbit.working.${sessionKey}`;let saved:any;try{saved=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    const at=startedAt || (saved?.turnId===turnId&&typeof saved.at==='number'?saved.at:Date.now());
    return {at,estimated:!startedAt};
  }),[now,setNow]=useState(Date.now);
  useEffect(()=>{if(startedAt)setClock({at:startedAt,estimated:false});},[startedAt]);
  useEffect(()=>{try{sessionStorage.setItem(`orbit.working.${sessionKey}`,JSON.stringify({turnId,at:clock.at}));}catch{}},[sessionKey,turnId,clock.at]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  return <div className="codexWorking" role="status" aria-live="off"><div className="codexWorkingLine"><span className="codexDot"/><strong>Working</strong><time title={clock.estimated?'실행 시작 시간을 받지 못해 웹에서 확인한 시점부터 표시합니다.':'현재 턴의 실행 시간'}>{clock.estimated?'연결 후 ':''}{elapsedLabel(now-clock.at)}</time><button type="button" disabled={disabled} aria-label="현재 작업 중단" title="입력창에서 Esc로 중단" onClick={interrupt}><kbd>Esc</kbd><span>중단</span></button></div><small>{activity}</small></div>;
}
