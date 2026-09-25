'use client';

/**
 * Keeping the capture screen on the device.
 *
 * The outbox on its own covers a dropped request. This covers a worse day: the
 * browser is closed in a dead spot and reopened there, and the facility is asked
 * to record what it counted. Without a stored shell the screen itself fails to
 * load, and the queue that was working perfectly is unreachable.
 *
 * The worker is registered from the page rather than from a manifest, and the
 * page — not the worker — decides what to keep, because only the page knows
 * which hashed assets it actually loaded. What comes back is a count of stored
 * files, and the interface reports that count rather than a hopeful claim, so
 * "saved for offline" means stored bytes rather than an intention.
 *
 * Nothing under `/api/` is ever kept: see `public/sw.js`. A cached stock
 * position would be a stale number presented as a current one, which is the
 * failure this platform exists to avoid.
 */

/** Must match the cache the worker opens. Asserted by `shell-cache.test.ts`. */
export const SHELL_CACHE = 'civora-shell-v1';

/** Where the worker is served from. Asserted to exist by `shell-cache.test.ts`. */
export const SHELL_WORKER_URL = '/sw.js';

/** How long to wait for the worker's answer before giving up on it. */
const REPLY_TIMEOUT_MS = 10_000;

export type ShellStatus = 'unsupported' | 'cached' | 'unavailable';

/**
 * Everything the loaded page needs to render again.
 *
 * Taken from the document rather than from a hand-written list, because the
 * stylesheet and chunk names are content-hashed and change on every build.
 */
export const shellAssets = (): readonly string[] => {
  const urls = new Set<string>([window.location.href]);

  for (const node of document.querySelectorAll(
    'script[src], link[rel="stylesheet"], link[rel="modulepreload"]',
  )) {
    const value = node.getAttribute('src') ?? node.getAttribute('href');
    if (value === null) {
      continue;
    }
    const resolved = new URL(value, window.location.href);
    if (resolved.origin === window.location.origin) {
      urls.add(resolved.href);
    }
  }

  return [...urls];
};

/** Ask the worker to store those assets, and report how many it kept. */
const askWorkerToStore = async (
  worker: ServiceWorker,
  urls: readonly string[],
): Promise<number> => {
  return await new Promise<number>((resolve) => {
    let settled = false;

    const settle = (stored: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(stored);
    };

    // A worker that never answers must not leave the interface saying it is
    // still preparing: an unknown answer is reported as one.
    const timer = window.setTimeout(() => {
      settle(0);
    }, REPLY_TIMEOUT_MS);

    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const data = event.data as { stored?: unknown } | null;
      settle(typeof data?.stored === 'number' ? data.stored : 0);
    };

    worker.postMessage({ type: 'warm-shell', urls }, [channel.port2]);
  });
};

/**
 * Register the worker, keep the screen, and say which of those happened.
 *
 * `cached` means the assets are on the device. `unavailable` means this browser
 * would open the screen only with a connection — which the interface states
 * plainly rather than implying an offline capability it does not have.
 */
const warm = async (worker: ServiceWorker): Promise<ShellStatus> =>
  (await askWorkerToStore(worker, shellAssets())) > 0 ? 'cached' : 'unavailable';

export async function warmOfflineShell(): Promise<ShellStatus> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    return 'unsupported';
  }

  try {
    await navigator.serviceWorker.register(SHELL_WORKER_URL, { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    // The worker claims open pages as it activates, so a first load is usually
    // controlled by the time `ready` resolves; the registration's own active
    // worker covers a load that has not been claimed yet.
    const worker = navigator.serviceWorker.controller ?? registration.active;

    return worker === null ? 'unavailable' : await warm(worker);
  } catch {
    return 'unavailable';
  }
}
