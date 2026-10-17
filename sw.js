// Mijn Geld service worker
// - Netwerk eerst (max ~3 s) voor de pagina, app.js, styles.css en manifest: updates zijn direct zichtbaar als je online bent.
// - Cache eerst voor iconen (veranderen zelden).
// - Offline: alles komt uit de cache.
const CACHE = 'mijn-geld-v31';
const NETWORK_TIMEOUT_MS = 3000;
const CORE = ['./', './app.js', './sync.js', './vendor/supabase.js', './styles.css', './manifest.webmanifest'];
const ICONS = ['./icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...CORE, ...ICONS].map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  const activation = (async () => {
    const keys = await caches.keys();
    const old = keys.filter(k => k.startsWith('mijn-geld-') && k !== CACHE);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    return old.some(k => /^mijn-geld-v[1-5]$/.test(k));
  })();
  event.waitUntil(activation);
  // Eenmalig: versies v1–v5 hadden nog geen automatische herlaadactie in app.js.
  // Ververs open vensters zodat de nieuwe versie meteen zichtbaar is. Bewust NA de activatie
  // (niet binnen waitUntil), anders wacht de navigatie op de activatie en andersom.
  activation.then(fromOldVersion => {
    if (!fromOldVersion) return;
    return self.clients.matchAll({ type: 'window' })
      .then(clients => Promise.all(clients.map(c => c.navigate(c.url).catch(() => {}))));
  });
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Safari weigert 'redirected' responses voor navigaties; maak er een schone kopie van.
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const network = fetch(request.mode === 'navigate' ? request.url : request, { cache: 'no-cache', credentials: 'same-origin' })
    .then(async res => {
      if (res && res.ok) {
        const copy = await clean(res.clone());
        await cache.put(cacheKey, copy.clone());
        return copy;
      }
      return res;
    });
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
    // Netwerk te traag: gebruik de cache (het netwerk werkt de cache op de achtergrond nog bij).
    const cached = await cache.match(cacheKey, { ignoreSearch: true });
    return cached || await network;
  } catch (e) {
    const cached = await cache.match(cacheKey, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // o.a. supabase.co: nooit cachen
  if (url.hostname.endsWith('supabase.co')) return;
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);

  if (req.mode === 'navigate' || path === '' || path === 'index.html') {
    event.respondWith(networkFirst(req, new URL('./', scope).href));
  } else if (path.startsWith('icons/')) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req, url.origin + url.pathname));
  }
});
