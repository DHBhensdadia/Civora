import {
  decideVoiceCommand,
  voiceCaptureCommandSchema,
  voiceIngestRequestFor,
} from '@civora/domain';
import type {
  BatchId,
  DateOnly,
  FacilityId,
  IngestReceipt,
  ItemId,
  VoiceCaptureCommand,
  VoiceObservationType,
  VoiceProblem,
} from '@civora/domain';

import { actorOf } from './audit-service';
import { applySubmission } from './ingest-boundary';
import { getLiveStore } from './live-store';
import type { LiveStore } from './live-store';
import { canSubmitForFacility, scopeRefusalFor } from './session';
import type { Session } from './session';

/**
 * Voice intake: what was heard, what it would write, and the confirmation in
 * between.
 *
 * The people who record stock are comfortable speaking and less comfortable
 * typing, in a country with twenty-two scheduled languages. Speech is also the
 * one input the platform cannot check against the evidence it came from: there is
 * no page to compare a transcript to. So this flow has a step no other flow has —
 * **the parse is held until the person who spoke has seen it and confirmed it**,
 * and the held proposal is what this file stores.
 *
 * Three properties are the point, and they are the same three the vision path
 * has, translated:
 *
 *  - **Nothing is written from an utterance alone.** A proposal sits in the queue
 *    until a confirmation arrives with the proposal's identity in it. The write
 *    happens only on that route, so a screen that forgot to show the
 *    confirmation could not write.
 *  - **The confirmation asks about the actual uncertainty.** The questions are
 *    computed by `decideVoiceCommand` — the platform's own rule — and rendered
 *    by the screen, rather than the screen inventing its own idea of what to
 *    check. A rule and a question that were written twice would drift.
 *  - **Re-confirming is a replay, not a second movement.** The identifiers are
 *    derived from the proposal, so a person pressing confirm twice arrives at the
 *    same submission and the ingest boundary answers it from the receipt.
 *
 * What the person may correct is narrow, and deliberately so: the item a name
 * meant, the batch and expiry of arriving stock, and how many of the filled posts
 * turned up. Those are exactly the questions the rule can raise. An intent, a
 * quantity and a cadre are *required* by the command schema, so a parse that lost
 * one is re-asked of the model rather than patched by a person filling in a gap
 * in the evidence.
 */

/** Where a parse came from. */
export const VOICE_SOURCES = ['model', 'supplied'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

/** One catalogue entry offered to a person settling a name. */
export interface VoiceCandidate {
  readonly id: string;
  readonly name: string;
  /** The strength is required in the label: the same medicine at two strengths is two entries. */
  readonly strength: string;
  readonly form: string;
}

/** The catalogue entry this utterance would be written against. */
export interface ProposedRecord {
  readonly id: ItemId;
  readonly name: string;
  readonly strength: string;
  readonly form: string;
}

export interface VoiceProposal {
  readonly id: string;
  readonly facilityId: FacilityId;
  readonly facilityName: string;
  /** The day the update is about. Speech carries no date, so it defaults to the capture day. */
  readonly observedOn: DateOnly;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: VoiceSource;
  /** The model that parsed it, or `none` when the parse was supplied. */
  readonly model: string;
  readonly cacheHit: boolean;
  /** Who spoke it, as the session named them, so the queue can say whose update waits. */
  readonly spokenBy: string;
  /** The parse exactly as it arrived: the transcript is shown back verbatim. */
  readonly command: VoiceCaptureCommand;
  /** Everything a person still has to settle. Empty means it is ready to write. */
  readonly problems: readonly VoiceProblem[];
  readonly observation: VoiceObservationType | null;
  /** The catalogue entry the name resolved to, if any. */
  readonly item: ProposedRecord | null;
  readonly candidates: readonly VoiceCandidate[];
  /** What a person changed while confirming, so the stored record is attributable. */
  readonly confirmedBy: string | null;
  /**
   * Set when somebody said the parse was not what they said.
   *
   * The proposal is kept rather than deleted, for the same reason the vision
   * queue keeps a discarded line: a rejection is evidence about the reader, and
   * deleting it would leave the parse rate looking better than it is.
   */
  readonly discardedBy: string | null;
  readonly receipt: IngestReceipt | null;
}

/** A refusal the interface can show, with the status the route answers with. */
export class VoiceRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'VoiceRefused';
    this.status = status;
  }
}

