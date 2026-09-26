import { createHash } from 'node:crypto';

import { auditEventSchema } from '@civora/domain';
import type { AuditEvent, AuditSubjectType, Role } from '@civora/domain';

import { getLiveStore } from './live-store';
import type { Session } from './session';

/**
 * The tamper-evident record of consequential actions.
 *
 * An approval is the moment a recommendation acquires a person's name, and the
 * record of it has to be able to survive a question years later: who decided,
 * in what capacity, at what moment, and on what grounds. So every event carries
 * the digest of the one before it — removing an entry, altering a reason or
 * reordering two decisions breaks the chain at the point of the change, which is
 * what makes the record evidence rather than a log.
 *
 * Three properties are deliberate:
 *
 *  - **The chain lives through the persistence port**, not in a module variable.
 *    An audit trail that a process restart erases is not an audit trail, and this
 *    is the first record in the platform written that way.
 *  - **Identifiers sort in chain order.** The in-memory provider lists by
 *    identifier, so `audit-000001` … `audit-000002` is the order the events were
 *    written, on any adapter that preserves that listing rule.
 *  - **Verification is a function of the events themselves.** `verifyAuditChain`
 *    recomputes every digest and checks every link, so a reader can be shown
 *    whether the trail they are looking at holds, rather than told that it does.
 *
 * The action vocabulary is this module's: a caller cannot record an action that
 * was not registered here, and the registry below names the file that performs
 * each one. That is the difference between a log and a decision about what must
 * be answerable later.
 */

export const AUDIT_COLLECTION = 'auditEvents';

/**
 * The consequential actions, enumerated.
 *
 * The type is the completeness mechanism: `recordAuditEvent` accepts only these
 * names, so an action nobody registered does not compile, and the registry below
 * names the file that performs each one for the test that scans them. An audit
 * trail is only as good as the set of things it was decided to record — this is
 * that decision, written down where a reviewer can argue with it.
 */
