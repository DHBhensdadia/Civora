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

import { buildNetwork } from './network';
import type { Network, NetworkOptions } from './network';
import { simulateNetwork } from './simulation';
import type { Simulation, SimulationOptions } from './simulation';
import { summariseDataset } from './summary';
import type { DatasetSummary } from './summary';

export * from './anchors/catalogue';
export * from './anchors/geography';
export * from './anchors/sources';
export * from './behaviour';
export * from './network';
export * from './rng';
export * from './scenarios';
export * from './simulation';
export * from './summary';

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

/**
 * Facilities per region the shipped demonstration dataset generates a history
 * for.
 *
 * Two, so the sample spans two facility tiers in every state rather than the
 * single tier a one-per-region sample happens to select. Coverage and depth are
 * separate choices: the network states the whole country, and this says how much
 * of each region has a past.
 */
export const DEMO_HISTORY_FACILITIES_PER_REGION = 2;

/** The demonstration dataset, generated and counted in one call. */
export interface DemoDataset {
  readonly network: Network;
  readonly simulation: Simulation;
  readonly summary: DatasetSummary;
  readonly facilityIds: readonly FacilityId[];
  /** Wall clock for generating the history and counting it, in milliseconds. */
  readonly generatedInMs: number;
}

/**
 * Generate the dataset the demonstration runs on, and describe it.
 *
 * One entry point rather than three calls, so the page that browses the dataset
 * and the command that seeds it cannot disagree about which dataset they mean.
 * The network is built whole — every state, district and facility the profile
 * covers — while the history is generated for the sample, which is the split
 * the summary reports.
 */
export const buildDemoDataset = (
  facilitiesPerRegion: number = DEMO_HISTORY_FACILITIES_PER_REGION,
): DemoDataset => {
  const startedAt = Date.now();
  const network = buildNetwork(DEMO_NETWORK_OPTIONS);
  const facilityIds = historySample(network, facilitiesPerRegion);
  const simulation = simulateNetwork(network, { ...DEMO_SIMULATION_OPTIONS, facilityIds });
  const summary = summariseDataset(network, simulation);

  return {
    network,
    simulation,
    summary,
    facilityIds,
    generatedInMs: Date.now() - startedAt,
  };
};
