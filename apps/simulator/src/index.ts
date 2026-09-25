/**
 * `@civora/simulator` — the synthetic nation.
 *
 * Scope: a seeded generator for a multi-state facility network anchored on real
 * administrative codes and published population norms, together with the
 * consumption, stock-out and reporting-lag behaviour that makes the demo
 * exercises meaningful.
 *
 * The generator is deterministic: the same seed produces the same nation, so a
 * reviewer can reproduce exactly what the demo video shows. Everything it emits
 * is labelled as simulated wherever it is displayed.
 *
 * The module reads from the outside in:
 *
 *  - `anchors/` — the external values everything else is built on, and the
 *    record of which of them were actually retrieved.
 *  - `network.ts` — the administrative spine, sized from population.
 *  - `behaviour.ts` — how one facility consumes, stocks out and reports.
 *  - `simulation.ts` — a whole country's worth of observations for one scenario.
 */

import type { FacilityId } from '@civora/domain';

import type { Network, NetworkOptions } from './network';
import type { SimulationOptions } from './simulation';

export * from './anchors/catalogue';
export * from './anchors/geography';
export * from './anchors/sources';
export * from './behaviour';
export * from './network';
export * from './rng';
export * from './scenarios';
export * from './simulation';

/**
 * The seed the shipped demonstration dataset is generated from.
 *
 * Published rather than hidden, because the point of a fixed seed is that
 * anyone can regenerate the dataset and check it against what the platform
 * displays.
 */
export const DEMO_SEED = 'civora-demo-2026';

/**
 * The network profile the demonstration runs on.
 *
 * Five districts of each anchored state, one block of each district and every
 * facility tier: enough that a district-level redistribution has somewhere to
 * move stock to, and small enough that the whole history regenerates in
 * seconds. Five rather than three or four because it is the smallest number that
 * places every district the scenarios name, which is asserted in
 * `network.test.ts` — a scenario with no facility to act on is not a scenario.
 *
 * The rest of the country is available at `coverage: 'all'`, and `network.ts`
 * states plainly that a demo profile is a sample of the real network rather
 * than all of it.
 */
export const DEMO_NETWORK_OPTIONS: NetworkOptions = {
  seed: DEMO_SEED,
  coverage: 'demo',
  districtsPerState: 5,
  blocksPerDistrict: 1,
  facilityTiersPerBlock: ['SHC', 'PHC', 'CHC'],
  countryName: 'India',
  currency: 'INR',
  languages: ['en', 'hi', 'bn', 'ta', 'mr'],
};

/**
 * The same history settings for every scenario, so two scenarios differ in the
 * world and not in the window they were observed over.
 */
export const DEMO_SIMULATION_OPTIONS: SimulationOptions = {
  seed: DEMO_SEED,
};

const byIdentifier = (left: { readonly id: string }, right: { readonly id: string }): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * A reproducible sample of facilities to generate a history for.
 *
 * Taken by identifier within each region rather than at random, so the sample
 * is the same on every machine and can be inspected by reading this function.
 * Spreading it across regions matters: a sample drawn from the whole list at
 * once is dominated by whichever state sorts first, which would make a national
 * platform look like a two-state one.
 *
 * Sizing it matters too, because the cost is linear in facilities and steep:
 * one facility over the full scenario window produces a little over fifteen
 * thousand ledger entries and takes about a tenth of a second, measured 2026-09-25.
 * Two facilities per state is a dataset of roughly a fifth of a million
 * observations, which is a comfortable size to seed and to browse.
 */
export const historySample = (network: Network, perRegion: number): readonly FacilityId[] => {
  const byRegion = new Map<string, FacilityId[]>();
  for (const facility of [...network.facilities].sort(byIdentifier)) {
    const list = byRegion.get(facility.regionId) ?? [];
    list.push(facility.id);
    byRegion.set(facility.regionId, list);
  }

  const sample: FacilityId[] = [];
  for (const facilities of byRegion.values()) {
    sample.push(...facilities.slice(0, perRegion));
  }

  return sample;
};
