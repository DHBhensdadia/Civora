import { FACILITY_A, ITEM_PARACETAMOL } from '@civora/domain/testing';
import { addDays } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  WarehouseResultError,
  bqmlBackend,
  buildForecastSql,
  forecastParameters,
  historyRows,
  mapForecastRows,
  statBackend,
  unavailableBackend,
} from './bqml';
import { compareBackends } from './parity';
import type { DemandPoint, DemandSeries, ForecastRequest } from './types';

/**
 * The warehouse adapter.
 *
 * Everything below runs against rows written out by hand, because no BigQuery
 * project is reachable from this environment. That is stated on every figure the
 * adapter produces, and the tests here deliberately cover the two ways a
 * warehouse response goes wrong quietly: a short horizon and a bound below the
 * median. Both would otherwise be read as a smaller forecast rather than as a
 * failure.
 */

const FROM = '2026-01-01';

const seriesOf = (issued: readonly number[]): DemandSeries => ({
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  points: issued.map((value, index): DemandPoint => ({
    on: addDays(FROM, index),
    issued: value,
    onHand: 100,
  })),
});

const request: ForecastRequest = {
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  asOf: '2026-04-01',
  horizonDays: 5,
  seed: 'fixture',
  synthetic: true,
  provenance: { kind: 'derived', reference: 'bqml-fixture' },
};

/** Seven days of a plausible response, as BigQuery returns them. */
const rowsFor = (horizon: number): readonly Record<string, unknown>[] =>
  Array.from({ length: horizon }, (_, index) => ({
    day: addDays('2026-04-02', index),
    // Numerics arrive as strings through several BigQuery client libraries, and
    // the mapper has to read them.
    p50: String(20 + index),
    lower: String(10 + index),
    p90: String(30 + index * 2),
    confidence_level: 0.9,
  }));

describe('the BigQuery ML adapter', () => {
  it('binds the facility, the item and the horizon rather than splicing them', () => {
    const sql = buildForecastSql({ model: 'timesfm' });

    expect(sql).toContain('@facility_id');
    expect(sql).toContain('@horizon_days');
    expect(sql).toContain('AI.FORECAST');
    // The censored-day decision is explained where the query is, so the next
    // reader does not correct it away.
    expect(sql).toContain('Censored days are sent at zero ON PURPOSE');

    const parameters = forecastParameters(request);
    expect(parameters).toContain(FACILITY_A);
    expect(parameters).toContain(ITEM_PARACETAMOL);
    expect(parameters).toContain(request.horizonDays);
  });

  it('generates the covariate path when asked for it', () => {
    const sql = buildForecastSql({ model: 'arima-plus-xreg' });

    expect(sql).toContain('ML.FORECAST');
    expect(sql).toContain('ARIMA_PLUS_XREG');
    expect(sql).toContain('external regressor');
  });

  it('sends the history as recorded, censored days and all', () => {
    // Pre-correcting the history would be handing the warehouse this project's
    // answer and then measuring agreement with itself.
    const series = seriesOf([...Array.from({ length: 20 }, () => 12), 0, 0, 12]);
    const rows = historyRows(series);

    expect(rows).toHaveLength(23);
    expect(rows[20]?.issued).toBe(0);
    expect(rows[20]?.on_hand).toBe(100);
  });

  it('maps a response to the same shape the local engine produces', () => {
    const outcome = mapForecastRows(
      rowsFor(5),
      request,
      seriesOf([...Array.from({ length: 60 }, () => 20)]),
    );

    expect(outcome.forecast.p50).toEqual([20, 21, 22, 23, 24]);
    expect(outcome.forecast.p90).toEqual([30, 32, 34, 36, 38]);
    expect(outcome.forecast.imputation).toBe('none');
    expect(outcome.forecast.censoredDaysImputed).toBe(0);
    expect(outcome.forecast.modelVersion).toContain('bqml');
    // The one thing a reader must not have to infer from a footnote.
    expect(outcome.forecast.warnings.join(' ')).toContain('not verified by any test');
    expect(outcome.cumulativeP90).toEqual([30, 62, 96, 132, 170]);
  });

  it('refuses a response that does not cover the horizon rather than reading a shorter one', () => {
    expect(() =>
      mapForecastRows(rowsFor(3), request, seriesOf(Array.from({ length: 60 }, () => 20))),
    ).toThrow(WarehouseResultError);
  });

  it('refuses a response with no usable number in a column', () => {
    const broken = [...rowsFor(5)];
    broken[2] = { ...broken[2], p50: null };

    expect(() =>
      mapForecastRows(broken, request, seriesOf(Array.from({ length: 60 }, () => 20))),
    ).toThrow(/no usable "p50"/);
  });

  it('never lets the upper bound fall below the median', () => {
    const inverted = rowsFor(5).map((row) => ({ ...row, p90: 1 }));

    const outcome = mapForecastRows(
      inverted,
      request,
      seriesOf(Array.from({ length: 60 }, () => 20)),
    );

    expect(
      outcome.forecast.p90.every((value, index) => value >= (outcome.forecast.p50[index] ?? 0)),
    ).toBe(true);
  });

  it('runs through a port, and says so when there is no port to run through', async () => {
    const asked: string[] = [];
    const backend = bqmlBackend({
      project: 'demo-project',
      dataset: 'demo',
      run: (sql) => {
        asked.push(sql);
        return Promise.resolve(rowsFor(request.horizonDays));
      },
    });

    const outcome = await backend.forecast(seriesOf(Array.from({ length: 60 }, () => 20)), request);

    expect(backend.available).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('AI.FORECAST');
    expect(outcome.forecast.p50).toHaveLength(request.horizonDays);

    const blocked = unavailableBackend('no Google Cloud project is configured');
    expect(blocked.available).toBe(false);
    expect(() => blocked.forecast(seriesOf([1, 2]), request)).toThrow(/no Google Cloud project/);
  });

  it('exposes the local engine behind the same contract', async () => {
    expect(statBackend.name).toBe('stat');
    expect(statBackend.available).toBe(true);
    // `await` normalises the local engine's synchronous answer and the
    // warehouse's promise, which is what lets one harness drive both.
    const outcome = await statBackend.forecast(
      seriesOf(Array.from({ length: 60 }, (_, index) => 10 + (index % 7))),
      { ...request, horizonDays: 7 },
    );
    expect(outcome.forecast.p50).toHaveLength(7);
  });
});

