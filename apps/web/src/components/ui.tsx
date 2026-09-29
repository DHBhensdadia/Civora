import type { ReactNode } from 'react';

/**
 * Presentation primitives shared by the platform's pages.
 *
 * Every surface is built from these, so the platform looks like one
 * application rather than thirteen. The shapes here are the whole visual
 * vocabulary: a surface, a panel, a statistic, a table, a count list, a notice,
 * an eyebrow and a control. A page that reaches past them for a raw colour is a
 * page that has left the system.
 *
 * Three things are load-bearing and must survive any future edit:
 *
 *  - **`Panel` and `Notice` name themselves** with `aria-labelledby` pointing at
 *    their own heading. The browser journeys resolve a panel *by its accessible
 *    name* — `getByRole('region', { name: 'Alert inbox' })` — so the `id` and the
 *    `h2` are an interface, not a styling detail.
 *  - **`Notice` declares `testId` as a prop** rather than accepting it as a
 *    passthrough attribute, because a component drops attributes it does not
 *    declare and the journey would then fail to find a marker that looks present
 *    in the source.
 *  - **Every control keeps `min-h-11`.** The touch-target floor is measured by
 *    the audit instrument and asserted in the phase's definition of done; a
 *    restyle that removes it is a regression even if it looks better.
 *
 * The visual language is the one measured in `research/10-apoha-standard.md`:
 * paper rather than a dark canvas, hierarchy from the opacity of a single ink
 * rather than from a ramp of greys, and separation by a wash rather than by a
 * border. A panel is an off-white plate on white with **no border at all**;
 * that is the whole mechanism.
 *
 * Numbers are formatted for an Indian readership, which is where the platform is
 * deployed today. The country is a configuration value rather than an assumption
 * in the domain, so this is a presentation default and not a constraint on the
 * model.
 */

/** Formats a count the way a reader in the deployment's home country reads it. */
export const formatCount = (value: number): string => value.toLocaleString('en-IN');

/*
 * Surfaces and controls, named once.
 *
 * A panel is a plate on the canvas. Before this file had these, the build
 * declared three border radii, four "panel" treatments and a tinted box per
 * tone at their call sites, and carried a border on every one of them — a
 * bordered box inside a bordered box is what a component library looks like, and
 * it is the first thing the reference does not do.
 */
const SURFACE = 'rounded-card bg-paper-raised';
const INSET = 'rounded-control bg-paper';

export interface EyebrowProps {
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'accent' | 'signal';
}

/**
 * The label above a title or a figure.
 *
 * This is the smallest component in the interface. It used to be monospace,
 * uppercase and tracked at +0.15em, which is the instrument idiom of a different
 * school; the reference writes its labels in the body family, in sentence case,
 * untracked. So does this now, and the class name is kept only because renaming
 * it would be churn without a reader.
 */
export function Eyebrow({ children, tone = 'muted' }: EyebrowProps) {
  const tones: Readonly<Record<NonNullable<EyebrowProps['tone']>, string>> = {
    muted: 'text-ink-subtle',
    accent: 'text-accent',
    signal: 'text-signal-watch',
  };
  return <p className={`text-eyebrow ${tones[tone]}`}>{children}</p>;
}

/** A hairline rule. Separation by line rather than by another box. */
export function Rule() {
  return <hr className="m-0 border-0 border-t border-hairline" />;
}

export interface PanelProps {
  readonly id: string;
  readonly title: string;
  /** A one-line group label above the title. */
  readonly eyebrow?: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}

