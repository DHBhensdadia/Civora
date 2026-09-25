import {
  REPORTING_DOMAINS,
  addDays,
  daysBetween,
  daysOfStock,
  demandRateFromLedger,
  detectReportingGaps,
  replayStockLedger,
  totalIssued,
} from '@civora/domain';
import type {
  BedStatus,
  DateOnly,
  DemandBasis,
  EssentialityTier,
  FacilityId,
  FootfallObservation,
  Item,
  ItemCategory,
  IngestRequest,
  ItemId,
  Provenance,
  ReportingGap,
  StaffAttendance,
  StockLedgerEntry,
  Syndrome,
  SyndromicSignal,
} from '@civora/domain';

/**
 * What the platform knows about a facility, derived from what it was told.
 *
 * Two writers feed this: the seed command, which replays a generated dataset
 * through it, and the ingest boundary, which replays whatever a facility
 * captures. Both write the same way — an observation in, a reading out — which
 * is why the dashboard reflects a seeded dataset and a live capture through one
 * code path rather than two.
 *
 * It is a projection, not a store: nothing here is authoritative. The ledger is
 * the record, and every figure below is derivable from it again. What the
 * projection adds is the ability to answer "what does this facility look like"
 * without re-reading a hundred thousand entries per request.
 *
 * The position a facility is *shown* in is the point of the whole exercise:
 * `current`, `stale` or `never-heard` are three genuinely different answers, and
 * a facility the platform has not heard from is not a facility with full
 * shelves. The status is computed here and rendered by every surface, so an
 * absence of data cannot be displayed as a clearance.
 */

/**
 * Days without a reading after which a facility is treated as out of contact.
 *
 * Three, because the network is expected to report daily: a facility that has
 * missed three consecutive days is not experiencing ordinary intermittent
 * connectivity, and a reading that old is not a position an officer should act
 * on without checking.
 */
export const STALE_AFTER_DAYS = 3;

/**
 * Days of cover below which an item is flagged.
 *
 * A week, which is at the short end of the modelled replenishment lead times: a
 * community health centre receives within five days, so cover below seven days
 * is where a shortfall stops being recoverable by ordering.
 */
export const CRITICAL_COVER_DAYS = 7;

/** How old a reading is, and whether that age disqualifies it. */
export const FACILITY_STATUSES = ['current', 'stale', 'never-heard'] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

/** The cover of one item at one facility. */
export interface ItemPosition {
  readonly itemId: ItemId;
  readonly name: string;
  readonly category: ItemCategory;
  readonly unit: string;
  readonly essentiality: EssentialityTier;
  readonly coldChain: boolean;
  readonly onHand: number;
  readonly inTransit: number;
  readonly issuedLast30Days: number;
  /** `null` when demand is not measurable — rendered as unknown, never as zero. */
  readonly daysOfStock: number | null;
  readonly demandBasis: DemandBasis;
  readonly lastMovementOn: DateOnly | null;
}

/** The stock picture at one facility, worst cover first. */
export interface StockPosition {
  readonly asOf: DateOnly;
  readonly windowDays: number;
  readonly itemsTracked: number;
  readonly itemsOutOfStock: number;
  readonly itemsBelowCritical: number;
  readonly itemsWithUnknownCover: number;
  /** Every tracked item, ascending by cover, with unmeasurable cover last. */
  readonly items: readonly ItemPosition[];
}

export interface BedReading {
  readonly observedOn: DateOnly;
  readonly total: number;
  readonly occupied: number;
  readonly occupancy: number;
}

export interface AttendanceReading {
  readonly observedOn: DateOnly;
  readonly sanctioned: number;
  readonly filled: number;
  readonly present: number;
  /** Present as a share of posts that are filled; null when nothing is filled. */
  readonly compliance: number | null;
}

export interface FootfallReading {
  readonly observedOn: DateOnly;
  readonly opd: number;
  readonly ipd: number;
}

export interface SyndromicReading {
  readonly observedOn: DateOnly;
  readonly cases: number;
  /** The syndromes with something to report, largest first. */
  readonly bySyndrome: readonly { readonly syndrome: Syndrome; readonly cases: number }[];
}

