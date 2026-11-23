import React, { useEffect, useRef, useState } from 'react';
import { Copy, File as FileIcon, ImagePlus, Paperclip, Plus, RotateCcw, X } from 'lucide-react';
import { fetchWorkspaceImage } from './workspace-images';
export type ImageSession = { id: string; connection: { url: string; token: string } };
export type UploadedAttachment = { id: string; path: string; name: string; kind?: 'image' | 'file' };
type AttachmentDraft = { key: string; name: string; kind: 'image' | 'file'; preview?: string; file: File; status: 'uploading' | 'ready' | 'error'; id?: string; path?: string; error?: string };
const MIME = new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function imageHeaders(session: ImageSession) { return { Authorization: `Bearer ${session.connection.token}`, 'x-orbitd-url': session.connection.url }; }
export function useAttachments(session: ImageSession, supported: { images: boolean; files: boolean }, report: (text: string) => void) {
  const [items,setItems] = useState<AttachmentDraft[]>([]);
  const current = useRef<AttachmentDraft[]>([]), controllers = useRef(new Map<string,AbortController>()), alive = useRef(true), uploads = useRef<Promise<void>>(Promise.resolve());
  const update = (change: (items: AttachmentDraft[]) => AttachmentDraft[]) => { current.current=change(current.current); if(alive.current) setItems(current.current); };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controllers.current.forEach(c=>c.abort());current.current.forEach(i=>i.preview && URL.revokeObjectURL(i.preview));};},[]);
  function upload(item: AttachmentDraft) {
    const controller=new AbortController();controllers.current.set(item.key,controller);
    update(items=>items.map(i=>i.key===item.key?{...i,status:'uploading',error:undefined}:i));
    const job = async () => { try {
      if (controller.signal.aborted || !alive.current) return;
      const image = item.kind === 'image';
      const route = image ? 'images' : `files?name=${encodeURIComponent(item.name)}`;
      const response=await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/${route}`,{method:'POST',headers:{...imageHeaders(session),'Content-Type':image ? item.file.type : 'application/octet-stream'},body:item.file,signal:controller.signal});
      const text=await response.text();let result: any;try{result=JSON.parse(text);}catch{throw Error(response.status===413?'첨부는 파일당 최대 50 MiB입니다.':`업로드 실패 (${response.status}). orbitd 버전을 확인하세요.`);}
      if(!response.ok)throw Error(result.error||`업로드 실패 (${response.status})`);
      if(!result.id||!result.path)throw Error('업로드 결과에 경로가 없습니다.');
      update(items=>items.map(i=>i.key===item.key?{...i,...result,status:'ready'}:i));
    }catch(error){if(!controller.signal.aborted)update(items=>items.map(i=>i.key===item.key?{...i,status:'error',error:String(error)}:i));}
    finally{controllers.current.delete(item.key);}
    };
    uploads.current = uploads.current.then(job,job);
    return uploads.current;
  }
  function add(files: File[]) {
    for (const file of files) {
      const kind = MIME.has(file.type) ? 'image' : 'file';
      if (!(kind === 'image' ? supported.images : supported.files)) {
        report(kind === 'file' ? '일반 파일 첨부는 orbitd와 웹 API를 업데이트한 뒤 사용할 수 있습니다.' : '이미지 첨부는 연결된 Codex Web 세션에서 사용할 수 있습니다.');
        continue;
      }
      if ((kind === 'image' && file.size === 0) || file.size > 50*1024*1024) { report('첨부는 파일당 최대 50 MiB입니다.'); continue; }
      if (current.current.length >= 8) { report('첨부는 한 메시지에 최대 8개입니다.'); break; }
      const item: AttachmentDraft = {
        key: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,'0')).join(''),
        name: file.name || (kind === 'image' ? '클립보드 이미지' : '파일'), kind, file,
        preview: kind === 'image' ? URL.createObjectURL(file) : undefined, status: 'uploading',
      };
      update(items=>[...items,item]);void upload(item);
    }
  }
  function remove(keys: string[]) { const selected=new Set(keys);current.current.filter(i=>selected.has(i.key)).forEach(i=>{controllers.current.get(i.key)?.abort();i.preview && URL.revokeObjectURL(i.preview);});update(items=>items.filter(i=>!selected.has(i.key))); }
  async function restoreUploaded(saved: UploadedAttachment[]) {
    const missing=saved.filter(item=>!current.current.some(i=>i.id===item.id));
    if(current.current.length+missing.length>8)throw Error('현재 첨부를 정리한 뒤 다시 복원하세요.');
    for(const item of missing){
      const kind = item.kind ?? 'image';
      const route = kind === 'image' ? 'images' : 'files';
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}/${route}/${encodeURIComponent(item.id)}`, { headers: imageHeaders(session) });
      if (!response.ok) throw Error('임시 첨부를 다시 업로드해야 합니다.');
      const blob = await response.blob();
      if (!alive.current) return;
      const restored: AttachmentDraft = {
        ...item, kind, key: 'restored-' + item.id, file: new File([blob],item.name,{type:blob.type}),
        preview: kind === 'image' ? URL.createObjectURL(blob) : undefined, status: 'ready',
      };
      update(items=>[...items,restored]);
    }
  }
  return {items,add,remove,restoreUploaded,retry:upload,busy:items.some(i=>i.status==='uploading'),ready:items.every(i=>i.status==='ready')};
}
export function AttachmentPicker({ images, files, add }: { images: boolean; files: boolean; add: (files: File[]) => void }) {
  const imageInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    add(Array.from(event.target.files || []));
    event.target.value = '';
    setOpen(false);
  }
  return <div className="codexImagePicker">
    <input ref={imageInput} type="file" aria-label="첨부할 이미지 선택" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={pick} />
    <input ref={fileInput} type="file" aria-label="첨부할 파일 선택" multiple hidden onChange={pick} />
    <button type="button" className="codexIconButton" aria-label="파일 첨부" title="파일 첨부" aria-expanded={open} disabled={!images && !files} onClick={() => setOpen(!open)}><Plus size={22} /></button>
    {open && <div className="codexAttachmentMenu" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
      {images && <button type="button" onClick={() => imageInput.current?.click()}><ImagePlus size={18} />이미지 선택</button>}
      {files && <button type="button" onClick={() => fileInput.current?.click()}><Paperclip size={18} />파일 선택</button>}
      <small>드래그 앤 드롭 · 클립보드 붙여넣기<br/>파일당 50 MiB · 최대 8개</small>
      <button type="button" onClick={() => setOpen(false)}>닫기</button>
    </div>}
  </div>;
}

