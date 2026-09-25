/**
 * The offline outbox.
 *
 * A facility at the end of a bad connection cannot wait for a round trip to
 * record what it has just counted, and a form that loses a capture because the
 * network dropped teaches staff not to use it. So a capture is written to this
 * device first and delivered afterwards: nothing is discarded on failure, every
 * attempt is accounted for, and the interface can say exactly how many changes
 * are waiting.
 *
 * Three design decisions are worth stating because they are the ones that go
 * wrong in offline clients:
 *
 *  1. **The idempotency key is generated when the capture is queued, not when it
 *     is sent.** A retry that regenerates its key is a new submission, and the
 *     platform would store the same count twice — which it is entitled to do,
 *     because it was asked to.
 *  2. **A refusal is kept, not retried.** If the platform refuses a submission
 *     because it contradicts a record already stored, retrying cannot help, and
 *     a queue that loops on it hides the disagreement from the person who can
 *     resolve it.
 *  3. **A failure to reach the platform is not a failure of the capture.** The
 *     item stays pending with its attempt count and its last error, and the
 *     schedule backs off rather than hammering a link that is plainly down.
 *
 * IndexedDB rather than memory, because the point is that a browser closed
 * offline and reopened in signal still holds what was captured.
 */

const DATABASE_NAME = 'civora-outbox';
const STORE_NAME = 'items';
const DATABASE_VERSION = 1;

/** Where a queued capture has got to. */
export const ITEM_STATUSES = ['pending', 'delivered', 'refused', 'rejected'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface OutboxItem {
  /** Identifies the queue entry on this device. Never sent to the platform. */
  readonly id: string;
  /** The ingest envelope, exactly as it will be submitted. */
  readonly request: unknown;
  /** How the interface describes the capture to the person who made it. */
  readonly label: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly status: ItemStatus;
  /** The moment this item may be attempted again, as an epoch millisecond. */
  readonly nextAttemptAt: number;
  /** The platform's answer, when there was one. */
  readonly response: unknown;
}

export interface FlushSummary {
  readonly delivered: number;
  readonly refused: number;
  readonly rejected: number;
  readonly pending: number;
}

/** First retry delay, doubling per attempt up to the cap. */
export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 30_000;

/** How long to wait before the next attempt at this item. */
export const backoffFor = (attempts: number): number =>
  Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 10)) +
  Math.floor(Math.random() * 250);

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('the capture outbox could not be opened'));
    };
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> => {
  const database = await openDatabase();
  return await new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => {
      resolve(request.result as T);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('the capture outbox could not be read'));
    };
    transaction.oncomplete = () => {
      database.close();
    };
  });
};

const listeners = new Set<() => void>();

/** Notify the interface that the queue changed. */
const announce = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/** Watch the queue; returns the unsubscribe function. */
export const subscribeToOutbox = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Everything queued on this device, oldest first. */
export const listItems = async (): Promise<readonly OutboxItem[]> => {
  const items = await withStore<OutboxItem[]>('readonly', (store) => store.getAll());
  return [...items].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
};

const putItem = async (item: OutboxItem): Promise<void> => {
  await withStore('readwrite', (store) => store.put(item));
};

/**
 * Queue a capture.
 *
 * Returns the queued item rather than a promise of delivery, because delivery
 * is not what the caller asked for: the capture is recorded as soon as this
 * resolves, and the interface may say so.
 */
export const enqueue = async (request: unknown, label: string): Promise<OutboxItem> => {
  const item: OutboxItem = {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()),
    request,
    label,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    status: 'pending',
    nextAttemptAt: 0,
    response: null,
  };

  await putItem(item);
  announce();
  return item;
};

/** Clear everything, including what was delivered. Used by the tests and the demo reset. */
export const clearOutbox = async (): Promise<void> => {
  await withStore('readwrite', (store) => store.clear());
  announce();
};

interface SubmissionOutcome {
  readonly status: ItemStatus;
  readonly response: unknown;
  readonly error: string | null;
}

/** What the platform said about one submission. */
const submit = async (request: unknown): Promise<SubmissionOutcome> => {
  const response = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  const body: unknown = await response.json().catch(() => null);
  const detail: unknown =
    typeof body === 'object' && body !== null
      ? (Reflect.get(body, 'detail') ?? Reflect.get(body, 'outcome'))
      : null;

  if (response.ok) {
    return { status: 'delivered', response: body, error: null };
  }

  if (response.status === 409) {
    // The platform holds a different record for this observation. Retrying
    // would produce the same refusal, so it is kept for a person to resolve.
    return {
      status: 'refused',
      response: body,
      error: typeof detail === 'string' ? detail : 'the platform refused this capture',
    };
  }

  if (response.status >= 500) {
    throw new Error(`the platform could not process this capture (${String(response.status)})`);
  }

  return {
    status: 'rejected',
    response: body,
    error: typeof detail === 'string' ? detail : `refused with status ${String(response.status)}`,
  };
};

/**
 * Deliver what is waiting.
 *
 * `force` ignores the backoff schedule, which is what the "retry now" control
 * asks for: a person who has just regained signal should not be told to wait
 * because the schedule says so.
 */
export async function flush(options: { readonly force?: boolean } = {}): Promise<FlushSummary> {
  const force = options.force ?? false;
  const items = await listItems();
  const now = Date.now();

  let delivered = 0;
  let refused = 0;
  let rejected = 0;
  let pending = 0;

  for (const item of items) {
    if (item.status !== 'pending') {
      continue;
    }

    if (!force && item.nextAttemptAt > now) {
      pending += 1;
      continue;
    }

    const attempts = item.attempts + 1;

    try {
      const outcome = await submit(item.request);
      await putItem({
        ...item,
        attempts,
        status: outcome.status,
        response: outcome.response,
        lastError: outcome.error,
        nextAttemptAt: 0,
      });

      if (outcome.status === 'delivered') {
        delivered += 1;
      } else if (outcome.status === 'refused') {
        refused += 1;
      } else {
        rejected += 1;
      }
    } catch (error) {
      // Unreachable rather than refused: the capture is still the facility's,
      // and it stays queued until it can be delivered.
      await putItem({
        ...item,
        attempts,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: Date.now() + backoffFor(attempts),
      });
      pending += 1;
    }
  }

  announce();
  return { delivered, refused, rejected, pending };
}

/** Queue entries still waiting to be delivered. */
export const pendingCount = async (): Promise<number> =>
  (await listItems()).filter((item) => item.status === 'pending').length;
