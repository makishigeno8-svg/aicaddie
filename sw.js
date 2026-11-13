// AIキャディ Service Worker：アプリ本体をキャッシュして電波の弱いコースでも起動できるようにする
const VERSION = 'aicaddie-v1.6.0';
const SHELL = ['./', './index.html', './style.css', './app.js', './round.js', './manifest.webmanifest',
  './lib/leaflet.js', './lib/leaflet.css', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // 外部（AI・地図・天気）は常にネットワーク
  // 自分のファイル：ネット優先、つながらなければキャッシュ
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
