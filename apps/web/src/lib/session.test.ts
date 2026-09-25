import { describe, expect, it } from 'vitest';

import {
  NATIONAL_SESSION,
  canReadDistrict,
  canSubmitForFacility,
  encodeSession,
  openingDistrictFor,
  parseSession,
  scopeRefusalFor,
} from './session';
import type { ScopeLookup, Session } from './session';

/**
 * The tenancy rules, as rules.
 *
 * These decide whether one facility's staff can write another facility's ledger
 * and whether a district officer can read a neighbouring district's stock. A
 * mistake here is not a broken page; it is a scope that leaks or a write that
 * should not happen, so the rules are asserted directly rather than only through
 * the routes that call them.
 */

/**
 * A tiny administrative tree, written out rather than derived, so the fixture
 * cannot accidentally agree with a rule that is wrong.
 */
const DISTRICT_OF: Readonly<Record<string, string>> = {
  'district-1/phc-1': 'district-1',
  'district-1/phc-2': 'district-1',
  'district-1/phc-10': 'district-1',
  'district-2/phc-1': 'district-2',
  'district-3/phc-1': 'district-3',
};

const REGION_OF: Readonly<Record<string, string>> = {
  'district-1': 'region-1',
  'district-2': 'region-1',
  'district-3': 'region-2',
};

const scope: ScopeLookup = {
  districtOfFacility: (facilityId) => DISTRICT_OF[facilityId] ?? null,
  regionOfDistrict: (districtId) => REGION_OF[districtId] ?? null,
  districtsInRegion: (regionId) =>
    Object.keys(REGION_OF)
      .filter((districtId) => REGION_OF[districtId] === regionId)
      .sort(),
};

const session = (role: Session['role'], scopeId: string | null): Session => ({
  role,
  scopeId,
  label: `${role} at ${String(scopeId)}`,
});

describe('who may write where', () => {
  it('lets front-line staff write only their own facility', () => {
    const staff = session('phc_staff', 'district-1/phc-1');
    expect(canSubmitForFacility(staff, 'district-1/phc-1', scope)).toBe(true);
    expect(canSubmitForFacility(staff, 'district-1/phc-2', scope)).toBe(false);
    // The facility that is only separated by a hyphen must not be reachable by a
    // prefix comparison, which is the mistake this shape invites.
    expect(canSubmitForFacility(staff, 'district-1/phc-10', scope)).toBe(false);
  });

  it('lets a district officer write inside the district and nowhere else', () => {
    const officer = session('district_officer', 'district-1');
    expect(canSubmitForFacility(officer, 'district-1/phc-1', scope)).toBe(true);
    expect(canSubmitForFacility(officer, 'district-2/phc-1', scope)).toBe(false);
  });

  it('lets a state officer write anywhere in the state', () => {
    const officer = session('state_officer', 'region-1');
    expect(canSubmitForFacility(officer, 'district-1/phc-1', scope)).toBe(true);
    expect(canSubmitForFacility(officer, 'district-2/phc-1', scope)).toBe(true);
    expect(canSubmitForFacility(officer, 'district-3/phc-1', scope)).toBe(false);
  });

  it('lets the control room write anywhere and an auditor write nowhere', () => {
    expect(canSubmitForFacility(NATIONAL_SESSION, 'anywhere/phc-1', scope)).toBe(true);
    expect(canSubmitForFacility(session('auditor', null), 'anywhere/phc-1', scope)).toBe(false);
  });

  it('refuses a facility this deployment does not know about', () => {
    // An unknown facility is not in anybody's district, so a scoped identity
    // cannot claim it — including one whose scope happens to be null.
    expect(canSubmitForFacility(session('district_officer', 'district-1'), 'orphan', scope)).toBe(
      false,
    );
  });
});

describe('who may read what', () => {
  it('scopes front-line staff to their own district', () => {
    const staff = session('phc_staff', 'district-1/phc-1');
    expect(canReadDistrict(staff, 'district-1', scope)).toBe(true);
    expect(canReadDistrict(staff, 'district-2', scope)).toBe(false);
  });

  it('scopes a district officer to their district and a state officer to their region', () => {
    const officer = session('district_officer', 'district-1');
    expect(canReadDistrict(officer, 'district-1', scope)).toBe(true);
    expect(canReadDistrict(officer, 'district-2', scope)).toBe(false);

    const state = session('state_officer', 'region-1');
    expect(canReadDistrict(state, 'district-1', scope)).toBe(true);
    expect(canReadDistrict(state, 'district-2', scope)).toBe(true);
    expect(canReadDistrict(state, 'district-3', scope)).toBe(false);
  });

  it('lets the control room and an auditor read everything', () => {
    expect(canReadDistrict(NATIONAL_SESSION, 'district-1', scope)).toBe(true);
    expect(canReadDistrict(session('auditor', null), 'district-1', scope)).toBe(true);
  });

  it('says why a refusal happened, in words a user can read', () => {
    expect(scopeRefusalFor(session('auditor', null), 'district')).toContain('does not write');
    expect(scopeRefusalFor(session('phc_staff', 'district-1/phc-1'), 'facility')).toContain(
      'outside',
    );
  });
});

describe('where a session opens', () => {
  it('opens a front-line identity on its own district', () => {
    expect(openingDistrictFor(session('phc_staff', 'district-1/phc-1'), scope, 'fallback')).toBe(
      'district-1',
    );
  });

  it('opens a district officer on the district it is scoped to', () => {
    expect(openingDistrictFor(session('district_officer', 'district-9'), scope, 'fallback')).toBe(
      'district-9',
    );
  });

  it('opens a state officer on a district of its own region', () => {
    expect(
      REGION_OF[openingDistrictFor(session('state_officer', 'region-1'), scope, 'fallback')],
    ).toBe('region-1');
  });

  it('falls back for the roles that have no place of their own', () => {
    expect(openingDistrictFor(NATIONAL_SESSION, scope, 'fallback')).toBe('fallback');
    expect(openingDistrictFor(session('auditor', null), scope, 'fallback')).toBe('fallback');
  });

  it('falls back rather than opening nowhere when the scope names an unknown place', () => {
    expect(openingDistrictFor(session('phc_staff', 'nowhere/phc-1'), scope, 'fallback')).toBe(
      'fallback',
    );
    expect(openingDistrictFor(session('state_officer', 'region-9'), scope, 'fallback')).toBe(
      'fallback',
    );
  });
});

describe('reading a session', () => {
  it('round-trips a session through its cookie value', () => {
    const original = session('district_officer', 'district-1');
    expect(parseSession(encodeSession(original))).toEqual(original);
  });

  it('treats a request with no cookie as the control room, not as nobody', () => {
    expect(parseSession(undefined)).toEqual(NATIONAL_SESSION);
    expect(parseSession('')).toEqual(NATIONAL_SESSION);
  });

  it('falls back rather than failing when the cookie is unusable', () => {
    // A corrupted cookie must not take the platform down, and it must not be
    // read as a wider scope than the default either.
    expect(parseSession('not-json')).toEqual(NATIONAL_SESSION);
    expect(parseSession(encodeURIComponent('{"role":"root"}'))).toEqual(NATIONAL_SESSION);
    expect(parseSession(encodeURIComponent('{"role":"national","scopeId":5,"label":"x"}'))).toEqual(
      NATIONAL_SESSION,
    );
  });
});
