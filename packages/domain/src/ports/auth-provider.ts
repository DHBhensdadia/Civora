import type { Role } from '../model/identity';

// Roles are a domain concept, so they are declared in the model and re-exported
// here for the convenience of callers that only touch the identity boundary.
export { ROLES, roleSchema } from '../model/identity';
export type { Role } from '../model/identity';

/**
 * The administrative scope a principal may act within.
 *
 * A district officer is confined to one district; a state officer to one state.
 * Tenancy is enforced from this object, never from a value supplied by a
 * client.
 */
export interface PrincipalScope {
  readonly stateId?: string;
  readonly districtId?: string;
  readonly facilityId?: string;
}

/** An authenticated actor. */
export interface Principal {
  readonly uid: string;
  readonly displayName: string;
  readonly role: Role;
  readonly scope: PrincipalScope;
}

/** Credentials presented to sign in. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/**
 * The authentication boundary.
 *
 * Implementations resolve an identity and the scope attached to it. No caller
 * receives a principal it did not obtain through this port, so swapping the
 * local fixture for a real identity provider changes nothing downstream.
 */
export interface AuthProvider {
  /** Stable identifier of the concrete adapter, reported by the health check. */
  readonly kind: string;
  currentPrincipal(): Promise<Principal | null>;
  signIn(credentials: Credentials): Promise<Principal>;
  signOut(): Promise<void>;
}
