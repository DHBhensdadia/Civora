import { IllegalTransition, isOpen, transitionAlert } from '@civora/domain';
import type {
  Alert,
  AlertSeverity,
  AlertState,
  EpidemicEvent,
  RiskBand,
  RiskDriver,
  RiskScore,
} from '@civora/domain';
import { scorePopulation } from '@civora/simulator';
import type { ScoredPopulation } from '@civora/simulator';

import { getLiveStore } from './live-store';
import { canReadDistrict } from './session';
import type { ScopeLookup, Session } from './session';

/**
 * What the platform concludes, over the demonstration dataset.
 *
 * The same pipeline the batch job runs — `scorePopulation` lives in the
 * simulator package precisely so that this file and `worker:score` cannot
 * disagree about the same world. What this adds is what a surface needs: the
 * rows sorted for a reader, the alerts held as state that a person can move
 * through its life, and the district scoping the rest of the platform applies.
 *
 * It is built once per process and shared, like the store. Every figure is
 * computed from the generated dataset, and the seed and the scoring day travel
 * with the payload so a reader can tell which run they are looking at.
 *
 * Two deliberate inheritances from the batch job: the population is scored at one
 * `asOf`, so no two readers see different numbers for the same pair; and a
 * condition that already has an open alert does not raise a second one, which is
 * what stops a recomputation from filling the inbox with its own history.
 */

export interface IntelligenceRow {
  readonly facilityId: string;
  readonly facilityName: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly unit: string;
  readonly essentiality: string;
  readonly band: RiskBand;
  readonly riskIndex: number;
  readonly shortfallProbability: number | null;
  readonly shortfallWindowDays: number | null;
  readonly horizonDays: number;
  /** Alert severity the score justifies, or null when it justifies none. */
  readonly severity: AlertSeverity | null;
  readonly drivers: readonly {
    readonly driver: RiskDriver;
    readonly contribution: number;
    readonly detail: string;
  }[];
  readonly missing: readonly string[];
}

export interface IntelligenceEvent {
  readonly id: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly districtId: string | null;
  readonly districtName: string;
  readonly syndrome: string;
  readonly growthRate: number;
  readonly detectedOn: string;
  readonly windowDays: number;
  readonly baselineCaseCount: number;
  readonly observedCaseCount: number;
  readonly method: string;
}

export interface Intelligence {
  readonly asOf: string;
  readonly horizonDays: number;
  readonly scoredInMs: number;
  readonly pairsScored: number;
  readonly liftedForecasts: number;
  readonly bands: readonly { readonly label: string; readonly count: number }[];
  readonly rows: readonly IntelligenceRow[];
  readonly alerts: readonly Alert[];
  readonly events: readonly IntelligenceEvent[];
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
}

interface Built {
  readonly population: ScoredPopulation;
  readonly alerts: Map<string, Alert>;
  readonly facilityById: Map<string, { name: string; districtId: string }>;
  readonly districtById: Map<string, string>;
  readonly itemById: Map<string, { name: string; unit: string; essentiality: string }>;
  readonly rows: readonly IntelligenceRow[];
  readonly events: readonly IntelligenceEvent[];
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly scope: ScopeLookup;
}

/** How many rows the surface is sent. The rest are counted, not listed. */
export const ROW_LIMIT = 60;

const BAND_ORDER: readonly RiskBand[] = ['unknown', 'critical', 'high', 'watch', 'low'];

/**
 * Bands that put a score in the inbox, mirrored from the domain's alert rule.
 *
 * Mirrored rather than re-decided: `alertFor` is the rule, and this only says
 * which of the alerts it built are still somebody's problem.
 */
const ALERTING: ReadonlySet<RiskBand> = new Set<RiskBand>(['unknown', 'critical', 'high']);

