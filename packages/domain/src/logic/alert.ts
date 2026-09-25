import type {
  Alert,
  AlertSeverity,
  AlertState,
  AlertTransition,
  DateOnly,
  ItemId,
  FacilityId,
  Provenance,
  RiskDriver,
  RiskScore,
  Role,
} from '../model';
import { shortfallWindowOf } from './risk';

/**
 * An alert's life, and the rules that keep it from being raised twice.
 *
 * Two failures destroy an alerting system, and both are designed against here.
 *
 *  - **Alert storms.** A score recomputed every day for every facility-item pair
 *    raises the same alert every day. Within a week the inbox is unusable and
 *    officers stop reading it, which is strictly worse than having no inbox. So
 *    an alert's identity is the *condition* — this facility, this item, this set
 *    of reasons — and a condition already alerting does not alert again.
 *  - **Alerts nobody is accountable for.** A state flag records where an alert
 *    is; it does not record that a person decided to put it there. Every move
 *    therefore carries an actor, a role, a time and a reason, and the list is
 *    append-only. "Resolved" and "resolved by the district pharmacist, who says a
 *    transfer is on the way" are different facts and the second is the useful one.
 *
 * The legal moves are declared in one table rather than inferred from the state
 * names. `action_proposed` is reachable from `acknowledged` and from
 * `escalated`, because escalating does not undo the acknowledgement — and
 * `resolved` is reachable from everything except `resolved`, because an alert
 * can always be closed and reopening one is a new alert.
 */

export const ALERT_TRANSITIONS: Readonly<Record<AlertState, readonly AlertState[]>> = {
  raised: ['acknowledged', 'escalated', 'snoozed', 'resolved'],
  acknowledged: ['action_proposed', 'escalated', 'snoozed', 'resolved'],
  action_proposed: ['resolved', 'escalated', 'snoozed'],
  snoozed: ['acknowledged', 'escalated', 'resolved'],
  escalated: ['acknowledged', 'action_proposed', 'resolved'],
  resolved: [],
};

/**
 * Contribution above which a driver is treated as part of the condition.
 *
 * A driver on the list at all is a reason; a driver above this is a reason that
 * moved the number enough to be worth naming in the alert. Using the
 * contributions rather than a fixed driver list is what makes the key describe
 * *why* the alert exists, so a facility whose problem changes from a delivery
 * failure to a demand surge raises a second, different alert instead of the
 * first one quietly changing its mind.
 */
export const ALERT_DRIVER_THRESHOLD = 0.5;

/**
 * The measured evidence an alert has to be able to name.
 *
 * A band alone is not enough to wake somebody, and the generated world's
 * negative control is what showed why. Four of the nine drivers describe the item
 * and the facility in general — the item is on the essential list, the facility
 * serves a large catchment, resupply in this world takes about a week, the item
 * needs cold storage — and those are true of thousands of pairs at once. On a
 * world with nothing wrong in it they carried a third of all pairs over the
 * `high` threshold, which is an inbox nobody would read twice.
 *
 * The band itself now rests on the shelf drivers alone (see `SHELF_DRIVERS` in
 * `./risk`), so an inbox entry is already a statement about a shelf rather than
 * about the catalogue. What is left here is the sentence: the quantity that put
 * the pair in the inbox, named for the reader. The two thresholds below are
 * stated as the plain-language tests they are — a coin flip, and half the wait —
 * rather than as tuned constants.
 */
export const ALERT_EVIDENCE = {
  /** A shelf that is as likely as not to outlast the wait for a delivery. */
  shortfallProbability: 0.5,
  /** Cover worth less than half the wait for a delivery is not cover. */
  coverShareOfWait: 0.5,
} as const;

/**
 * The measured reason this score belongs in somebody's inbox, or null.
 *
 * Null is not a judgement about the risk; it is a statement that everything the
 * score said was a property of the item or the district rather than of the shelf.
 * A pair in that state stays on the ranked list with its band, where it can be
 * sorted and looked at while it gets worse.
 */
export function measuredReasonFor(score: RiskScore): string | null {
  const fact = (name: string): number | null =>
    score.facts.find((entry) => entry.name === name)?.value ?? null;

  const probability = score.shortfallProbability;
  const window = fact('shortfallWindowDays') ?? score.horizonDays;
  const cover = fact('daysOfStock');

  if (probability !== null && probability >= ALERT_EVIDENCE.shortfallProbability) {
    return `the forecast puts the chance of the shelf not outlasting the next delivery at ${(
      probability * 100
    ).toFixed(0)}%`;
  }

  if (cover !== null && cover <= window * ALERT_EVIDENCE.coverShareOfWait) {
    return `${cover.toFixed(
      1,
    )} days of cover against the ${String(window)} days before a delivery can arrive`;
  }

  const surgeMultiplier = fact('surgeMultiplier');
  if (surgeMultiplier !== null && surgeMultiplier > 1) {
    return `a detected epidemic surge is expected to raise demand for this item by ${(
      (surgeMultiplier - 1) *
      100
    ).toFixed(0)}%`;
  }

  const expiryUnits = fact('nearExpiryUnits');
  const expiryDays = fact('daysToNearestExpiry');
  if (expiryUnits !== null && expiryUnits > 0 && expiryDays !== null) {
    return `${expiryUnits.toFixed(0)} units expire in ${expiryDays.toFixed(0)} days`;
  }

  return null;
}

