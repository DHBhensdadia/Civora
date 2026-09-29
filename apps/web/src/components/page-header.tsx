import type { ReactNode } from 'react';

import { Eyebrow } from '@/components/ui';

/**
 * The title block at the head of a surface.
 *
 * Every one of the thirteen surfaces opens the same way — a group label, the page's `h1`, and a
 * lead paragraph — and before this component existed they were written out thirteen times. Four
 * surfaces used the `Eyebrow` primitive and nine hand-rolled the identical `<p>` with the same
 * class list, in three different gap values, which meant a change to the header was a change in
 * thirteen files and a restyle was a change in thirteen files twice over.
 *
 * Two things about it are load-bearing:
 *
 *  - **The title is rendered verbatim.** Nineteen browser assertions resolve a page by its exact
 *    `h1` string, so this component takes the text as a prop and renders it as given — no
 *    `text-transform`, no truncation, no `aria-label` standing in for it. A title that has been
 *    reworded for display is a journey that fails.
 *  - **No spacing is decided here for the reader.** `spacing` and `scale` exist to carry the values
 *    the surfaces already had, so that extracting this component changed nothing on screen; they
 *    exist to be removed by the restyle, not to be used by new pages.
 *
 * `label` is optional because a surface's loading and error states render the same title without a
 * group label above it.
 *
 * **The composition is now a prop as well.** `layout="split"` puts the title in the left half of a
 * two-column grid with the lead beside it, which is the reference's measured `660px 660px` grid at
 * `gap: 0` — the one place a title and its explanation sit side by side instead of being stacked
 * into a column that ends before the page has started. The two surfaces a reader meets first take
 * it; the default stays `stacked`, so no other surface moves until it is rebuilt.
 */
export interface PageHeaderProps {
  /** The group label above the title — who this surface is, in a few words. */
  readonly label?: string;
  /** The page's `h1`, rendered exactly as given. */
  readonly title: string;
  /** `hero` on the surface that opens the product; `display` on the other twelve. */
  readonly scale?: 'hero' | 'display';
  /** `muted` is the label's own tone (the plan's ink at 70%); `accent` is for a label that must read as a link. */
  readonly labelTone?: 'accent' | 'muted';
  /** The gap the surfaces already carried: `compact` is 12px, `roomy` is 20px. */
  readonly spacing?: 'compact' | 'roomy';
  /**
   * `stacked` is a title, then its lead beneath it. `split` is the reference's two-column header:
   * the title in the left half, the lead in the right. It applies at `lg` and above and falls back
   * to `stacked` below it, where there is no second column to put anything in.
   */
  readonly layout?: 'stacked' | 'split';
  /** The lead paragraph, and any provenance or status line beneath it. */
  readonly children?: ReactNode;
}

export function PageHeader({
  label,
  title,
  scale = 'display',
  labelTone = 'muted',
  spacing = 'compact',
  layout = 'stacked',
  children,
}: PageHeaderProps) {
  const heading = (
    <h1 className={scale === 'hero' ? 'text-hero text-balance' : 'text-display text-balance'}>
      {title}
    </h1>
  );

  if (layout === 'split') {
    return (
      <header className="grid gap-y-6 lg:grid-cols-2 lg:gap-x-0">
        <div className="flex flex-col gap-3">
          {label === undefined ? null : <Eyebrow tone={labelTone}>{label}</Eyebrow>}
          {heading}
        </div>
        {children === undefined ? null : <div className="flex flex-col gap-4">{children}</div>}
      </header>
    );
  }

  return (
    <header className={spacing === 'roomy' ? 'flex flex-col gap-5' : 'flex flex-col gap-3'}>
      {label === undefined ? null : <Eyebrow tone={labelTone}>{label}</Eyebrow>}
      {heading}
      {children}
    </header>
  );
}
