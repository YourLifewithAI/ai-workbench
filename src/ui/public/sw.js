// The service worker caches the application shell and nothing else (D-61). No API response, no run, no
// document, no trace: a phone that is off the tailnet should show an empty app, not a stale copy of private
// work it can no longer verify.
const SHELL = 'workbench-shell-v1';

self.addEventListener('install', (event) => {
  // Only the entry document. Hashed assets are cached as they are asked for, below.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** True for the built app's own files: the entry document and the hashed bundles beside it. */
function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  return url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.webmanifest');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !isShell(url)) return; // everything else goes straight to the network

  // Network first, so a running workbench always serves the current build; the cache is the offline shell.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('/'))),
  );
});

// A push payload is `{ kind, id, runId, title, url }` — a pointer and a generic title, never the content it
// points at (SEC-32). The app fetches what it needs once the person opens it and is authenticated again.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title : 'AI Workbench';
  event.waitUntil(self.registration.showNotification(title, {
    body: 'Open the workbench to see it.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.id === 'string' ? data.id : undefined,
    data: { url: typeof data.url === 'string' ? data.url : '/dashboard', kind: data.kind, id: data.id, runId: data.runId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open window when there is one: the token lives in that page's memory and nowhere else.
      const open = clients.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus().then(() => open.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});
