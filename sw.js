/* Shepr service worker.
   Goal: when the tailnet is unreachable, the user sees YOUR app with YOUR message,
   not Safari's error page. It is NOT a general offline database. */

const VERSION = 'shepr-v22';
// The app shell: everything needed to paint a useful screen with no network.
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  // skipWaiting so a reload picks up the new version instead of waiting for every
  // tab to close. On a personal tool that is what you want.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;             // never cache writes
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // never cache other hosts
  if (url.pathname.endsWith('/ping')) return;   // the reachability probe must be real

  // The queue: network first, so you get fresh data when home is reachable and the last known
  // answer (labelled with its time by app.js) when it is not.
  if (url.pathname === '/api/queue') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Only a good answer is worth keeping: a cached 401 would hide the pairing screen.
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then(async (hit) => {
          // Offline: the last queue, but LABELLED as old. Its own age_s was true when it was cached, so
          // recompute it from when it was built, or the app would show frozen statuses as current.
          if (!hit) return hit;
          try {
            const q = await hit.clone().json();
            q.cached = true;
            q.age_s = Math.max(0, Math.round(Date.now() / 1000 - (q.now || 0)));
            return new Response(JSON.stringify(q), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } catch (e) { return hit; }
        }))
    );
    return;
  }

  // Everything else under /api is live-only: a pane tail is terminal text that may hold secrets,
  // and a stale one would look like the current question. Let it fail honestly when offline.
  if (url.pathname.startsWith('/api/')) return;

  // Shell: NETWORK first, so a change shows on the very next open instead of the one after. If the network
  // is gone or slower than 2.5s (a dead tailnet can hang for a long time), fall back to the cache, which is
  // what keeps the app opening offline.
  e.respondWith(
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('slow')), 2500);
      fetch(req).then((res) => { clearTimeout(t); resolve(res); }, (err) => { clearTimeout(t); reject(err); });
    }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
