import Link from 'next/link';

import { LanguagePicker } from '@/components/language-picker';
import { navigationFor } from '@/lib/navigation';
import { offeredLanguages } from '@/lib/language';
import type { Session } from '@/lib/session';

/**
 * The platform's navigation, for one session.
 *
 * The order is the order a person meets the platform: what it is running on,
 * the national picture and the drill-down beneath it, what the facilities have
 * reported, what the platform concludes and asks of somebody, what a facility
 * records — typed, photographed, spoken — and what all of it came from.
 *
 * Only the sections the session is offered are drawn. A link a reader would be
 * refused is worse than no link: it teaches a person their place by closing a
 * door in their face, and it makes a permission bug indistinguishable from a
 * working refusal.
 *
 * The active role is shown beside the navigation rather than hidden in a menu,
 * because the demonstration switches personas on stage and a viewer has to be
 * able to see which one is acting — and because a person who has just been
 * refused deserves to know who the platform thinks they are.
 *
 * The language control sits beside it for the same reason, and the page element
 * it sits in carries the same language, so assistive technology reads the
 * Devanagari on the page as Devanagari.
 */

export interface SiteNavProps {
  readonly session: Session;
  /** The interface language, as the cookie resolved it. */
  readonly language: string;
}

export function SiteNav({ session, language }: SiteNavProps) {
  const sections = navigationFor(session);

  return (
    <nav aria-label="Platform sections" className="flex flex-wrap items-center gap-x-5 gap-y-1">
      {sections.map((section) => (
        <Link
          key={section.href}
          className="text-sm text-sky-400 underline-offset-4 hover:underline"
          href={section.href}
        >
          {section.label}
        </Link>
      ))}
      <span
        data-testid="active-role"
        className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 font-mono text-xs text-slate-300"
      >
        {session.label} · {session.role.replace('_', ' ')}
      </span>
      <LanguagePicker current={language} offered={offeredLanguages()} />
    </nav>
  );
}
