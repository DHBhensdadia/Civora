import type { CaptureSource } from '@civora/domain';

/**
 * How a movement reached the ledger, in the words a reader sees on a record.
 *
 * Two surfaces answer this question and they are answering different ones. At
 * intake — `/vision`, `/voice` — the open question is *which reader* filled the
 * page, so the badge there names the model beside the channel (`AI-extracted ·
 * vision · gemini-…`). A movement read back later knows a single field,
 * `captureSource`, and nothing about who or what filled it. So the badge here
 * names the **channel the movement came down** and stops there: it does not
 * repeat `AI-extracted` over a record that may have been a supplied reading,
 * because a record surface has no evidence for that claim and a badge is the one
 * place a reader looks instead of the field.
 *
 * What it does say is the thing a district officer checking a facility's recent
 * movements actually asks: was this counted on a shelf, or copied off a page? So
 * the two reading paths read `extracted`, a person at a keyboard reads `typed`,
 * and an incumbent system reads `imported`.
 *
 * `simulation` reads `Simulated`, deliberately not folded in with the captures.
 * The seeded history is generated, commitment A8 requires it labelled as such
 * everywhere it appears, and this list holds generated and captured movements
 * side by side — so the label is what keeps them apart.
 *
 * A source this build does not know is shown as itself. `CAPTURE_SOURCES` is
 * append-only, and a source added later would otherwise be swallowed by the
 * nearest known one; a raw value is a visible gap, while the wrong word is a
 * quiet lie.
 */

/** What a source implies about the record, for styling. `unknown` means unmapped. */
export const CAPTURE_TONES = ['extracted', 'typed', 'imported', 'generated', 'unknown'] as const;
export type CaptureTone = (typeof CAPTURE_TONES)[number];

export interface CaptureBadge {
  /** The phrase shown beside the movement. */
  readonly label: string;
  /** Which family the source belongs to. */
  readonly tone: CaptureTone;
}

/**
 * The badge for each source the platform can store.
 *
 * Typed as a total record over `CaptureSource`, so adding a source to the enum
 * fails the build here rather than silently rendering a raw value on a surface
 * nobody remembered to update.
 */
const CAPTURE_BADGES: Readonly<Record<CaptureSource, CaptureBadge>> = {
  vision: { label: 'Extracted · vision', tone: 'extracted' },
  voice: { label: 'Heard · voice', tone: 'extracted' },
  manual: { label: 'Typed · manual', tone: 'typed' },
  import: { label: 'Imported · import', tone: 'imported' },
  simulation: { label: 'Simulated', tone: 'generated' },
};

const isCaptureSource = (value: string): value is CaptureSource =>
  Object.hasOwn(CAPTURE_BADGES, value);

/** The badge for a movement's `captureSource`, known or not. */
export const captureBadge = (source: string): CaptureBadge =>
  isCaptureSource(source) ? CAPTURE_BADGES[source] : { label: source, tone: 'unknown' };
