import { facilityIdSchema, itemIdSchema } from '../model/common';
import type { FacilityId, ItemId } from '../model/common';

/**
 * Keys for the pair a stock position is always about.
 *
 * Nearly every record in this platform is scoped to one facility and one item,
 * and most of the expensive mistakes come from pairing the wrong two. The
 * separator is a double colon because neither identifier may contain a colon.
 */
const SEPARATOR = '::';

export const facilityItemKey = (facilityId: FacilityId, itemId: ItemId): string =>
  `${facilityId}${SEPARATOR}${itemId}`;

export interface FacilityItemRef {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
}

/** Inverse of `facilityItemKey`; null when the key is not a valid pair. */
export function parseFacilityItemKey(key: string): FacilityItemRef | null {
  const parts = key.split(SEPARATOR);
  if (parts.length !== 2) {
    return null;
  }

  const [rawFacilityId, rawItemId] = parts;
  const facilityId = facilityIdSchema.safeParse(rawFacilityId);
  const itemId = itemIdSchema.safeParse(rawItemId);

  return facilityId.success && itemId.success ? { facilityId: facilityId.data, itemId: itemId.data } : null;
}
