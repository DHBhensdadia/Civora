import { transferProposalSchema } from '@civora/domain';
import type { FacilityId, StockLedgerEntry } from '@civora/domain';
import { FACILITY_A, aLedgerEntry } from '@civora/domain/testing';
import {
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  ITEMS,
  buildNetwork,
  scorePopulation,
  simulateNetwork,
} from '@civora/simulator';
import type { Network } from '@civora/simulator';
import { beforeAll, describe, expect, it } from 'vitest';

import { readAuditEvents, recordAuditEvent, verifyAuditChain } from './audit-service';
import { readScoredPopulation } from './intelligence-service';
import { LedgerService } from './ledger-service';
import { getLiveStore } from './live-store';
import {
  LIST_LIMIT,
  ProposalRefused,
  decisionRefusal,
  decideTransferProposal,
  lotsFrom,
  planWorld,
  readDecisions,
  readRedistribution,
} from './redistribution-service';
import type { RedistributionRow } from './redistribution-service';
import { NATIONAL_SESSION } from './session';
import type { Session } from './session';

/**
 * Setu's workbench, held to what it claims.
 *
 * Three things are asserted here that a unit test of the optimiser cannot see:
 * that the records a surface reads are persisted through the persistence port;
 * that a decision records who, when and why, in a chain that can still be
 * verified afterwards; and that the *whole* pipeline — dataset, forecasts, graph,
 * rankings, plan, validator, impact — proposes nothing in the world's own
 * negative control, where nothing wrong is happening at all.
 *
 * The last one is why this file builds a second, smaller nation: the control is a
 * property of the pipeline over a scenario designed to need no redistribution,
 * and asserting it over the demonstration dataset would prove nothing.
 */

/** A receipt of stock, with the batch and expiry the ledger requires. */
const receipt = (
  id: string,
  quantity: number,
  batchId: string,
  expiresOn: string,
): StockLedgerEntry =>
  aLedgerEntry({
    id,
    kind: 'receipt',
    quantity,
    batchId,
    expiresOn,
    occurredOn: '2026-01-02',
    recordedAt: '2026-01-02T09:00:00.000Z',
  });

const issue = (id: string, quantity: number, batchId: string | null): StockLedgerEntry =>
  aLedgerEntry({
    id,
    kind: 'issue',
    quantity,
    batchId,
    expiresOn: null,
    occurredOn: '2026-01-03',
    recordedAt: '2026-01-03T09:00:00.000Z',
  });

describe('the batches the ledger still holds', () => {
  it('keeps stock with a known expiry, drops what is consumed, and drops an expiry the ledger never stated', () => {
    const lots = lotsFrom([
      receipt('r-kept', 60, 'batch-kept', '2027-01-01'),
      issue('i-uses-kept', 50, 'batch-kept'),
      receipt('r-consumed', 40, 'batch-consumed', '2026-06-01'),
      issue('i-consumes-all', 40, 'batch-consumed'),
      // An adjustment upward, which is how a batch with no stated expiry can
      // hold stock at all. The graph is not told about it: a lot whose expiry
      // nobody knows cannot be promised to arrive before it expires.
      aLedgerEntry({
        id: 'adjust-no-expiry',
        kind: 'adjust',
        adjustmentDirection: 'increase',
        quantity: 5,
        batchId: 'batch-no-expiry',
        expiresOn: null,
        occurredOn: '2026-01-03',
        recordedAt: '2026-01-03T09:00:00.000Z',
      }),
      receipt('r-soonest', 12, 'batch-soonest', '2026-08-01'),
    ]);

    expect(lots.map((lot) => [lot.batchId, lot.quantity, lot.expiresOn])).toEqual([
      ['batch-kept', 10, '2027-01-01'],
      ['batch-soonest', 12, '2026-08-01'],
    ]);
    expect(lots.every((lot) => lot.facilityId === FACILITY_A)).toBe(true);
  });
});