export const AUDIT_ACTIONS = [
  'capture-recorded',
  'adjustment-recorded',
  'alert-acknowledged',
  'alert-escalated',
  'alert-snoozed',
  'alert-resolved',
  'alert-action-proposed',
  'transfer-proposal-approved',
  'transfer-proposal-rejected',
  'federation-rounds-computed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One consequential action, and where the platform performs it. */
export interface ConsequentialAction {
  readonly action: AuditAction;
  /**
   * The subject this action usually concerns. Not a constraint on the events
   * themselves: a capture carries the observation's own type, so one action name
   * covers a stock movement, a bed report, an attendance record and a syndromic
   * report while each event says which it was.
   */
  readonly subjectType: AuditSubjectType;
  /**
   * The files that perform it, relative to `Source/`. The completeness test reads
   * each one and fails if it no longer writes through the chain, so a writer that
   * quietly stops recording is caught rather than discovered later.
   */
  readonly writers: readonly string[];
  /** One sentence, for the viewer and for this project's own documentation. */
  readonly detail: string;
}

/**
 * Everything that counts as consequential, and everything that does not.
 *
 * Not recorded, deliberately: a refused move (nothing changed), a replay or a
 * duplicate submission (nothing was written), a read of any surface, and the
 * automatic recomputations — scores, forecasts, advisories — which are the
 * platform's arithmetic rather than a person's decision. The federated round is
 * recorded because a session causes it and it consumes a privacy budget; the
 * alert moves and the transfer decisions are recorded because they change what
 * the platform will do next.
 */
export const CONSEQUENTIAL_ACTIONS: readonly ConsequentialAction[] = [
  {
    action: 'capture-recorded',
    subjectType: 'stock_ledger_entry',
    writers: ['apps/web/src/lib/ingest-boundary.ts'],
    detail:
      'an observation a facility recorded reached the ledger; the event carries the observation’s own type, so a bed report and a stock movement are told apart by the record they name',
  },
  {
    action: 'adjustment-recorded',
    subjectType: 'stock_ledger_entry',
    writers: ['apps/web/src/lib/ingest-boundary.ts'],
    detail: 'a stock correction was written, which is the movement most worth reading later',
  },
  {
    action: 'alert-acknowledged',
    subjectType: 'alert',
    writers: ['apps/web/src/lib/intelligence-service.ts'],
    detail: 'somebody took responsibility for an early warning',
  },
  {
    action: 'alert-escalated',
    subjectType: 'alert',
    writers: ['apps/web/src/lib/intelligence-service.ts'],
    detail: 'an alert was sent to a level above the one that received it',
  },
  {
    action: 'alert-snoozed',
    subjectType: 'alert',
    writers: ['apps/web/src/lib/intelligence-service.ts'],
    detail: 'an alert was deliberately deferred, with a reason',
  },
  {
    action: 'alert-resolved',
    subjectType: 'alert',
    writers: ['apps/web/src/lib/intelligence-service.ts'],
    detail: 'the condition behind an alert was declared over',
  },
  {
    action: 'alert-action-proposed',
    subjectType: 'alert',
    writers: ['apps/web/src/lib/intelligence-service.ts'],
    detail: 'a course of action was proposed against an alert',
  },
  {
    action: 'transfer-proposal-approved',
    subjectType: 'transfer_proposal',
    writers: ['apps/web/src/lib/redistribution-service.ts'],
    detail: 'a person approved moving stock between facilities',
  },
  {
    action: 'transfer-proposal-rejected',
    subjectType: 'transfer_proposal',
    writers: ['apps/web/src/lib/redistribution-service.ts'],
    detail: 'a person refused a transfer, and the refusal is part of the record',
  },
  {
    action: 'federation-rounds-computed',
    subjectType: 'federation_round',
    writers: ['apps/web/src/lib/federation-service.ts'],
    detail: 'a session caused rounds to be taken across the silos, consuming a privacy budget',
  },
];

/**
 * The person whose decision this is.
 *
 * Taken from the validated session rather than from a request body, so the chain
 * names the identity the platform authenticated for the action.
 */
export interface AuditActor {
  readonly uid: string;
  readonly role: Role;
}

export const actorOf = (session: Session): AuditActor => ({
  // The label is what every other record on the platform already uses to name a
  // person (`transitionAlert`, the proposal approvals), so the chain agrees with
  // the records it audits. A deployment swaps the label for an authenticated
  // identifier in one place: here.
  uid: session.label,
  role: session.role,
});

/** The registered action, or null. Used by the viewer to describe what it shows. */
export const consequentialActionOf = (action: string): ConsequentialAction | null =>
  CONSEQUENTIAL_ACTIONS.find((entry) => entry.action === action) ?? null;

/** What happened, in the actor's voice. Free text, because the chain is generic. */
export interface AuditInput {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: string;
  readonly reason: string | null;
  /** The moment of the decision. Defaults to now; tests pass a fixed instant. */
  readonly at?: string | undefined;
}

const PROVENANCE = { kind: 'derived', reference: 'audit-chain' } as const;

/**
 * The digest of one entry.
 *
 * Every field that the entry asserts goes in, including the previous hash, so
 * the digest commits to the whole chain behind it as well as to its own content.
 * Keys are written in a fixed order rather than relying on object key order, so
 * the same entry hashes the same way on any machine.
 */
function digestOf(input: {
  readonly occurredAt: string;
  readonly actorUid: string;
  readonly actorRole: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly previousHash: string | null;
}): string {
  const canonical = JSON.stringify([
    input.occurredAt,
    input.actorUid,
    input.actorRole,
    input.action,
    input.subjectType,
    input.subjectId,
    input.reason,
    input.previousHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const collection = async () => {
  const store = await getLiveStore();
  return store.provider.collection(AUDIT_COLLECTION, auditEventSchema);
};

/** Every event, oldest first — the order the chain was written in. */
export async function readAuditEvents(): Promise<readonly AuditEvent[]> {
  return await (await collection()).list();
}

/**
 * Append one entry to the chain.
 *
 * The previous digest is read from the trail itself rather than kept in memory,
 * so the link is to what was actually stored. Nothing here may update or remove
 * an event: the only operation is append, which is the property the chain rests
 * on.
 */
export async function recordAuditEvent(input: AuditInput): Promise<AuditEvent> {
  const events = await readAuditEvents();
  const previousHash = events.at(-1)?.hash ?? null;
  const occurredAt = input.at ?? new Date().toISOString();
  const sequence = events.length + 1;
  const id = `audit-${String(sequence).padStart(6, '0')}`;

  const common = {
    occurredAt,
    actorUid: input.actor.uid,
    actorRole: input.actor.role,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    reason: input.reason,
    previousHash,
  } as const;

  const event: AuditEvent = auditEventSchema.parse({
    id,
    ...common,
    hash: digestOf(common),
    // The decision is not simulated: a person made it here, against a proposal
    // that came out of a generated world. Which is which is on the proposal.
    synthetic: false,
    provenance: PROVENANCE,
  });

  await (await collection()).set(id, event);
  return event;
}

export interface AuditChainReport {
  readonly events: number;
  readonly valid: boolean;
  /** The identifier of the first entry that does not hold, or null. */
  readonly brokenAt: string | null;
  /** One sentence naming what failed, or what was checked. */
  readonly detail: string;
}

/**
 * Check the chain, rather than assert it.
 *
 * Two ways an entry can fail: its own digest does not match its content, or its
 * `previousHash` does not name the entry before it. The first is an altered
 * entry; the second is an inserted, removed or reordered one. Both are reported
 * with the identifier of the entry where the trail stops holding, because "the
 * chain is broken" without saying where is not something anyone can act on.
 */
export function verifyAuditChain(events: readonly AuditEvent[]): AuditChainReport {
  let previousHash: string | null = null;

  for (const event of events) {
    const recomputed = digestOf({
      occurredAt: event.occurredAt,
      actorUid: event.actorUid,
      actorRole: event.actorRole,
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      reason: event.reason,
      previousHash: event.previousHash,
    });

    if (event.previousHash !== previousHash) {
      return {
        events: events.length,
        valid: false,
        brokenAt: event.id,
        detail: `entry ${event.id} does not follow ${previousHash ?? 'the start of the chain'}`,
      };
    }
    if (event.hash !== recomputed) {
      return {
        events: events.length,
        valid: false,
        brokenAt: event.id,
        detail: `entry ${event.id} does not match its own digest — its content was altered after it was written`,
      };
    }
    previousHash = event.hash;
  }

  return {
    events: events.length,
    valid: true,
    brokenAt: null,
    detail:
      events.length === 0
        ? 'the chain is empty: nothing consequential has been decided in this process yet'
        : `all ${String(events.length)} entries link to the one before them and match their own digests`,
  };
}
