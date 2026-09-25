import Link from 'next/link';

/**
 * The platform's navigation.
 *
 * Five destinations, and the first is honest about being a status page rather
 * than a dashboard. The order is the order a person meets the platform: what it
 * is running on, what the facilities have reported, what the platform concludes
 * and asks of somebody, what a facility records, and what all of it came from.
 */

const SECTIONS = [
  { href: '/', label: 'Overview' },
  { href: '/visibility', label: 'Visibility' },
  { href: '/intelligence', label: 'Intelligence' },
  { href: '/capture', label: 'Capture' },
  { href: '/dataset', label: 'Dataset inspector' },
] as const;

export function SiteNav() {
  return (
    <nav aria-label="Platform sections" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {SECTIONS.map((section) => (
        <Link
          key={section.href}
          className="text-sky-400 underline-offset-4 hover:underline"
          href={section.href}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