describe('the pipeline over the demonstration dataset', () => {
  let payload: Awaited<ReturnType<typeof readRedistribution>>;

  beforeAll(async () => {
    payload = await readRedistribution(NATIONAL_SESSION);

    // The numbers this suite is about, printed so a reader of the run can see
    // what the assertions were made against rather than inferring it.
    console.log(
      `redistribution ${payload.asOf}: graph ${String(payload.graph.edges)} edge(s) of ` +
        `${String(payload.graph.candidates)} candidate(s); ` +
        `${String(payload.rankings.receiversRanked)} receiver(s) ranked, ` +
        `${String(payload.rankings.donorsEligible)} donor(s) eligible, ` +
        `${String(payload.rankings.needs)} need(s); ${String(payload.rows.length)} proposal(s), ` +
        `${String(payload.totals.units)} unit(s) over ${String(payload.totals.unitKm)} unit-km, ` +
        `net benefit ${String(payload.totals.netBenefit)}; chosen ${payload.chosen.name} ` +
        `(${payload.chosen.decidedBy}); built in ${String(payload.generatedInMs)} ms`,
    );
  }, 120_000);

  it('proposes at least one transfer the independent validator admitted', () => {
    expect(payload.verdict.valid).toBe(true);
    expect(payload.refused).toEqual([]);
    expect(payload.rows.length).toBeGreaterThan(0);
  });

  it('gives every row a proposed verdict, no violations, and assumptions under every figure', () => {
    for (const row of payload.rows) {
      expect(row.proposal.verdict).toBe('proposed');
      expect(row.proposal.violations).toEqual([]);
      expect(row.proposal.approvals).toEqual([]);
      expect(row.donor.facilityId).not.toBe(row.receiver.facilityId);
      expect(row.proposal.quantity).toBeGreaterThan(0);
      expect(Number.isInteger(row.proposal.expectedImpact.unmetDemandAvoided)).toBe(true);
      expect(row.proposal.expectedImpact.assumptions.length).toBeGreaterThanOrEqual(5);
      expect(row.proposal.expectedImpact.assumptions.join(' ')).toContain(
        'two-quantile-stock-projection',
      );
      // Every quantity in the record is an engine's, and the record still says
      // which of the optimiser's transfers it describes.
      expect(row.transfer.quantity).toBe(row.proposal.quantity);
      expect(row.transfer.batchId).toBe(row.proposal.batchId);
    }
  });

  it('persists each proposal through the port, and reads it back by identifier', async () => {
    const store = await getLiveStore();
    const collection = store.provider.collection('transferProposals', transferProposalSchema);

    for (const row of payload.rows) {
      const stored = await collection.get(row.proposal.id);
      expect(stored?.id).toBe(row.proposal.id);
      expect(stored?.quantity).toBe(row.proposal.quantity);
    }
  });

  it('counts what the ranking could not use instead of leaving it invisible', () => {
    // The demonstration dataset holds a history for a sample of facilities, so
    // the graph and the rankings legitimately exclude most of them. What matters
    // is that the count is reported rather than folded into a quiet zero.
    expect(payload.rankings.receiversRanked + payload.rankings.receiversUnmeasured).toBeGreaterThan(
      0,
    );
    expect(payload.rankings.donorsEligible + payload.rankings.donorsIneligible).toBeGreaterThan(0);
    expect(payload.graph.candidates).toBeGreaterThanOrEqual(payload.graph.edges);
    expect(payload.ineligibleDonors.length).toBeLessThanOrEqual(LIST_LIMIT);
    expect(payload.unmeasuredReceivers.length).toBeLessThanOrEqual(LIST_LIMIT);
  });

  it('repeats the plan byte for byte when it is computed again from the same world', async () => {
    const store = await getLiveStore();
    const population = await readScoredPopulation();

    const again = await planWorld({
      network: store.dataset.network,
      simulation: store.dataset.simulation,
      catalogue: store.catalogue,
      ledger: store.ledger,
      facilitiesWithHistory: store.historyFacilities,
      scored: population.assessments,
    });

    expect(again.proposals.map((each) => JSON.stringify(each.proposal))).toEqual(
      payload.rows.map((row) => JSON.stringify(row.proposal)),
    );
    expect(again.objective).toEqual(payload.objective);
  }, 120_000);

  it('shows the four weightings side by side with the chosen one marked', () => {
    expect(payload.strategies.map((strategy) => strategy.name)).toEqual([
      'balanced',
      'risk-averse',
      'cost-minimising',
      'expiry-aware',
    ]);
    expect(payload.strategies.filter((strategy) => strategy.chosen)).toHaveLength(1);
    expect(payload.chosen.decidedBy).toBe('fallback');
    expect(payload.chosen.reason.length).toBeGreaterThan(0);
  });
});

