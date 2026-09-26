import { vectorNorm } from './model';
import type { SiloUpdate } from './types';

/**
 * What a silo is allowed to send, and the check that makes the privacy claim
 * falsifiable.
 *
 * "Your data never leaves the state" is worth exactly as much as the test
 * behind it. This module defines the update payload as a **closed** object — six
 * fields, five numbers and one array of numbers, plus the silo's own identity —
 * and the assertion below serialises the real payload and refuses it if anything
 * outside that shape appears: an unexpected key, a non-finite number, or any
 * **sentinel value** the caller injected into the silo's raw records. The
 * sentinel scan is the part that cannot be satisfied by a well-typed empty shell:
 * a string that names a facility, an item, a batch or a day must not be findable
 * anywhere in the bytes that cross.
 *
 * The three rules live here as functions rather than inside one inspection,
 * because a second payload crosses the boundary — the per-feature sums and counts
 * that fix the shared training basis (`scaling.ts`) — and a second payload held to
 * weaker rules than the first would be the first crack in the claim.
 */

export const ALLOWED_PAYLOAD_FIELDS = [
  'kind',
  'siloId',
  'sampleCount',
  'localLoss',
  'parameterNorm',
  'update',
] as const;

export interface SiloPayload {
  readonly kind: 'silo-update';
  readonly siloId: string;
  readonly sampleCount: number;
  readonly localLoss: number;
  /** The norm of the vector, so a reader can see the clip actually applied. */
  readonly parameterNorm: number;
  readonly update: readonly number[];
}

export const siloPayloadOf = (update: SiloUpdate): SiloPayload => ({
  kind: 'silo-update',
  siloId: update.siloId,
  sampleCount: update.sampleCount,
  localLoss: update.localLoss,
  parameterNorm: vectorNorm(update.update),
  update: update.update,
});

/**
 * A canonical serialisation: fixed key order and full precision.
 *
 * Canonical because a hash of this string is how a round ledger records what
 * crossed, and two runs of the same round should hash the same.
 */
export function serialiseSiloPayload(payload: SiloPayload): string {
  const ordered = {
    kind: payload.kind,
    siloId: payload.siloId,
    sampleCount: payload.sampleCount,
    localLoss: payload.localLoss,
    parameterNorm: payload.parameterNorm,
    update: payload.update,
  };
  return JSON.stringify(ordered);
}

export interface PayloadInspection {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly serialised: string;
}

/**
 * The text a sentinel scan reads: the object as it was received.
 *
 * `serialiseSiloPayload` is the *canonical* form — it emits only allow-listed
 * fields, in a fixed order, and its hash is what a round ledger records. That
 * makes it the wrong text for this job: a leak arrives as a field the payload
 * should not have at all, and the canonical serialisation would drop it before
 * the scan ever saw it. So the scan reads the whole received object, and an
 * object that cannot be serialised at all is `null` rather than silently
 * skipped — a payload whose bytes cannot be inspected is not a passing payload.
 */
export function scanTextOf(payload: unknown): string | null {
  try {
    const text = JSON.stringify(payload);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Rule one: every key is on the allow-list, and nothing else is present. */
export function fieldFindings(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): readonly string[] {
  const findings: string[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      findings.push(`unexpected field "${key}" is not part of the allow-list`);
    }
  }
  return findings;
}

/** Rule two: a declared numeric vector holds finite numbers and nothing else. */
export function vectorFindings(label: string, values: unknown): readonly string[] {
  if (!Array.isArray(values)) {
    return [`${label} is not an array, so it could carry a nested structure`];
  }
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? []
    : [`${label} contains a value that is not a finite number`];
}

/** Rule three: no value from the silo's raw records is findable in the bytes. */
export function sentinelFindings(
  payload: unknown,
  sentinels: readonly (string | number)[],
): readonly string[] {
  const scanned = scanTextOf(payload);
  if (scanned === null) {
    return ['the payload could not be serialised, so its fields cannot be inspected'];
  }
  return sentinels
    .map((sentinel) => String(sentinel))
    .filter((text) => text.length > 0 && scanned.includes(text))
    .map((text) => `sentinel "${text}" from the silo's raw records appears in the payload`);
}

/**
 * The blocking check, in full.
 *
 * Every failure names what it found, because a privacy assertion that says
 * "invalid" without saying why is one nobody can act on. `sentinels` are values
 * the caller planted in the silo's records — a facility id, an item id, a batch
 * id, a date, a distinctive quantity — and each one found in the payload is a
 * finding, not a warning.
 */
export function inspectSiloPayload(
  payload: SiloPayload,
  sentinels: readonly (string | number)[] = [],
): PayloadInspection {
  const record = payload as unknown as Record<string, unknown>;
  const findings = [
    ...fieldFindings(record, ALLOWED_PAYLOAD_FIELDS),
    ...vectorFindings('update', payload.update),
    ...sentinelFindings(payload, sentinels),
  ];

  return { ok: findings.length === 0, findings, serialised: serialiseSiloPayload(payload) };
}

/** Every sentinel found, for a caller that wants the list without the verdict. */
export function sentinelsFound(
  payload: unknown,
  sentinels: readonly (string | number)[],
): readonly string[] {
  const text = scanTextOf(payload) ?? '';
  return sentinels
    .map((sentinel) => String(sentinel))
    .filter((value) => value.length > 0 && text.includes(value));
}
