import type { APIRequestContext } from '@playwright/test';

/**
 * Shared fixtures for the browser journeys.
 *
 * Everything here reads the platform's own published shape rather than a
 * hard-coded identifier, so a journey cannot pass by naming something that no
 * longer exists. The district and facility a test acts on are looked up by name
 * from the visibility read, which is the same read the interface uses.
 */

export interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly unit: string;
  readonly coldChain: boolean;
}

export interface DistrictSummary {
  readonly id: string;
  readonly name: string;
  readonly regionName: string;
  readonly facilities: number;
  readonly heard: number;
  readonly stale: number;
  readonly neverHeard: number;
}

export interface FacilityView {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly reading: {
    readonly status: 'current' | 'stale' | 'never-heard';
    readonly newestReadingOn: string | null;
    readonly daysSinceReading: number | null;
    readonly recentMovements: readonly { readonly id: string; readonly quantity: number }[];
    readonly beds: {
      readonly total: number;
      readonly occupied: number;
      readonly occupancy: number;
    } | null;
    readonly footfall: { readonly opd: number; readonly ipd: number } | null;
    readonly stock: {
      readonly itemsTracked: number;
      readonly itemsOutOfStock: number;
      readonly itemsBelowCritical: number;
      readonly itemsWithUnknownCover: number;
    } | null;
    readonly gap: {
      readonly count: number;
      readonly longestDays: number;
      readonly openSince: string | null;
    };
  };
}

export interface VisibilityPayload {
  readonly district: { readonly id: string; readonly name: string; readonly regionName: string };
  readonly districts: readonly DistrictSummary[];
  readonly facilities: readonly FacilityView[];
  readonly thresholds: { readonly staleAfterDays: number; readonly criticalCoverDays: number };
  readonly ledger: { readonly asOf: string };
  readonly store: {
    readonly seed: string;
    readonly fingerprint: string;
    readonly facilitiesWithHistory: number;
    readonly window: { readonly from: string; readonly to: string };
  };
}

export interface Session {
  readonly role: string;
  readonly scopeId: string | null;
  readonly label: string;
}

/** A session as the platform reads it from a cookie. */
export const sessionCookie = (session: Session): string =>
  `civora-session=${encodeURIComponent(JSON.stringify(session))}`;

const json = async <T>(response: {
  json: () => Promise<unknown>;
  ok: () => boolean;
  status: () => number;
}): Promise<T> => {
  if (!response.ok()) {
    throw new Error(`the platform answered ${String(response.status())}`);
  }
  return (await response.json()) as T;
};

export const readVisibility = async (
  request: APIRequestContext,
  options: { readonly districtId?: string; readonly session?: Session } = {},
): Promise<VisibilityPayload> => {
  const query =
    options.districtId === undefined ? '' : `?districtId=${encodeURIComponent(options.districtId)}`;
  const response = await request.get(`/api/visibility${query}`, {
    headers: options.session === undefined ? {} : { cookie: sessionCookie(options.session) },
  });
  return await json<VisibilityPayload>(response);
};

export const readCatalogue = async (
  request: APIRequestContext,
): Promise<readonly CatalogueItem[]> => {
  const response = await request.get('/api/catalogue');
  return (await json<{ items: readonly CatalogueItem[] }>(response)).items;
};

/** The identifier of a district, by the name an officer would use for it. */
export const districtIdNamed = async (
  request: APIRequestContext,
  name: string,
): Promise<string> => {
  const payload = await readVisibility(request);
  const district = payload.districts.find((candidate) => candidate.name === name);

  if (district === undefined) {
    throw new Error(`the demonstration network has no district named ${name}`);
  }

  return district.id;
};

/** A facility of a district, by tier, as the visibility read reports it. */
export const facilityOfTier = async (
  request: APIRequestContext,
  districtId: string,
  tier: string,
): Promise<FacilityView> => {
  const payload = await readVisibility(request, { districtId });
  const facility = payload.facilities.find((candidate) => candidate.tier === tier);

  if (facility === undefined) {
    throw new Error(`the demonstration district ${districtId} sites no ${tier}`);
  }

  return facility;
};

export interface IngestResult {
  readonly status: number;
  readonly body: {
    readonly outcome?: string;
    readonly reason?: string;
    readonly detail?: string;
    readonly subjectKey?: string;
    readonly conflict?: { readonly differences: readonly { readonly field: string }[] } | null;
  };
}

export const postIngest = async (
  request: APIRequestContext,
  envelope: unknown,
  session?: Session,
): Promise<IngestResult> => {
  const response = await request.post('/api/ingest', {
    data: envelope,
    headers: session === undefined ? {} : { cookie: sessionCookie(session) },
  });
  return { status: response.status(), body: (await response.json()) as IngestResult['body'] };
};

/** A stock movement, as the capture surface builds one. */
export const stockEnvelope = (input: {
  readonly facilityId: string;
  readonly itemId: string;
  readonly entryId: string;
  readonly key: string;
  readonly quantity: number;
  readonly kind?: 'receipt' | 'issue';
  readonly occurredOn: string;
  readonly capturedAt?: string;
}): unknown => ({
  type: 'stock_ledger_entry',
  idempotencyKey: input.key,
  captureSource: 'manual',
  capturedAt: input.capturedAt ?? new Date().toISOString(),
  observation: {
    id: input.entryId,
    facilityId: input.facilityId,
    itemId: input.itemId,
    kind: input.kind ?? 'receipt',
    quantity: input.quantity,
    adjustmentDirection: null,
    occurredOn: input.occurredOn,
    batchId: (input.kind ?? 'receipt') === 'receipt' ? `e2e-batch-${input.entryId}` : null,
    expiresOn: (input.kind ?? 'receipt') === 'receipt' ? '2027-12-31' : null,
    correctsEntryId: null,
    counterpartFacilityId: null,
    transferId: null,
  },
});

/** A bed report, as the capture surface builds one. */
export const bedEnvelope = (input: {
  readonly facilityId: string;
  readonly key: string;
  readonly observedOn: string;
  readonly bedsTotal: number;
  readonly bedsOccupied: number;
}): unknown => ({
  type: 'bed_status',
  idempotencyKey: input.key,
  captureSource: 'manual',
  capturedAt: new Date().toISOString(),
  observation: {
    facilityId: input.facilityId,
    observedOn: input.observedOn,
    bedsTotal: input.bedsTotal,
    bedsOccupied: input.bedsOccupied,
  },
});

/** Today, in the same form the platform's dates take. */
export const today = (): string => new Date().toISOString().slice(0, 10);
