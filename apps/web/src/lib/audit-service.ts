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
  'import-accepted',
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
    action: 'import-accepted',
    subjectType: 'import',
    writers: ['apps/web/src/lib/import-service.ts'],
    detail:
      'a file from a system the ministry already runs was accepted, and its rows reached the ledger with the source they arrived from — the entry names the file by digest, the rows it wrote and, where the file states them, the source it came from',
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
  /**
   * What the subject was and became, where the platform has both. Required
   * rather than optional so that a writer has to say which it is: a pair of
   * figures, or an explicit statement that there is nothing to compare against.
   */
  readonly before: string | null;
  readonly after: string | null;
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
  readonly before: string | null;
  readonly after: string | null;
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
    input.before,
    input.after,
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
 * Appends are taken one at a time.
 *
 * An entry's identity depends on the tail of the chain twice over: its
 * identifier is the next sequence number and its `previousHash` is the digest of
 * the last entry stored. Two appends that read the same tail therefore claim the
 * same identifier, and the second write silently replaces the first — a lost
 * decision, in the one record whose whole value is not losing one. The tests
 * below fire five concurrent decisions and fail without this queue.
 *
 * A deployment gets this from a transaction on the store. The local adapter gets
 * it from here, so the two have the same guarantee rather than the same hope —
 * and the guarantee is stated where it is provided.
 */
let appending: Promise<unknown> = Promise.resolve();

/**
 * Append one entry to the chain.
 *
 * The previous digest is read from the trail itself rather than kept in memory,
 * so the link is to what was actually stored. Nothing here may update or remove
 * an event: the only operation is append, which is the property the chain rests
 * on.
 */
export function recordAuditEvent(input: AuditInput): Promise<AuditEvent> {
  const appended = appending.then(() => appendOne(input));
  // The queue has to survive a failure: an append that threw must not stall every
  // later one, and the caller still sees its own rejection below.
  appending = appended.catch(() => undefined);
  return appended;
}

async function appendOne(input: AuditInput): Promise<AuditEvent> {
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
    before: input.before,
    after: input.after,
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

/** How many rows the viewer shows before it says what it is not showing. */
export const AUDIT_ROW_LIMIT = 100;

/** The question a reader is asking of the chain. Every field is optional. */
export interface AuditFilters {
  readonly actor: string | null;
  readonly action: string | null;
  readonly subject: string | null;
  /** Inclusive first day, as `YYYY-MM-DD`, compared against the entry's own day. */
  readonly from: string | null;
  readonly to: string | null;
}

export const NO_AUDIT_FILTERS: AuditFilters = {
  actor: null,
  action: null,
  subject: null,
  from: null,
  to: null,
};

/** One entry as a viewer reads it, with the link made into a sentence. */
export interface AuditTrailRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly day: string;
  readonly actorUid: string;
  readonly actorRole: Role;
  readonly action: string;
  /** The registry's own sentence for the action, or null for an unknown one. */
  readonly meaning: string | null;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly hash: string;
  /** The entry this one links to, or null for the first — the chain's own order. */
  readonly linksTo: string | null;
}

export interface AuditTrail {
  readonly report: AuditChainReport;
  /** When the chain was walked. The verification is an act, and this is when. */
  readonly checkedAt: string;
  readonly rows: readonly AuditTrailRow[];
  readonly matched: number;
  readonly total: number;
  readonly shown: number;
  readonly filters: AuditFilters;
  /** What the chain actually holds, so a filter can offer values that exist. */
  readonly offers: {
    readonly actors: readonly string[];
    readonly actions: readonly string[];
    readonly subjects: readonly string[];
  };
  /**
   * Every action the platform is built to record, with whether it has fired.
   *
   * This is the viewer's honesty panel: a registered action with no entry says
   * the path has not been exercised in this process, rather than being absent
   * from a list a reader cannot see.
   */
  readonly registered: readonly {
    readonly action: string;
    readonly detail: string;
    readonly recorded: number;
  }[];
}

const matches = (event: AuditEvent, filters: AuditFilters): boolean => {
  const day = event.occurredAt.slice(0, 10);
  if (filters.actor !== null && event.actorUid !== filters.actor) {
    return false;
  }
  if (filters.action !== null && event.action !== filters.action) {
    return false;
  }
  if (
    filters.subject !== null &&
    event.subjectId !== filters.subject &&
    event.subjectType !== filters.subject
  ) {
    return false;
  }
  if (filters.from !== null && day < filters.from) {
    return false;
  }
  return filters.to === null || day <= filters.to;
};

/**
 * The chain as a reader is shown it.
 *
 * Two things are deliberately not filtered. The **verification** walks every
 * entry, because a chain that held only within the rows a reader happened to ask
 * for would be a chain that can be broken anywhere else — and a reader who
 * filtered down to one actor must not be told the trail is intact when it is not.
 * And each row **links to the entry before it in the chain**, not to the row above
 * it in the list, because that link is what the digest commits to and a filtered
 * list's neighbour is an artefact of the filter.
 */
export async function readAuditTrail(
  filters: AuditFilters = NO_AUDIT_FILTERS,
): Promise<AuditTrail> {
  const events = await readAuditEvents();
  const report = verifyAuditChain(events);

  const previousIdOf = new Map<string, string>();
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    const before = events[index - 1];
    if (event !== undefined && before !== undefined) {
      previousIdOf.set(event.id, before.id);
    }
  }

  const matching = events.filter((event) => matches(event, filters));
  const newestFirst = [...matching].reverse();

  return {
    report,
    checkedAt: new Date().toISOString(),
    rows: newestFirst.slice(0, AUDIT_ROW_LIMIT).map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt,
      day: event.occurredAt.slice(0, 10),
      actorUid: event.actorUid,
      actorRole: event.actorRole,
      action: event.action,
      meaning: consequentialActionOf(event.action)?.detail ?? null,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      reason: event.reason,
      before: event.before,
      after: event.after,
      hash: event.hash,
      linksTo: previousIdOf.get(event.id) ?? null,
    })),
    matched: matching.length,
    total: events.length,
    shown: Math.min(matching.length, AUDIT_ROW_LIMIT),
    filters,
    offers: {
      actors: [...new Set(events.map((event) => event.actorUid))].sort(),
      actions: [...new Set(events.map((event) => event.action))].sort(),
      subjects: [...new Set(events.map((event) => event.subjectType))].sort(),
    },
    registered: CONSEQUENTIAL_ACTIONS.map((entry) => ({
      action: entry.action,
      detail: entry.detail,
      recorded: events.filter((event) => event.action === entry.action).length,
    })),
  };
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
      before: event.before,
      after: event.after,
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
