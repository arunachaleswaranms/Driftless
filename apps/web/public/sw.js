// Driftless service worker.
//
// This worker establishes the registration, scope, and update lifecycle that
// installability and any later application-shell caching build on. It
// deliberately registers no fetch handler: every request is handled by the
// network exactly as if no worker were installed, and nothing is cached.
// Requests for blob: object URLs are never dispatched to a service worker.
//
// A new version activates as soon as it installs. With no fetch handler there
// is no cached state for different versions to disagree about; revisit this
// before adding any caching.
self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
