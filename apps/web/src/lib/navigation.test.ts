import { ROLES } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { NAV_SECTIONS, navigationFor, mayReach, surfaceRefusalFor } from './navigation';
import { NATIONAL_SESSION } from './session';
import type { Session } from './session';

/**
 * The navigation map.
 *
 * Two claims are held here. First, **every role is offered something and every
 * section is offered to somebody** — a section nobody can reach is a dead page,
 * and a role with nothing to open is a role with no story to tell on stage.
 * Second, **the hidden surfaces are hidden and the refusal says why**, which is
 * the part a judge sees: the role indicator names the role, and the sentence
 * names the surface.
 *
 * The national role is asserted as reaching everything, deliberately, with the
 * reasoning in the module: it is the control room, and a symmetric-looking
 * matrix bought by inventing a denial for it would be a lie about the model.
 */

const session = (role: Session['role'], scopeId: string | null = null): Session => ({
  role,
  scopeId,
  label: `test ${role}`,
});

describe('what each role is offered', () => {
  it('lists every role, and each of them has something to open', () => {
    for (const role of ROLES) {
      expect(navigationFor(session(role)).length, role).toBeGreaterThan(0);
    }
  });

  it('offers every section to at least one role, with no duplicate or unknown address', () => {
    const hrefs = NAV_SECTIONS.map((section) => section.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const section of NAV_SECTIONS) {
      expect(section.roles.length, section.href).toBeGreaterThan(0);
      for (const role of section.roles) {
        expect(ROLES).toContain(role);
      }
    }
  });

  it('hides a surface from a role that has no business on it, and keeps the rest', () => {
    // A facility worker records what their own facility counted; the national
    // ranked list, the transfer approvals and the federation console are not
    // theirs to work.
    for (const href of ['/command', '/intelligence', '/redistribution', '/federation']) {
      expect(mayReach(session('phc_staff'), href), href).toBe(false);
    }
    expect(mayReach(session('phc_staff'), '/capture')).toBe(true);
    // A district officer works the inbox and the workbench; the federation's
    // silos are states, which is the level above them.
    expect(mayReach(session('district_officer'), '/intelligence')).toBe(true);
    expect(mayReach(session('district_officer'), '/federation')).toBe(false);
    // An auditor reads the record and writes none of it, so the three capture
    // surfaces — the only surfaces that exist to make a record — are not shown.
    for (const href of ['/capture', '/vision', '/voice']) {
      expect(mayReach(session('auditor'), href), href).toBe(false);
    }
    expect(mayReach(session('auditor'), '/redistribution')).toBe(true);
  });

  it('offers the national control room every surface, as the module says it does', () => {
    // Not an accident of the list: the count is asserted, so adding a section
    // without deciding who can see it fails here.
    expect(navigationFor(NATIONAL_SESSION)).toHaveLength(NAV_SECTIONS.length);
  });
});

describe('the sentence a refused surface gives', () => {
  it('names the surface and the role that is being refused', () => {
    const refusal = surfaceRefusalFor(session('phc_staff', 'SIM-FAC-1'), '/command');

    expect(refusal).toContain('Command tower');
    expect(refusal).toContain('phc staff');
  });

  it('says a surface is offered when it is, rather than refusing by accident', () => {
    expect(surfaceRefusalFor(session('district_officer'), '/visibility')).toContain(
      'is offered Visibility',
    );
  });

  it('answers an address this build does not navigate to', () => {
    expect(surfaceRefusalFor(session('national'), '/nowhere')).toBe(
      'this build has no surface at this address',
    );
  });
});
