import { generateRationale } from '@civora/ai';
import type { RationaleAttempt, TransferRationaleInput } from '@civora/ai';

import { getProviders } from '@/providers';
import { readRedistribution } from './redistribution-service';
import type { RedistributionRow } from './redistribution-service';
import type { Session } from './session';

/**
 * The explanation beside each proposal, written once for the set that is on the
 * workbench.
 *
 * A proposal carries the solver's quantity, the validator's verdict and the
 * estimator's figures. What it does not carry is the case for it in words — and
 * that is the part a model is genuinely useful for and the part the platform must
 * not let it invent. So this walks the proposals the session can see, asks
 * `@civora/ai`'s grounded rationale writer for each one, and reports what came
 * back **per proposal**.
 *
 * Three decisions are load-bearing:
 *
 *  - **Once per process, not per row.** Nothing here is called because somebody
 *    opened a proposal. Writing the set in one pass is what makes the second
 *    reader — and a five-second refresh — cost nothing, and it is the same
 *    discipline the advisory set follows.
 *  - **A refusal is a result.** With no key configured every attempt refuses, and
 *    the workbench shows the writer's own sentence per proposal. What it must
 *    never do is leave an empty space a reader could take for agreement.
 *  - **Every figure is one the proposal already carries.** The facts handed to
 *    the writer are the very figures the row displays; the grounded schema
 *    refuses anything else, including arithmetic on them.
 *
 * The writer is asked about the **same rows the page displays**, so a scoped
 * reader never gets an explanation of a transfer they cannot see.
 */

export interface RationaleView {
  readonly proposalId: string;
  readonly status: 'written' | 'refused';
  /** The written summary, or null. */
  readonly summary: string | null;
  /** What would make this transfer the wrong thing to do. */
  readonly conditions: readonly string[];
  readonly citations: readonly string[];
  /**
   * Why nothing was written, in the writer's own words.
   *
   * Null when something *was* written. A field that carried "no rationale has
   * been asked for" beside a written summary would be a sentence a client could
   * read as a refusal that never happened — the live check found exactly that,
   * which is why it is asserted there.
   */
  readonly refusal: string | null;
  readonly model: string | null;
  readonly cacheHit: boolean;
  readonly attemptedAt: string;
}

export interface RationaleSet {
  readonly provider: string;
  readonly proposals: number;
  readonly rationales: readonly RationaleView[];
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
  /** Whether this read did the writing, or answered from what the process holds. */
  readonly regenerated: boolean;
  readonly generatedAt: string;
  readonly generatedInMs: number;
}

interface Attempted {
  readonly attempt: RationaleAttempt;
  readonly at: string;
}

const attempted = new Map<string, Attempted>();
let generatedAt = '';
let generationMs = 0;

/**
 * The proposal as the writer is given it.
 *
 * Built from the row's own view rather than from the domain record alone, so the
 * names, the unit and the expiry the writer may mention are the ones the page
 * shows — and an impact the estimator could not measure travels as `null`, which
 * `@civora/ai` turns into *no fact at all* rather than a zero standing in for a
 * measurement nobody took.
 */
export function rationaleInputOf(row: RedistributionRow): TransferRationaleInput {
  return {
    proposalId: row.proposal.id,
    donorFacility: row.donor.name,
    donorDistrict: row.donor.districtName,
    receiverFacility: row.receiver.name,
    receiverDistrict: row.receiver.districtName,
    item: row.item.name,
    unit: row.item.unit,
    quantity: row.transfer.quantity,
    batchId: row.transfer.batchId,
    expiresOn: row.transfer.expiresOn,
    distanceKm: row.transfer.distanceKm,
    leadTimeDays: row.transfer.leadTimeDays,
    shelfLifeOnArrivalDays: row.transfer.shelfLifeOnArrivalDays,
    coldChain: row.transfer.coldChain,
    assessment: row.impact?.assessment ?? 'unquantified',
    unmetDemandAvoided: row.impact?.expectedUnmetDemandAvoided ?? null,
    stockOutDaysAverted: row.impact?.expectedStockOutDaysAverted ?? null,
    transportCost: row.impact?.transportCost ?? null,
    netBenefit: row.impact?.netBenefit ?? null,
    donorDaysOfStockAfter: row.proposal.expectedImpact.donorDaysOfStockAfter,
    receiverDaysOfStockAfter: row.proposal.expectedImpact.receiverDaysOfStockAfter,
    assumptions: row.proposal.expectedImpact.assumptions,
  };
}

function viewOf(proposalId: string, entry: Attempted | undefined): RationaleView {
  const rationale = entry?.attempt.status === 'written' ? entry.attempt.rationale : null;

  return {
    proposalId,
    status: entry?.attempt.status ?? 'refused',
    summary: rationale?.summary ?? null,
    conditions: rationale?.conditions ?? [],
    citations: rationale?.citations ?? [],
    refusal:
      entry === undefined
        ? 'no rationale has been asked for in this process yet'
        : entry.attempt.status === 'written'
          ? null
          : (entry.attempt.refusal ?? 'the writer refused without saying why'),
    model: entry?.attempt.model ?? null,
    cacheHit: entry?.attempt.cacheHit ?? false,
    attemptedAt: entry?.at ?? '',
  };
}

/**
 * Write the rationales for the proposals on the workbench, or answer from what
 * this process already holds.
 *
 * Sequentially, for the same reason the advisory batch is: a handful of requests
 * fired at once turns a rate limit into a wave of refusals that all say the same
 * thing, and the honest outcome is a complete account of what was attempted.
 */
export async function readRationaleSet(
  session: Session,
  options: { readonly regenerate?: boolean | undefined } = {},
): Promise<RationaleSet> {
  const startedAt = Date.now();
  const redistribution = await readRedistribution(session);
  const provider = getProviders().reasoning;
  const regenerate = options.regenerate === true;
  let didWork = false;

  for (const row of redistribution.rows) {
    const proposalId = row.proposal.id;
    if (!regenerate && attempted.has(proposalId)) {
      continue;
    }

    const attempt = await generateRationale(provider, rationaleInputOf(row));
    attempted.set(proposalId, { attempt, at: new Date().toISOString() });
    didWork = true;
  }

  if (didWork) {
    generatedAt = new Date().toISOString();
    generationMs = Date.now() - startedAt;
  }

  const views = redistribution.rows.map((row) =>
    viewOf(row.proposal.id, attempted.get(row.proposal.id)),
  );
  const tried = views.filter((view) => view.attemptedAt !== '');

  return {
    provider: provider.kind,
    proposals: redistribution.rows.length,
    rationales: views,
    attempted: tried.length,
    written: tried.filter((view) => view.status === 'written').length,
    refused: tried.filter((view) => view.status === 'refused').length,
    regenerated: didWork,
    generatedAt,
    generatedInMs: generationMs,
  };
}
