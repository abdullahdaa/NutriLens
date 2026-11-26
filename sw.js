/* سُعرة — Service Worker (app-shell cache) — V8
 * - index.html / navigations: network-first (updates arrive immediately), cache fallback offline.
 * - Other same-origin files + fonts / Tailwind / barcode-reader CDN: stale-while-revalidate.
 * - API calls are NEVER intercepted or cached: Gemini (googleapis.com), USDA (api.nal.usda.gov),
 *   Open Food Facts, DeepSeek.
 * - This worker never touches IndexedDB or localStorage. It only deletes its OWN old caches.
 */
const VERSION = 'v8.0.0';
const SHELL_CACHE = `su3rah-shell-${VERSION}`;
const RUNTIME_CACHE = `su3rah-runtime-${VERSION}`;
const OWN_CACHE_PREFIXES = ['su3rah-shell-', 'su3rah-runtime-'];
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon.png', './icon-512.png', './icon-maskable.png'];

// Static asset hosts that may be cached for offline use.
const CACHEABLE_CDN = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com', 'cdn.jsdelivr.net']);
// API hosts: never cached, never intercepted.
const API_HOSTS = ['api.nal.usda.gov', 'world.openfoodfacts.org', 'openfoodfacts.org', 'api.deepseek.com', 'deepseek.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL_FILES.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => OWN_CACHE_PREFIXES.some((p) => k.startsWith(p)) && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  const h = url.hostname;
  if (API_HOSTS.some((a) => h === a || h.endsWith('.' + a))) return true;
  if (h === 'googleapis.com' || h.endsWith('.googleapis.com')) return h !== 'fonts.googleapis.com';
  return false;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request, { cache: 'no-store' });
    if (fresh && fresh.ok) cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => {}); return res; })
    .catch(() => cached || Response.error());
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;                 // POST (AI calls) go straight to the network
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isApiRequest(url)) return;                        // never cache API calls

  const sameOrigin = url.origin === self.location.origin;
  const isShellDoc = request.mode === 'navigate' || (sameOrigin && /\/(index\.html)?$/.test(url.pathname));
  if (sameOrigin && isShellDoc) { event.respondWith(networkFirst(request)); return; }
  if (sameOrigin && url.pathname.endsWith('/sw.js')) return;
  if (sameOrigin) { event.respondWith(staleWhileRevalidate(request, SHELL_CACHE)); return; }
  if (CACHEABLE_CDN.has(url.hostname)) { event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE)); return; }
  // Everything else: default browser behaviour.
});
