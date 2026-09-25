import { createHash } from 'node:crypto';

import { auditEventSchema } from '@civora/domain';
import type { AuditEvent, AuditSubjectType, Role } from '@civora/domain';

import { getLiveStore } from './live-store';

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
 * The action vocabulary is the caller's: this module records what it is told and
 * never decides what deserves recording. Phase 9 reads the same chain.
 */

export const AUDIT_COLLECTION = 'auditEvents';

/** What happened, in the actor's voice. Free text, because the chain is generic. */
export interface AuditInput {
  readonly actorUid: string;
  readonly actorRole: Role;
  readonly action: string;
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
    actorUid: input.actorUid,
    actorRole: input.actorRole,
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
