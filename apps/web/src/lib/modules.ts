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
}

export const MODULES: readonly ModuleDescriptor[] = [
  {
    name: 'Drishti',
    meaning: 'visibility',
    responsibility: 'What is in stock, where it is, and how stale the answer is.',
    status:
      'sensing plane implemented — offline capture, idempotent ingest, photographed and spoken updates a person confirms, district visibility with reporting gaps',
  },
  {
    name: 'Poorvadarshan',
    meaning: 'forecasting',
    responsibility: 'What each facility will need next, from its own consumption history.',
    status:
      'forecasting implemented — censored-demand repair, four baselines, backtested against the generated world',
  },
  {
    name: 'Chetavani',
    meaning: 'early warning',
    responsibility: 'Which facilities are heading for a stock-out, and when.',
    status: 'early warning implemented — nine risk drivers, a ranked list and an alert inbox',
  },
  {
    name: 'Setu',
    meaning: 'redistribution',
    responsibility: 'Which transfers would help, subject to every safety constraint.',
    status: 'not implemented',
  },
  {
    name: 'Samvad',
    meaning: 'federation',
    responsibility: 'What states can learn from each other without sharing records.',
    status: 'not implemented',
  },
] as const;