/** One movement, as an officer would read it off the day's book. */
export interface RecentMovement {
  readonly id: string;
  readonly itemId: ItemId;
  readonly itemName: string;
  readonly kind: string;
  readonly quantity: number;
  readonly occurredOn: DateOnly;
  readonly recordedAt: string;
  readonly captureSource: string;
}

export interface FacilityReading {
  readonly facilityId: FacilityId;
  readonly status: FacilityStatus;
  /** Newest day the platform holds any reading for, in any domain. */
  readonly newestReadingOn: DateOnly | null;
  readonly daysSinceReading: number | null;
  /** Distinct days on which something arrived. */
  readonly daysHeard: number;
  readonly ledgerEntries: number;
  readonly beds: BedReading | null;
  readonly attendance: AttendanceReading | null;
  readonly footfall: FootfallReading | null;
  readonly syndromic: SyndromicReading | null;
  /** Present only once the facility has been heard from at all. */
  readonly stock: StockPosition | null;
  /** The most recent stock movements, newest first. */
  readonly recentMovements: readonly RecentMovement[];
  /** Periods with no reading at all, oldest first. */
  readonly gaps: readonly ReportingGap[];
}

export interface LedgerServiceOptions {
  /** First day of the window a reading is judged over. */
  readonly from: DateOnly;
  /** Last day the seeded dataset describes. Readings never precede it. */
  readonly through: DateOnly;
  readonly items: readonly Item[];
  /** Days of history cover is computed over. Defaults to 90. */
  readonly windowDays?: number;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

const DEFAULT_WINDOW_DAYS = 90;

/** How many recent movements a reading carries. */
const RECENT_MOVEMENTS = 5;

/** The newest of two optional days. */
const laterOf = (left: DateOnly | null, right: DateOnly | null): DateOnly | null =>
  left === null ? right : right === null ? left : left > right ? left : right;

export class LedgerService {
  private readonly entries = new Map<FacilityId, StockLedgerEntry[]>();
  private readonly itemIds = new Map<FacilityId, Set<ItemId>>();
  private readonly heardDays = new Map<FacilityId, Set<DateOnly>>();
  private readonly newestReading = new Map<FacilityId, DateOnly>();
  private readonly beds = new Map<FacilityId, BedStatus>();
  private readonly attendance = new Map<FacilityId, StaffAttendance[]>();
  private readonly footfall = new Map<FacilityId, FootfallObservation>();
  private readonly syndromic = new Map<FacilityId, SyndromicSignal[]>();
  /** Units dispatched towards a facility and not yet received, by item. */
  private readonly inbound = new Map<FacilityId, Map<ItemId, number>>();
  private readonly stockCache = new Map<FacilityId, StockPosition>();
  private readonly readingCache = new Map<FacilityId, FacilityReading>();

  private readonly options: LedgerServiceOptions;
  private readonly itemsById = new Map<ItemId, Item>();

  constructor(options: LedgerServiceOptions) {
    this.options = options;
    for (const item of options.items) {
      this.itemsById.set(item.id, item);
    }
  }

  /** Facilities the platform has heard from at least once. */
  facilities(): readonly FacilityId[] {
    return [...this.heardDays.keys()];
  }

  /**
   * The day the platform is currently reading at.
   *
   * The seed's last day until something later arrives, and then the later day:
   * a facility capturing today's stock moves the platform's present forward
   * rather than being filed as a reading from the future.
   */
  asOf(): DateOnly {
    let newest: DateOnly | null = this.options.through;
    for (const day of this.newestReading.values()) {
      newest = laterOf(newest, day);
    }
    return newest ?? this.options.through;
  }

  /**
   * Every way in, one method per record kind.
   *
   * Typed rather than dispatched from a discriminated union, so the ingest
   * boundary and the seed command cannot pass a record under the wrong type and
   * have it silently ignored. Both caches are cleared together on every write:
   * a stock figure that survived an entry because only one of the two was
   * cleared is the kind of bug a dashboard hides until it matters.
   */
  applyEntry(entry: StockLedgerEntry): void {
    this.invalidate(entry.facilityId);
    const list = this.entries.get(entry.facilityId) ?? [];
    list.push(entry);
    this.entries.set(entry.facilityId, list);

    const itemIds = this.itemIds.get(entry.facilityId) ?? new Set<ItemId>();
    itemIds.add(entry.itemId);
    this.itemIds.set(entry.facilityId, itemIds);

    this.noteHeard(entry.facilityId, entry.occurredOn);
    this.applyTransfer(entry);
  }