describe('who may see a transfer, and who may decide one', () => {
  const scope = {
    districtOfFacility: (facilityId: string) =>
      facilityId === 'facility-b' ? 'district-2' : 'district-1',
    regionOfDistrict: (districtId: string) =>
      districtId === 'district-2' ? 'region-2' : 'region-1',
    districtsInRegion: () => ['district-1'],
  };

  const session = (role: Session['role'], scopeId: string | null): Session => ({
    role,
    scopeId,
    label: `${role} fixture`,
  });

  const row = (): RedistributionRow =>
    ({
      donor: { districtId: 'district-1' },
      receiver: { districtId: 'district-2' },
    }) as unknown as RedistributionRow;

  it('lets a district officer decide a transfer with an end in their own district', () => {
    expect(decisionRefusal(session('district_officer', 'district-1'), row(), scope)).toBeNull();
    expect(decisionRefusal(session('district_officer', 'district-2'), row(), scope)).toBeNull();
  });

  it('refuses a district officer whose district is neither end, and says which rule stopped it', () => {
    expect(decisionRefusal(session('district_officer', 'district-9'), row(), scope)).toContain(
      'neither end of this transfer',
    );
  });

  it('refuses an auditor and front-line staff whatever the scope', () => {
    expect(decisionRefusal(session('auditor', null), row(), scope)).toBe(
      'an auditor reads the record but does not write to it',
    );
    expect(decisionRefusal(session('phc_staff', 'facility-a'), row(), scope)).toContain(
      'district level or above',
    );
  });

  it('lets a state officer decide a transfer in their state and not one outside it', () => {
    expect(decisionRefusal(session('state_officer', 'region-1'), row(), scope)).toBeNull();
    expect(decisionRefusal(session('state_officer', 'region-9'), row(), scope)).toContain(
      'neither end of this transfer is in it',
    );
  });
});

const statusOf = async (run: () => Promise<unknown>): Promise<number | 'none'> => {
  try {
    await run();
    return 'none';
  } catch (error) {
    return error instanceof ProposalRefused ? error.status : 'none';
  }
};

describe('deciding a proposal', () => {
  let payload: Awaited<ReturnType<typeof readRedistribution>>;

  beforeAll(async () => {
    payload = await readRedistribution(NATIONAL_SESSION);
  }, 120_000);

  it('refuses an unknown proposal, a decision with no reason, and a repeated decision', async () => {
    const first = payload.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    expect(
      await statusOf(() =>
        decideTransferProposal(NATIONAL_SESSION, {
          proposalId: 'transfer:not-a-transfer',
          decision: 'approved',
          reason: 'this should never be recorded',
        }),
      ),
    ).toBe(404);

    expect(
      await statusOf(() =>
        decideTransferProposal(NATIONAL_SESSION, {
          proposalId: first.proposal.id,
          decision: 'approved',
          reason: '   ',
        }),
      ),
    ).toBe(400);

    // The control room approves it, and the record names who decided and why.
    const approved = await decideTransferProposal(NATIONAL_SESSION, {
      proposalId: first.proposal.id,
      decision: 'approved',
      reason: 'the receiving district confirms the need and the transport',
    });

    expect(approved.decision.decision).toBe('approved');
    expect(approved.decision.by).toBe(NATIONAL_SESSION.label);
    expect(approved.decision.actorRole).toBe('national');
    expect(approved.decision.reason).toBe(
      'the receiving district confirms the need and the transport',
    );
    expect(approved.proposal.approvals).toHaveLength(1);
    expect(approved.proposal.approvals[0]?.by).toBe(NATIONAL_SESSION.label);
    expect(approved.proposal.approvals[0]?.at).toBe(approved.decision.at);

    // A proposal is decided once: the second attempt is refused, not overwritten.
    expect(
      await statusOf(() =>
        decideTransferProposal(NATIONAL_SESSION, {
          proposalId: first.proposal.id,
          decision: 'rejected',
          reason: 'changed my mind',
        }),
      ),
    ).toBe(409);

    // And the decision is on the record, through the port, with the approval.
    const store = await getLiveStore();
    const recorded = await store.provider
      .collection('transferProposals', transferProposalSchema)
      .get(first.proposal.id);
    expect(recorded?.approvals).toHaveLength(1);
    expect((await readDecisions()).get(first.proposal.id)?.decision).toBe('approved');
  }, 120_000);

  it('refuses an auditor and front-line staff', async () => {
    const first = payload.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    expect(
      await statusOf(() =>
        decideTransferProposal(
          { role: 'auditor', scopeId: null, label: 'Auditor fixture' },
          { proposalId: first.proposal.id, decision: 'rejected', reason: 'no' },
        ),
      ),
    ).toBe(403);
    expect(
      await statusOf(() =>
        decideTransferProposal(
          { role: 'phc_staff', scopeId: first.donor.facilityId, label: 'PHC fixture' },
          { proposalId: first.proposal.id, decision: 'approved', reason: 'ok' },
        ),
      ),
    ).toBe(403);
  });

  it('lets a district officer decide a transfer that touches their district', async () => {
    const undecided = payload.rows.find(
      (row) => row.decision === null && row.proposal.id !== payload.rows[0]?.proposal.id,
    );

    // With one proposal in the plan there is no second decision to test a scoped
    // officer with; the rule itself is asserted in the block above.
    if (undecided === undefined) {
      return;
    }

    const officer: Session = {
      role: 'district_officer',
      scopeId: undecided.donor.districtId,
      label: `District officer — ${undecided.donor.districtName}`,
    };
    const decided = await decideTransferProposal(officer, {
      proposalId: undecided.proposal.id,
      decision: 'rejected',
      reason: 'the donor has a delivery due and should keep this batch',
    });

    expect(decided.decision.decision).toBe('rejected');
    expect(decided.decision.actorRole).toBe('district_officer');
    // A rejection is in the chain and not on the proposal: `approvals` is a list
    // of approvals, and writing a refusal into it would misstate the record.
    expect(decided.proposal.approvals).toEqual([]);
    expect((await readDecisions()).get(undecided.proposal.id)?.decision).toBe('rejected');
  }, 120_000);
});

