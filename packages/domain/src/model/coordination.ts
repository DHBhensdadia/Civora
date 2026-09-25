import { z } from 'zod';

import {
  batchIdSchema,
  facilityIdSchema,
  instantSchema,
  itemIdSchema,
  provenanceSchema,
  recordIdSchema,
  regionIdSchema,
  syntheticSchema,
} from './common';
import { roleSchema } from './identity';

/**
 * Coordination between facilities and between regions.
 *
 * Two things are structural here. A transfer is a *proposal* until a human with
 * the authority approves it, because no health system accepts logistics that
 * execute themselves. And a federation round must be able to prove what it
 * did not send, which is why the payload assertion is part of the record rather
 * than part of the transport.
 */

export const TRANSFER_CONSTRAINTS = [
  'same-facility',
  'donor-safety-floor',
  'receiver-need-cap',
  'cold-chain',
  'shelf-life',
  'feasibility-window',
  'transport-capacity',
  'budget',
] as const;

export const transferConstraintSchema = z.enum(TRANSFER_CONSTRAINTS);
export type TransferConstraint = z.infer<typeof transferConstraintSchema>;

export const TRANSFER_VERDICTS = ['proposed', 'rejected'] as const;
export const transferVerdictSchema = z.enum(TRANSFER_VERDICTS);
export type TransferVerdict = z.infer<typeof transferVerdictSchema>;

export const transferProposalSchema = z
  .strictObject({
    id: recordIdSchema,
    itemId: itemIdSchema,
    fromFacilityId: facilityIdSchema,
    toFacilityId: facilityIdSchema,
    quantity: z.int().positive(),
    /** The batch the optimiser intends to move, where it has chosen one. */
    batchId: batchIdSchema.nullable(),
    /** Refusing a transfer is an outcome of the platform working, not a failure. */
    verdict: transferVerdictSchema,
    /**
     * The constraints that refused it, each with its reason. Empty when the
     * proposal stands; never empty when the verdict is `rejected`.
     */
    violations: z.array(
      z.strictObject({
        constraint: transferConstraintSchema,
        detail: z.string().trim().min(1),
      }),
    ),
    expectedImpact: z.strictObject({
      unmetDemandAvoided: z.int().nonnegative(),
      donorDaysOfStockAfter: z.number().nonnegative(),
      receiverDaysOfStockAfter: z.number().nonnegative(),
      /**
       * How the figures above were arrived at. An impact estimate without its
       * assumptions is a claim, and this field is what stops it becoming one.
       */
      assumptions: z.array(z.string().trim().min(1)).min(1),
    }),
    approvals: z.array(
      z.strictObject({
        by: z.string().trim().min(1),
        role: roleSchema,
        at: instantSchema,
        reason: z.string().trim().min(1).nullable(),
      }),
    ),
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((proposal) => proposal.fromFacilityId !== proposal.toFacilityId, {
    message: 'a transfer must move stock between two different facilities',
    path: ['toFacilityId'],
  })
  .refine((proposal) => proposal.verdict !== 'rejected' || proposal.violations.length > 0, {
    message: 'a rejected proposal must name the constraint that refused it',
    path: ['violations'],
  })
  .refine(
    (proposal) => proposal.verdict !== 'proposed' || proposal.violations.length === 0,
    {
      message: 'a proposal that stands cannot also carry a violation',
      path: ['violations'],
    },
  );

export type TransferProposal = z.infer<typeof transferProposalSchema>;

export const FEDERATION_ALGORITHMS = ['fedavg', 'fedprox'] as const;
export const federationAlgorithmSchema = z.enum(FEDERATION_ALGORITHMS);
export type FederationAlgorithm = z.infer<typeof federationAlgorithmSchema>;

export const federationRoundSchema = z.strictObject({
  id: recordIdSchema,
  round: z.int().positive(),
  algorithm: federationAlgorithmSchema,
  /**
   * The silos that took part. A silo is a region, because a region is the
   * administrative body that actually owns its own records.
   */
  participantRegionIds: z.array(regionIdSchema).min(2),
  startedAt: instantSchema,
  completedAt: instantSchema.nullable(),
  /** Privacy budget spent by this round, against a stated ceiling. */
  epsilonSpent: z.number().positive(),
  delta: z.number().positive(),
  /**
   * The load-bearing assertion of the whole federation story.
   *
   * It is a literal `false` in the schema because a payload that contained a
   * record identifier would be a privacy breach, and a schema that merely
   * *permits* the flag to be true is not a guarantee. Anything constructing
   * this record has to state that it checked.
   */
  containsRecordIdentifiers: z.literal(false),
  /** Accuracy the round achieved, and what a silo achieved alone. */
  federatedMetric: z.number().nullable(),
  localOnlyBaselineMetric: z.number().nullable(),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type FederationRound = z.infer<typeof federationRoundSchema>;

export const AUDIT_SUBJECT_TYPES = [
  'stock_ledger_entry',
  'transfer_proposal',
  'alert',
  'facility',
  'item',
  'federation_round',
] as const;

export const auditSubjectTypeSchema = z.enum(AUDIT_SUBJECT_TYPES);
export type AuditSubjectType = z.infer<typeof auditSubjectTypeSchema>;

/**
 * A tamper-evident record of a consequential action.
 *
 * Each entry carries the hash of the previous one, so removing or altering an
 * entry breaks the chain at the point of the change. This is cheap to implement
 * and is the kind of thing a government user asks for before anything else.
 */
export const auditEventSchema = z.strictObject({
  id: recordIdSchema,
  occurredAt: instantSchema,
  actorUid: z.string().trim().min(1),
  actorRole: roleSchema,
  action: z.string().trim().min(1),
  subjectType: auditSubjectTypeSchema,
  subjectId: z.string().trim().min(1),
  reason: z.string().trim().min(1).nullable(),
  /** Digest of this entry; recomputing it is how the chain is verified. */
  hash: z.string().trim().min(1),
  /** Digest of the preceding entry. Null only for the first. */
  previousHash: z.string().trim().min(1).nullable(),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