  applyBedStatus(status: BedStatus): void {
    this.invalidate(status.facilityId);
    const previous = this.beds.get(status.facilityId);
    if (previous === undefined || status.observedOn >= previous.observedOn) {
      this.beds.set(status.facilityId, status);
    }
    this.noteHeard(status.facilityId, status.observedOn);
  }

  applyAttendance(attendance: StaffAttendance): void {
    this.invalidate(attendance.facilityId);
    const previous = this.attendance.get(attendance.facilityId);
    const day = previous?.[0]?.observedOn;

    // Cadre rows for one day arrive together, so a row is appended to the day
    // already held and a newer day replaces it. Keeping the newest day only is
    // deliberate: this is a projection of the current picture, and the row-by-row
    // history remains in the store for anything that needs it.
    if (previous === undefined || day === undefined || attendance.observedOn > day) {
      this.attendance.set(attendance.facilityId, [attendance]);
    } else if (attendance.observedOn === day) {
      previous.push(attendance);
    }

    this.noteHeard(attendance.facilityId, attendance.observedOn);
  }

  applyFootfall(observation: FootfallObservation): void {
    this.invalidate(observation.facilityId);
    const previous = this.footfall.get(observation.facilityId);
    if (previous === undefined || observation.observedOn >= previous.observedOn) {
      this.footfall.set(observation.facilityId, observation);
    }
    this.noteHeard(observation.facilityId, observation.observedOn);
  }

  /**
   * Apply a submission's own observation, for callers holding the envelope.
   *
   * The projection reads what was observed — the facility, the day, the counts,
   * the movement — and never the bookkeeping fields the platform stamps onto a
   * record as it stores it. So applying the submitted observation is the same
   * thing as applying the stored one, and taking the envelope here keeps the
   * dispatch type-safe instead of casting a union to whichever member the caller
   * claims it is.
   */
  applyRequest(request: IngestRequest): void {
    switch (request.type) {
      case 'stock_ledger_entry':
        this.applyEntry(request.observation);
        return;
      case 'bed_status':
        this.applyBedStatus(request.observation);
        return;
      case 'staff_attendance':
        this.applyAttendance(request.observation);
        return;
      case 'footfall_observation':
        this.applyFootfall(request.observation);
        return;
      case 'syndromic_signal':
        this.applySyndromic(request.observation);
        return;
    }
  }

  applySyndromic(signal: SyndromicSignal): void {
    this.invalidate(signal.facilityId);
    const previous = this.syndromic.get(signal.facilityId);
    const day = previous?.[0]?.observedOn;

    if (previous === undefined || day === undefined || signal.observedOn > day) {
      this.syndromic.set(signal.facilityId, [signal]);
    } else if (signal.observedOn === day) {
      previous.push(signal);
    }

    this.noteHeard(signal.facilityId, signal.observedOn);
  }

  private invalidate(facilityId: FacilityId): void {
    this.stockCache.delete(facilityId);
    this.readingCache.delete(facilityId);
  }

  private noteHeard(facilityId: FacilityId, day: DateOnly): void {
    const days = this.heardDays.get(facilityId) ?? new Set<DateOnly>();
    days.add(day);
    this.heardDays.set(facilityId, days);
    this.newestReading.set(
      facilityId,
      laterOf(this.newestReading.get(facilityId) ?? null, day) ?? day,
    );
  }

