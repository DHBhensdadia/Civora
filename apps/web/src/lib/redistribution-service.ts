import { transferProposalSchema } from '@civora/domain';
import type { AuditEvent, DateOnly, Facility, Item, Role, TransferProposal } from '@civora/domain';
import type {
  ImpactAssumptions,
  PlanObjective,
  PlanRefusal,
  PlannedTransfer,
  PlanVerdict,
  RedistributionPlan,
  StrategyName,
  StrategyRefusal,
  TransferImpact,
  UnquantifiedTransfer,
} from '@civora/optimizer';

import { planWorld } from '@civora/simulator';

import { actorOf, readAuditEvents, recordAuditEvent, verifyAuditChain } from './audit-service';
import type { AuditChainReport } from './audit-service';
import { readScoredPopulation } from './intelligence-service';
import { getLiveStore } from './live-store';
import type { LiveStore } from './live-store';
import { canReadDistrict } from './session';
import type { ScopeLookup, Session } from './session';

/**
 * Setu's workbench: the plan, the proposals built from it, and the decisions
 * people take on them.
 *
 * The pipeline itself is `@civora/optimizer`'s — this file gathers the world it
 * runs over (the network, the catalogue, the stock projection, the forecasts the
 * intelligence surface already holds), persists the records it produces, and
 * records what a person decides about each one. It is deliberately the same
 * gathering the batch job will do, so a proposal a judge reads on screen and a
 * proposal a report quotes come from one computation.
 *
 * Three decisions carry the design:
 *
 *  - **A transfer is a proposal, not a command.** Nothing here moves stock.
 *    A proposal acquires a person's name or it stays undecided, and the interface
 *    says so in those words.
 *  - **The verdict is the validator's.** A plan the independent validator refuses
 *    produces no proposals at all; what it produces is the refusal, attributed
 *    rule by rule, beside every strategy's own verdict. Nothing a person can
 *    approve is ever shown without that verdict.
 *  - **The decision is recorded twice, on purpose.** The approval goes onto the
 *    proposal (`approvals`, where Phase 9's audit export reads it) *and* into the
 *    hash-chained trail (where it cannot be altered afterwards). A rejection is
 *    only in the chain, because the proposal's field is a list of approvals and
 *    writing a rejection into it would be a lie about the record's own shape.
 *
 * Scope works like the rest of the platform: a district officer sees transfers
 * with an end in their district, a state officer those in their state, the
 * control room and an auditor everything. Reading is wider than deciding —
 * deciding a cross-district transfer is a district-level act, and front-line
 * staff and auditors do not have that authority.
 */

export const PROPOSAL_COLLECTION = 'transferProposals';

/** The two actions this phase writes into the audit chain. */
export const APPROVE_ACTION = 'transfer-proposal-approved';
export const REJECT_ACTION = 'transfer-proposal-rejected';

/** How many refusal and ineligibility rows a payload carries before counting. */
export const LIST_LIMIT = 12;

