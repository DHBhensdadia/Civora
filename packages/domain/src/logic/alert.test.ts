import { describe, expect, it } from 'vitest';

import type { Alert, RiskScore } from '../model';
import {
  ALERT_DRIVER_THRESHOLD,
  ALERT_TRANSITIONS,
  IllegalTransition,
  alertFor,
  applyDeduplication,
  dedupeKeyOf,
  isOpen,
  openAlertMatching,
  severityForBand,
  transitionAlert,
} from './alert';
import { FACILITY_A, ITEM_PARACETAMOL } from '../testing';

/**
 * The alert lifecycle.
 *
 * The phase names three things as evidence: acknowledge then resolve, acknowledge
 * then escalate, and deduplication. All three are here, plus the case the phase
 * does not name but which decides whether the inbox survives contact with a
 * daily batch job — the same condition recomputed every morning.
 */

const SIMULATED = { kind: 'simulated', reference: 'fixture' } as const;

const scoreWith = (
  drivers: readonly { driver: RiskScore['drivers'][number]['driver']; contribution: number }[],
  band: RiskScore['band'] = 'high',
): RiskScore => ({
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  asOf: '2026-06-30',
  horizonDays: 14,
  shortfallProbability: 0.55,
  riskIndex: 0.81,
  band,
  drivers: drivers.map((entry) => ({
    ...entry,
    detail: `${entry.driver} is why`,
  })),
  facts: [{ name: 'daysOfStock', value: 4 }],
  missing: [],
  synthetic: true,
  provenance: SIMULATED,
});

const raised = (drivers = [{ driver: 'daysOfStock' as const, contribution: 2.4 }]): Alert => {
  const alert = alertFor({
    score: scoreWith(drivers),
    facilityName: 'PHC Example',
    itemName: 'Paracetamol',
    raisedOn: '2026-06-30',
    raisedAt: '2026-06-30T06:00:00.000Z',
    actor: 'system:score',
    synthetic: true,
    provenance: SIMULATED,
  });
  if (alert === null) {
    throw new Error('the fixture was expected to justify an alert');
  }
  return alert;
};

describe('raising an alert from a score', () => {
  it('carries the facts and the driver breakdown the narrative will be written from', () => {
    const alert = raised();

    expect(alert.state).toBe('raised');
    expect(alert.severity).toBe('high');
    expect(alert.facts.length).toBeGreaterThan(0);
    expect(alert.drivers[0]?.detail).toBe('daysOfStock is why');
    expect(alert.history).toEqual([]);
    expect(alert.bodies.en).toContain('PHC Example');
    expect(Object.keys(alert.bodies).length).toBeGreaterThan(1);
  });

  it('quotes the measured probability when there is one, and the index when there is not', () => {
    expect(raised().bodies.en).toContain('55%');

    // An alert raised off a reporting gap has no forecast behind it. Saying
    // "80% chance" here would be inventing a measurement the platform never made,
    // so the body offers the index and its band instead.
    const unmeasured = alertFor({
      score: {
        ...scoreWith([{ driver: 'reportingGap', contribution: 3.6 }]),
        shortfallProbability: null,
      },
      facilityName: 'PHC Silent',
      itemName: 'Paracetamol',
      raisedOn: '2026-06-30',
      raisedAt: '2026-06-30T06:00:00.000Z',
      actor: 'system:score',
      synthetic: true,
      provenance: SIMULATED,
    });

    expect(unmeasured).not.toBeNull();
    expect(unmeasured?.bodies.en).not.toContain('%');
    expect(unmeasured?.bodies.en).toContain('risk index is 0.81');
    expect(unmeasured?.facts.find((fact) => fact.name === 'riskIndex')?.value).toBe(0.81);
  });

  it('raises nothing for a score that justifies nothing', () => {
    expect(severityForBand('low')).toBeNull();
    // An unknown is not a low: it is a licence to go and look.
    expect(severityForBand('unknown')).toBe('high');
    expect(severityForBand('critical')).toBe('critical');

    // A watch item stays on the ranked list and does not reach the inbox — the
    // difference between a catalogue and a to-do list.
    const watched = alertFor({
      score: { ...scoreWith([{ driver: 'daysOfStock', contribution: 1.2 }]), band: 'watch' },
      facilityName: 'PHC Example',
      itemName: 'Paracetamol',
      raisedOn: '2026-06-30',
      raisedAt: '2026-06-30T06:00:00.000Z',
      actor: 'system:score',
      synthetic: true,
      provenance: SIMULATED,
    });
    expect(watched).toBeNull();
  });
});

