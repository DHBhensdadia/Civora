import { z } from 'zod';

/**
 * What the reasoning layer *writes* — the half of model output that a person
 * reads rather than a machine records.
 *
 * Everything here is prose, and prose is where a model is most useful and most
 * dangerous, so the shapes carry the guarantee in their own fields rather than
 * in a promise. Three rules are structural:
 *
 *  - **A numeral in this text must be a numeral that was supplied.** The facts an
 *    advisory was written from are named in `citations`, and the grounding
 *    assertion checks every numeral in `title`, `body`, `actions` and `reasoning`
 *    against the fact set. An explanation that needed a number the platform had
 *    not computed is refused, not published.
 *  - **An answer with no citations is not an answer.** `citations` is non-empty,
 *    so a narrative resting on nothing cannot be constructed — the shape
 *    refuses it before the grounding test gets a chance to.
 *  - **The model explains; it does not decide.** No field here is a quantity the
 *    platform acts on. A score, a probability, a shelf-life verdict or a
 *    proposed transfer is computed by the engines of Phases 2–4 and arrives as a
 *    fact; these shapes give a model somewhere to put the *reasoning* and nowhere
 *    to put a number of its own.
 */

/**
 * One advisory, in one language.
 *
 * Stored per language rather than translated on read, because what a nurse was
 * shown on a given day has to be reproducible afterwards, and because the demo
 * must not depend on a live burst of calls at the moment it is judged.
 */
export const advisoryDraftSchema = z.strictObject({
  /** BCP-47 tag of the language this draft is written in. */
  language: z.string().trim().min(2),
  /** One line, for a list somebody scans. */
  title: z.string().trim().min(1),
  /** The paragraph an officer reads before deciding anything. */
  body: z.string().trim().min(1),
  /** What to do, in the order to do it. */
  actions: z.array(z.string().trim().min(1)).min(1),
  /** Why the alert was raised, one sentence per measured reason. */
  reasoning: z.array(z.string().trim().min(1)).min(1),
  /**
   * The names of the facts the prose rests on.
   *
   * These are the keys of the alert's own `facts` list — the same list the
   * grounding assertion checks numerals against — so a reader can audit an
   * advisory without a model in the loop.
   */
  citations: z.array(z.string().trim().min(1)).min(1),
});

export type AdvisoryDraft = z.infer<typeof advisoryDraftSchema>;

/**
 * An explanation of one risk driver, for the person holding the shelf.
 *
 * The driver's contribution and its detail sentence are computed in
 * `logic/risk`, and both travel to the writer as facts. This shape is where the
 * explanation goes; it deliberately has no contribution field, so a model cannot
 * restate the arithmetic as its own.
 */
export const driverExplanationSchema = z.strictObject({
  /** A short line naming the driver and what it means here. */
  headline: z.string().trim().min(1),
  /** Two or three sentences: what was measured, why it matters, what would move it. */
  explanation: z.string().trim().min(1),
  /** The names of the facts the explanation rests on. */
  citations: z.array(z.string().trim().min(1)).min(1),
});

export type DriverExplanation = z.infer<typeof driverExplanationSchema>;

/**
 * Why a transfer is proposed — and what would make it wrong.
 *
 * The second field is not decoration. `logic/optimizer` (Phase 6) proposes
 * transfers under hard safety constraints; a rationale that cannot name a
 * condition under which the proposal should not be carried out is an assertion
 * rather than a reason, and a receiving pharmacist has no way to disagree with
 * it. The list may be empty only when there is genuinely nothing to check, which
 * is a statement the writer has to make deliberately.
 */
export const transferRationaleSchema = z.strictObject({
  /** The proposal in one sentence, in terms the receiving facility can check. */
  summary: z.string().trim().min(1),
  /** What would make this transfer the wrong thing to do. */
  conditions: z.array(z.string().trim().min(1)),
  /** The names of the facts the rationale rests on. */
  citations: z.array(z.string().trim().min(1)).min(1),
});

export type TransferRationale = z.infer<typeof transferRationaleSchema>;

/**
 * A summary of one federated round — and what that round cannot support.
 *
 * The round's figures are the coordinator's and the accountant's; the writer's
 * only product is prose about them, and every numeral it uses must appear in the
 * round facts or the grounding rule refuses the draft. `limitations` is required
 * to be non-empty for the same reason a rationale's `conditions` is: a narrative
 * that cannot say what it does not establish reads as a claim that a federation
 * is deployed across organisations, which is the single overclaim ADR 0006
 * forbids by name.
 */
export const roundNarrativeSchema = z.strictObject({
  /** One line naming the round and what moved. */
  headline: z.string().trim().min(1),
  /** Two or three sentences about the round, in the facts' own terms. */
  summary: z.string().trim().min(1),
  /** What this round does not establish. At least one, deliberately. */
  limitations: z.array(z.string().trim().min(1)).min(1),
  /** The names of the facts the narrative rests on. */
  citations: z.array(z.string().trim().min(1)).min(1),
});

export type RoundNarrative = z.infer<typeof roundNarrativeSchema>;
