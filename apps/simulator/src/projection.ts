import { LedgerService } from '@civora/domain';
import type { Item } from '@civora/domain';

import type { Simulation } from './simulation';

/**
 * A generated world, replayed into what the platform knows about each facility.
 *
 * This is the one place the demonstration environment and the batch jobs build
 * their projection, so the figures a surface shows and the figures a worker
 * plans from cannot come from two different readings of the same ledger. Both
 * replay with the same methods the ingest boundary calls; a collection-wide scan
 * would be the alternative, and it would need a query the persistence port does
 * not have.
 *
 * The provenance is deliberate and belongs here rather than at either call site:
 * a reporting gap is not observed and not generated — it is *computed* from what
 * the platform received — so the projection says so rather than inheriting the
 * simulator's label from the records it was derived over.
 */
export function projectSimulation(simulation: Simulation, items: readonly Item[]): LedgerService {
  const ledger = new LedgerService({
    from: simulation.from,
    through: simulation.to,
    items,
    synthetic: true,
    provenance: { kind: 'derived', reference: 'reporting-gap-detection' },
  });

  for (const entry of simulation.ledgerEntries) {
    ledger.applyEntry(entry);
  }
  for (const status of simulation.bedStatuses) {
    ledger.applyBedStatus(status);
  }
  for (const attendance of simulation.staffAttendance) {
    ledger.applyAttendance(attendance);
  }
  for (const observation of simulation.footfall) {
    ledger.applyFootfall(observation);
  }
  for (const signal of simulation.syndromicSignals) {
    ledger.applySyndromic(signal);
  }

  return ledger;
}
