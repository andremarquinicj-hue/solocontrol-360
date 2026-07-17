// sc360-v2 — rede primeiro para a página, cache como reserva offline
const CACHE = 'sc360-v2';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    // Página principal: sempre tenta a rede primeiro (pega deploys novos)
    e.respondWith(
      fetch(e.request).then(r => {
        caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(() => {});
        return r.clone();
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Demais arquivos: cache com atualização em segundo plano
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const rede = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
      return cached || rede;
    })
  );
});
