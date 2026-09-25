import { NextResponse } from 'next/server';

import { getLiveStore } from '@/lib/live-store';

/**
 * The items a capture form may name.
 *
 * Read from the same catalogue the dataset was generated against, so the item a
 * pharmacist picks is the item the ledger will hold — an identifier typed from
 * memory is how a ledger ends up with two spellings of the same medicine and its
 * stock split between them.
 *
 * The catalogue is reference data rather than observations, so it is not scoped
 * to a session: which medicines are on the national essential list is published.
 * What a district holds is not, and that lives behind the visibility read.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const store = await getLiveStore();

  return NextResponse.json({
    items: store.catalogue.map((item) => ({
      id: item.id,
      nlemCode: item.nlemCode,
      name: item.genericName,
      form: item.form,
      strength: item.strength,
      unit: item.unit,
      category: item.category,
      storage: item.storage,
      coldChain: item.coldChain,
      essentiality: item.essentiality,
      careLevels: item.careLevels,
    })),
    // The catalogue is anchored on the national essential medicines list, but
    // the labels the demonstration runs on are generated. Both facts are stated
    // here rather than left for a reader to infer from a code.
    simulated: true,
  });
}