  /**
   * Keep stock in transit current as entries arrive.
   *
   * The incremental counterpart of `deriveInTransit`, which scans the whole
   * ledger to answer the same question. Both are kept, and a test asserts they
   * agree, because the scanning version is the definition and this is the
   * optimisation — an optimisation that disagrees with its definition is a
   * wrong answer delivered quickly.
   */
  private applyTransfer(entry: StockLedgerEntry): void {
    if (entry.transferId === null) {
      return;
    }

    if (entry.kind === 'transfer_out' && entry.counterpartFacilityId !== null) {
      const inbound = this.inbound.get(entry.counterpartFacilityId) ?? new Map<ItemId, number>();
      inbound.set(entry.itemId, (inbound.get(entry.itemId) ?? 0) + entry.quantity);
      this.inbound.set(entry.counterpartFacilityId, inbound);
      return;
    }

    if (entry.kind === 'transfer_in' && entry.counterpartFacilityId !== null) {
      const inbound = this.inbound.get(entry.facilityId) ?? new Map<ItemId, number>();
      inbound.set(entry.itemId, Math.max(0, (inbound.get(entry.itemId) ?? 0) - entry.quantity));
      this.inbound.set(entry.facilityId, inbound);
    }
  }

  /**
   * The stock position at a facility, or null when there is nothing to stand on.
   *
   * Items the facility holds and items dispatched towards it are both in scope,
   * and the second is not an optimisation. Stock on a truck is a fact about the
   * facility it is going to, and a facility that cannot see it orders again —
   * which is how stock ends up expiring in a store while a shelf runs empty. So
   * a facility with nothing in its ledger but a delivery on the way still has a
   * position: zero on hand, thirty in transit, and no cover figure at all.
   */
  stockFor(facilityId: FacilityId): StockPosition | null {
    const inbound = this.inbound.get(facilityId) ?? new Map<ItemId, number>();
    const tracked = new Set<ItemId>([...(this.itemIds.get(facilityId) ?? []), ...inbound.keys()]);

    if (tracked.size === 0) {
      return null;
    }

    const cached = this.stockCache.get(facilityId);
    if (cached !== undefined) {
      return cached;
    }

    const asOf = this.asOf();
    const windowDays = this.options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const from = addDays(asOf, -(windowDays - 1));
    const entries = this.entries.get(facilityId) ?? [];

    const positions: ItemPosition[] = [];
    for (const itemId of tracked) {
      const item = this.itemsById.get(itemId);
      if (item === undefined) {
        continue;
      }

      const replay = replayStockLedger(entries, facilityId, itemId, { from, to: asOf });
      const demand = demandRateFromLedger(replay.days);

      positions.push({
        itemId,
        name: item.genericName,
        category: item.category,
        unit: item.unit,
        essentiality: item.essentiality,
        coldChain: item.coldChain,
        onHand: replay.closingOnHand,
        inTransit: inbound.get(itemId) ?? 0,
        issuedLast30Days: totalIssued(replay.days.slice(-30)),
        daysOfStock: daysOfStock(replay.closingOnHand, demand.rate),
        demandBasis: demand.basis,
        lastMovementOn: replay.lastMovementOn,
      });
    }

    // Unmeasurable cover sorts last rather than first: `null` is not a small
    // number, and a list of the worst-covered items is not where an unknown
    // belongs.
    const sorted = [...positions].sort((left, right) => {
      if (left.daysOfStock === null && right.daysOfStock === null) {
        return left.name < right.name ? -1 : 1;
      }
      if (left.daysOfStock === null) {
        return 1;
      }
      if (right.daysOfStock === null) {
        return -1;
      }
      return left.daysOfStock - right.daysOfStock;
    });

    const stock: StockPosition = {
      asOf,
      windowDays,
      itemsTracked: sorted.length,
      itemsOutOfStock: sorted.filter((position) => position.onHand === 0).length,
      itemsBelowCritical: sorted.filter(
        (position) => position.daysOfStock !== null && position.daysOfStock < CRITICAL_COVER_DAYS,
      ).length,
      itemsWithUnknownCover: sorted.filter((position) => position.daysOfStock === null).length,
      items: sorted,
    };

    this.stockCache.set(facilityId, stock);
    return stock;
  }

