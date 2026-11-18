import { useEffect, useRef } from 'react';

type Entry = { id: string; close: () => void; owned: boolean };
type Manager = { entries: Entry[]; pending: ('dismiss'|'skip')[]; detailRequested: boolean; handled: WeakSet<Event> };
const owner = window as typeof window & { orbitDialogHistoryV3?: Manager };
const manager: Manager = owner.orbitDialogHistoryV3 || { entries: [], pending: [], detailRequested:false, handled: new WeakSet() };
function push(entry: Entry) {
  history.pushState({ ...history.state, orbitModal: entry.id }, '', location.href); entry.owned=true;
}
function flushDetail() {
  if(manager.detailRequested&&!manager.pending.length&&!history.state?.orbitModal) {
    manager.detailRequested=false;history.pushState({ ...history.state, orbitDetail:true },'',location.href);
  }
}
export function pushDetailHistory() {manager.detailRequested=true;flushDetail();}
export function cancelDetailHistory() {manager.detailRequested=false;}
if (!owner.orbitDialogHistoryV3) {
  owner.orbitDialogHistoryV3 = manager;
  window.addEventListener('popstate', event => {
    const reason=manager.pending.shift(), id=history.state?.orbitModal;
    if(reason)manager.handled.add(event);
    if(id&&!manager.entries.some(entry=>entry.id===id)) {
      manager.handled.add(event);manager.pending.push(reason==='dismiss'?'dismiss':'skip');history.back();return;
    }
    const top=manager.entries.at(-1);
    if(top&&!top.owned) {manager.handled.add(event);flushDetail();push(top);return;}
    if(reason==='dismiss'){flushDetail();return;}
    if(top&&id!==top.id) {manager.handled.add(event);top.close();}
  });
}
export function dialogHandledBack(event: Event) { return manager.handled.has(event); }
export function useDialogHistory(close: () => void, enabled = true) {
  const callback = useRef(close); callback.current = close;
  useEffect(() => {
    if (!enabled) return;
    const entry: Entry = { id:`dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`, close:()=>callback.current(), owned:false };
    manager.entries.push(entry);
    if(!manager.pending.length)push(entry);
    return () => {
      manager.entries=manager.entries.filter(item=>item!==entry);
      // Let a replacement/nested dialog mount before deciding whether to traverse.
      queueMicrotask(()=>{if(history.state?.orbitModal===entry.id){manager.pending.push('dismiss');history.back();}});
    };
  }, [enabled]);
}
