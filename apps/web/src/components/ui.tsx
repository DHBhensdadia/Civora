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
 * Two things are load-bearing and must survive any future edit:
 *
 *  - **`Panel` and `Notice` name themselves** with `aria-labelledby` pointing at
 *    their own heading. The browser journeys resolve a panel *by its accessible
 *    name* — `getByRole('region', { name: 'Alert inbox' })` — so the `id` and the
 *    `h2` are an interface, not a styling detail.
 *  - **`Notice` declares `testId` as a prop** rather than accepting it as a
 *    passthrough attribute, because a component drops attributes it does not
 *    declare and the journey would then fail to find a marker that looks present
 *    in the source.
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
 * Before this file had these, the build declared three border radii, four
 * "panel" treatments and a tinted box per tone at their call sites; the count of
 * bordered elements ranged from 15 to 51 between surfaces, which is what "the
 * boxes do not match" measures.
 */
const SURFACE = 'rounded-instrument border border-ink-700 bg-ink-900';
const INSET = 'rounded-instrument bg-ink-800';

export interface EyebrowProps {
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'accent' | 'signal';
}

/**
 * The mono uppercase label above a title or a figure.
 *
 * This is the smallest component in the interface and the one that does the most
 * work: a widely-tracked, small, uppercase mono label over a heading is what
 * separates an instrument panel from a paragraph. The tracking is positive here
 * and negative on display type — deliberately, and in opposite directions.
 */
export function Eyebrow({ children, tone = 'muted' }: EyebrowProps) {
  const tones: Readonly<Record<NonNullable<EyebrowProps['tone']>, string>> = {
    muted: 'text-fg-subtle',
    accent: 'text-accent',
    signal: 'text-signal-watch',
  };
  return <p className={`font-mono text-eyebrow uppercase ${tones[tone]}`}>{children}</p>;
}

/** A hairline rule. Separation by line rather than by another box. */
export function Rule() {
  return <hr className="m-0 border-0 border-t border-ink-700" />;
}

export interface PanelProps {
  readonly id: string;
  readonly title: string;
  /** A one-line group label above the title, in the mono eyebrow style. */
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
          <div className="max-w-measure text-sm text-fg-muted">{description}</div>
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
      {hint === undefined ? null : <p className="text-xs text-fg-subtle">{hint}</p>}
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
    <div className="overflow-x-auto rounded-instrument border border-ink-700">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-ink-800">
          <tr className="border-b border-ink-700 text-left">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={
                  column.numeric === true
                    ? 'px-4 py-3 text-right font-mono text-eyebrow uppercase text-fg-subtle'
                    : 'px-4 py-3 font-mono text-eyebrow uppercase text-fg-subtle'
                }
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700/70">
          {rows.map((row, rowIndex) => (
            // Rows have no natural identity of their own: they are positions in
            // a generated table, and the order is stable because the dataset is.
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={
                    columns[cellIndex]?.numeric === true
                      ? 'tabular px-4 py-3 text-right text-fg-muted'
                      : 'px-4 py-3 text-fg-muted'
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
 * It is an inset block rather than a bordered card: a panel already provides the
 * border, and a box inside a box is how a dense page turns into a grid of frames.
 */
export function CountList({ id, title, counts, footnote }: CountListProps) {
  const largest = counts.reduce((most, entry) => Math.max(most, entry.count), 0);

  return (
    <div className={`${INSET} p-4`}>
      <h3 id={`${id}-heading`} className="font-mono text-eyebrow text-fg-subtle uppercase">
        {title}
      </h3>
      <ul aria-labelledby={`${id}-heading`} className="mt-3 flex flex-col gap-2.5">
        {counts.map((entry) => (
          <li key={entry.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-fg-muted">{entry.label}</span>
              <span className="tabular text-fg">{formatCount(entry.count)}</span>
            </div>
            <div aria-hidden="true" className="h-1 w-full rounded-full bg-ink-700">
              <div
                className="h-1 rounded-full bg-accent/70"
                style={{ width: `${largest === 0 ? 0 : (entry.count / largest) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {footnote === undefined ? null : <p className="mt-3 text-xs text-fg-subtle">{footnote}</p>}
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

const NOTICE_TONES: Readonly<Record<NoticeTone, { rail: string; title: string }>> = {
  warning: { rail: 'border-l-signal-watch', title: 'text-signal-watch' },
  info: { rail: 'border-l-accent', title: 'text-accent' },
};

/**
 * A refusal, a scope note or a read-only warning.
 *
 * It carries the tone in a **rail rather than in a filled box**. A tinted panel
 * is the loudest thing a page can draw, and a build that draws one for every
 * informational note spends the reader's attention before it reaches the figure
 * the page exists to show. The disclosure banner on the overview is the one
 * place that keeps a full tint, deliberately, because it is the one sentence a
 * reader must not miss.
 */
export function Notice({ id, tone, title, testId, children }: NoticeProps) {
  const { rail, title: titleTone } = NOTICE_TONES[tone];
  return (
    <section
      aria-labelledby={`${id}-heading`}
      data-testid={testId}
      className={`${SURFACE} border-l-2 ${rail} p-5`}
    >
      <h2 id={`${id}-heading`} className={`text-base font-medium ${titleTone}`}>
        {title}
      </h2>
      <div className="mt-2 flex max-w-measure flex-col gap-2 text-sm text-fg-muted">{children}</div>
    </section>
  );
}

/*
 * Controls.
 *
 * Every control is a pill with a 2px border and a 44px minimum height. The
 * build's controls were 18–20px tall — *every one of them*, on every surface —
 * which is under the accessible touch target on the tablet the README says this
 * runs on. Three classes cover every button in the platform, so the control
 * vocabulary is fixed rather than re-invented per form.
 */
const CONTROL =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border-2 px-4 py-2 text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40';

/** The action a page is asking for. */
export const CONTROL_PRIMARY = `${CONTROL} border-accent bg-accent/15 text-accent hover:bg-accent/25`;

/** A secondary action beside a primary one. */
export const CONTROL_QUIET = `${CONTROL} border-ink-600 text-fg-muted hover:border-accent hover:text-accent`;

/** In-place, per-row actions, which are visually lighter than a page action. */
export const CONTROL_SMALL = `${CONTROL} min-h-11 border-ink-600 px-3 text-xs text-fg-muted hover:border-accent hover:text-accent`;

/** A field a person types into. */
export const FIELD =
  'min-h-11 w-full rounded-instrument border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle';
