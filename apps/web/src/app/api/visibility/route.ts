import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { CRITICAL_COVER_DAYS, STALE_AFTER_DAYS } from '@civora/domain';
import type { FacilityReading, ItemPosition } from '@civora/domain';
import { getLiveStore } from '@/lib/live-store';
import {
  SESSION_COOKIE,
  canReadDistrict,
  openingDistrictFor,
  parseSession,
  scopeRefusalFor,
} from '@/lib/session';
import { tierLabelOf } from '@/lib/tiers';

/**
 * What one district looks like right now.
 *
 * The read model behind the visibility surface, and the place the platform's
 * central honesty rule is enforced: a facility the platform has not heard from
 * is reported as `never-heard` or `stale` with its figures absent, not as a
 * facility with full shelves. The rule lives in the projection; this route's job
 * is to not undo it — a facility without a reading is serialised without one
 * rather than with zeros.
 *
 * Reads are scoped to the session's district, and a district outside that scope
 * is refused rather than silently replaced with one that is inside it. The
 * refusal is an assertion in the browser journey: the demonstration opens as the
 * national control room and can be narrowed to a district officer, whose scope
 * is then enforced here.
 *
 * Subscriptions would be the natural transport once the managed adapter lands.
 * The local in-process adapter has no change feed, so the surface polls this
 * route on a short interval, and the interface says so rather than implying a
 * push that does not exist.
 */

export const dynamic = 'force-dynamic';

/** How many worst-covered items are sent per facility. */
const AT_RISK_LIMIT = 8;

