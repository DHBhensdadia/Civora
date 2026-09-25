/**
 * The platform's five modules.
 *
 * Declared here so the skeleton, the documentation and the eventual navigation
 * cannot describe the product in three different ways.
 */
export interface ModuleDescriptor {
  readonly name: string;
  readonly meaning: string;
  readonly responsibility: string;
}

export const MODULES: readonly ModuleDescriptor[] = [
  {
    name: 'Drishti',
    meaning: 'visibility',
    responsibility: 'What is in stock, where it is, and how stale the answer is.',
  },
  {
    name: 'Poorvadarshan',
    meaning: 'forecasting',
    responsibility: 'What each facility will need next, from its own consumption history.',
  },
  {
    name: 'Chetavani',
    meaning: 'early warning',
    responsibility: 'Which facilities are heading for a stock-out, and when.',
  },
  {
    name: 'Setu',
    meaning: 'redistribution',
    responsibility: 'Which transfers would help, subject to every safety constraint.',
  },
  {
    name: 'Samvad',
    meaning: 'federation',
    responsibility: 'What states can learn from each other without sharing records.',
  },
] as const;
