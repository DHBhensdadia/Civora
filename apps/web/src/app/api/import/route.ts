import { IMPORT_FORMATS } from '@civora/domain';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { ImportRefused, acceptImport, previewImport, readImports } from '@/lib/import-service';
import { SESSION_COOKIE, canImport, parseSession } from '@/lib/session';

/**
 * Handing the platform a file.
 *
 * Three operations, deliberately distinct: `GET` lists the files already
 * accepted, `POST` decides a file without writing it, and `PUT` accepts it. The
 * separation is the phase's own requirement — validation errors have to be
 * visible *before* anything is written — and it is also the honest shape of the
 * act: checking a file and accepting it are two decisions, and a platform that
 * collapsed them would make the first one invisible.
 *
 * The file arrives as text in the body. A deployment would take a multipart
 * upload and a signed URL; a demonstration takes the text, and the register
 * records the digest either way, because the digest is what identifies the file
 * and not the transport.
 */

export const dynamic = 'force-dynamic';

/** A file larger than this is a file nobody meant to send here. */
const MAX_BYTES = 1_000_000;

const importSchema = z.strictObject({
  format: z.enum(IMPORT_FORMATS),
  fileName: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(MAX_BYTES),
});

const readBody = async (request: NextRequest): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const refused = (error: unknown): NextResponse => {
  if (error instanceof ImportRefused) {
    return NextResponse.json(
      { outcome: 'refused', reason: 'not-accepted', detail: error.message },
      { status: error.status },
    );
  }
  throw error;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  // The register names who accepted what. It is read by the roles that may
  // import, and refused to the rest with the same sentence a file would get.
  if (!canImport(session)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-permitted',
        detail: `${session.label} is scoped to a place, and the register names every file the platform has taken; it is read by a district officer and above`,
      },
      { status: 403 },
    );
  }

  try {
    return NextResponse.json({ outcome: 'read', imports: await readImports() });
  } catch (error) {
    return refused(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const body = await readBody(request);
  const parsed = importSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-a-file',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({
      outcome: 'checked',
      session: { label: session.label, role: session.role },
      preview: await previewImport(session, parsed.data),
    });
  } catch (error) {
    return refused(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
  const body = await readBody(request);
  const parsed = importSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'not-a-file',
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
          .join('; '),
      },
      { status: 400 },
    );
  }

  try {
    const accepted = await acceptImport(session, parsed.data);
    return NextResponse.json({
      outcome: 'accepted',
      record: accepted.record,
      preview: accepted.preview,
      wrote: accepted.wrote,
      auditId: accepted.auditId,
    });
  } catch (error) {
    return refused(error);
  }
}
