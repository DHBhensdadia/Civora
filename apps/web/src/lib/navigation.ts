import type { Role } from '@civora/domain';

import type { Session } from './session';

/**
 * What each role is offered, and what the platform says when it is not.
 *
 * The role model in `session.ts` is the *enforcement*: it decides which
 * district a session may read and whether an observation may be written for a
 * facility. This file is the *offer*: which surfaces the interface puts in front
 * of a person, which is what a judge sees on stage and what the phase asks to be
 * visible rather than buried.
 *
 * The two are deliberately not the same thing, and the difference is named
 * rather than glossed. Hiding a link is not a refusal — the API's scope rule is
 * the refusal, and a session that typed a hidden address would be answered by
 * the surface's own guard with the sentence below. What the map buys is that a
 * role is never shown a door it will be turned away from, which is the failure
 * mode of a permission system that is only enforced underneath: the interface
 * offers everything and a person discovers their place by being refused.
 *
 * One decision worth stating outright: **the national role reaches every
 * surface**. It is the control room; a role that has to run the country's supply
 * chain and cannot look at the field's capture form is a role with a token
 * permission. Its tests therefore assert scope and action denials rather than a
 * hidden surface, and the roles page says so instead of inventing a denial to
 * make the matrix symmetric.
 */

export interface NavSection {
  readonly href: string;
  readonly label: string;
  /** One line naming what the surface is for, printed on the roles page. */
  readonly purpose: string;
  /** The roles the surface is offered to, in the order it is listed. */
  readonly roles: readonly Role[];
}

/**
 * The platform's navigation, in the order a person meets it.
 *
 * The first destination is honest about being a status page rather than a
 * dashboard. The control tower comes next because that is what an officer opens
 * first; capture is where a reading is made; the dataset inspector and the
 * provenance panel are what all of it came from.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    href: '/',
    label: 'Overview',
    purpose: 'What the platform is, which modules exist, and which adapters it runs on.',
    roles: ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/command',
    label: 'Command tower',
    purpose:
      'The national picture — stock-out risk, bed pressure and reporting gaps — with the drill-down from a state to the batch behind it.',
    roles: ['district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/visibility',
    label: 'Visibility',
    purpose: 'What is in stock where, and how stale the answer is, district by district.',
    roles: ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/intelligence',
    label: 'Intelligence',
    purpose: 'The ranked risk list and the alert inbox an officer works.',
    roles: ['district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/redistribution',
    label: 'Redistribution',
    purpose: 'Constraint-checked transfer proposals, their verdicts and approvals.',
    roles: ['district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/federation',
    label: 'Federation',
    purpose: 'The federated rounds, the privacy budget they spent and what it cost.',
    roles: ['state_officer', 'national', 'auditor'],
  },
  {
    href: '/audit',
    label: 'Audit trail',
    purpose:
      'Every consequential decision in one digest-linked chain, with a verification that names the entry where it stops holding.',
    // The same rule the stored rules enforce on the collection: the chain holds
    // every place's decisions, so it is read by the auditor and the control room.
    roles: ['national', 'auditor'],
  },
  {
    href: '/capture',
    label: 'Capture',
    purpose: 'Record what a facility counted, written and spoken, offline.',
    roles: ['phc_staff', 'district_officer', 'national'],
  },
  {
    href: '/vision',
    label: 'Vision intake',
    purpose: 'Read a register from a photograph and confirm it before it is stored.',
    roles: ['phc_staff', 'district_officer', 'national'],
  },
  {
    href: '/voice',
    label: 'Voice intake',
    purpose: 'Say a stock, bed or attendance update and confirm what was heard.',
    roles: ['phc_staff', 'district_officer', 'national'],
  },
  {
    href: '/dataset',
    label: 'Dataset inspector',
    purpose: 'The generated world itself: counts, fingerprints and seeded records.',
    roles: ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor'],
  },
  {
    href: '/provenance',
    label: 'Provenance',
    purpose: 'Which layers are real, which are simulated, and under which seed.',
    roles: ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor'],
  },
] as const;

/** What each role is, in a sentence, for the role indicator and the roles page. */
export const ROLE_MEANINGS: Readonly<Record<Role, string>> = {
  phc_staff: 'the health worker at one facility, recording what it counted',
  district_officer: 'the level at which redistribution authority sits',
  state_officer: 'the level that owns a state’s districts and its silo',
  national: 'the control room that reads the whole country',
  auditor: 'reads every record and writes none of them',
};

/** The sections a session is offered, in navigation order. */
export const navigationFor = (session: Session): readonly NavSection[] =>
  NAV_SECTIONS.filter((section) => section.roles.includes(session.role));

/** Whether a session is offered a surface, by its path. */
export const mayReach = (session: Session, href: string): boolean =>
  NAV_SECTIONS.some((section) => section.href === href && section.roles.includes(session.role));

/** The section for a path, when the path is one the platform navigates to. */
export const sectionFor = (href: string): NavSection | null =>
  NAV_SECTIONS.find((section) => section.href === href) ?? null;

/**
 * Why a session is not offered a surface, in a sentence a page can show.
 *
 * The same shape as `scopeRefusalFor`, and for the same reason: a refusal that a
 * person can read is a refusal they can act on. It names the role that *is*
 * offered the surface rather than the one that is not, because that is the
 * question the reader has.
 */
export function surfaceRefusalFor(session: Session, href: string): string {
  const section = sectionFor(href);
  if (section === null) {
    return 'this build has no surface at this address';
  }
  if (mayReach(session, href)) {
    return `${session.label} is offered ${section.label}`;
  }
  return `${section.label} is not offered to ${session.role.replace('_', ' ')} — ${ROLE_MEANINGS[session.role]}`;
}
