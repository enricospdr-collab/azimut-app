self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open('azimut-app').then(function(cache) {
      return cache.addAll(['index.html']);
    })
  );
});