describe('comparing the two backends', () => {
  const entries = Array.from({ length: 6 }, (_, index) => {
    const series = seriesOf(Array.from({ length: 90 }, (_, day) => 10 + (day % 7) + index));
    return { series, latent: series.points.map((point) => point.issued) };
  });

  const options = {
    horizonDays: 7,
    strideDays: 7,
    minimumHistoryDays: 28,
    maxOriginsPerSeries: 6,
    bootstrapReplications: 40,
    seasonLength: 7,
  };

  it('reports the disagreements rather than an average, and what they were computed on', async () => {
    // A warehouse that agrees exactly: the gaps must come out at zero, so a
    // harness that reported agreement for any response is caught.
    const agreeing = bqmlBackend({
      project: 'demo-project',
      dataset: 'demo',
      run: (_sql, parameters) => {
        const horizon = Number(parameters[2]);
        return Promise.resolve(rowsFor(horizon));
      },
    });

    const parity = await compareBackends({
      entries,
      options,
      backend: agreeing,
      basis: 'recorded rows, not a live BigQuery project',
    });

    expect(parity.executed).toBe(true);
    expect(parity.basis).toContain('not a live BigQuery project');
    expect(parity.origins).toBeGreaterThan(0);
    expect(parity.agreeWithinTenPercent).toBeGreaterThanOrEqual(0);
    expect(parity.worst.length).toBeLessThanOrEqual(5);
    expect(parity.worst.every((entry) => entry.relativeGap >= 0)).toBe(true);
  });

  it('reports a backend it could not run, with the reason, instead of a zero', async () => {
    const parity = await compareBackends({
      entries,
      options,
      backend: unavailableBackend('no Google Cloud credentials or project are configured'),
      basis: 'nothing: the backend could not be reached',
    });

    expect(parity.executed).toBe(false);
    expect(parity.origins).toBe(0);
    expect(parity.reason).toContain('no Google Cloud credentials');
    expect(parity.worst).toEqual([]);
  });
});
