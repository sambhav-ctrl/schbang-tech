// ── Billing Dashboard Service Worker ──────────────────────────
const CACHE = 'schbang-tech-v2';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// The dept this SW instance belongs to (passed at registration: /sw.js?dept=tech)
const SW_DEPT = 'tech';

// Push received — fetch latest notification payload and show a rich notification
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = 'Schbang Billing';
    let body  = 'Tap to review your unbilled estimates.';
    let tag   = 'weekly-' + Date.now();
    let image = null;
    let dept  = SW_DEPT;

    try {
      const res  = await fetch('/api/notifications?dept=' + SW_DEPT);
      const data = await res.json();
      if (data.latest) {
        title = data.latest.title || title;
        body  = data.latest.body  || body;
        tag   = data.latest.id    || tag;
        image = data.latest.image || null;
        dept  = data.latest.dept  || SW_DEPT;
      }
    } catch(e) {}

    const icon  = dept === 'martech' ? '/icon-192-martech.png' : '/icon-192.png';
    const badge = dept === 'martech' ? '/badge-96-martech.png'  : '/badge-96.png';
    const url   = dept === 'martech' ? '/' : '/';

    const opts = {
      body,
      tag,
      icon,
      badge,
      vibrate: [120, 60, 120, 60, 200],
      requireInteraction: true,
      data: { url },
      actions: [
        { action: 'open',  title: 'Open dashboard' },
        { action: 'later', title: 'Later' }
      ]
    };
    // Big expandable banner image (if the server generated one)
    if (image) opts.image = image;

    await self.registration.showNotification(title, opts);
  })());
});

// Tap notification (or its "Open" action) → open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'later') return;
  const path = (e.notification.data && e.notification.data.url) || '/';
  const full = new URL(path, self.location.origin).href;
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If an app window is already open, focus it
    for (const c of list) {
      if ('focus' in c) {
        try { if ('navigate' in c) await c.navigate(full); } catch(_){}
        return c.focus();
      }
    }
    // Otherwise open a new window
    if (clients.openWindow) return clients.openWindow(full);
  })());
});
