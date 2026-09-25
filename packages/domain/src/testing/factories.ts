import {
  SIMULATED_PROVENANCE,
  facilityIdSchema,
  itemIdSchema,
} from '../model/common';
import type { DateOnly, FacilityId, ItemId } from '../model/common';
import { facilitySchema } from '../model/administrative';
import type { Facility } from '../model/administrative';
import { itemSchema } from '../model/catalogue';
import type { Item } from '../model/catalogue';
import { stockLedgerEntrySchema } from '../model/sensing';
import type { StockLedgerEntry } from '../model/sensing';

/**
 * Factories for valid records.
 *
 * Tests and fixtures both need records that satisfy their schema without four
 * screens of setup. Everything here produces schema-valid values, so a test
 * that fails is testing behaviour rather than accidentally testing validation.
 */

/** The date these fixtures are anchored to, so tests never read a clock. */
export const BASE_DATE: DateOnly = '2026-01-01';

export const FACILITY_A: FacilityId = facilityIdSchema.parse('facility-a');
export const FACILITY_B: FacilityId = facilityIdSchema.parse('facility-b');
export const ITEM_PARACETAMOL: ItemId = itemIdSchema.parse('item-paracetamol');

/**
 * Overrides accepted by the factories.
 *
 * `id` is declared explicitly because the idempotency key defaults to it, and
 * because reading a property out of a bare index signature is a type error
 * under `noPropertyAccessFromIndexSignature`.
 */
export interface RecordOverrides {
  /** Identifier for the record; the idempotency key defaults to `key-<id>`. */
  readonly id?: string;
  readonly [field: string]: unknown;
}

const DEFAULT_ENTRY: Record<string, unknown> = {
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  kind: 'issue',
  quantity: 1,
  adjustmentDirection: null,
  occurredOn: BASE_DATE,
  recordedAt: '2026-01-01T09:00:00.000Z',
  batchId: null,
  expiresOn: null,
  correctsEntryId: null,
  counterpartFacilityId: null,
  transferId: null,
  synthetic: true,
  provenance: SIMULATED_PROVENANCE,
};

/**
 * A valid ledger entry.
 *
 * The idempotency key derives from the identifier so that two entries built
 * without explicit keys are two distinct movements, and a test that wants a
 * duplicate has to say so.
 */
export const aLedgerEntry = (overrides: RecordOverrides = {}): StockLedgerEntry => {
  const id = typeof overrides.id === 'string' ? overrides.id : 'entry-1';
  return stockLedgerEntrySchema.parse({
    ...DEFAULT_ENTRY,
    id,
    idempotencyKey: `key-${id}`,
    ...overrides,
  });
};

/** A stream of daily issues from `facility-a` of the default item. */
export const dailyIssues = (quantities: readonly number[], from: DateOnly = BASE_DATE): StockLedgerEntry[] => {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  return quantities
    .map((quantity, offset) => ({ quantity, offset }))
    .filter(({ quantity }) => quantity > 0)
    .map(({ quantity, offset }) => {
      const occurredOn = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
      return aLedgerEntry({
        id: `issue-${occurredOn}`,
        kind: 'issue',
        quantity,
        occurredOn,
        recordedAt: `${occurredOn}T09:00:00.000Z`,
      });
    });
};

/** A receipt of stock, with the batch and expiry the schema requires. */
export const aReceipt = (overrides: RecordOverrides = {}): StockLedgerEntry => {
  const id = typeof overrides.id === 'string' ? overrides.id : 'receipt-1';
  return aLedgerEntry({
    id,
    kind: 'receipt',
    quantity: 100,
    batchId: `${id}-batch`,
    expiresOn: '2027-01-01',
    ...overrides,
  });
};

export const aFacility = (overrides: RecordOverrides = {}): Facility =>
  facilitySchema.parse({
    id: FACILITY_A,
    name: 'Primary Health Centre, Demo North',
    tier: 'PHC',
    blockId: 'block-a',
    districtId: 'district-a',
    regionId: 'region-a',
    lgdCode: 'LGD-PHC-0001',
    coordinates: { latitude: 20.2961, longitude: 85.8245 },
    catchmentPopulation: 25_000,
    normPopulation: 25_000,
    sanctionedPosts: 12,
    sanctionedBeds: 6,
    connectivity: 'intermittent',
    coldChain: { available: true, reliability: 0.8 },
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

export const anItem = (overrides: RecordOverrides = {}): Item =>
  itemSchema.parse({
    id: ITEM_PARACETAMOL,
    nlemCode: 'NLEM-1.1',
    genericName: 'Paracetamol',
    form: 'tablet',
    strength: '500 mg',
    unit: 'tablet',
    category: 'analgesic',
    essentiality: 'essential',
    storage: 'ambient',
    coldChain: false,
    // Paracetamol is listed at every level of care, which is what makes it a
    // reasonable default for a fixture and keeps this factory usable at any tier.
    careLevels: ['primary', 'secondary', 'tertiary'],
    shelfLifeDays: 730,
    packSize: 10,
    unitsPerCase: 12,
    syndromes: ['fever'],
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });
