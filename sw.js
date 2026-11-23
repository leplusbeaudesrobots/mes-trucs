// Mes trucs : fonctionne hors ligne. Change VERSION à chaque mise à jour du code.
const VERSION = 'mes-trucs-v10';
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

/* ---------- Rappels (soir + dimanche) ----------
   GitHub envoie un signal à l'heure choisie (« soir », ou « week » le dimanche). Ici, on choisit la tâche dans la copie IndexedDB
   tenue par l'appli : les tâches ne quittent jamais le téléphone. */
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('mes-trucs', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = tx.onerror = () => res(); }); }
const pad = n => String(n).padStart(2, '0');
const isoDay = (plus = 0) => { const d = new Date(); d.setDate(d.getDate() + plus); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
async function readTasks() { try { return JSON.parse(await idbGet('tasks') || '{}') || {}; } catch (e) { return {}; } }

// Rappel du soir : seulement les tâches à rattraper ou du jour (même logique que la carte « Maintenant »)
const live = tasks => Object.entries(tasks).map(([id, t]) => ({ id, ...t })).filter(t => t && !t.done && !t.idea && !t.split && typeof t.title === 'string');
function pick(tasks) {
  const today = isoDay();
  const urgent = live(tasks).filter(t => t.due && t.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || (a.created || 0) - (b.created || 0));
  return urgent[0] || null;
}
const any = a => a[Math.floor(Math.random() * a.length)];
// Des formulations qui changent, pour que l'œil ne s'habitue pas à la même alerte
const SOIR = ['Ton truc du soir', 'Juste celui-là', 'Un truc, et c’est plié', '10 minutes pour celui-là ?', 'Le seul qui compte ce soir'];
const BASE = { icon: 'icon-192.png', badge: 'badge-96.png', lang: 'fr' };

// Rien à montrer (soir vide, pause) : Chrome exige quand même une notification.
// On l'affiche sans son ni vibration, puis on l'enlève tout de suite après (au mieux).
async function quiet(title) {
  await self.registration.showNotification(title, { ...BASE, tag: 'calme', silent: true, renotify: false });
  setTimeout(() => self.registration.getNotifications({ tag: 'calme' }).then(ns => ns.forEach(n => n.close())), 4000);
}

async function showEvening() {
  const t = pick(await readTasks());
  if (!t) return quiet('Rien d’urgent ce soir ✌️');
  return self.registration.showNotification(t.title, {
    ...BASE, tag: 'soir', renotify: true, body: any(SOIR), data: { id: t.id },
    actions: [{ action: 'done', title: 'C’est fait ✓' }, { action: 'tomorrow', title: 'Demain' }]
  });
}

// Point du dimanche : un coup d'œil sur la semaine, qui ouvre l'appli
async function showWeek() {
  const all = live(await readTasks()), today = isoDay(), in7 = isoDay(7);
  const late = all.filter(t => t.due && t.due < today).length, week = all.filter(t => t.due && t.due >= today && t.due <= in7).length;
  const free = all.filter(t => !t.due).length;
  if (!late && !week && !free) return quiet('Semaine toute propre ✌️');
  const bits = [];
  if (week) bits.push(week + ' prévu' + (week > 1 ? 's' : '') + ' cette semaine');
  if (late) bits.push(late + ' à rattraper');
  if (free) bits.push(free + ' sans date');
  return self.registration.showNotification(any(['Point du dimanche', 'On prépare la semaine ?', 'Petit tri du dimanche']), {
    ...BASE, tag: 'semaine', renotify: true, body: bits.join(' · ') + '. 5 minutes pour trier ?', data: { open: true }
  });
}

async function onSignal(kind) {
  const pause = await idbGet('pauseUntil').catch(() => 0);
  if (pause && Date.now() < pause) return quiet('Rappels en pause');
  return kind === 'week' ? showWeek() : showEvening();
}

self.addEventListener('push', e => {
  let kind = 'soir'; try { kind = (e.data && e.data.json().type) || 'soir'; } catch (err) {}
  e.waitUntil(onSignal(kind));
});
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'test') e.waitUntil(e.data.kind === 'week' ? showWeek() : showEvening());
});

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