function rowsFrom(
  population: ScoredPopulation,
  facilityById: Map<string, { name: string; districtId: string }>,
  districtById: Map<string, string>,
  itemById: Map<string, { name: string; unit: string; essentiality: string }>,
  alerts: Map<string, Alert>,
): readonly IntelligenceRow[] {
  const alertByPair = new Map<string, Alert>();
  for (const alert of alerts.values()) {
    if (isOpen(alert)) {
      alertByPair.set(`${alert.facilityId}|${alert.itemId}`, alert);
    }
  }

  const rank = (band: RiskBand): number => BAND_ORDER.indexOf(band);

  return [...population.assessments]
    .sort((left, right) => {
      const byBand = rank(left.risk.band) - rank(right.risk.band);
      return byBand !== 0 ? byBand : right.risk.riskIndex - left.risk.riskIndex;
    })
    .map((assessment) => {
      const risk: RiskScore = assessment.risk;
      const facility = facilityById.get(assessment.facilityId);
      const item = itemById.get(assessment.itemId);
      const alert = alertByPair.get(`${assessment.facilityId}|${assessment.itemId}`);

      return {
        facilityId: assessment.facilityId,
        facilityName: facility?.name ?? assessment.facilityId,
        districtId: facility?.districtId ?? '',
        districtName: districtById.get(facility?.districtId ?? '') ?? '—',
        itemId: assessment.itemId,
        itemName: item?.name ?? assessment.itemId,
        unit: item?.unit ?? '',
        essentiality: item?.essentiality ?? '',
        band: risk.band,
        riskIndex: risk.riskIndex,
        shortfallProbability: risk.shortfallProbability,
        shortfallWindowDays:
          risk.facts.find((fact) => fact.name === 'shortfallWindowDays')?.value ?? null,
        horizonDays: risk.horizonDays,
        severity: ALERTING.has(risk.band) ? (alert?.severity ?? null) : null,
        drivers: risk.drivers,
        missing: risk.missing,
      };
    });
}

async function build(): Promise<Built> {
  const store = await getLiveStore();
  const { simulation, network } = store.dataset;

  // Fewer bootstrap replications than the batch job, because this runs inside a
  // request and only the upper quantile is read. The number travels on every
  // forecast's own features, so the interface is not claiming the batch's
  // precision for a lighter computation.
  const population = scorePopulation(simulation, network, {
    horizonDays: 14,
    seedPrefix: 'intelligence',
    bootstrapReplications: 60,
  });

  const facilityById = new Map(
    network.facilities.map((facility) => [
      facility.id as string,
      { name: facility.name, districtId: facility.districtId },
    ]),
  );
  const districtById = new Map(
    network.districts.map((district) => [district.id as string, district.name]),
  );
  const itemById = new Map(
    store.catalogue.map((item) => [
      item.id as string,
      { name: item.genericName, unit: item.unit, essentiality: item.essentiality },
    ]),
  );

  const alerts = new Map<string, Alert>();
  for (const alert of population.alerts) {
    alerts.set(alert.id, alert);
  }

  return {
    population,
    alerts,
    facilityById,
    districtById,
    itemById,
    rows: rowsFrom(population, facilityById, districtById, itemById, alerts),
    events: population.epidemicEvents.map((event) =>
      describeEvent(event, facilityById, districtById),
    ),
    seed: store.info.seed,
    scenarioId: store.info.scenarioId,
    scenarioLabel: store.info.scenarioLabel,
    scope: store.scope,
  };
}

const describeEvent = (
  event: EpidemicEvent,
  facilityById: Map<string, { name: string; districtId: string }>,
  districtById: Map<string, string>,
): IntelligenceEvent => ({
  id: event.id,
  facilityId: event.facilityId,
  facilityName: facilityById.get(event.facilityId)?.name ?? event.facilityId,
  districtId: event.districtId,
  districtName: districtById.get(event.districtId ?? '') ?? '—',
  syndrome: event.syndrome,
  growthRate: event.growthRate,
  detectedOn: event.detectedOn,
  windowDays: event.windowDays,
  baselineCaseCount: event.baselineCaseCount,
  observedCaseCount: event.observedCaseCount,
  method: event.method,
});

let pending: Promise<Built> | undefined;

const built = (): Promise<Built> => (pending ??= build());

