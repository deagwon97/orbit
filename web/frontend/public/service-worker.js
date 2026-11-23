const CACHE_NAME = "orbit-pwa-v2";
const APP_SHELL = ["/", "/index.html", "/manifest.json", "/icon.svg?v=2"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("push", (event) => {
  let message;
  try { message = event.data?.json(); } catch { message = null; }
  event.waitUntil(self.registration.showNotification("Orbit · 작업 완료", {
    body: "Codex 세션을 열어 결과를 확인하세요.",
    icon: "/icon.svg?v=2",
    tag: typeof message?.tag === "string" ? message.tag : "orbit-completed",
    data: { path: typeof message?.path === "string" ? message.path : "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const home = self.location.origin + "/";
  let href = home;
  try {
    const target = new URL(event.notification.data?.path || home, home);
    if (target.origin === self.location.origin && target.pathname === "/") href = target.href;
  } catch { /* Open Orbit for an invalid notification URL. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url === href);
    if (existing) await existing.focus();
    else await self.clients.openWindow(href);
  })());
});
