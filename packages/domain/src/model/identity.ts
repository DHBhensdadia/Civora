import { z } from 'zod';

/**
 * The roles the platform recognises.
 *
 * Declared in the domain rather than at the authentication boundary, because a
 * role is a statement about who may do what to the record, not about how
 * someone signed in. The identity port imports from here.
 *
 * This is the single source of truth: a role cannot be spelled differently in
 * two places, and adding one is a change the compiler propagates.
 */
export const ROLES = ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor'] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/**
 * The administrative level a role may act at.
 *
 * Used by the tenancy rules and by the redistribution authority check: a
 * transfer between districts is approved a level above the facilities it moves
 * stock between.
 */
export const ROLE_SCOPES: Readonly<Record<Role, 'facility' | 'district' | 'region' | 'country' | 'audit-only'>> = {
  phc_staff: 'facility',
  district_officer: 'district',
  state_officer: 'region',
  national: 'country',
  auditor: 'audit-only',
};
