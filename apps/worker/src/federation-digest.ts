import { createHash } from 'node:crypto';

import type { FederationOutcome, FederationPartition } from '@civora/simulator';
import type { Simulation } from '@civora/simulator';

/**
 * A digest of one federated run, so two processes can be compared byte for byte.
 *
 * The phase requires round determinism — the same seed and configuration produce
 * identical round metrics — and a unit test cannot supply a process restart. This
 * can: `pnpm fl:run --digest-only` prints one line, and the same line from two
 * separate invocations is the evidence.
 *
 * The digest deliberately contains **no wall clock and no date**. Every figure in
 * it is a function of the world, the configuration and the seed, and a digest
 * that moved because the clock moved would prove nothing about determinism. The
 * time a round took is measured by the command and reported beside the digest,
 * not inside it.
 *
 * Numbers are printed at full precision for the same reason Phase 6's plan digest
 * does it: a drift of 0.005 units in a loss changes the hash, and a rounded digest
 * would hide exactly the drift a refactor introduces.
 */

export interface FederationDigestFacts {
  readonly partition: FederationPartition;
  readonly outcome: FederationOutcome;
  readonly simulation: Pick<Simulation, 'from' | 'to' | 'ledgerEntries'>;
  readonly model: string;
  readonly elapsedMs: number;
}

export interface FederationDigest {
  readonly text: string;
  readonly sha256: string;
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

export function federationDigestOf(facts: FederationDigestFacts): FederationDigest {
  const { partition, outcome, simulation } = facts;
  const { config } = outcome.resolved;
  const run = outcome.run;
  const lines: string[] = [
    'civora-federation-digest@1',
    `world ${partition.countryId} · ${partition.regionLevelName} level · window ${simulation.from} → ${simulation.to} · ledger entries ${String(simulation.ledgerEntries.length)}`,
    `partition ${String(partition.silos.length)} silo(s) · ${String(partition.seriesRead)} series read · ${String(partition.seriesTooShort)} too short · ${String(partition.censoredDaysFound)} censored day(s) found · ${String(partition.censoredDaysImputed)} imputed · imputation ${partition.imputations.join(',')} · ${String(partition.samples)} row(s)`,
    `config rounds ${String(config.rounds)} · samplingRate ${String(config.samplingRate)} · model ${facts.model} · clipNorm ${String(config.clipNorm)} · delta ${String(config.delta)} · sigma ${String(outcome.resolved.noiseMultiplier)} · epsilonTarget ${outcome.resolved.epsilonTarget === null ? 'none' : String(outcome.resolved.epsilonTarget)} · mu ${String(config.local.mu ?? 0)} · masked ${config.maskUpdates ? 'yes' : 'no'} · seed ${config.seed}`,
    `spend ${run.spend === null ? 'no mechanism: epsilon unbounded, recorded as absent' : `epsilon ${String(run.spend.epsilon)} at order ${String(run.spend.bestOrder)} · rdp ${String(run.spend.rdp)}`}`,
    'ledger',
  ];

  for (const round of run.ledger) {
    lines.push(
      `round ${String(round.round)} · participants ${String(round.participants.length)} · samples ${String(
        round.participants.reduce((total, entry) => total + entry.sampleCount, 0),
      )} · meanLocalLoss ${String(round.meanLocalLoss)} · globalLoss ${String(round.globalLoss)} · divergence ${
        round.divergence === null ? 'masked' : String(round.divergence)
      } · clipped ${String(round.clippedSilos)} · largestRawNorm ${String(round.largestRawNorm)} · noise ${String(
        round.noiseStandardDeviation,
      )} · epsilon ${round.epsilonSpent === null ? 'none' : String(round.epsilonSpent)} · bytes ${String(
        round.bytesIn,
      )} · masked ${round.masked ? 'yes' : 'no'}`,
    );
  }

  lines.push(
    `final initial ${String(run.initialLoss)} · final ${String(run.finalLoss)} · improvement ${String(
      run.initialLoss === 0 ? 0 : 1 - run.finalLoss / run.initialLoss,
    )}`,
  );

  const siloLines = outcome.perSilo.map(
    (entry) =>
      `${entry.siloId} · samples ${String(entry.sampleCount)} · localOnly ${String(
        entry.localOnlyLoss,
      )} · federated ${String(entry.federatedLoss)}`,
  );
  lines.push(
    `silos ${String(siloLines.length)} of sha256:${sha256Of(siloLines.join('\n'))}`,
    ...siloLines,
  );

  lines.push(
    outcome.fedAvg === null
      ? `fedprox mu ${String(config.local.mu ?? 0)} · final ${String(run.finalLoss)}`
      : `fedavg mu 0 · final ${String(outcome.fedAvg.finalLoss)} · fedprox mu ${String(
          config.local.mu ?? 0,
        )} · final ${String(run.finalLoss)} · ${outcome.proximalWinner ?? 'unknown'} better`,
  );

  const text = lines.join('\n');
  return { text, sha256: sha256Of(text) };
}
