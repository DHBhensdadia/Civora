import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { CORRELATION_HEADER, correlationIdOf, logLine } from '@/lib/log';

/**
 * A correlation id on every request, and one line of JSON to say so.
 *
 * This runs before every path, which is the only place a platform can promise that
 * *every* request has an id rather than the ones somebody remembered to
 * instrument. A caller's own id is taken when they send a plausible one, so a
 * deployment's gateway id and a bug report's id are the same string; otherwise one
 * is minted here. The id is forwarded to the route (which can then log its own
 * `request.handled` line against it) and echoed on the response, so a client can
 * quote something that will find the lines.
 *
 * This is the file Next calls `proxy` — the convention it renamed from
 * `middleware` — and `e2e/observability.spec.ts` asserts it from outside rather
 * than trusting the convention: a request carrying an id gets that id back, and one
 * carrying none gets a minted one.
 *
 * Two deliberate limits. **The query string is not logged**, because that is where
 * an identifier arrives when nobody meant to send one. And this imports only
 * `lib/log`, a module with no dependencies, because this runs in the edge runtime
 * on every path and pulling the store, the dataset or the model adapters into that
 * bundle would be both slow and wrong.
 */
export function proxy(request: NextRequest): NextResponse {
  const correlationId = correlationIdOf(request.headers.get(CORRELATION_HEADER));

  logLine({
    level: 'info',
    event: 'request.received',
    correlationId,
    fields: { method: request.method, path: request.nextUrl.pathname },
  });

  const forwarded = new Headers(request.headers);
  forwarded.set(CORRELATION_HEADER, correlationId);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

/**
 * Every path a person or a probe reaches; nothing that is served as a file.
 *
 * Built static assets and the service worker are excluded because a page load
 * would otherwise write dozens of lines that say nothing about the request anyone
 * cares about — and the offline shell must keep working exactly as it did, since a
 * worker's own fetches are not requests this platform is being asked to serve.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|samples/).*)',
  ],
};
