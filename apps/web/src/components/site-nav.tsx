'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Eyebrow } from '@/components/ui';
import { NAV_GROUPS, navigationFor } from '@/lib/navigation';
import type { Session } from '@/lib/session';

/**
 * The platform's navigation, for one session, in four groups.
 *
 * The order inside a group is the order a person meets the platform. The groups
 * are the loop the platform closes — *situation, decide, record, assure* — and
 * they exist because thirteen flat links in a wrapping header row is a list, not
 * a navigation: past roughly seven entries a reader has to scan all of it to find
 * any of it.
 *
 * Only the sections the session is offered are drawn. A link a reader would be
 * refused is worse than no link: it teaches a person their place by closing a
 * door in their face, and it makes a permission bug indistinguishable from a
 * working refusal. This is also asserted from outside — a role the platform does
 * not offer a surface must be able to find **no** link to it here.
 *
 * One DOM, two presentations: a wrapped row under the header on a narrow screen,
 * and a vertical grouped column beside the content at `lg` and above. It is not
 * rendered twice with one copy hidden, because a second copy is a second thing
 * for a journey to match and a second place for the offer rule to go wrong.
 *
 * The current surface is marked with a rail and the accent, and carries
 * `aria-current`, because a reader who cannot see where they are has to open
 * pages to find out.
 */

export interface SiteNavProps {
  readonly session: Session;
}

export function SiteNav({ session }: SiteNavProps) {
  const pathname = usePathname();
  const sections = navigationFor(session);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    sections: sections.filter((section) => section.group === group.key),
  })).filter((group) => group.sections.length > 0);

  return (
    <nav aria-label="Platform sections" className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <Eyebrow>{group.label}</Eyebrow>
          <ul className="flex flex-row flex-wrap gap-x-5 gap-y-0 lg:flex-col lg:gap-x-0">
            {group.sections.map((section) => {
              const active = pathname === section.href;
              return (
                <li key={section.href}>
                  <Link
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center border-l-2 pl-3 text-sm transition-colors duration-150 ${
                      active
                        ? 'border-accent font-medium text-accent'
                        : 'border-transparent text-fg-muted hover:border-ink-600 hover:text-fg'
                    }`}
                    href={section.href}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
