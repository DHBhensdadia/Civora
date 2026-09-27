import type { ReasoningTelemetry } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { telemetryViewOf, volumeProjectionOf } from './telemetry';

/**
 * What the telemetry panel is allowed to claim.
 *
 * The rules asserted here are the ones a reader would otherwise have to take on
 * trust: that the numbers carry the adapter they came from, that an unknown token
 * count is not rendered as zero, that the mean is absent rather than `NaN` when
 * nothing ran, and that the volume figures are arithmetic over this inbox rather
 * than a constant somebody typed.
 */

function aReport(overrides: Partial<ReasoningTelemetry> = {}): ReasoningTelemetry {
  return {
    model: 'gemini-3.8-flash',
    calls: 4,
    attempts: 5,
    cacheHits: 1,
    failures: 2,
    totalInputTokens: 1200,
    totalOutputTokens: 300,
    totalDurationMs: 800,
    perTask: [
      {
        task: 'advisory-generation@2',
        calls: 3,
        attempts: 4,
        cacheHits: 1,
        failures: 2,
        totalInputTokens: 900,
        totalOutputTokens: 200,
        totalDurationMs: 600,
      },
      {
        task: 'stock-extraction@1',
        calls: 1,
        attempts: 1,
        cacheHits: 0,
        failures: 0,
        totalInputTokens: 300,
        totalOutputTokens: 100,
        totalDurationMs: 200,
      },
    ],
    ...overrides,
  };
}

const AT = '2026-09-25T10:00:00.000Z';

describe('what a burst would cost', () => {
  it('is the alert set in every language the record carries', () => {
    // Three alerts times two languages: the figure the demo profile states, and
    // the one the free tier has to be assessed against.
    expect(volumeProjectionOf(3, ['en', 'hi'])).toEqual({
      alerts: 3,
      languages: 2,
      advisoryPass: 6,
      perCapture: 1,
    });
  });

  it('is zero requests when the inbox is empty, not a stale constant', () => {
    expect(volumeProjectionOf(0, ['en', 'hi']).advisoryPass).toBe(0);
  });
});

describe('the view of an adapter’s own counters', () => {
  it('carries the adapter and the model beside the numbers', () => {
    const view = telemetryViewOf({
      provider: 'gemini',
      telemetry: aReport(),
      alerts: 3,
      languages: ['en', 'hi'],
      readAt: AT,
    });

    // A count without its source is not evidence: the same panel under the
    // recorded-replay adapter means something entirely different.
    expect(view.provider).toBe('gemini');
    expect(view.model).toBe('gemini-3.8-flash');
    expect(view.reported).toBe(true);
    expect(view.calls).toBe(4);
    expect(view.attempts).toBe(5);
    expect(view.failures).toBe(2);
    expect(view.meanRequestMs).toBe(200);
    expect(view.projection.advisoryPass).toBe(6);
    expect(view.readAt).toBe(AT);
  });

  it('names each task separately, in first-seen order, with its own mean', () => {
    const view = telemetryViewOf({
      provider: 'gemini',
      telemetry: aReport(),
      alerts: 3,
      languages: ['en', 'hi'],
      readAt: AT,
    });

    expect(view.perTask.map((task) => task.task)).toEqual([
      'advisory-generation@2',
      'stock-extraction@1',
    ]);
    expect(view.perTask[0]).toMatchObject({ calls: 3, attempts: 4, failures: 2 });
    expect(view.perTask[0]?.meanRequestMs).toBe(200);
    // Every row adds up to the totals above it, so a reader can check them.
    expect(view.perTask.reduce((total, task) => total + task.calls, 0)).toBe(view.calls);
    expect(view.perTask.reduce((total, task) => total + task.failures, 0)).toBe(view.failures);
  });

  it('leaves a token count the provider never returned as unknown, not zero', () => {
    const view = telemetryViewOf({
      provider: 'fixture',
      telemetry: aReport({
        model: null,
        attempts: 0,
        totalInputTokens: null,
        totalOutputTokens: null,
        perTask: [
          {
            task: 'advisory-generation@2',
            calls: 3,
            attempts: 0,
            cacheHits: 1,
            failures: 2,
            totalInputTokens: null,
            totalOutputTokens: null,
            totalDurationMs: 1,
          },
        ],
      }),
      alerts: 3,
      languages: ['en', 'hi'],
      readAt: AT,
    });

    expect(view.inputTokens).toBeNull();
    expect(view.outputTokens).toBeNull();
    expect(view.perTask[0]?.inputTokens).toBeNull();
    // A recording has no model to report, so none is named for it.
    expect(view.model).toBeNull();
  });

  it('reports an adapter that keeps no count as unable to answer, not idle', () => {
    const view = telemetryViewOf({
      provider: 'some-future-adapter',
      telemetry: null,
      alerts: 3,
      languages: ['en', 'hi'],
      readAt: AT,
    });

    expect(view.reported).toBe(false);
    expect(view.calls).toBe(0);
    expect(view.perTask).toEqual([]);
    // The projection is still derived: what a pass costs does not depend on
    // whether this adapter tells anybody what it has done.
    expect(view.projection.advisoryPass).toBe(6);
  });

  it('has no mean to report when nothing has been asked', () => {
    const view = telemetryViewOf({
      provider: 'gemini',
      telemetry: aReport({
        calls: 0,
        attempts: 0,
        cacheHits: 0,
        failures: 0,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalDurationMs: 0,
        perTask: [],
      }),
      alerts: 0,
      languages: [],
      readAt: AT,
    });

    // Not `0 ms`, which would read as an instant answer, and not `NaN`, which
    // reads as arithmetic somebody did not finish.
    expect(view.meanRequestMs).toBeNull();
    expect(view.reported).toBe(true);
    expect(view.projection.advisoryPass).toBe(0);
  });
});
