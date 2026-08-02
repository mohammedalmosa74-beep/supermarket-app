var CACHE = 'supermarket-v5';
var urls = ['/', '/customer.html?v=8', '/admin.html', '/manifest.json'];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(urls); }).then(function() { return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.filter(function(n) { return n !== CACHE; }).map(function(n) { return caches.delete(n); }));
    }).then(function() { return clients.claim(); })
  );
});
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  if (e.request.url.includes('socket.io') || e.request.url.includes('socket.io.js')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        var copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
