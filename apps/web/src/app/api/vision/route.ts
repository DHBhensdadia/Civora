import { dateSchema, facilityIdSchema, instantSchema, stockExtractionSchema } from '@civora/domain';
import type { StockExtraction } from '@civora/domain';
import { stockExtractionPrompt } from '@civora/ai';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getProviders } from '@/providers';
import { getLiveStore } from '@/lib/live-store';
import { SESSION_COOKIE, parseSession } from '@/lib/session';
import {
  REVIEW_THRESHOLD,
  VisionRefused,
  recordExtraction,
  visionQueue,
} from '@/lib/vision-service';

/**
 * Where a photograph becomes a reading, and a reading becomes records.
 *
 * The model call is the only thing this route does that is not the platform's
 * own decision. It asks the reasoning provider — the port, so the adapter is
 * configuration — with the versioned extraction prompt, and the answer is
 * validated against the extraction schema *inside* the adapter, so what arrives
 * here to write can only be a shape the platform defined.
 *
 * A reading can also be **supplied** rather than read, and that is a deliberate
 * part of the contract rather than a convenience: a device that cannot reach the
 * provider holds the reading and sends it when it can, and the evaluator submits
 * labelled readings to measure what the platform does with them. What the
 * platform does is identical either way, so the two cannot drift — and the
 * batch records which of the two it was, because a reader of the queue is
 * entitled to know that no model was involved.
 *
 * Everything after the reading is `lib/vision-service.ts`: lines the platform
 * can stand behind are written through the ordinary ingest boundary with
 * `captureSource: 'vision'`, and the rest wait for a person.
 */

export const dynamic = 'force-dynamic';

const readingSchema = z.strictObject({
  facilityId: facilityIdSchema,
  occurredOn: dateSchema.optional(),
  capturedAt: instantSchema.optional(),
  /** A photograph, base64-encoded with its MIME type. */
  image: z
    .strictObject({
      mimeType: z.string().trim().min(1),
      data: z.string().trim().min(1),
    })
    .optional(),
  /** A reading made elsewhere — on a device that could not reach the provider. */
  extraction: z.unknown().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const store = await getLiveStore();

  return NextResponse.json({
    batches: await visionQueue(session),
    provider: getProviders().reasoning.kind,
    threshold: REVIEW_THRESHOLD,
    catalogueSize: store.catalogue.length,
    simulated: true,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const receivedAt = new Date().toISOString();
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'refused', reason: 'malformed-body', detail: 'the request body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = readingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'invalid-request',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  const { facilityId, image, extraction } = parsed.data;
  if ((image === undefined) === (extraction === undefined)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'one-reading',
        detail: 'send either a photograph to read or a reading to record, not both and not neither',
      },
      { status: 400 },
    );
  }

  const capturedAt = parsed.data.capturedAt ?? receivedAt;

  let reading: StockExtraction;
  let source: 'model' | 'supplied';
  let model: string;
  let cacheHit: boolean;

  if (image === undefined) {
    const supplied = stockExtractionSchema.safeParse(extraction);
    if (!supplied.success) {
      return NextResponse.json(
        {
          outcome: 'refused',
          reason: 'invalid-extraction',
          detail: supplied.error.issues
            .map((issue) => `${issue.path.join('.') || 'extraction'}: ${issue.message}`)
            .join('; '),
        },
        { status: 400 },
      );
    }
    reading = supplied.data;
    source = 'supplied';
    model = 'none';
    cacheHit = false;
  } else {
    try {
      const response = await getProviders().reasoning.reason(
        stockExtractionPrompt.request({ images: [{ mimeType: image.mimeType, data: image.data }] }),
      );
      reading = response.value;
      source = 'model';
      model = response.model;
      cacheHit = response.cacheHit;
    } catch (error) {
      // No key, no recorded response, or an answer the schema rejected. All three
      // are the platform declining to write anything, which is the behaviour that
      // matters: a photograph never becomes a ledger entry by accident.
      return NextResponse.json(
        {
          outcome: 'unavailable',
          reason: 'reasoning-provider-unavailable',
          detail: error instanceof Error ? error.message : String(error),
          provider: getProviders().reasoning.kind,
        },
        { status: 503 },
      );
    }
  }

  // The register's own date when the page states one, because a batch that
  // arrived on Tuesday belongs to Tuesday however long the photograph took to
  // reach the platform.
  const occurredOn = parsed.data.occurredOn ?? reading.registerDate ?? capturedAt.slice(0, 10);

  try {
    const batch = await recordExtraction({
      session,
      facilityId,
      extraction: reading,
      occurredOn,
      capturedAt,
      receivedAt,
      source,
      model,
      cacheHit,
    });

    const written = batch.lines.filter((line) => line.decision === 'accepted').length;
    const held = batch.lines.filter((line) => line.decision === 'pending').length;

    return NextResponse.json({
      outcome: held > 0 ? 'needs-review' : 'written',
      written,
      held,
      batch,
      source,
      threshold: REVIEW_THRESHOLD,
      model,
      cacheHit,
    });
  } catch (error) {
    if (error instanceof VisionRefused) {
      return NextResponse.json(
        { outcome: 'refused', reason: 'not-permitted', detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
