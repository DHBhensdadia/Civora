import type { Item, Syndrome } from '../model';
import type { SurgeDetection } from './surge';

/**
 * Turning an epidemic signal into a number an order can be placed against.
 *
 * The chain is: excess cases per day → units per case → units per day → a
 * multiplier on the item's own routine demand. Every link is recorded, because
 * the output of this module is the difference between a pharmacist ordering
 * three weeks of paracetamol and ordering seven, and a multiplier nobody can
 * decompose is a multiplier nobody should act on.
 *
 * The units-per-case figure is the roughest number in the platform. It is
 * carried on the item itself, derived in `@civora/interop` from a documented
 * table of assumptions rather than chosen here, and documented as an assumption
 * rather than as a measurement. Two consequences are stated in the code rather
 * than left to be discovered:
 *
 *  - A case that receives no dose of an item still counts as a case. So the
 *    figure is a *fraction of a unit per case*, averaged over all cases — which
 *    is why an antibiotic is 0.22 and not 10.
 *  - An item that treats no syndrome gets no lift at all. Its consumption does
 *    not follow a fever surge, and pretending it does would spread a real signal
 *    across items that have nothing to do with it.
 */

export interface DemandLiftInput {
  readonly item: Item;
  readonly syndrome: Syndrome;
  readonly detection: SurgeDetection;
  /** The item's routine demand per day, before any lift, as forecast. */
  readonly routineDailyDemand: number;
  /** First day of the horizon, as a date. */
  readonly horizonFrom: string;
  readonly horizonDays: number;
  /** Highest multiplier that will be applied. Defaults to three. */
  readonly maxMultiplier?: number;
}

export interface DemandLift {
  /** What the routine forecast per day is multiplied by. Never below one. */
  readonly multiplier: number;
  /** The surplus in units per day, before the cap. */
  readonly addedUnitsPerDay: number;
  /** Horizon days the multiplier applies over; zero when it does not apply. */
  readonly daysApplied: number;
  readonly surgeSensitive: boolean;
  /** True when the cap bound, so the surplus is understated. */
  readonly capped: boolean;
  /** One sentence a reader can check against the numbers above. */
  readonly reason: string;
}

const DEFAULT_MAX_MULTIPLIER = 3;

export function demandLiftFor(input: DemandLiftInput): DemandLift {
  const { item, syndrome, detection, routineDailyDemand } = input;
  const maxMultiplier = input.maxMultiplier ?? DEFAULT_MAX_MULTIPLIER;

  if (!detection.detected) {
    return {
      multiplier: 1,
      addedUnitsPerDay: 0,
      daysApplied: 0,
      surgeSensitive: false,
      capped: false,
      reason: `no surge was detected in ${syndrome} reports`,
    };
  }

  if (!item.syndromes.includes(syndrome)) {
    return {
      multiplier: 1,
      addedUnitsPerDay: 0,
      daysApplied: 0,
      surgeSensitive: false,
      capped: false,
      reason: `${item.genericName} does not treat ${syndrome}, so its consumption does not follow this signal`,
    };
  }

  if (item.unitsPerCase <= 0) {
    return {
      multiplier: 1,
      addedUnitsPerDay: 0,
      daysApplied: 0,
      surgeSensitive: true,
      capped: false,
      reason: `${item.genericName} treats ${syndrome} but has no documented units per case, so no lift is applied`,
    };
  }

  const addedUnitsPerDay = detection.excessCasesPerDay * item.unitsPerCase;
  // The lift runs from the crossing onward, so days of the horizon before it are
  // unaffected. A surge detected before the horizon therefore covers all of it.
  const daysApplied = Math.min(input.horizonDays, Math.max(0, input.horizonDays));

  if (routineDailyDemand <= 0) {
    return {
      multiplier: 1,
      addedUnitsPerDay,
      daysApplied,
      surgeSensitive: true,
      capped: true,
      reason: `${item.genericName} has no measurable routine demand to multiply, so the ${addedUnitsPerDay.toFixed(
        1,
      )} units a day the surge adds are reported as units rather than as a ratio`,
    };
  }

  const raw = (routineDailyDemand + addedUnitsPerDay) / routineDailyDemand;
  const multiplier = Math.min(maxMultiplier, Math.max(1, raw));

  return {
    multiplier,
    addedUnitsPerDay,
    daysApplied,
    surgeSensitive: true,
    capped: raw > maxMultiplier,
    reason: `a ${syndrome} signal growing ${(detection.growthRate * 100).toFixed(
      1,
    )}% a day adds ${detection.excessCasesPerDay.toFixed(1)} cases a day, which at ${String(
      item.unitsPerCase,
    )} units a case is ${addedUnitsPerDay.toFixed(1)} units a day on top of ${routineDailyDemand.toFixed(
      1,
    )}${
      raw > maxMultiplier
        ? `; capped at ${String(maxMultiplier)}×, so the surplus above is understated`
        : ''
    }`,
  };
}