  readingFor(facilityId: FacilityId): FacilityReading {
    const cached = this.readingCache.get(facilityId);
    if (cached !== undefined) {
      return cached;
    }

    const asOf = this.asOf();
    const newest = this.newestReading.get(facilityId) ?? null;
    const daysSinceReading = newest === null ? null : daysBetween(newest, asOf);

    const status: FacilityStatus =
      newest === null
        ? 'never-heard'
        : daysSinceReading !== null && daysSinceReading > STALE_AFTER_DAYS
          ? 'stale'
          : 'current';

    const days = [...(this.heardDays.get(facilityId) ?? [])].sort();
    const gaps = detectReportingGaps(facilityId, {
      from: this.options.from,
      to: asOf,
      reportedDays: days,
      missing: [...REPORTING_DOMAINS],
      synthetic: this.options.synthetic,
      provenance: this.options.provenance,
    });

    const attendanceRows = this.attendance.get(facilityId) ?? [];
    const attendanceDay = attendanceRows[0]?.observedOn;
    const filled = attendanceRows.reduce((total, row) => total + row.postsFilled, 0);
    const syndromicRows = this.syndromic.get(facilityId) ?? [];

    const reading: FacilityReading = {
      facilityId,
      status,
      newestReadingOn: newest,
      daysSinceReading,
      daysHeard: days.length,
      ledgerEntries: (this.entries.get(facilityId) ?? []).length,
      beds: this.bedReading(facilityId),
      attendance:
        attendanceDay === undefined
          ? null
          : {
              observedOn: attendanceDay,
              sanctioned: attendanceRows.reduce((total, row) => total + row.postsSanctioned, 0),
              filled,
              present: attendanceRows.reduce((total, row) => total + row.presentToday, 0),
              compliance:
                filled === 0
                  ? null
                  : attendanceRows.reduce((total, row) => total + row.presentToday, 0) / filled,
            },
      footfall: this.footfallReading(facilityId),
      syndromic:
        syndromicRows.length === 0
          ? null
          : {
              observedOn: syndromicRows[0]?.observedOn ?? asOf,
              cases: syndromicRows.reduce((total, row) => total + row.caseCount, 0),
              bySyndrome: [...syndromicRows]
                .map((row) => ({ syndrome: row.syndrome, cases: row.caseCount }))
                .sort(
                  (left, right) =>
                    right.cases - left.cases || (left.syndrome < right.syndrome ? -1 : 1),
                ),
            },
      stock: this.stockFor(facilityId),
      recentMovements: this.recentMovements(facilityId),
      gaps,
    };

    this.readingCache.set(facilityId, reading);
    return reading;
  }

  /**
   * The latest movements at a facility, newest first.
   *
   * What arrived most recently is the question a capture raises — did my entry
   * land, and did it land once — so it is answerable from the read model rather
   * than only from the store.
   */
  recentMovements(facilityId: FacilityId, limit = RECENT_MOVEMENTS): readonly RecentMovement[] {
    const entries = [...(this.entries.get(facilityId) ?? [])].sort((left, right) => {
      if (left.occurredOn !== right.occurredOn) {
        return left.occurredOn < right.occurredOn ? 1 : -1;
      }
      if (left.recordedAt !== right.recordedAt) {
        return left.recordedAt < right.recordedAt ? 1 : -1;
      }
      return left.id < right.id ? 1 : -1;
    });

    return entries.slice(0, limit).map((entry) => ({
      id: entry.id,
      itemId: entry.itemId,
      itemName: this.itemsById.get(entry.itemId)?.genericName ?? entry.itemId,
      kind: entry.kind,
      quantity: entry.quantity,
      occurredOn: entry.occurredOn,
      recordedAt: entry.recordedAt,
      captureSource: entry.captureSource,
    }));
  }

  private bedReading(facilityId: FacilityId): BedReading | null {
    const status = this.beds.get(facilityId);
    if (status === undefined) {
      return null;
    }
    return {
      observedOn: status.observedOn,
      total: status.bedsTotal,
      occupied: status.bedsOccupied,
      occupancy: status.bedsTotal === 0 ? 0 : status.bedsOccupied / status.bedsTotal,
    };
  }

  private footfallReading(facilityId: FacilityId): FootfallReading | null {
    const observation = this.footfall.get(facilityId);
    if (observation === undefined) {
      return null;
    }
    return {
      observedOn: observation.observedOn,
      opd: observation.opdCount,
      ipd: observation.ipdCount,
    };
  }
}
