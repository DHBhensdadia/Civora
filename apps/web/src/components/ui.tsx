import type { ReactNode } from 'react';

/**
 * Presentation primitives shared by the platform's pages.
 *
 * Deliberately small and unopinionated: a panel, a statistic, a table and a
 * count list. Every later surface — the control tower, the facility capture
 * form, the federation console — is built from these, so the platform looks
 * like one application rather than five.
 *
 * Numbers are formatted for an Indian readership, which is where the platform
 * is deployed today. The country is a configuration value rather than an
 * assumption in the domain, so this is a presentation default and not a
 * constraint on the model.
 */

/** Formats a count the way a reader in the deployment's home country reads it. */
export const formatCount = (value: number): string => value.toLocaleString('en-IN');

export interface PanelProps {
  readonly id: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}

/** A titled section, anchored by its own heading so assistive technology can navigate to it. */
export function Panel({ id, title, description, children }: PanelProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {title}
        </h2>
        {description === undefined ? null : (
          <div className="max-w-3xl text-sm text-slate-400">{description}</div>
        )}
      </div>
      {children}
    </section>
  );
}

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
      <p className="text-xs tracking-wider text-slate-400 uppercase">{label}</p>
      <p className="mt-1 font-mono text-xl text-sky-300">{value}</p>
      {hint === undefined ? null : <p className="mt-1 text-xs text-slate-500">{hint}</p>}
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
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-800 bg-slate-900/60 text-left">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={
                  column.numeric === true
                    ? 'px-4 py-2 text-right font-medium text-slate-300'
                    : 'px-4 py-2 font-medium text-slate-300'
                }
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {rows.map((row, rowIndex) => (
            // Rows have no natural identity of their own: they are positions in
            // a generated table, and the order is stable because the dataset is.
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={
                    columns[cellIndex]?.numeric === true
                      ? 'px-4 py-2 text-right font-mono text-slate-200'
                      : 'px-4 py-2 text-slate-300'
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
 */
export function CountList({ id, title, counts, footnote }: CountListProps) {
  const largest = counts.reduce((most, entry) => Math.max(most, entry.count), 0);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 id={`${id}-heading`} className="text-sm font-medium text-slate-200">
        {title}
      </h3>
      <ul aria-labelledby={`${id}-heading`} className="mt-3 flex flex-col gap-2">
        {counts.map((entry) => (
          <li key={entry.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-slate-300">{entry.label}</span>
              <span className="font-mono text-slate-400">{formatCount(entry.count)}</span>
            </div>
            <div aria-hidden="true" className="h-1 w-full rounded-full bg-slate-800">
              <div
                className="h-1 rounded-full bg-sky-500/70"
                style={{ width: `${largest === 0 ? 0 : (entry.count / largest) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {footnote === undefined ? null : <p className="mt-3 text-xs text-slate-500">{footnote}</p>}
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

const NOTICE_TONES: Readonly<Record<NoticeTone, string>> = {
  warning: 'border-amber-500/40 bg-amber-500/10',
  info: 'border-sky-500/30 bg-sky-500/5',
};

const NOTICE_TITLES: Readonly<Record<NoticeTone, string>> = {
  warning: 'text-amber-200',
  info: 'text-sky-200',
};

const NOTICE_BODY: Readonly<Record<NoticeTone, string>> = {
  warning: 'text-amber-100/90',
  info: 'text-sky-100/80',
};

export function Notice({ id, tone, title, testId, children }: NoticeProps) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      data-testid={testId}
      className={`rounded-xl border p-6 ${NOTICE_TONES[tone]}`}
    >
      <h2 id={`${id}-heading`} className={`text-base font-semibold ${NOTICE_TITLES[tone]}`}>
        {title}
      </h2>
      <div className={`mt-2 flex flex-col gap-2 text-sm ${NOTICE_BODY[tone]}`}>{children}</div>
    </section>
  );
}
