import type { DemandPoint, DemandSeries } from '@civora/forecasting';
import { describe, expect, it } from 'vitest';

import { buildSiloSamples } from './features';
import { trainLocally } from './local';
import { linearShape } from './model';
import { inspectSiloPayload, sentinelsFound, serialiseSiloPayload, siloPayloadOf } from './payload';
import type { SiloPayload } from './payload';

/**
 * The phase's blocking test.
 *
 * The claim is "no raw record crosses a silo boundary", and a claim like that is
 * only worth anything if it can fail. So the silo's records are loaded with
 * **sentinels** — the facility's own identifier, the item's, a batch string and
 * a quantity that exists nowhere else — and the test asserts first that the raw
 * input really carries them (or the scan would be vacuous), then that none of
 * them is findable in the payload that actually crosses, and finally that the
 * same check *does* fire on payloads built to leak.
 */

const FACILITY = 'SIM-BIHAR-GAYA-B1-CHC-03';
const ITEM = 'nlem-15-1-furosemide';
const BATCH = 'BATCH-7f3a-9911';
const QUANTITY = 97531.2468;
const DAY = '2026-03-01';

const SENTINELS: readonly (string | number)[] = [FACILITY, ITEM, BATCH, QUANTITY, DAY];

const rawSeries = (): DemandSeries => {
  const points: DemandPoint[] = Array.from({ length: 60 }, (_unused, index) => ({
    on: `2026-02-${String((index % 28) + 1).padStart(2, '0')}`,
    issued: index === 2 ? QUANTITY : 4 + (index % 3),
    onHand: 100,
  }));
  points[1] = { on: DAY, issued: 6, onHand: 90 };
  return {
    facilityId: FACILITY as DemandSeries['facilityId'],
    itemId: ITEM as DemandSeries['itemId'],
    points,
  };
};

describe('the payload that crosses the silo boundary', () => {
  it('carries no sentinel from the records it was trained on', () => {
    const series = rawSeries();
    const built = buildSiloSamples([series], { minHistoryDays: 28 });
    const trained = trainLocally({
      shape: linearShape(built.featureNames.length),
      global: new Array<number>(built.featureNames.length + 1).fill(0),
      samples: built.samples,
      options: { seed: 'payload', epochs: 1, batchSize: 32 },
    });

    // The raw input really does contain every sentinel, so the assertion below
    // is a statement about the boundary and not about empty data. The series
    // alone names the facility and the item; the lot rows are where a batch
    // string lives, and a silo does hold them.
    const raw = JSON.stringify({
      series,
      lots: [
        { batchId: BATCH, itemId: ITEM, facilityId: FACILITY, quantity: QUANTITY, expiry: DAY },
      ],
    });
    for (const sentinel of SENTINELS) {
      expect(raw.includes(String(sentinel))).toBe(true);
    }

    const payload = siloPayloadOf({
      siloId: FACILITY, // the silo's own identity is allowed by design; see below
      sampleCount: built.samples.length,
      update: trained.update,
      localLoss: trained.firstLoss,
    });

    // The silo's identity is not a record — it is who is speaking — so it is
    // checked here deliberately: it is the one string allowed to equal a
    // sentinel, and the test proves the check is scoped to everything else.
    const inspection = inspectSiloPayload(
      payload,
      SENTINELS.filter((value) => value !== FACILITY),
    );
    expect(inspection.findings).toEqual([]);
    expect(inspection.ok).toBe(true);
    expect(sentinelsFound(payload, [ITEM, BATCH, QUANTITY, DAY])).toEqual([]);

    const serialised = serialiseSiloPayload(payload);
    expect(serialised).not.toContain(ITEM);
    expect(serialised).not.toContain(BATCH);
    expect(serialised).not.toContain(DAY);
    expect(serialised).not.toContain(String(QUANTITY));
  });

  it('fires on exactly the leaks it exists for', () => {
    const leaking = {
      kind: 'silo-update',
      siloId: FACILITY,
      sampleCount: 10,
      localLoss: 0.5,
      parameterNorm: 1,
      update: [0.1, 0.2],
      // A payload like this is what a careless implementation sends: the row it
      // was trained on, "for context".
      features: [QUANTITY, 6, 90],
    } as unknown as SiloPayload;

    const found = inspectSiloPayload(leaking, SENTINELS);
    expect(found.ok).toBe(false);
    expect(found.findings.some((finding) => finding.includes('unexpected field'))).toBe(true);
    expect(found.findings.some((finding) => finding.includes(QUANTITY.toString()))).toBe(true);
  });

  it('catches a record identifier smuggled through a declared field', () => {
    const smuggled = {
      kind: 'silo-update',
      siloId: BATCH,
      sampleCount: 10,
      localLoss: 0.5,
      parameterNorm: 1,
      update: [0.1, 0.2],
    } as SiloPayload;
    const found = inspectSiloPayload(smuggled, SENTINELS);
    expect(found.ok).toBe(false);
    expect(found.findings.some((finding) => finding.includes(BATCH))).toBe(true);
  });

  it('refuses a payload whose numbers are not numbers', () => {
    const infinite = {
      kind: 'silo-update',
      siloId: 's',
      sampleCount: 1,
      localLoss: 0,
      parameterNorm: 1,
      update: [Number.NaN],
    } as SiloPayload;
    expect(inspectSiloPayload(infinite).findings.some((f) => f.includes('finite number'))).toBe(
      true,
    );

    const textual = {
      kind: 'silo-update',
      siloId: 's',
      sampleCount: 1,
      localLoss: 0,
      parameterNorm: 1,
      update: ['2026-03-01'],
    } as unknown as SiloPayload;
    const found = inspectSiloPayload(textual, SENTINELS);
    expect(found.ok).toBe(false);
    expect(found.findings.length).toBeGreaterThan(0);
  });

  it('serialises canonically, so a round hash is comparable across processes', () => {
    const payload = {
      kind: 'silo-update' as const,
      siloId: 'SIM-BIHAR',
      sampleCount: 3,
      localLoss: 0.25,
      parameterNorm: 0.5,
      update: [0.1, -0.2],
    };
    const reordered = {
      update: [0.1, -0.2],
      parameterNorm: 0.5,
      localLoss: 0.25,
      sampleCount: 3,
      siloId: 'SIM-BIHAR',
      kind: 'silo-update' as const,
    };
    expect(serialiseSiloPayload(payload)).toBe(serialiseSiloPayload(reordered));
  });
});
