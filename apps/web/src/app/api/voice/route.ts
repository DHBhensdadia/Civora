import {
  dateSchema,
  facilityIdSchema,
  instantSchema,
  voiceCaptureCommandSchema,
} from '@civora/domain';
import type { VoiceCaptureCommand } from '@civora/domain';
import { voiceCommandPrompt } from '@civora/ai';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getProviders } from '@/providers';
import { getLiveStore } from '@/lib/live-store';
import { SESSION_COOKIE, parseSession } from '@/lib/session';
import { VoiceRefused, recordVoiceCommand, voiceQueue } from '@/lib/voice-service';

/**
 * Where a spoken update becomes a proposal, and a person is asked to confirm it.
 *
 * This route does not write anything. It ends with a proposal in the queue — the
 * transcript, what the platform understood, and every question still open — and
 * the write happens only at `/api/voice/confirm`, where a person's confirmation
 * arrives carrying the proposal's identity. That is the flow's whole safety
 * argument, and putting the two in separate routes is what makes it a property of
 * the platform rather than a convention in a component.
 *
 * The parse can come from two places, and the proposal says which. A recording
 * is sent to the configured reasoning provider with the versioned
 * voice-command-parsing prompt, and the answer is validated against the command
 * schema *inside* the adapter. A **supplied** parse is one made elsewhere — on a
 * device that could not reach the provider, or by a service the platform is
 * integrating with. The platform's behaviour after the parse is identical in both
 * cases, so the two cannot drift, and a reader of the queue is told when no model
 * was involved.
 */

export const dynamic = 'force-dynamic';

const utteranceSchema = z.strictObject({
  facilityId: facilityIdSchema,
  /** The day the update is about. Speech carries no date; the capture day is the default. */
  observedOn: dateSchema.optional(),
  capturedAt: instantSchema.optional(),
  /** A recording, base64-encoded with its MIME type. */
  audio: z
    .strictObject({
      mimeType: z.string().trim().min(1),
      data: z.string().trim().min(1),
    })
    .optional(),
  /** A parse made elsewhere — on a device that could not reach the provider. */
  command: z.unknown().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const store = await getLiveStore();

  return NextResponse.json({
    proposals: await voiceQueue(session),
    provider: getProviders().reasoning.kind,
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

  const parsed = utteranceSchema.safeParse(body);
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

  const { facilityId, audio, command } = parsed.data;
  if ((audio === undefined) === (command === undefined)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'one-utterance',
        detail:
          'send either a recording to listen to or a parsed command to confirm, not both and not neither',
      },
      { status: 400 },
    );
  }

  const capturedAt = parsed.data.capturedAt ?? receivedAt;
  const observedOn = parsed.data.observedOn ?? capturedAt.slice(0, 10);

  let spoken: VoiceCaptureCommand;
  let source: 'model' | 'supplied';
  let model: string;
  let cacheHit: boolean;

  if (audio !== undefined) {
    try {
      const response = await getProviders().reasoning.reason(
        voiceCommandPrompt.request({
          // The recording is passed as it is. The platform does not transcribe
          // first: a transcript made in front of the model throws away how the
          // words were said, which is often what tells two drug names apart.
          audio: [{ mimeType: audio.mimeType, data: audio.data }],
        }),
      );
      spoken = response.value;
      source = 'model';
      model = response.model;
      cacheHit = response.cacheHit;
    } catch (error) {
      // No key, no recorded response, or an answer the schema rejected. All three
      // are the platform holding the utterance rather than guessing at it.
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
  } else {
    // The one-utterance rule above has already refused a request that carried
    // neither, so reaching here means a command was sent.
    const supplied = voiceCaptureCommandSchema.safeParse(command);
    if (!supplied.success) {
      return NextResponse.json(
        {
          outcome: 'refused',
          reason: 'invalid-command',
          detail: supplied.error.issues
            .map((issue) => `${issue.path.join('.') || 'command'}: ${issue.message}`)
            .join('; '),
        },
        { status: 400 },
      );
    }
    spoken = supplied.data;
    source = 'supplied';
    model = 'none';
    cacheHit = false;
  }

  try {
    const proposal = await recordVoiceCommand({
      session,
      facilityId,
      command: spoken,
      observedOn,
      capturedAt,
      receivedAt,
      source,
      model,
      cacheHit,
    });

    return NextResponse.json({
      outcome: 'awaiting-confirmation',
      proposal,
      source,
      model,
      cacheHit,
    });
  } catch (error) {
    if (error instanceof VoiceRefused) {
      return NextResponse.json(
        { outcome: 'refused', reason: 'not-permitted', detail: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
