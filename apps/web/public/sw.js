/**
 * The offline app shell.
 *
 * A facility that has opened the capture screen once should be able to open it
 * again with no connection at all. That is a different claim from the one the
 * outbox makes: the outbox says a capture already made on this device survives
 * the network going away, and this file says the screen itself survives a
 * browser that was closed and reopened in a dead spot. The two are needed
 * together, because a queue nobody can reach is still a lost record.
 *
 * Two rules it must not break:
 *
 *  1. **Nothing under `/api/` is ever stored or served from here.** A stock
 *     position read ten minutes ago is not a stock position, and the platform's
 *     central claim is that it says *unknown* rather than presenting a stale
 *     figure as a current one. An offline read must fail as unknown, not succeed
 *     with yesterday's answer.
 *  2. **The network wins wherever it exists.** The stored copy is a fallback for
 *     a request that could not be made, never a substitute for making it.
 *
 * The cache name is also declared in `src/lib/shell-cache.ts`, which is what the
 * page warms the shell through; a test asserts the two agree.
 */

const SHELL_CACHE = 'civora-shell-v1';

/** Whether a request is allowed anywhere near the shell cache. */
const isShellRequest = (request) => {
  if (request.method !== 'GET') {
    return false;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return false;
  }
  return !url.pathname.startsWith('/api/') && url.pathname !== '/healthz';
};

/** Store one response, tolerating a response the cache will not take. */
const store = async (cache, request, response) => {
  try {
    await cache.put(request, response);
    return true;
  } catch {
    return false;
  }
};

/**
 * Keep a set of URLs, at the request of a page that is currently on screen.
 *
 * The page knows which assets it actually loaded — hashed chunk names are not
 * knowable in advance — so it sends them and this stores what it can. The count
 * that comes back is what the interface reports, so "saved for offline" is a
 * statement about stored bytes rather than an intention.
 */
const warmShell = async (urls) => {
  const cache = await caches.open(SHELL_CACHE);
  let stored = 0;

  for (const url of urls) {
    const request = new Request(url, { credentials: 'same-origin' });
    if ((await cache.match(request)) !== undefined) {
      stored += 1;
      continue;
    }
    try {
      const response = await fetch(request);
      if (response.ok && (await store(cache, request, response))) {
        stored += 1;
      }
    } catch {
      // A shell that cannot be stored is reported as such; it is not an error
      // worth failing the page over.
    }
  }

  return stored;
};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.type !== 'warm-shell') {
    return;
  }

  const reply = event.ports[0];
  event.waitUntil(
    warmShell(Array.isArray(data.urls) ? data.urls : []).then((stored) => {
      if (reply !== undefined) {
        reply.postMessage({ ok: stored > 0, stored });
      }
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isShellRequest(request)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          await store(cache, request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached !== undefined) {
          return cached;
        }
        throw error;
      }
    })(),
  );
});
