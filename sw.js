// Mes trucs : fonctionne hors ligne. Change VERSION à chaque mise à jour du code.
const VERSION = 'mes-trucs-v6';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './sc-add.png', './sc-tonight.png', './sc-today.png', './sc-tomorrow.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Page : réseau d'abord (pour les mises à jour), mais on n'attend pas plus de 3 s.
  // Réseau lent ou absent : la version en cache s'ouvre tout de suite, la nouvelle se range pour la prochaine fois.
  if (req.mode === 'navigate') {
    const net = fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); }
      return r;
    });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(new Promise(resolve => {
      let settled = false;
      const fallback = () => caches.match('./index.html').then(hit => {
        if (hit && !settled) { settled = true; resolve(hit); }
        return hit;
      });
      const timer = setTimeout(fallback, 3000);
      net.then(r => {
        clearTimeout(timer);
        if (settled) return;
        if (r.ok) { settled = true; resolve(r); }
        else fallback().then(hit => { if (!hit && !settled) { settled = true; resolve(r); } });
      }).catch(() => {
        clearTimeout(timer);
        fallback().then(hit => { if (!hit && !settled) { settled = true; resolve(Response.error()); } });
      });
    }));
    return;
  }

  // Fichiers de l'appli et police Google : cache d'abord
  if (url.origin === location.origin || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(r => {
        if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return r;
      }))
    );
  }
});