describe('the alert lifecycle', () => {
  it('acknowledges and then resolves, recording who acted and when', () => {
    const acknowledged = transitionAlert(raised(), {
      to: 'acknowledged',
      actor: 'uid-7',
      actorRole: 'phc_staff',
      at: '2026-06-30T09:00:00.000Z',
      reason: 'checked the shelf, the count is right',
    });

    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.acknowledgedBy).toBe('uid-7');
    expect(acknowledged.acknowledgedByRole).toBe('phc_staff');
    expect(acknowledged.acknowledgedAt).toBe('2026-06-30T09:00:00.000Z');
    expect(acknowledged.resolvedAt).toBeNull();

    const resolved = transitionAlert(acknowledged, {
      to: 'resolved',
      actor: 'uid-7',
      actorRole: 'phc_staff',
      at: '2026-06-30T11:00:00.000Z',
      reason: 'a transfer from the district store arrived',
    });

    expect(resolved.state).toBe('resolved');
    expect(resolved.resolvedAt).toBe('2026-06-30T11:00:00.000Z');
    // Both moves are on the record, oldest first, with the actor on each.
    expect(resolved.history.map((move) => move.to)).toEqual(['acknowledged', 'resolved']);
    expect(resolved.history.map((move) => move.actor)).toEqual(['uid-7', 'uid-7']);
  });

  it('escalates after acknowledging without losing who picked it up', () => {
    const acknowledged = transitionAlert(raised(), {
      to: 'acknowledged',
      actor: 'uid-7',
      actorRole: 'phc_staff',
      at: '2026-06-30T09:00:00.000Z',
      reason: 'the shelf is genuinely empty',
    });

    const escalated = transitionAlert(acknowledged, {
      to: 'escalated',
      actor: 'uid-2',
      actorRole: 'district_officer',
      at: '2026-06-30T14:00:00.000Z',
      reason: 'no stock in the district store either, raising to the state',
    });

    expect(escalated.state).toBe('escalated');
    // The escalation does not overwrite the acknowledgement: the first person to
    // pick it up is still the first person to pick it up.
    expect(escalated.acknowledgedBy).toBe('uid-7');
    expect(escalated.acknowledgedAt).toBe('2026-06-30T09:00:00.000Z');
    expect(escalated.history).toHaveLength(2);
    expect(escalated.history[1]?.actorRole).toBe('district_officer');
    expect(escalated.history[1]?.reason).toContain('district store');
  });

  it('refuses a move that is not on the table, and says what is', () => {
    const resolved = transitionAlert(raised(), {
      to: 'resolved',
      actor: 'uid-7',
      actorRole: 'phc_staff',
      at: '2026-06-30T09:00:00.000Z',
      reason: 'covered',
    });

    // Reopening is a new alert, not a move on a closed one. A store that
    // accepted this would let an interface bug erase a decision that was made.
    expect(() =>
      transitionAlert(resolved, {
        to: 'acknowledged',
        actor: 'uid-9',
        actorRole: 'national',
        at: '2026-07-02T09:00:00.000Z',
        reason: 'reopening',
      }),
    ).toThrow(IllegalTransition);
  });

  it('declares a legal move out of every state except the closed one', () => {
    const reachable = new Set(Object.values(ALERT_TRANSITIONS).flat());
    for (const state of Object.keys(ALERT_TRANSITIONS) as (keyof typeof ALERT_TRANSITIONS)[]) {
      if (state === 'resolved') {
        expect(ALERT_TRANSITIONS[state]).toEqual([]);
        continue;
      }
      expect(ALERT_TRANSITIONS[state].length).toBeGreaterThan(0);
      // Every state but the opening one has to be reachable, or it is a state
      // nothing can enter and the table is describing an alert that cannot exist.
      if (state !== 'raised') {
        expect(reachable.has(state)).toBe(true);
      }
    }
  });
});

describe('keeping the inbox from filling up', () => {
  it('keys a condition by facility, item and the reasons that caused it', () => {
    const one = dedupeKeyOf(FACILITY_A, ITEM_PARACETAMOL, [
      { driver: 'daysOfStock', contribution: 2.4 },
      { driver: 'surgeSignal', contribution: 1.9 },
    ]);
    // The same reasons found in a different order are the same condition.
    const reordered = dedupeKeyOf(FACILITY_A, ITEM_PARACETAMOL, [
      { driver: 'surgeSignal', contribution: 1.9 },
      { driver: 'daysOfStock', contribution: 2.4 },
    ]);
    expect(reordered).toBe(one);

    // A different reason is a different condition, so the alert says something new.
    const other = dedupeKeyOf(FACILITY_A, ITEM_PARACETAMOL, [
      { driver: 'reportingGap', contribution: 3.1 },
    ]);
    expect(other).not.toBe(one);

    // A reason too small to have moved the number is not part of the condition.
    const quiet = dedupeKeyOf(FACILITY_A, ITEM_PARACETAMOL, [
      { driver: 'daysOfStock', contribution: ALERT_DRIVER_THRESHOLD - 0.1 },
    ]);
    expect(quiet).toContain('daysOfStock');
  });

  it('does not raise the same condition twice while the first is open', () => {
    const first = raised();
    const again = { ...first, id: 'alert-second' };

    const kept = applyDeduplication([again], [first]);

    expect(kept).toEqual([]);
    expect(openAlertMatching([first], first.dedupeKey)?.id).toBe(first.id);
  });

  it('raises the condition again once the first alert has been resolved', () => {
    // A condition that comes back is a new problem, and hiding it behind a closed
    // record is how a resolved alert makes a persistent shortage invisible.
    const first = raised();
    const closed = transitionAlert(first, {
      to: 'resolved',
      actor: 'uid-7',
      actorRole: 'phc_staff',
      at: '2026-06-30T09:00:00.000Z',
      reason: 'a transfer arrived',
    });

    expect(isOpen(closed)).toBe(false);
    expect(openAlertMatching([closed], closed.dedupeKey)).toBeNull();

    const second = { ...first, id: 'alert-second' };
    expect(applyDeduplication([second], [closed])).toHaveLength(1);
  });

  it('deduplicates within one run as well as against what is already stored', () => {
    const first = raised();
    const twin = { ...first, id: 'alert-twin' };

    const kept = applyDeduplication([first, twin], []);

    expect(kept.map((alert) => alert.id)).toEqual([first.id]);
  });

  it('lets two different items at one facility alert separately', () => {
    const acid = raised();
    const other = {
      ...acid,
      id: 'alert-other',
      itemId: ITEM_PARACETAMOL,
      dedupeKey: dedupeKeyOf(FACILITY_A, ITEM_PARACETAMOL, [
        { driver: 'coldChain', contribution: 1.0 },
      ]),
    };

    expect(applyDeduplication([acid, other], [])).toHaveLength(2);
  });
});
