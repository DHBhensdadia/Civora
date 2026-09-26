/**
 * One JSON line per event, and the correlation id that joins them.
 *
 * A leaf module with no imports on purpose: `middleware.ts` runs on every path,
 * including the ones served from the edge runtime, and it must not drag the
 * store, the dataset or the reasoning adapters into that bundle. So the writer
 * lives here, and the readiness and metrics reads — which are Node work — live
 * beside it in `observability.ts`.
 *
 * A log a person reads with their eyes is a log nobody can query, and the
 * question this platform's logs have to answer is rarely "what happened at ten
 * past four" but "which requests did this correlation id touch". So: one line per
 * event, machine-parseable, carrying the request's id, and **no personal data**.
 *
 * That last part is enforced rather than intended. A field whose *key* looks like
 * a person's is withheld and the key named under `withheld`, so a defect is
 * visible in the line that would have carried it instead of being written or
 * silently dropped. Keys are matched, never values: a value is whatever the
 * caller sends, while a key is a shape a reviewer can read in the source.
 */

/** The header a caller may supply, and the one this platform answers with. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * The correlation id for one request.
 *
 * A caller's id is honoured rather than replaced, because the point is to join
 * this platform's lines to whatever sent the request — but only when it is
 * plausibly an identifier. A value carrying newlines would let a caller forge
 * entries in a file a person reads as structured, so anything outside the allowed
 * shape is replaced by one this process minted.
 */
export const correlationIdOf = (supplied: string | null | undefined): string =>
  supplied !== null && supplied !== undefined && /^[A-Za-z0-9._:-]{8,96}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();

/** Levels a line may carry. `warn` and `error` are the ones a person greps for. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What every line says about where it came from. */
export const LOG_SERVICE = 'civora-web';

/**
 * Key fragments that mean a value belongs to a person rather than to a platform.
 *
 * Fragments rather than exact names, because a leaking field is `patientName` on
 * one form and `patient_name` on the next. Deliberately **not** the bare word
 * `name`: every key this platform logs has one — `fileName`, `facilityName`,
 * `itemName` — and a rule that withheld all of them would be a rule nobody keeps.
 * The person's own spellings are listed instead.
 */
export const PERSONAL_KEY_FRAGMENTS = [
  'patient',
  'person',
  'aadhaar',
  'abha',
  'phone',
  'mobile',
  'contact',
  'address',
  'guardian',
  'relative',
  'dateofbirth',
  'birthdate',
  'fullname',
  'surname',
] as const;

export const looksPersonal = (key: string): boolean => {
  const flattened = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return PERSONAL_KEY_FRAGMENTS.some((fragment) => flattened.includes(fragment));
};

export interface LogRecord {
  readonly level: LogLevel;
  /** A stable event name, dotted: `request.received`, `request.handled`. */
  readonly event: string;
  readonly correlationId: string;
  /** Values are strings, numbers and booleans so a log store can index them. */
  readonly fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/**
 * The writer, in one place.
 *
 * `process.stdout` where it exists — the standalone server and the container both
 * have it — with the console as the fallback, because the middleware sandbox does
 * not expose it. A log line that cannot be written must never take a request down
 * with it, which is the other reason this is guarded rather than asserted.
 */
const writeLine = (line: string): void => {
  // `Reflect.get` rather than `process.stdout`, because the types say the stream
  // is always there and the sandbox this runs in for some requests is not
  // obliged to agree. Reading it reflectively is what lets the guard be written
  // at all, and a missing stream falls back to the console rather than throwing
  // inside a request.
  const stdout = Reflect.get(process, 'stdout') as { write?: (chunk: string) => void } | undefined;
  if (typeof stdout?.write === 'function') {
    stdout.write(line);
    return;
  }
  console.log(line);
};

/** Write one structured line. This is the only function that writes one. */
export const logLine = (record: LogRecord): void => {
  const fields: Record<string, string | number | boolean | null> = {};
  const withheld: string[] = [];

  for (const [key, value] of Object.entries(record.fields ?? {})) {
    if (looksPersonal(key)) {
      withheld.push(key);
      continue;
    }
    fields[key] = value;
  }

  writeLine(
    `${JSON.stringify({
      at: new Date().toISOString(),
      level: record.level,
      event: record.event,
      correlationId: record.correlationId,
      service: LOG_SERVICE,
      ...fields,
      ...(withheld.length === 0 ? {} : { withheld }),
    })}\n`,
  );
};

/**
 * One line for a request that has been answered.
 *
 * The path but not the query: a query string is where an identifier ends up when
 * nobody meant to send one, and a path is what an operator groups by.
 */
export const logHandled = (input: {
  readonly correlationId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}): void => {
  logLine({
    level: input.status >= 500 ? 'error' : input.status >= 400 ? 'warn' : 'info',
    event: 'request.handled',
    correlationId: input.correlationId,
    fields: {
      method: input.method,
      path: input.path,
      status: input.status,
      durationMs: input.durationMs,
    },
  });
};