export interface FacilityView {
  readonly facilityId: string;
  readonly name: string;
  readonly tier: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly regionName: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface ItemView {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly essentiality: string;
  readonly coldChain: boolean;
}

/** A person's decision, as the chain recorded it. */
export interface ProposalDecision {
  readonly decision: 'approved' | 'rejected';
  readonly by: string;
  readonly actorRole: Role;
  readonly at: string;
  readonly reason: string | null;
  readonly action: string;
}

export interface RedistributionRow {
  /** The persisted record, which is the one carrying any approvals. */
  readonly proposal: TransferProposal;
  /** The plan's own entry for this movement: distance, lead time, shelf life. */
  readonly transfer: PlannedTransfer;
  /** Null when no forecast covered the receiver and item. */
  readonly impact: TransferImpact | null;
  readonly donor: FacilityView;
  readonly receiver: FacilityView;
  readonly item: ItemView;
  readonly decision: ProposalDecision | null;
}

export interface StrategyView {
  readonly name: StrategyName;
  readonly description: string;
  readonly acceptable: boolean;
  readonly refusal: string | null;
  readonly benefitPerUnitKm: number;
  readonly transfers: number;
  readonly units: number;
  readonly unitKm: number;
  readonly objective: PlanObjective;
  readonly violations: readonly PlanRefusal[];
  readonly unchecked: readonly { readonly rule: string; readonly detail: string }[];
  readonly measured: PlanVerdict['measured'];
  readonly chosen: boolean;
}

export interface NamedRefusal {
  readonly facilityId: string;
  readonly facilityName: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly reason: string;
}

export interface RedistributionTotals {
  readonly proposals: number;
  readonly units: number;
  readonly unitKm: number;
  readonly unmetDemandAvoided: number;
  readonly stockOutDaysAverted: number;
  readonly transportCost: number;
  readonly netBenefit: number;
  readonly beneficial: number;
  readonly marginal: number;
  readonly negative: number;
  readonly unquantified: number;
}

export interface Redistribution {
  /** Who is reading, so the surface can say what this session may decide. */
  readonly session: { readonly role: Role; readonly label: string };
  /** The decision events themselves, oldest first — the audit view reads them. */
  readonly auditEvents: readonly AuditEvent[];
  readonly asOf: DateOnly;
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly generatedInMs: number;
  readonly rows: readonly RedistributionRow[];
  readonly strategies: readonly StrategyView[];
  readonly chosen: {
    readonly name: StrategyName;
    readonly decidedBy: 'model' | 'fallback';
    readonly reason: string;
    readonly iterations: number;
    readonly budgetReached: boolean;
    readonly refusals: readonly StrategyRefusal[];
  };
  readonly verdict: PlanVerdict;
  readonly refused: readonly PlanRefusal[];
  readonly totals: RedistributionTotals;
  readonly unquantified: readonly UnquantifiedTransfer[];
  readonly objective: PlanObjective;
  readonly baseline: PlanObjective;
  readonly improvementPasses: number;
  readonly graph: {
    readonly edges: number;
    readonly candidates: number;
    readonly removedByRule: Readonly<Record<string, number>>;
    readonly unknownFacilities: number;
    readonly unknownItems: number;
  };
  readonly rankings: {
    readonly receiversRanked: number;
    readonly receiversUnmeasured: number;
    readonly donorsEligible: number;
    readonly donorsIneligible: number;
    readonly needs: number;
    readonly unpositionedReceivers: number;
  };
  readonly ineligibleDonors: readonly NamedRefusal[];
  readonly unmeasuredReceivers: readonly NamedRefusal[];
  readonly unserved: readonly (NamedRefusal & { readonly units: number })[];
  readonly transport: RedistributionPlan['world']['transport'];
  readonly impactAssumptions: ImpactAssumptions;
  readonly impactMethod: string;
  readonly audit: AuditChainReport;
  readonly national: boolean;
  readonly hidden: number;
  readonly scopeNote: string;
}

interface Built {
  readonly asOf: DateOnly;
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly generatedInMs: number;
  readonly plan: RedistributionPlan;
  readonly rows: readonly RedistributionRow[];
  readonly facilityById: ReadonlyMap<string, Facility>;
  readonly itemById: ReadonlyMap<string, Item>;
  readonly scope: ScopeLookup;
}

// --- Reading the world ---------------------------------------------------------

// The gathering — the scoring the plan reads, the ledger's lots, the
// projection's positions and the plan itself — lives in `@civora/simulator`, so
// the workbench and the batch command cannot disagree about the same world.
// What this file adds is the store it is pointed at, the scoped read, the
// records and the decisions.

const facilityViewOf = (
  facility: Facility,
  districtName: string,
  regionName: string,
): FacilityView => ({
  facilityId: facility.id,
  name: facility.name,
  tier: facility.tier,
  districtId: facility.districtId,
  districtName,
  regionName,
  latitude: facility.coordinates.latitude,
  longitude: facility.coordinates.longitude,
});

const itemViewOf = (item: Item): ItemView => ({
  itemId: item.id,
  name: item.genericName,
  unit: item.unit,
  essentiality: item.essentiality,
  coldChain: item.coldChain,
});

const decisionOf = (event: AuditEvent): ProposalDecision => ({
  // Only these two actions are ever written against a proposal; anything else
  // would be a caller misusing the chain, and is treated as a refusal so that an
  // unknown action can never be displayed as an approval.
  decision: event.action === APPROVE_ACTION ? 'approved' : 'rejected',
  by: event.actorUid,
  actorRole: event.actorRole,
  at: event.occurredAt,
  reason: event.reason,
  action: event.action,
});

async function proposalCollection() {
  const store = await getLiveStore();
  return store.provider.collection(PROPOSAL_COLLECTION, transferProposalSchema);
}

/**
 * Every decision the chain holds, newest wins — a proposal is decided once.
 *
 * Only the two decision actions count. An audit event recorded against a proposal
 * for any other reason is a different kind of act, and folding it in would let an
 * unknown action be displayed as a refusal.
 */
export async function readDecisions(): Promise<ReadonlyMap<string, ProposalDecision>> {
  const decisions = new Map<string, ProposalDecision>();

  for (const event of await readAuditEvents()) {
    if (
      event.subjectType !== 'transfer_proposal' ||
      (event.action !== APPROVE_ACTION && event.action !== REJECT_ACTION)
    ) {
      continue;
    }
    decisions.set(event.subjectId, decisionOf(event));
  }

  return decisions;
}

// --- The plan and its proposals ----------------------------------------------

function rowsOf(plan: RedistributionPlan, store: LiveStore): readonly RedistributionRow[] {
  const { network } = store.dataset;
  const facilityById = new Map(
    network.facilities.map((facility) => [facility.id as string, facility]),
  );
  const districtById = new Map(
    network.districts.map((district) => [district.id as string, district]),
  );
  const regionById = new Map(network.regions.map((region) => [region.id as string, region]));
  const itemById = new Map(store.catalogue.map((item) => [item.id as string, item]));

  const facilityView = (facilityId: string): FacilityView => {
    const facility = facilityById.get(facilityId);
    if (facility === undefined) {
      throw new Error(`the plan names a facility the network does not hold: ${facilityId}`);
    }
    const district = districtById.get(facility.districtId);
    const region = district === undefined ? undefined : regionById.get(district.regionId);
    return facilityViewOf(facility, district?.name ?? facility.districtId, region?.name ?? '');
  };

  const itemView = (itemId: string): ItemView => {
    const item = itemById.get(itemId);
    if (item === undefined) {
      throw new Error(`the plan names an item the catalogue does not hold: ${itemId}`);
    }
    return itemViewOf(item);
  };

  return plan.proposals.map((planned) => ({
    proposal: planned.proposal,
    transfer: planned.transfer,
    impact: planned.impact,
    donor: facilityView(planned.transfer.donorId),
    receiver: facilityView(planned.transfer.receiverId),
    item: itemView(planned.transfer.itemId),
    decision: null,
  }));
}

function strategyViews(plan: RedistributionPlan): readonly StrategyView[] {
  return plan.selection.outcomes.map((outcome) => ({
    name: outcome.name,
    description: outcome.description,
    acceptable: outcome.acceptable,
    refusal: outcome.refusal,
    benefitPerUnitKm: Math.round(outcome.benefitPerUnitKm * 1000) / 1000,
    transfers: outcome.plan.transfers.length,
    units: outcome.plan.transfers.reduce((total, transfer) => total + transfer.quantity, 0),
    unitKm: Math.round(
      outcome.plan.transfers.reduce(
        (total, transfer) => total + transfer.quantity * transfer.distanceKm,
        0,
      ),
    ),
    objective: outcome.plan.objective,
    violations: outcome.verdict.violations.map((violation) => ({
      rule: violation.rule,
      code: violation.code,
      detail: violation.detail,
    })),
    unchecked: outcome.verdict.unchecked.map((unchecked) => ({
      rule: unchecked.rule,
      detail: unchecked.detail,
    })),
    measured: outcome.verdict.measured,
    chosen: outcome.name === plan.selection.name,
  }));
}

/**
 * Build the process's plan once, and persist the proposals it earned.
 *
 * The proposal records go through the persistence port on the way out, so the
 * record a decision is appended to is the record the platform stored. The plan
 * itself is held in memory: it is a computation over the dataset, and
 * `pnpm worker:propose` recomputes it from the same inputs and prints a digest
 * of it, which is how the numbers on the page are reproduced outside a browser.
 */
async function build(): Promise<Built> {
  const startedAt = Date.now();
  const store = await getLiveStore();
  const population = await readScoredPopulation();
  const { network, simulation } = store.dataset;

  const plan = await planWorld({
    network,
    simulation,
    catalogue: store.catalogue,
    ledger: store.ledger,
    facilitiesWithHistory: store.historyFacilities,
    scored: population.assessments,
  });

  const collection = await proposalCollection();
  for (const proposed of plan.proposals) {
    await collection.set(proposed.proposal.id, proposed.proposal);
  }

  return {
    asOf: population.asOf,
    seed: store.info.seed,
    scenarioId: store.info.scenarioId,
    scenarioLabel: store.info.scenarioLabel,
    generatedInMs: Date.now() - startedAt,
    plan,
    rows: rowsOf(plan, store),
    facilityById: new Map(network.facilities.map((facility) => [facility.id as string, facility])),
    itemById: new Map(store.catalogue.map((item) => [item.id as string, item])),
    scope: store.scope,
  };
}

let pending: Promise<Built> | undefined;

const built = (): Promise<Built> => (pending ??= build());

// --- Reading ------------------------------------------------------------------

/** Whether a session may see a transfer, given which end of it is theirs. */
const mayRead = (session: Session, row: RedistributionRow, scope: ScopeLookup): boolean =>
  canReadDistrict(session, row.receiver.districtId, scope) ||
  canReadDistrict(session, row.donor.districtId, scope);

/**
 * Whether a session may decide this transfer, or the sentence explaining why not.
 *
 * The authority sits a level above the facilities the stock moves between: a
 * district officer may decide a transfer with an end in their district (the
 * phase's reviewer), a state officer one within their state, the control room
 * any. Front-line staff may not approve a cross-facility movement, and an auditor
 * writes nothing at all.
 */
export function decisionRefusal(
  session: Session,
  row: RedistributionRow,
  scope: ScopeLookup,
): string | null {
  switch (session.role) {
    case 'auditor':
      return 'an auditor reads the record but does not write to it';
    case 'phc_staff':
      return 'a transfer between facilities is decided at district level or above';
    case 'district_officer': {
      const own = session.scopeId;
      if (own !== null && (row.donor.districtId === own || row.receiver.districtId === own)) {
        return null;
      }
      return `${session.label} is scoped to a district, and neither end of this transfer is that district`;
    }
    case 'state_officer': {
      const own = session.scopeId;
      const donorRegion = scope.regionOfDistrict(row.donor.districtId);
      const receiverRegion = scope.regionOfDistrict(row.receiver.districtId);
      if (own !== null && (donorRegion === own || receiverRegion === own)) {
        return null;
      }
      return `${session.label} is scoped to a state, and neither end of this transfer is in it`;
    }
    case 'national':
      return null;
  }
}

function totalsOf(plan: RedistributionPlan): RedistributionTotals {
  const impact = plan.selection.outcome.impact;
  return {
    proposals: plan.proposals.length,
    units: plan.selection.outcome.verdict.measured.units,
    unitKm: plan.selection.outcome.verdict.measured.unitKm,
    unmetDemandAvoided: impact.totalExpectedUnmetDemandAvoided,
    stockOutDaysAverted: impact.totalExpectedStockOutDaysAverted,
    transportCost: impact.totalTransportCost,
    netBenefit: impact.totalNetBenefit,
    beneficial: impact.transfers.filter((each) => each.assessment === 'beneficial').length,
    marginal: impact.transfers.filter((each) => each.assessment === 'marginal').length,
    negative: impact.transfers.filter((each) => each.assessment === 'negative').length,
    unquantified: impact.unquantified.length,
  };
}

/**
 * The workbench payload, scoped to the session.
 *
 * The plan is national and the *view* is scoped, deliberately: one computation
 * produces the records the batch job and the surface both read, and a district
 * officer is shown the transfers with an end in their own district rather than a
 * different plan built from a subset. What was hidden is counted and said, so a
 * scoped view cannot be mistaken for the whole picture.
 */
export async function readRedistribution(session: Session): Promise<Redistribution> {
  const state = await built();
  const decisions = await readDecisions();
  const collection = await proposalCollection();
  const auditEvents = await readAuditEvents();

  const rows: RedistributionRow[] = [];
  let hidden = 0;

  for (const row of state.rows) {
    if (!mayRead(session, row, state.scope)) {
      hidden += 1;
      continue;
    }
    const persisted = await collection.get(row.proposal.id);
    rows.push({
      ...row,
      proposal: persisted ?? row.proposal,
      decision: decisions.get(row.proposal.id) ?? null,
    });
  }

  const { plan } = state;
  const named = (
    facilityId: string,
    itemId: string,
  ): {
    readonly facilityId: string;
    readonly itemId: string;
    readonly facilityName: string;
    readonly itemName: string;
  } => ({
    facilityId,
    itemId,
    facilityName: state.facilityById.get(facilityId)?.name ?? facilityId,
    itemName: state.itemById.get(itemId)?.genericName ?? itemId,
  });

  const removedByRule: Record<string, number> = { ...plan.graph.removedByRule };
  const candidates =
    plan.graph.edges.length +
    Object.values(plan.graph.removedByRule).reduce((sum, count) => sum + count, 0);

  return {
    session: { role: session.role, label: session.label },
    auditEvents,
    asOf: state.asOf,
    seed: state.seed,
    scenarioId: state.scenarioId,
    scenarioLabel: state.scenarioLabel,
    generatedInMs: state.generatedInMs,
    rows,
    strategies: strategyViews(plan),
    chosen: {
      name: plan.selection.name,
      decidedBy: plan.selection.decidedBy,
      reason: plan.selection.reason,
      iterations: plan.iterations,
      budgetReached: plan.budgetReached,
      refusals: plan.selection.refusals,
    },
    verdict: plan.selection.outcome.verdict,
    refused: plan.refused,
    totals: totalsOf(plan),
    unquantified: plan.selection.outcome.impact.unquantified,
    objective: plan.objective,
    baseline: plan.baseline,
    improvementPasses: plan.improvementPasses,
    graph: {
      edges: plan.graph.edges.length,
      candidates,
      removedByRule,
      unknownFacilities: plan.graph.unknownFacilities.length,
      unknownItems: plan.graph.unknownItems.length,
    },
    rankings: {
      receiversRanked: plan.receivers.ranked.length,
      receiversUnmeasured: plan.receivers.unmeasured.length,
      donorsEligible: plan.donors.ranked.length,
      donorsIneligible: plan.donors.ineligible.length,
      needs: plan.needs.length,
      unpositionedReceivers: plan.unpositionedReceivers.length,
    },
    ineligibleDonors: plan.donors.ineligible.slice(0, LIST_LIMIT).map((donor) => ({
      ...named(donor.facilityId, donor.itemId),
      reason:
        donor.basis === 'demand-unmeasured'
          ? 'no daily demand was ever measured here, so no safety floor can be computed and this facility cannot donate'
          : 'everything it holds is inside the floor it keeps for itself',
    })),
    unmeasuredReceivers: plan.receivers.unmeasured.slice(0, LIST_LIMIT).map((receiver) => ({
      ...named(receiver.facilityId, receiver.itemId),
      reason:
        'the forecast measured no shortfall probability for this pair, so it is reported rather than ranked',
    })),
    unserved: plan.unserved.slice(0, LIST_LIMIT).map((need) => ({
      ...named(need.facilityId, need.itemId),
      units: need.units,
      reason:
        'no donor within the feasibility window could cover this need without falling below its own safety floor',
    })),
    transport: plan.world.transport,
    impactAssumptions: plan.selection.outcome.impact.assumptions,
    impactMethod: plan.selection.outcome.impact.assumptions.method,
    audit: verifyAuditChain(auditEvents),
    national: hidden === 0,
    hidden,
    scopeNote:
      hidden === 0
        ? 'this session sees every transfer in the plan'
        : `this session sees ${String(rows.length)} of ${String(rows.length + hidden)} transfers; the rest are outside what ${session.label} is responsible for`,
  };
}

// --- Deciding -----------------------------------------------------------------

/**
 * A decision refused, with the status the route should answer with.
 *
 * Carried on the refusal rather than decided by the route, so the rule that
 * refused and the code a client sees cannot drift apart: 404 for a proposal that
 * does not exist, 400 for a request that is not a decision (no reason), 403 for a
 * decision this session is not allowed to make, and 409 for one already taken.
 */
export class ProposalRefused extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = 'ProposalRefused';
    this.status = status;
  }
}