const proposals = new Map<string, VoiceProposal>();
let received = 0;

const candidateOf = (item: {
  readonly id: string;
  readonly genericName: string;
  readonly strength: string;
  readonly form: string;
}): VoiceCandidate => ({
  id: item.id,
  name: item.genericName,
  strength: item.strength,
  form: item.form,
});

/**
 * Everything the rule would say about a proposal's command.
 *
 * Composed in one place because it is computed twice — once when the parse
 * arrives and again with a person's corrections in front of it — and the two must
 * be the same computation, or a queue would accept what the write refuses.
 */
function viewOf(input: {
  readonly command: VoiceCaptureCommand;
  readonly catalogue: LiveStore['catalogue'];
  readonly observedOn: DateOnly;
  readonly chosenItemId?: string | undefined;
}): Pick<VoiceProposal, 'problems' | 'observation' | 'item' | 'candidates'> {
  const decision = decideVoiceCommand({
    command: input.command,
    catalogue: input.catalogue,
    observedOn: input.observedOn,
    ...(input.chosenItemId === undefined ? {} : { chosenItemId: input.chosenItemId }),
  });

  return {
    problems: decision.problems,
    observation: decision.observation,
    item:
      decision.item === null
        ? null
        : {
            id: decision.item.id,
            name: decision.item.genericName,
            strength: decision.item.strength,
            form: decision.item.form,
          },
    candidates: decision.candidates.map(candidateOf),
  };
}

export interface RecordVoiceCommandInput {
  readonly session: Session;
  readonly facilityId: FacilityId;
  readonly command: VoiceCaptureCommand;
  readonly observedOn: DateOnly;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: VoiceSource;
  readonly model: string;
  readonly cacheHit: boolean;
}

/**
 * Hold a parse for confirmation.
 *
 * Nothing here reaches the ledger: the proposal is the whole output, and the
 * only way out of this file into a record is `confirmVoiceCommand`.
 */
export async function recordVoiceCommand(input: RecordVoiceCommandInput): Promise<VoiceProposal> {
  const store = await getLiveStore();

  if (!canSubmitForFacility(input.session, input.facilityId, store.scope)) {
    throw new VoiceRefused(403, scopeRefusalFor(input.session, 'facility'));
  }

  const facility = store.dataset.network.facilities.find((entry) => entry.id === input.facilityId);

  received += 1;
  const proposal: VoiceProposal = {
    id: `voice-${String(received)}`,
    facilityId: input.facilityId,
    facilityName: facility?.name ?? input.facilityId,
    observedOn: input.observedOn,
    capturedAt: input.capturedAt,
    receivedAt: input.receivedAt,
    source: input.source,
    model: input.model,
    cacheHit: input.cacheHit,
    spokenBy: input.session.label,
    command: input.command,
    ...viewOf({
      command: input.command,
      catalogue: store.catalogue,
      observedOn: input.observedOn,
    }),
    confirmedBy: null,
    discardedBy: null,
    receipt: null,
  };

  proposals.set(proposal.id, proposal);
  return proposal;
}

/** The proposals a session may act on, oldest first. */
export async function voiceQueue(session: Session): Promise<readonly VoiceProposal[]> {
  const store = await getLiveStore();

  return [...proposals.values()].filter((proposal) =>
    canSubmitForFacility(session, proposal.facilityId, store.scope),
  );
}

/** What a person changed about the parse while confirming it. */
export interface VoiceCorrections {
  /** The catalogue entry the spoken name meant. */
  readonly itemId?: string | undefined;
  readonly batchId?: BatchId | null | undefined;
  readonly expiresOn?: string | null | undefined;
  readonly presentToday?: number | null | undefined;
}

export interface ConfirmVoiceCommandInput {
  readonly session: Session;
  readonly id: string;
  readonly corrections?: VoiceCorrections | undefined;
}

/**
 * Write a confirmed utterance, or refuse it with what is still outstanding.
 *
 * The rule runs again with the person's corrections in front of it, so a
 * proposal that is still incomplete is refused *after* somebody pressed confirm
 * rather than written because they did. The corrections are applied to the
 * command and re-parsed by the command's own schema, which means a person cannot
 * use the confirmation screen to build a record the platform would not have
 * accepted from a model — putting a batch on an issue is refused here, not
 * silently dropped.
 */