export function AttachmentDrafts({items,remove,retry,report}: {items:AttachmentDraft[];remove:(keys:string[])=>void;retry:(item:AttachmentDraft)=>void;report:(text:string)=>void}) {
  if(!items.length)return null;
  return <div className="codexImageDrafts" aria-label="첨부 파일">{items.map(item=><div className={`codexImageDraft ${item.status}`} key={item.key}>
    {item.preview ? <img src={item.preview} alt={item.name}/> : <FileIcon size={24} className="codexAttachmentFileIcon" aria-hidden="true" />}
    <div><strong>{item.name}</strong><small>{item.status==='uploading'?'실행 호스트에 업로드 중…':item.status==='error'?item.error:'첨부 준비 완료'}</small>{item.path&&<code title={item.path}>{item.path}</code>}</div>
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

export function WorkspaceImage({ path, label, session }: { path: string; label: string; session: ImageSession }) {
  const { url: server, token } = session.connection;
  const [result, setResult] = useState<{ path: string; url: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setResult(undefined);
    void fetchWorkspaceImage(path, server, token, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setResult({ path, url: objectUrl });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ path, url: '' });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, server, token]);

  const current = result?.path === path ? result : undefined;
  return <span className="codexWorkspaceImage">
    {current?.url
      ? <a href={current.url} download={path.split('/').at(-1) || 'image'} title="원본 이미지 다운로드"><img src={current.url} alt={label} />{label}</a>
      : <span title={path}>{label} <small role="status">{current ? '미리보기를 불러올 수 없습니다.' : '이미지 불러오는 중…'}</small></span>}
  </span>;
}