export interface DecisionInput {
  readonly proposalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
}

/**
 * Approve or reject one proposal, and record who decided, when, and why.
 *
 * The chain is written first. It is the authoritative record — an approval on a
 * proposal that the trail does not know about would put the two records the wrong
 * way round — and a rejection exists *only* there, because `approvals` is a list
 * of approvals and writing a refusal into it would misstate the record.
 *
 * A proposal is decided once. Reopening a decision, or approving a plan the
 * validator refused, is refused with the reason stated; nothing is silently
 * clamped and no state is overwritten.
 */
export async function decideTransferProposal(
  session: Session,
  input: DecisionInput,
): Promise<{ readonly proposal: TransferProposal; readonly decision: ProposalDecision }> {
  const state = await built();
  const row = state.rows.find((each) => each.proposal.id === input.proposalId);

  if (row === undefined) {
    throw new ProposalRefused(`no transfer proposal with the identifier ${input.proposalId}`, 404);
  }
  if (!mayRead(session, row, state.scope)) {
    throw new ProposalRefused('this transfer is outside the scope this session is responsible for');
  }

  const refusal = decisionRefusal(session, row, state.scope);
  if (refusal !== null) {
    throw new ProposalRefused(refusal);
  }
  if (input.reason.trim() === '') {
    // A decision with no reason cannot be explained to anyone afterwards, and it
    // is refused as a request rather than as a permission.
    throw new ProposalRefused('a decision has to say why it was made', 400);
  }

  const already = (await readDecisions()).get(input.proposalId);
  if (already !== undefined) {
    throw new ProposalRefused(
      `this proposal was already ${already.decision} by ${already.by} on ${already.at}; a decision is taken once`,
      409,
    );
  }

  const collection = await proposalCollection();
  const proposal = await collection.get(input.proposalId);
  if (proposal === null) {
    throw new ProposalRefused(`no transfer proposal with the identifier ${input.proposalId}`, 404);
  }
  if (proposal.verdict === 'rejected') {
    throw new ProposalRefused('a proposal the validator refused cannot be approved', 409);
  }

  const at = new Date().toISOString();
  const reason = input.reason.trim();
  const event = await recordAuditEvent({
    actor: actorOf(session),
    action: input.decision === 'approved' ? APPROVE_ACTION : REJECT_ACTION,
    subjectType: 'transfer_proposal',
    subjectId: proposal.id,
    reason,
    // A proposal is decided once, so the state it leaves is always the same one:
    // the pair says what the decision was, and says it in the same vocabulary the
    // workbench shows.
    before: 'awaiting decision',
    after: input.decision === 'approved' ? 'approved' : 'rejected',
    at,
  });

  if (input.decision === 'approved') {
    const approved = transferProposalSchema.parse({
      ...proposal,
      approvals: [...proposal.approvals, { by: session.label, role: session.role, at, reason }],
    });
    await collection.set(approved.id, approved);
    return { proposal: approved, decision: decisionOf(event) };
  }

  return { proposal, decision: decisionOf(event) };
}