/**
 * Bands that put something in the inbox.
 *
 * `watch` deliberately does not. A risk list is a ranked catalogue and can hold
 * hundreds of rows; an inbox is a list of things somebody is expected to act on
 * today, and a batch job that raised one for every item at 20% would produce
 * several hundred a morning and teach every officer to stop reading them. Watch
 * items stay on the list, where they can be sorted and looked at, and cross into
 * the inbox when they get worse or when nobody has reported for a while.
 */
export const ALERTING_BANDS: ReadonlySet<RiskScore['band']> = new Set<RiskScore['band']>([
  'high',
  'critical',
  'unknown',
]);

/** States in which an alert is still somebody's problem. */
export const OPEN_ALERT_STATES: ReadonlySet<AlertState> = new Set<AlertState>([
  'raised',
  'acknowledged',
  'action_proposed',
  'snoozed',
  'escalated',
]);

/** Whether an alert still needs attention. */
export const isOpen = (alert: Alert): boolean => OPEN_ALERT_STATES.has(alert.state);

/**
 * The identity of the condition an alert describes.
 *
 * Facility, item and the set of contributing reasons — the phase's
 * `(facility, item, driver-set)`. Drivers are sorted so that the same reasons
 * found in a different order produce the same key; without that, a harmless
 * change to the scoring order would re-raise every alert in the country.
 */
export function dedupeKeyOf(
  facilityId: FacilityId,
  itemId: ItemId,
  drivers: readonly { readonly driver: RiskDriver; readonly contribution: number }[],
): string {
  const named = drivers
    .filter((driver) => driver.contribution >= ALERT_DRIVER_THRESHOLD)
    .map((driver) => driver.driver)
    .sort();

  // A score where nothing crossed the threshold still names its largest reason:
  // an alert must always say why it exists, even when the total is small.
  const reasons =
    named.length > 0
      ? named
      : [...drivers]
          .sort((left, right) => right.contribution - left.contribution)
          .slice(0, 1)
          .map((driver) => driver.driver);

  return `${facilityId}|${itemId}|${reasons.join('+')}`;
}

/** The severity an alert takes from the band of the score behind it. */
export function severityForBand(band: RiskScore['band']): AlertSeverity | null {
  switch (band) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'watch':
      return 'watch';
    // `unknown` is not a low risk: it is a licence to go and look, and the
    // review a high-severity alert prompts is the right size for it.
    case 'unknown':
      return 'high';
    case 'low':
      return null;
  }
}