/** Whether a session may see this facility's intelligence. */
const maySee = (session: Session, facilityId: string, scope: ScopeLookup): boolean => {
  const districtId = scope.districtOfFacility(facilityId);
  return districtId !== null && canReadDistrict(session, districtId, scope);
};

/**
 * The intelligence this session is entitled to read.
 *
 * Scoped like every other read in the platform, and by the same rule: a
 * district officer is shown the districts they are responsible for and nothing
 * else. A scoped reader is also told what was hidden, because a district view
 * that silently omits the rest of the country is a view that can be mistaken for
 * the whole picture.
 */
export async function readIntelligence(
  session: Session,
): Promise<Intelligence & { readonly national: boolean }> {
  const state = await built();

  const rows = state.rows.filter((row) => maySee(session, row.facilityId, state.scope));
  const alerts = [...state.alerts.values()].filter((alert) =>
    maySee(session, alert.facilityId, state.scope),
  );
  const events = state.events.filter((event) => maySee(session, event.facilityId, state.scope));

  const counts = new Map<RiskBand, number>();
  for (const row of rows) {
    counts.set(row.band, (counts.get(row.band) ?? 0) + 1);
  }

  return {
    asOf: state.population.asOf,
    horizonDays: state.population.horizonDays,
    scoredInMs: state.population.elapsedMs,
    pairsScored: state.population.assessments.length,
    liftedForecasts: state.population.liftedForecasts,
    bands: BAND_ORDER.filter((band) => (counts.get(band) ?? 0) > 0).map((band) => ({
      label: band,
      count: counts.get(band) ?? 0,
    })),
    rows: rows.slice(0, ROW_LIMIT),
    alerts: [...alerts].sort((left, right) => (left.raisedOn < right.raisedOn ? 1 : -1)),
    events,
    seed: state.seed,
    scenarioId: state.scenarioId,
    scenarioLabel: state.scenarioLabel,
    national: rows.length === state.rows.length,
  };
}

export class AlertRefused extends Error {
  /**
   * The status the move should be refused with.
   *
   * Carried on the refusal rather than decided by the route, so the rule that
   * refused and the code the client sees cannot drift apart: 404 for an alert
   * that does not exist, 400 for a request that is not a decision (no reason),
   * and 403 for one that is a decision this session is not allowed to make.
   */
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = 'AlertRefused';
    this.status = status;
  }
}

export interface AlertMove {
  readonly alertId: string;
  readonly to: AlertState;
  readonly reason: string;
}

/**
 * Move an alert through its life, or refuse and say why.
 *
 * Three refusals, each for its own reason: an auditor reads the record but does
 * not write to it; a session scoped to a district cannot act on another
 * district's alert; and an illegal move is refused by the domain's own table
 * rather than by this function, so the interface cannot invent a transition the
 * model does not allow. A refused move leaves the store untouched — a store that
 * quietly ignored one would let an interface bug close an alert nobody dealt
 * with.
 */
export async function moveAlert(session: Session, move: AlertMove): Promise<Alert> {
  const state = await built();
  const alert = state.alerts.get(move.alertId);

  if (alert === undefined) {
    throw new AlertRefused(`no alert with the identifier ${move.alertId}`, 404);
  }
  if (session.role === 'auditor') {
    throw new AlertRefused('an auditor reads the record but does not write to it');
  }
  if (!maySee(session, alert.facilityId, state.scope)) {
    throw new AlertRefused('this alert is outside the scope this session is responsible for');
  }
  if (move.reason.trim() === '') {
    // A move with no reason is a state change nobody can explain afterwards, and
    // it is refused as a request rather than as a permission.
    throw new AlertRefused('a move has to say why it was made', 400);
  }

  let moved: Alert;
  try {
    moved = transitionAlert(alert, {
      to: move.to,
      actor: session.label,
      actorRole: session.role,
      at: new Date().toISOString(),
      reason: move.reason.trim(),
    });
  } catch (error) {
    if (error instanceof IllegalTransition) {
      throw new AlertRefused(error.message);
    }
    throw error;
  }

  state.alerts.set(moved.id, moved);
  return moved;
}
