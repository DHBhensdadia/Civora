'use client';

import { useCallback, useEffect, useState } from 'react';

import { flush, listItems, subscribeToOutbox } from './outbox';
import type { FlushSummary, OutboxItem } from './outbox';

/**
 * The outbox, as the interface sees it.
 *
 * Delivery is attempted when the page opens, whenever the browser reports that
 * connectivity has returned, and on an interval while anything is waiting — so
 * a capture queued in a dead spot is delivered by the device without anyone
 * having to remember to press anything. The manual control exists for the case
 * that actually needs it: a link that has come back without the browser saying
 * so, which is the normal state of affairs on a poor connection.
 *
 * Every attempt reports what happened, so the interface can state the queue's
 * condition rather than just its size.
 */

/** How often to attempt delivery while something is waiting. */
const FLUSH_INTERVAL_MS = 5000;

export interface OutboxView {
  readonly items: readonly OutboxItem[];
  readonly pending: number;
  /** False until the queue has been read from this device. */
  readonly ready: boolean;
  readonly online: boolean;
  readonly flushing: boolean;
  readonly lastSummary: FlushSummary | null;
  readonly retryNow: () => void;
}

export function useOutbox(): OutboxView {
  const [items, setItems] = useState<readonly OutboxItem[]>([]);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [flushing, setFlushing] = useState(false);
  const [lastSummary, setLastSummary] = useState<FlushSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const stored = await listItems();
    setItems(stored);
    setReady(true);
  }, []);

  const attempt = useCallback(
    async (force: boolean): Promise<void> => {
      setFlushing(true);
      try {
        setLastSummary(await flush({ force }));
      } finally {
        setFlushing(false);
        await refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const stored = await listItems();
      if (!cancelled) {
        setItems(stored);
        setReady(true);
      }
    };

    void load();
    const unsubscribe = subscribeToOutbox(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);

    const wentOnline = (): void => {
      setOnline(true);
      // Force: the browser knows the link is back, so nothing should be waiting
      // on a backoff schedule that was set while it was down.
      void attempt(true);
    };
    const wentOffline = (): void => {
      setOnline(false);
    };

    window.addEventListener('online', wentOnline);
    window.addEventListener('offline', wentOffline);

    return () => {
      window.removeEventListener('online', wentOnline);
      window.removeEventListener('offline', wentOffline);
    };
  }, [attempt]);

  useEffect(() => {
    void attempt(false);
    const timer = window.setInterval(() => {
      void attempt(false);
    }, FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [attempt]);

  const retryNow = useCallback((): void => {
    void attempt(true);
  }, [attempt]);

  return {
    items,
    pending: items.filter((item) => item.status === 'pending').length,
    ready,
    online,
    flushing,
    lastSummary,
    retryNow,
  };
}
