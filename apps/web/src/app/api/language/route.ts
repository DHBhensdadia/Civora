import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { isSupported } from '@civora/i18n';

import { LANGUAGE_COOKIE, languageFrom, offeredLanguages } from '@/lib/language';

/**
 * The interface language: read it, or choose another.
 *
 * A refusal here is a 400 naming the languages this build offers rather than a
 * silent fallback to English. That distinction matters for the same reason the
 * advisory panel names an unknown tag instead of relabelling it: a reader who
 * asked for a language and was quietly given another has been told something
 * untrue about what they are reading.
 */

export const dynamic = 'force-dynamic';

const choiceSchema = z.strictObject({ language: z.string().trim().min(2) });

const payload = (language: string): Record<string, unknown> => ({
  language,
  offered: offeredLanguages(),
  /** Said here as well as in the picker: this is the interface, not the record. */
  note: 'This selects the language the capture and alert flows read. It does not translate a record, and an alert body is shown in the language the record carries it in.',
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json(payload(languageFrom(request.cookies.get(LANGUAGE_COOKIE)?.value)));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { outcome: 'refused', reason: 'malformed-body', detail: 'the request body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = choiceSchema.safeParse(body);
  if (!parsed.success || !isSupported(parsed.data.language)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'unsupported-language',
        detail: `this build offers ${offeredLanguages()
          .map((language) => language.code)
          .join(', ')}`,
      },
      { status: 400 },
    );
  }

  const response = NextResponse.json(payload(parsed.data.language));
  response.cookies.set({
    name: LANGUAGE_COOKIE,
    value: parsed.data.language,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