export async function confirmVoiceCommand(input: ConfirmVoiceCommandInput): Promise<VoiceProposal> {
  const store = await getLiveStore();
  const proposal = proposals.get(input.id);

  if (proposal === undefined) {
    throw new VoiceRefused(404, `no spoken update is waiting under "${input.id}"`);
  }
  if (!canSubmitForFacility(input.session, proposal.facilityId, store.scope)) {
    throw new VoiceRefused(403, scopeRefusalFor(input.session, 'facility'));
  }
  if (proposal.discardedBy !== null) {
    throw new VoiceRefused(409, `that update was discarded by ${proposal.discardedBy}`);
  }
  if (proposal.receipt !== null) {
    // Confirming a proposal that has already been written is the same
    // confirmation, not a second movement.
    return proposal;
  }

  const corrections = input.corrections ?? {};
  const corrected = applyCorrections(proposal.command, corrections);

  const view = viewOf({
    command: corrected,
    catalogue: store.catalogue,
    observedOn: proposal.observedOn,
    ...(corrections.itemId === undefined ? {} : { chosenItemId: corrections.itemId }),
  });

  if (view.problems.length > 0 || view.observation === null) {
    throw new VoiceRefused(
      409,
      view.problems.length > 0
        ? `that update still cannot be written: ${view.problems.join(', ')}`
        : 'that utterance was not understood, so there is nothing to write',
    );
  }
  if (view.observation === 'stock_ledger_entry' && view.item === null) {
    throw new VoiceRefused(409, 'that update has no catalogue item to write against');
  }

  const submission = voiceIngestRequestFor({
    facilityId: proposal.facilityId,
    command: corrected,
    itemId: view.item === null ? null : view.item.id,
    observedOn: proposal.observedOn,
    capturedAt: proposal.capturedAt,
    recordId: `entry-${proposal.id}`,
    idempotencyKey: `key-${proposal.id}`,
  });

  const { decision } = await applySubmission(
    store,
    submission,
    proposal.receivedAt,
    actorOf(input.session),
  );
  if (decision.outcome === 'conflict') {
    throw new VoiceRefused(409, decision.detail);
  }

  const confirmed: VoiceProposal = {
    ...proposal,
    command: corrected,
    ...view,
    confirmedBy: input.session.label,
    receipt: decision.receipt,
  };
  proposals.set(confirmed.id, confirmed);
  return confirmed;
}

/**
 * Reject a proposal: the parse is not what the person said.
 *
 * Kept in the queue rather than deleted, because a rejected parse is the only
 * signal the platform has about how the reader performs on real speech, and a
 * queue that quietly removed its own mistakes could not report one.
 */
export async function discardVoiceCommand(input: {
  readonly session: Session;
  readonly id: string;
}): Promise<VoiceProposal> {
  const store = await getLiveStore();
  const proposal = proposals.get(input.id);

  if (proposal === undefined) {
    throw new VoiceRefused(404, `no spoken update is waiting under "${input.id}"`);
  }
  if (!canSubmitForFacility(input.session, proposal.facilityId, store.scope)) {
    throw new VoiceRefused(403, scopeRefusalFor(input.session, 'facility'));
  }
  if (proposal.receipt !== null) {
    throw new VoiceRefused(409, 'that update was already written into the ledger');
  }

  const discarded: VoiceProposal = { ...proposal, discardedBy: input.session.label };
  proposals.set(discarded.id, discarded);
  return discarded;
}

/**
 * Apply a person's corrections to the parse they are confirming.
 *
 * Parsed rather than merged, because the corrections are *evidence* and the
 * command schema is the only thing that decides whether the evidence is
 * admissible. A correction that would make the command illegal is reported as a
 * refusal naming the schema's own complaint.
 */
function applyCorrections(
  command: VoiceCaptureCommand,
  corrections: VoiceCorrections,
): VoiceCaptureCommand {
  const patched = {
    ...command,
    ...(corrections.batchId === undefined ? {} : { batchId: corrections.batchId }),
    ...(corrections.expiresOn === undefined ? {} : { expiresOn: corrections.expiresOn }),
    ...(corrections.presentToday === undefined ? {} : { presentToday: corrections.presentToday }),
  };

  const parsed = voiceCaptureCommandSchema.safeParse(patched);
  if (!parsed.success) {
    throw new VoiceRefused(
      409,
      `that update cannot be written as corrected: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'command'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  return parsed.data;
}
