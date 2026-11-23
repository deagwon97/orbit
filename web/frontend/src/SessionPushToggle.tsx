import { Bell, BellOff } from 'lucide-react';
import { useEffect, useState } from 'react';

const DEVICE_KEY = 'orbit.pushDevice';

function deviceKey() {
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(DEVICE_KEY, key);
  return key;
}

export function SessionPushToggle({ id, connection }: {
  id: string;
  connection: { id: string; url: string; token: string };
}) {
  const [available, setAvailable] = useState<{ registration: ServiceWorkerRegistration; publicKey: string; device: string }>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/api/v1/push/sessions/${encodeURIComponent(id)}`;
  const { id: connectionId, url, token } = connection;
  const headers = { 'x-orbitd-url': url, Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const device = deviceKey();
        const response = await fetch(endpoint, {
          headers: { 'x-orbitd-url': url, Authorization: `Bearer ${token}`, 'x-orbit-push-device': device },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const { publicKey, enabled } = await response.json();
        const registration = await navigator.serviceWorker.ready;
        if (controller.signal.aborted) return;
        setAvailable({ registration, publicKey, device });
        setEnabled(enabled);
      } catch {
        // This browser or server does not expose push notifications.
      }
    })();
    return () => controller.abort();
  }, [endpoint, url, token]);

  async function toggle() {
    if (!available || busy) return;
    setBusy(true);
    setError('');
    try {
      const pushHeaders = { ...headers, 'x-orbit-push-device': available.device };
      const response = enabled
        ? await fetch(endpoint, { method: 'DELETE', headers: pushHeaders })
        : await (async () => {
            const key = atob(available.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
            // Call subscribe directly from this click so mobile Safari can request permission.
            const subscription = await available.registration.pushManager.subscribe({
              userVisibleOnly: true, applicationServerKey: Uint8Array.from(key, value => value.charCodeAt(0)),
            });
            return fetch(endpoint, {
              method: 'PUT',
              headers: { ...pushHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ connection: connectionId, subscription }),
            });
          })();
      if (!response.ok) throw new Error('완료 알림 설정을 저장할 수 없습니다.');
      setEnabled(!enabled);
    } catch (cause) {
      if (Notification.permission === 'denied') setError('브라우저 설정에서 Orbit 알림을 허용하세요.');
      else setError(cause instanceof DOMException ? '이 기기에서 완료 알림을 등록할 수 없습니다.' : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!available) return null;
  return <>
    <button type="button" aria-pressed={enabled} disabled={busy} onClick={() => void toggle()}>
      {enabled ? <BellOff size={15} /> : <Bell size={15} />}
      {enabled ? '완료 알림 끄기' : '완료 알림 켜기'}
    </button>
    {error && <small role="status">{error}</small>}
  </>;
}
