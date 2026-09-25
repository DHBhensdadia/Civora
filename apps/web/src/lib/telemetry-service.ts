import { advisoryLanguagesOf } from '@civora/ai';

import { getProviders } from '@/providers';
import { readIntelligence } from './intelligence-service';
import type { Session } from './session';
import { telemetryViewOf } from './telemetry';
import type { TelemetryView } from './telemetry';

/**
 * Read what the reasoning layer has been asked to do.
 *
 * Two sources, and neither of them is a model call:
 *
 *  - **The adapter's own counters.** The configured provider reports what it has
 *    counted since this process started, including the attempts a validator
 *    rejected and the requests the provider refused. An adapter that keeps no
 *    count answers nothing, and the panel says so rather than showing zeros.
 *  - **The inbox.** The volume figures are arithmetic over the alerts the session
 *    may read, so what a pass would cost is derived from what is actually there.
 *
 * Deliberately *not* `readAdvisorySet`, even though the advisory panel sits
 * beside this one on the same page. That read is what makes the platform write
 * the bodies; a step that counts calls must never make them, or a page refresh
 * would become a burst — exactly what writing ahead of the burst exists to
 * prevent. Scoring is read instead, which costs no model calls and is cached
 * per process by the intelligence service.
 */
export async function readTelemetry(session: Session): Promise<TelemetryView> {
  const provider = getProviders().reasoning;
  const intelligence = await readIntelligence(session);

  return telemetryViewOf({
    provider: provider.kind,
    // The optional method, and the `null` it can produce, are the design: see
    // `ReasoningProvider.telemetry`.
    telemetry: provider.telemetry?.() ?? null,
    alerts: intelligence.alerts.length,
    languages: advisoryLanguagesOf(intelligence.alerts),
    readAt: new Date().toISOString(),
  });
}
