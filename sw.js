// Mes trucs : fonctionne hors ligne. Change VERSION à chaque mise à jour du code.
const VERSION = 'mes-trucs-v9';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './sc-add.png', './sc-tonight.png', './sc-today.png', './sc-tomorrow.png', './badge-96.png'];

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

/* ---------- Rappel de 18h ----------
   GitHub envoie un signal vide vers 18h. Ici, on choisit la tâche dans la copie IndexedDB
   tenue par l'appli : les tâches ne quittent jamais le téléphone. */
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('mes-trucs', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = tx.onerror = () => res(); }); }
const pad = n => String(n).padStart(2, '0');
const isoDay = (plus = 0) => { const d = new Date(); d.setDate(d.getDate() + plus); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
async function readTasks() { try { return JSON.parse(await idbGet('tasks') || '{}') || {}; } catch (e) { return {}; } }

// Même logique que la carte « Maintenant » : à rattraper + aujourd'hui, sinon un truc sans date
function pick(tasks) {
  const today = isoDay();
  const all = Object.entries(tasks).map(([id, t]) => ({ id, ...t })).filter(t => t && !t.done && !t.idea && !t.split && typeof t.title === 'string');
  const urgent = all.filter(t => t.due && t.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || (a.created || 0) - (b.created || 0));
  if (urgent.length) return { t: urgent[0], others: urgent.length - 1 };
  const free = all.filter(t => !t.due).sort((a, b) => (a.created || 0) - (b.created || 0));
  if (free.length) return { t: free[0], free: true };
  return null;
}

async function showEvening() {
  const p = pick(await readTasks());
  const base = { icon: 'icon-192.png', badge: 'badge-96.png', tag: 'soir', renotify: true, lang: 'fr' };
  if (!p) return self.registration.showNotification('Rien d’urgent ce soir ✌️', { ...base, body: 'Profite.' });
  const body = p.free ? 'Si t’as 10 minutes ce soir'
    : 'Ton truc du soir' + (p.others ? ' · ' + p.others + ' autre' + (p.others > 1 ? 's' : '') + ' en attente, sans pression' : '');
  return self.registration.showNotification(p.t.title, {
    ...base, body, data: { id: p.t.id },
    actions: [{ action: 'done', title: 'C’est fait ✓' }, { action: 'tomorrow', title: 'Demain' }]
  });
}

self.addEventListener('push', e => e.waitUntil(showEvening()));
self.addEventListener('message', e => { if (e.data && e.data.type === 'test') e.waitUntil(showEvening()); });

async function act(type, id) {
  if (!id) return;
  const tasks = await readTasks(), t = tasks[id];
  const op = { type, id, at: Date.now(), due: type === 'tomorrow' ? isoDay(1) : null };
  if (t) { // copie à jour tout de suite, pour le prochain rappel
    if (type === 'done') { t.done = true; t.doneAt = op.at; } else { t.due = op.due; t.time = null; }
    await idbSet('tasks', JSON.stringify(tasks));
  }
  const pending = (await idbGet('pending')) || []; pending.push(op); await idbSet('pending', pending);
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach(c => c.postMessage({ type: 'pending' }));
}

self.addEventListener('notificationclick', e => {
  const n = e.notification, id = n.data && n.data.id; n.close();
  if (e.action === 'done' || e.action === 'tomorrow') { e.waitUntil(act(e.action, id)); return; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    const w = wins.find(c => 'focus' in c);
    return w ? w.focus() : self.clients.openWindow('./');
  }));
});