describe('the audit chain', () => {
  it('links each entry to the one before it and verifies over the whole trail', async () => {
    const events = await readAuditEvents();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.previousHash).toBeNull();
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.previousHash).toBe(events[index - 1]?.hash);
    }

    const report = verifyAuditChain(events);
    expect(report.valid).toBe(true);
    expect(report.events).toBe(events.length);
  });

  it('fails verification at the entry an alteration touched, naming it', async () => {
    const events = await readAuditEvents();
    const first = events[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }

    const tampered = [{ ...first, reason: 'an approval nobody made' }, ...events.slice(1)];
    const report = verifyAuditChain(tampered);

    expect(report.valid).toBe(false);
    expect(report.brokenAt).toBe(first.id);
    expect(report.detail).toContain('altered');
  });

  it('appends rather than rewrites, and notices a removed entry', async () => {
    const before = await readAuditEvents();
    const recorded = await recordAuditEvent({
      actorUid: 'Auditor fixture',
      actorRole: 'auditor',
      action: 'chain-exercised',
      subjectType: 'transfer_proposal',
      subjectId: 'not-a-real-proposal',
      reason: null,
    });
    const after = await readAuditEvents();

    expect(after.length).toBe(before.length + 1);
    expect(recorded.previousHash).toBe(before.at(-1)?.hash ?? null);
    expect(verifyAuditChain(after).valid).toBe(true);

    // Removing the entry a later one points at breaks the link, which is the
    // property the trail exists for.
    const last = after.at(-1);
    expect(last).toBeDefined();
    if (last === undefined) {
      return;
    }
    expect(verifyAuditChain([...after.slice(0, -2), last]).valid).toBe(false);

    // The extra event is not a decision about a proposal, so no proposal's
    // decision state is affected by it.
    expect((await readDecisions()).get('not-a-real-proposal')).toBeUndefined();
  });
});

describe('the world’s own negative control', () => {
  const firstBlockFacilities = (network: Network): readonly FacilityId[] => {
    for (const block of network.blocks) {
      const facilities = network.facilities
        .filter((facility) => facility.blockId === block.id)
        .map((facility) => facility.id);
      if (facilities.length >= 3) {
        return facilities;
      }
    }
    throw new Error('the demonstration network is expected to hold a block with every tier');
  };

  it('proposes nothing in the scenario where no transfer could do any good', async () => {
    const network = buildNetwork(DEMO_NETWORK_OPTIONS);
    const facilitiesWithHistory = firstBlockFacilities(network);
    const simulation = simulateNetwork(network, {
      seed: DEMO_SEED,
      scenarioId: 'no-transfer-warranted',
      facilityIds: facilitiesWithHistory,
    });
    const population = scorePopulation(simulation, network, { bootstrapReplications: 20 });
    const ledger = new LedgerService({
      from: simulation.from,
      through: simulation.to,
      items: ITEMS,
      synthetic: true,
      provenance: { kind: 'derived', reference: 'reporting-gap-detection' },
    });
    for (const entry of simulation.ledgerEntries) {
      ledger.applyEntry(entry);
    }

    const plan = await planWorld({
      network,
      simulation,
      catalogue: ITEMS,
      ledger,
      facilitiesWithHistory,
      scored: population.assessments,
    });

    console.log(
      `${simulation.scenario.id}: ${String(facilitiesWithHistory.length)} facilities, ` +
        `${String(population.assessments.length)} scored pair(s), graph ${String(plan.graph.edges.length)} edge(s), ` +
        `${String(plan.needs.length)} need(s), ${String(plan.proposals.length)} proposal(s)`,
    );

    // The moves were physically possible — the graph held edges — and the
    // pipeline still proposed none, because no facility was short enough to need
    // one. That is the difference between a control and a tautology.
    expect(plan.graph.edges.length).toBeGreaterThan(0);
    expect(plan.needs).toEqual([]);
    expect(plan.proposals).toEqual([]);
    expect(plan.refused).toEqual([]);
  }, 120_000);
});