/** A titled section, anchored by its own heading so assistive technology can navigate to it. */
export function Panel({ id, title, eyebrow, description, children }: PanelProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className={`${SURFACE} flex flex-col`}>
      <header className="flex flex-col gap-2 px-5 pt-5 pb-4 sm:px-6">
        {eyebrow === undefined ? null : <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 id={`${id}-heading`} className="text-2xl text-balance">
          {title}
        </h2>
        {description === undefined ? null : (
          <div className="max-w-measure text-sm text-ink-muted">{description}</div>
        )}
      </header>
      <Rule />
      <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

/**
 * A single figure, with the figure as its own most important element.
 *
 * The value is the largest thing in the card and it is set in tabular figures at
 * weight 400, because a column of stats has to line up on the decimal and a bold
 * number reads as a claim rather than as a measurement.
 */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className={`${SURFACE} flex flex-col gap-2 px-4 py-4`}>
      <Eyebrow>{label}</Eyebrow>
      <p className="tabular text-stat">{value}</p>
      {hint === undefined ? null : <p className="text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}

export interface Column {
  readonly header: string;
  /** Right-aligns the column, which is what numeric columns want. */
  readonly numeric?: boolean;
}

export interface DataTableProps {
  /** Read aloud in place of the visual heading; required for a table with no caption row. */
  readonly caption: string;
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly ReactNode[])[];
}

export function DataTable({ caption, columns, rows }: DataTableProps) {
  return (
    <div className="overflow-x-auto rounded-card bg-paper">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-paper-sunken">
          <tr className="border-b border-hairline text-left">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={
                  column.numeric === true
                    ? 'px-4 py-3 text-right text-eyebrow text-ink-subtle'
                    : 'px-4 py-3 text-eyebrow text-ink-subtle'
                }
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((row, rowIndex) => (
            // Rows have no natural identity of their own: they are positions in
            // a generated table, and the order is stable because the dataset is.
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={
                    columns[cellIndex]?.numeric === true
                      ? 'tabular px-4 py-3 text-right text-ink-muted'
                      : 'px-4 py-3 text-ink-muted'
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One label-and-count pair, as the summaries produce them. */
export interface Counted {
  readonly label: string;
  readonly count: number;
}

export interface CountListProps {
  readonly id: string;
  readonly title: string;
  readonly counts: readonly Counted[];
  /** Set when the counts are the whole story and an empty list would be a bug. */
  readonly footnote?: string;
}

/**
 * A label-and-count list, with each count shown as a share of the largest.
 *
 * The bar is measured against the biggest entry rather than the total, because
 * the question a reader asks of a distribution like this is "which dominates",
 * and a bar drawn against the total is invisible for everything but the leader.
 *
 * The bar is a **pastel mark**, which is the one thing the reference's palette is
 * good for: a colour that is unusable as text is perfectly good as a fill.
 */
export function CountList({ id, title, counts, footnote }: CountListProps) {
  const largest = counts.reduce((most, entry) => Math.max(most, entry.count), 0);

  return (
    <div className={`${INSET} p-4`}>
      <h3 id={`${id}-heading`} className="text-eyebrow text-ink-subtle">
        {title}
      </h3>
      <ul aria-labelledby={`${id}-heading`} className="mt-3 flex flex-col gap-2.5">
        {counts.map((entry) => (
          <li key={entry.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-ink-muted">{entry.label}</span>
              <span className="tabular text-ink">{formatCount(entry.count)}</span>
            </div>
            <div aria-hidden="true" className="h-1 w-full rounded-full bg-paper-sunken">
              <div
                className="h-1 rounded-full bg-mint"
                style={{ width: `${largest === 0 ? 0 : (entry.count / largest) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {footnote === undefined ? null : <p className="mt-3 text-xs text-ink-subtle">{footnote}</p>}
    </div>
  );
}

export type NoticeTone = 'warning' | 'info';

export interface NoticeProps {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly title: string;
  /**
   * An identifier for the browser journeys. It is a prop rather than a
   * `data-testid` written at the call site because a component drops attributes
   * it does not declare: the journey would then fail to find a marker that looks
   * present in the source.
   */
  readonly testId?: string;
  readonly children: ReactNode;
}

const NOTICE_TONES: Readonly<Record<NoticeTone, { plate: string; title: string }>> = {
  warning: { plate: 'bg-sun/30', title: 'text-ink' },
  info: { plate: 'bg-paper-raised', title: 'text-accent' },
};

/**
 * A refusal, a scope note or a read-only warning.
 *
 * The warning tone is now the same pale yellow the reference paints its
 * announcement bar in, because that is what this is: the one sentence on a
 * surface that a reader must not miss. The key sits at the label's luminance and
 * never at a pastel's, so the title is ink on a tint rather than coloured text.
 */
export function Notice({ id, tone, title, testId, children }: NoticeProps) {
  const { plate, title: titleTone } = NOTICE_TONES[tone];
  return (
    <section
      aria-labelledby={`${id}-heading`}
      data-testid={testId}
      className={`rounded-card ${plate} p-5`}
    >
      <h2 id={`${id}-heading`} className={`text-base font-medium ${titleTone}`}>
        {title}
      </h2>
      <div className="mt-2 flex max-w-measure flex-col gap-2 text-sm text-ink-muted">
        {children}
      </div>
    </section>
  );
}

/*
 * Controls.
 *
 * Every control keeps a 44px minimum height, because the build's controls were
 * 18–20px tall — *every one of them*, on every surface — and that floor is the
 * one piece of the previous language that was measuring something real.
 *
 * What has changed is the shape: a 6px radius and a fill, instead of a pill with
 * a 2px border. A border on a control is a second outline competing with the
 * panel it sits on; the reference fills the primary action and leaves nothing
 * else to look at.
 */
const CONTROL =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40';

/** The action a page is asking for. */
export const CONTROL_PRIMARY = `${CONTROL} bg-accent text-paper hover:bg-accent/85`;

/** A secondary action beside a primary one. */
export const CONTROL_QUIET = `${CONTROL} bg-paper-sunken text-ink-muted hover:bg-hairline hover:text-ink`;

/** In-place, per-row actions, which are visually lighter than a page action. */
export const CONTROL_SMALL = `${CONTROL} min-h-11 bg-paper-sunken px-3 text-xs text-ink-muted hover:bg-hairline hover:text-ink`;

/** A field a person types into. */
export const FIELD =
  'min-h-11 w-full rounded-control border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-subtle';