export interface RaiseAlertInput {
  readonly score: RiskScore;
  readonly facilityName: string;
  readonly itemName: string;
  readonly raisedOn: DateOnly;
  /** The day the alert was raised, as an instant. */
  readonly raisedAt: string;
  /** Who or what raised it. `system:score` for the batch job. */
  readonly actor: string;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

/**
 * Build the alert a score justifies, or null when it justifies none.
 *
 * Null rather than a suppressed alert: an item at forty days of cover is not a
 * suppressed problem, it is not a problem, and recording a decision not to raise
 * something would fill the store with non-events.
 */
export function alertFor(input: RaiseAlertInput): Alert | null {
  const { score } = input;
  const severity = severityForBand(score.band);
  if (severity === null || !ALERTING_BANDS.has(score.band)) {
    return null;
  }

  // The band already rests on the shelf drivers alone, so it is itself the
  // evidence. This names the quantity behind it for the reader, and falls back to
  // the index for a pair the platform cannot measure.
  const evidence = measuredReasonFor(score);

  const worst = score.drivers[0];

  // What the alert offers as its reason to act. The measured probability when a
  // forecast produced one, the band and index when it did not — an alert raised
  // off a data-quality caveat must not borrow a probability it never measured.
  const days = shortfallWindowOf(score);
  const likelihood =
    score.shortfallProbability === null
      ? `the composite risk index is ${score.riskIndex.toFixed(2)}, banded ${score.band}`
      : `the forecast puts the chance of running out before a delivery can arrive, over the next ${String(
          days,
        )} days, at ${(score.shortfallProbability * 100).toFixed(0)}%`;
  // The measured reason first. A reader opening an inbox row wants the quantity
  // that put it there, not the largest driver — which is often criticality, true
  // of the item everywhere it is stocked.
  const reason = evidence ?? worst?.detail ?? null;

  const headline = `${input.facilityName} · ${input.itemName}`;

  return {
    id: `alert:${dedupeKeyOf(score.facilityId, score.itemId, score.drivers)}:${input.raisedOn}`,
    facilityId: score.facilityId,
    itemId: score.itemId,
    raisedOn: input.raisedOn,
    severity,
    state: 'raised',
    bodies: {
      // Only templates exist at this phase; Phase 5 writes narrative prose from
      // the alert's own facts. The record is a map so that adding a language is
      // adding a key rather than a schema change.
      en: `${headline} — ${likelihood}${reason === null ? '' : `. ${reason}`}`,
      hi:
        score.shortfallProbability === null
          ? `${headline} — जोखिम सूचकांक ${score.riskIndex.toFixed(2)}। कृपया जाँच करें।`
          : `${headline} — ${String(days)} दिनों में स्टॉक खत्म होने की संभावना। कृपया जाँच करें।`,
    },
    riskScoreId: `${score.facilityId}:${score.itemId}:${score.asOf}`,
    dedupeKey: dedupeKeyOf(score.facilityId, score.itemId, score.drivers),
    // The index is carried on the alert in its own right, because it is what the
    // band was chosen from; the measured probability is already in `score.facts`
    // when there was one.
    facts: [...score.facts, { name: 'riskIndex', value: score.riskIndex }],
    drivers: score.drivers,
    history: [],
    acknowledgedBy: null,
    acknowledgedByRole: null,
    acknowledgedAt: null,
    resolvedAt: null,
    synthetic: input.synthetic,
    provenance: input.provenance,
  };
}

export interface TransitionInput {
  readonly to: AlertState;
  readonly actor: string;
  readonly actorRole: Role;
  readonly at: string;
  readonly reason: string;
}

export class IllegalTransition extends Error {
  constructor(from: AlertState, to: AlertState) {
    super(
      `an alert cannot move from ${from} to ${to}; from ${from} it may go to ${
        ALERT_TRANSITIONS[from].join(', ') || 'nowhere, because it is closed'
      }`,
    );
    this.name = 'IllegalTransition';
  }
}

/**
 * Move an alert, or refuse.
 *
 * Refusing rather than clamping is the whole point: a store that quietly
 * ignored an illegal move would let an interface bug resolve alerts nobody had
 * dealt with, and the record would show a decision that was never made.
 */
export function transitionAlert(alert: Alert, move: TransitionInput): Alert {
  if (!ALERT_TRANSITIONS[alert.state].includes(move.to)) {
    throw new IllegalTransition(alert.state, move.to);
  }

  const transition: AlertTransition = {
    from: alert.state,
    to: move.to,
    actor: move.actor,
    actorRole: move.actorRole,
    at: move.at,
    reason: move.reason,
  };

  // Acknowledgement is recorded once, on whatever move first takes an alert out
  // of `raised`. A later escalation by a different person does not overwrite the
  // first person's name — the history holds both, and the field holds the one
  // who picked it up.
  const acknowledgedAt = alert.acknowledgedAt ?? (alert.state === 'raised' ? move.at : null);
  const acknowledgedBy = alert.acknowledgedBy ?? (alert.state === 'raised' ? move.actor : null);
  const acknowledgedByRole =
    alert.acknowledgedByRole ?? (alert.state === 'raised' ? move.actorRole : null);

  return {
    ...alert,
    state: move.to,
    history: [...alert.history, transition],
    acknowledgedBy,
    acknowledgedByRole,
    acknowledgedAt,
    resolvedAt: move.to === 'resolved' ? move.at : alert.resolvedAt,
  };
}

/**
 * The alert a re-run of the batch job should not raise again.
 *
 * Returns the open alert whose condition matches, if there is one. A resolved
 * alert does not suppress anything: a condition that has come back is a new
 * problem, and hiding it behind a closed record is how a resolved alert becomes
 * a way of making a persistent shortage invisible.
 */
export const openAlertMatching = (alerts: readonly Alert[], dedupeKey: string): Alert | null =>
  alerts.find((alert) => alert.dedupeKey === dedupeKey && isOpen(alert)) ?? null;

/**
 * Filter a batch of candidate alerts down to the ones worth raising.
 *
 * Applied in order, so the first candidate for a condition wins and the rest are
 * dropped. Runs over the existing alerts too, so a condition raised earlier in
 * the same run is deduplicated against the one raised before it.
 */
export function applyDeduplication(
  candidates: readonly Alert[],
  existing: readonly Alert[],
): readonly Alert[] {
  const seen = new Set(existing.filter(isOpen).map((alert) => alert.dedupeKey));
  const raised: Alert[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.dedupeKey)) {
      continue;
    }
    seen.add(candidate.dedupeKey);
    raised.push(candidate);
  }

  return raised;
}
