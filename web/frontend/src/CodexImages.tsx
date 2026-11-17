import React, { useEffect, useRef, useState } from 'react';
import { Copy, ImagePlus, Plus, RotateCcw, X } from 'lucide-react';
export type ImageSession = { id: string; connection: { url: string; token: string } };
export type ImageDraft = { key: string; name: string; preview: string; file: File; status: 'uploading' | 'ready' | 'error'; id?: string; path?: string; error?: string };
const MIME = new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function imageHeaders(session: ImageSession) { return { Authorization: `Bearer ${session.connection.token}`, 'x-orbitd-url': session.connection.url }; }
export function useImages(session: ImageSession, enabled: boolean, report: (text: string) => void) {
  const [items,setItems] = useState<ImageDraft[]>([]);
  const current = useRef<ImageDraft[]>([]), controllers = useRef(new Map<string,AbortController>()), alive = useRef(true);
  const update = (change: (items: ImageDraft[]) => ImageDraft[]) => { current.current=change(current.current); if(alive.current) setItems(current.current); };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controllers.current.forEach(c=>c.abort());current.current.forEach(i=>URL.revokeObjectURL(i.preview));};},[]);
  async function upload(item: ImageDraft) {
    const controller=new AbortController();controllers.current.set(item.key,controller);
    update(items=>items.map(i=>i.key===item.key?{...i,status:'uploading',error:undefined}:i));
    try {
      const response=await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/images`,{method:'POST',headers:{...imageHeaders(session),'Content-Type':item.file.type},body:item.file,signal:controller.signal});
      const text=await response.text();let result: any;try{result=JSON.parse(text);}catch{throw Error(response.status===413?'이미지는 파일당 최대 10 MiB입니다.':`업로드 실패 (${response.status}). orbitd 버전을 확인하세요.`);}
      if(!response.ok)throw Error(result.error||`업로드 실패 (${response.status})`);
      if(!result.id||!result.path)throw Error('업로드 결과에 경로가 없습니다.');
      update(items=>items.map(i=>i.key===item.key?{...i,...result,status:'ready'}:i));
    }catch(error){if(!controller.signal.aborted)update(items=>items.map(i=>i.key===item.key?{...i,status:'error',error:String(error)}:i));}
    finally{controllers.current.delete(item.key);}
  }
  function add(files: File[]) {
    if(!enabled){report('이미지 첨부는 orbitd 업데이트 후 실행 중인 Codex Web 세션에서 사용할 수 있습니다.');return;}
    for(const file of files){
      if(!MIME.has(file.type)){report('PNG, JPEG, WebP, GIF 이미지만 첨부할 수 있습니다.');continue;}
      if(file.size===0||file.size>10*1024*1024){report('이미지는 파일당 최대 10 MiB입니다.');continue;}
      if(current.current.length>=8){report('이미지는 한 메시지에 최대 8개입니다.');break;}
      const item: ImageDraft={key:Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''),name:file.name||'클립보드 이미지',file,preview:URL.createObjectURL(file),status:'uploading'};
      update(items=>[...items,item]);void upload(item);
    }
  }
  function remove(keys: string[]) { const selected=new Set(keys);current.current.filter(i=>selected.has(i.key)).forEach(i=>{controllers.current.get(i.key)?.abort();URL.revokeObjectURL(i.preview);});update(items=>items.filter(i=>!selected.has(i.key))); }
  return {items,add,remove,retry:upload,busy:items.some(i=>i.status==='uploading'),ready:items.every(i=>i.status==='ready')};
}
export function ImagePicker({enabled,add}: {enabled:boolean;add:(files:File[])=>void}) {
  const input=useRef<HTMLInputElement>(null),[open,setOpen]=useState(false);
  return <div className="codexImagePicker"><input ref={input} type="file" aria-label="첨부할 이미지 선택" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e=>{add(Array.from(e.target.files||[]));e.target.value='';setOpen(false);}} />
    <button type="button" className="codexIconButton" aria-label="이미지 첨부" title={enabled?'이미지 첨부 · 드래그 또는 붙여넣기도 가능':'orbitd 업데이트 후 사용할 수 있습니다.'} aria-expanded={open} disabled={!enabled} onClick={()=>setOpen(!open)}><Plus size={22} /></button>
    {open&&<div className="codexAttachmentMenu" onKeyDown={e=>{if(e.key==='Escape')setOpen(false);}}><button type="button" onClick={()=>input.current?.click()}><ImagePlus size={18}/>이미지 선택</button><small>드래그 앤 드롭 · 클립보드 붙여넣기<br/>파일당 10 MiB · 최대 8개</small><button type="button" onClick={()=>setOpen(false)}>닫기</button></div>}
  </div>;
}
export function ImageDrafts({items,remove,retry,report}: {items:ImageDraft[];remove:(keys:string[])=>void;retry:(item:ImageDraft)=>void;report:(text:string)=>void}) {
  if(!items.length)return null;
  return <div className="codexImageDrafts" aria-label="첨부 이미지">{items.map(item=><div className={`codexImageDraft ${item.status}`} key={item.key}>
    <img src={item.preview} alt={item.name}/><div><strong>{item.name}</strong><small>{item.status==='uploading'?'실행 호스트에 업로드 중…':item.status==='error'?item.error:'첨부 준비 완료'}</small>{item.path&&<code title={item.path}>{item.path}</code>}</div>
    {item.status==='error'&&<button type="button" aria-label={`${item.name} 다시 업로드`} onClick={()=>retry(item)}><RotateCcw size={16}/></button>}
    {item.path&&<button type="button" aria-label={`${item.name} 경로 복사`} onClick={()=>{ void (async()=>{try{await navigator.clipboard.writeText(item.path!);}catch(e){report(`경로 복사 실패: ${String(e)}`);}})(); }}><Copy size={16}/></button>}
    <button type="button" aria-label={`${item.name} 첨부 해제`} onClick={()=>remove([item.key])}><X size={16}/></button>
  </div>)}</div>;
}
function HistoryImage({path,session}: {path:string;session:ImageSession}) {
  const [url,setUrl]=useState(''),[missing,setMissing]=useState(false);
  const parts=path.split('/'),id=parts.at(-1)||'',owned=parts.at(-2)===session.id&&/^[0-9a-f-]+\.(png|jpg|webp|gif)$/.test(id);
  useEffect(()=>{
    if(!owned)return;const controller=new AbortController();let objectUrl='';setUrl('');setMissing(false);
    void fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/images/${encodeURIComponent(id)}`,{headers:imageHeaders(session),signal:controller.signal}).then(async r=>{if(!r.ok)throw Error('missing');const blob=await r.blob();if(controller.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}).catch(()=>{if(!controller.signal.aborted)setMissing(true);});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[path,session.id,session.connection.url,session.connection.token]);
  return <div className="codexHistoryImage">{url&&<a href={url} target="_blank" rel="noreferrer"><img src={url} alt="첨부 이미지"/></a>}<code>{path}</code>{missing&&<small>임시 이미지가 정리되어 미리보기를 사용할 수 없습니다.</small>}</div>;
}
export function MessageImages({content,session}: {content:any[];session:ImageSession}) {
  return <>{content.filter(c=>c.type==='localImage').map((c,i)=><HistoryImage key={`${c.path}-${i}`} path={c.path} session={session}/>)}</>;
}
