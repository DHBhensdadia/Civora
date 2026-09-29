/**
 * The platform's five modules.
 *
 * Declared here so the skeleton, the documentation and the eventual navigation
 * cannot describe the product in three different ways. Each carries its own
 * status, because a platform that names five capabilities and does not say which
 * of them exist is asking to be taken on trust.
 */
export interface ModuleDescriptor {
  readonly name: string;
  readonly meaning: string;
  readonly responsibility: string;
  /** What is built, in the platform's own words rather than a percentage. */
  readonly status: string;
  /**
   * Where the module is shown at work.
   *
   * A status is a claim about a capability, and this is the surface that answers
   * for it, so the overview links each card to the page behind it rather than
   * leaving a reader to guess which of thirteen surfaces "Poorvadarshan" is.
   */
  readonly href: string;
}

export const MODULES: readonly ModuleDescriptor[] = [
  {
    name: 'Drishti',
    meaning: 'visibility',
    responsibility: 'What is in stock, where it is, and how stale the answer is.',
    status:
      'sensing plane implemented — offline capture, idempotent ingest, photographed and spoken updates a person confirms, district visibility with reporting gaps',
    href: '/visibility',
  },
  {
    name: 'Poorvadarshan',
    meaning: 'forecasting',
    responsibility: 'What each facility will need next, from its own consumption history.',
    status:
      'forecasting implemented — censored-demand repair, four baselines, backtested against the generated world',
    href: '/intelligence',
  },
  {
    name: 'Chetavani',
    meaning: 'early warning',
    responsibility: 'Which facilities are heading for a stock-out, and when.',
    status: 'early warning implemented — nine risk drivers, a ranked list and an alert inbox',
    href: '/intelligence',
  },
  {
    name: 'Setu',
    meaning: 'redistribution',
    responsibility: 'Which transfers would help, subject to every safety constraint.',
    status:
      'redistribution implemented — constraint-checked proposals, quantified impact with its assumptions, and human decisions with a reason; nothing is executed',
    href: '/redistribution',
  },
  {
    name: 'Samvad',
    meaning: 'federation',
    responsibility: 'What states can learn from each other without sharing records.',
    status:
      'federation implemented — a differentiable model trained per state silo, clipped weighted aggregation with FedProx, additive-mask secure aggregation, and a Rényi-DP accountant; the managed substrate is documented, not built',
    href: '/federation',
  },
] as const;