interface FacilityView {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly tierLabel: string;
  readonly blockName: string;
  readonly connectivity: string;
  readonly catchmentPopulation: number;
  readonly sanctionedBeds: number;
  readonly coldChain: boolean;
  readonly reading: {
    readonly status: FacilityReading['status'];
    readonly newestReadingOn: string | null;
    readonly daysSinceReading: number | null;
    readonly daysHeard: number;
    readonly ledgerEntries: number;
    readonly beds: FacilityReading['beds'];
    readonly attendance: FacilityReading['attendance'];
    readonly footfall: FacilityReading['footfall'];
    readonly syndromic: FacilityReading['syndromic'];
    readonly recentMovements: FacilityReading['recentMovements'];
    readonly stock: {
      readonly asOf: string;
      readonly windowDays: number;
      readonly itemsTracked: number;
      readonly itemsOutOfStock: number;
      readonly itemsBelowCritical: number;
      readonly itemsWithUnknownCover: number;
      readonly atRisk: readonly ItemPosition[];
      readonly atRiskOmitted: number;
    } | null;
    readonly gap: {
      readonly count: number;
      readonly longestDays: number;
      readonly openSince: string | null;
    };
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const store = await getLiveStore();
  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  // A request that names no district opens where the session's scope is, so a
  // scoped reader is not refused for having asked for nothing.
  const requested = request.nextUrl.searchParams.get('districtId');
  const districtId = requested ?? openingDistrictFor(session, store.scope, store.defaultDistrictId);

  const district = store.dataset.network.districts.find((candidate) => candidate.id === districtId);
  if (district === undefined) {
    return NextResponse.json(
      { outcome: 'refused', reason: 'unknown-district', detail: `no such district: ${districtId}` },
      { status: 404 },
    );
  }

  if (!canReadDistrict(session, district.id, store.scope)) {
    return NextResponse.json(
      {
        outcome: 'refused',
        reason: 'out-of-scope',
        detail: scopeRefusalFor(session, 'district'),
        districtId: district.id,
      },
      { status: 403 },
    );
  }

  const region = store.dataset.network.regions.find(
    (candidate) => candidate.id === district.regionId,
  );
  const blockNameOf = new Map(store.dataset.network.blocks.map((block) => [block.id, block.name]));

  const facilities: FacilityView[] = store.dataset.network.facilities
    .filter((facility) => facility.districtId === district.id)
    .map((facility) => {
      const reading = store.ledger.readingFor(facility.id);
      const stock = reading.stock;

      return {
        id: facility.id,
        name: facility.name,
        tier: facility.tier,
        tierLabel: tierLabelOf(facility.tier),
        blockName: blockNameOf.get(facility.blockId) ?? facility.blockId,
        connectivity: facility.connectivity,
        catchmentPopulation: facility.catchmentPopulation,
        sanctionedBeds: facility.sanctionedBeds,
        coldChain: facility.coldChain.available,
        reading: {
          status: reading.status,
          newestReadingOn: reading.newestReadingOn,
          daysSinceReading: reading.daysSinceReading,
          daysHeard: reading.daysHeard,
          ledgerEntries: reading.ledgerEntries,
          recentMovements: reading.recentMovements,
          beds: reading.beds,
          attendance: reading.attendance,
          footfall: reading.footfall,
          syndromic: reading.syndromic,
          stock:
            stock === null
              ? null
              : {
                  asOf: stock.asOf,
                  windowDays: stock.windowDays,
                  itemsTracked: stock.itemsTracked,
                  itemsOutOfStock: stock.itemsOutOfStock,
                  itemsBelowCritical: stock.itemsBelowCritical,
                  itemsWithUnknownCover: stock.itemsWithUnknownCover,
                  atRisk: stock.items.slice(0, AT_RISK_LIMIT),
                  atRiskOmitted: Math.max(0, stock.items.length - AT_RISK_LIMIT),
                },
          gap: {
            count: reading.gaps.length,
            longestDays: reading.gaps.reduce((longest, gap) => Math.max(longest, gap.days), 0),
            openSince: reading.gaps.find((gap) => gap.to === null)?.from ?? null,
          },
        },
      };
    })
    // Attention first: what the platform cannot see is at the top of the list,
    // because that is what an officer has to act on. Then by name, so the order
    // within a status is stable.
    .sort((left, right) => {
      const rank = STATUS_RANK[left.reading.status] - STATUS_RANK[right.reading.status];
      return rank !== 0 ? rank : left.name < right.name ? -1 : 1;
    });

  // The overview is scoped too: a district officer is not shown the rest of the
  // country as a list they cannot open, because a list is disclosure.
  const readableDistricts = store.dataset.network.districts.filter((candidate) =>
    canReadDistrict(session, candidate.id, store.scope),
  );

  const districtSummaries = readableDistricts.map((candidate) => {
    const inDistrict = store.dataset.network.facilities.filter(
      (facility) => facility.districtId === candidate.id,
    );
    let heard = 0;
    let stale = 0;
    for (const facility of inDistrict) {
      const status = store.ledger.readingFor(facility.id).status;
      if (status !== 'never-heard') {
        heard += 1;
      }
      if (status === 'stale') {
        stale += 1;
      }
    }
    const regionOfDistrict = store.dataset.network.regions.find(
      (each) => each.id === candidate.regionId,
    );
    return {
      id: candidate.id,
      name: candidate.name,
      regionName: regionOfDistrict?.name ?? candidate.regionId,
      facilities: inDistrict.length,
      heard,
      stale,
      neverHeard: inDistrict.length - heard,
    };
  });

  return NextResponse.json({
    session: { role: session.role, label: session.label, scopeId: session.scopeId },
    district: {
      id: district.id,
      name: district.name,
      regionName: region?.name ?? district.regionId,
      population: district.population,
    },
    facilities,
    districts: districtSummaries,
    thresholds: { staleAfterDays: STALE_AFTER_DAYS, criticalCoverDays: CRITICAL_COVER_DAYS },
    ledger: {
      asOf: store.ledger.asOf(),
      windowDays: store.dataset.simulation.counts.days,
    },
    store: {
      seed: store.info.seed,
      fingerprint: store.info.fingerprint,
      documents: store.info.documents,
      window: store.info.window,
      scenarioId: store.info.scenarioId,
      scenarioLabel: store.info.scenarioLabel,
      negativeControl: store.info.negativeControl,
      facilities: store.info.facilities,
      facilitiesWithHistory: store.info.facilitiesWithHistory,
    },
    // Every figure above is derived from generated data, except the captures
    // that arrive through this platform's own ingest boundary in the course of
    // a demonstration — and those are labelled simulated as they are stored.
    simulated: true,
  });
}

const STATUS_RANK: Readonly<Record<FacilityReading['status'], number>> = {
  'never-heard': 0,
  stale: 1,
  current: 2,
};
