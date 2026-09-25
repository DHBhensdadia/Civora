import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import {
  districtIdNamed,
  facilityOfTier,
  readCatalogue,
  readVisibility,
  today,
  unambiguousCatalogueItem,
} from './support';
import type { CatalogueItem, FacilityView } from './support';

/**
 * Photographs into ledger lines, in a browser.
 *
 * The phase's blocking requirement for this flow is a negative one: a poor
 * photograph must produce review-queue entries rather than ledger writes. So the
 * reading these journeys submit is deliberately bad — a smudged name with no
 * batch, and a complete line the reader was unsure of — and what is asserted is
 * first that *nothing* from it reached the ledger, then that a person can rescue
 * a line without the platform ever writing one it cannot stand behind.
 *
 * The reading is supplied to the endpoint rather than read by a model, and that
 * is stated rather than disguised: there is no Gemini key in this build, so the
 * configured provider refuses every request, and the last journey asserts that
 * refusal rather than working around it. What is verified here is everything
 * downstream of the reading — the threshold, the routing, the queue, the person's
 * corrections, and `captureSource: 'vision'` on the records that are finally
 * stored. What is *not* verified is a model reading a photograph, and no fixture
 * is invented to pretend otherwise.
 *
 * One case is covered by unit tests and not here, deliberately: an *ambiguous*
 * name. The demonstration catalogue is the national essential medicines list,
 * which stocks each generic name at exactly one strength — so the queue's
 * candidate list cannot be produced from real data, and the matcher's ambiguity
 * rule is asserted against a catalogue built for it in
 * `packages/domain/src/logic/match.test.ts` instead of being faked here.
 *
 * The journeys share one server and one queue, so they run in order.
 */

test.describe.configure({ mode: 'serial' });

const DISTRICT = 'Pune';
const REGISTER_DAY = today();

/** A register line as the extraction contract defines it. */
const aLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemName: 'Paracetamol 500 mg Tab',
  quantity: 10,
  unit: 'Tabs',
  batchId: 'e2e-batch',
  expiresOn: '2027-12-31',
  confidence: 0.95,
  note: null,
  ...overrides,
});

interface VisionView {
  readonly outcome: string;
  readonly written: number;
  readonly held: number;
  readonly source: string;
  readonly threshold: number;
  readonly batch: {
    readonly id: string;
    readonly receivedAt: string;
    readonly lines: readonly {
      readonly index: number;
      readonly itemName: string | null;
      readonly reasons: readonly string[];
      readonly decision: string;
      readonly receipt: { readonly idempotencyKey: string } | null;
    }[];
  };
}

const readFacility = async (
  request: APIRequestContext,
  district: string,
  facility: string,
): Promise<FacilityView> => {
  const payload = await readVisibility(request, { districtId: district });
  const found = payload.facilities.find((candidate) => candidate.id === facility);

  if (found === undefined) {
    throw new Error(`the district read does not hold facility ${facility}`);
  }
  return found;
};

const visionMovements = (facility: FacilityView): FacilityView['reading']['recentMovements'] =>
  facility.reading.recentMovements.filter((line) => line.captureSource === 'vision');

let districtId: string;
let facilityId: string;
let catalogue: readonly CatalogueItem[];
let unambiguous: CatalogueItem;
let matched: string;

test.describe('reading a paper register', () => {
  test('a poor reading is queued rather than written', async ({ request }) => {
    districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');
    facilityId = facility.id;

    catalogue = await readCatalogue(request);
    unambiguous = unambiguousCatalogueItem(catalogue);
    matched = `${unambiguous.name} ${unambiguous.strength}`;

    // The facility's own record first. The seeded ledger was generated rather
    // than captured, so a movement captured by vision stands out from every one
    // already there — which is what makes the negative half of this test mean
    // something.
    const before = visionMovements(await readFacility(request, districtId, facilityId));
    expect(before.some((line) => line.itemId === unambiguous.id)).toBe(false);

    const response = await request.post('/api/vision', {
      data: {
        facilityId,
        extraction: {
          facilityName: facility.name,
          registerDate: REGISTER_DAY,
          lines: [
            // The bad half of the page: nothing matches the name, no batch, no
            // expiry, and the reader was not sure of it either.
            aLine({
              itemName: 'Smudged entry',
              quantity: 7,
              batchId: null,
              expiresOn: null,
              confidence: 0.31,
              note: 'the page was folded over this row',
            }),
            // A real medicine, complete on the page, but read without confidence.
            aLine({ itemName: matched, quantity: 11, unit: unambiguous.unit, confidence: 0.52 }),
            // The good half: confident, complete, and resolvable.
            aLine({ itemName: matched, quantity: 13, unit: unambiguous.unit, confidence: 0.97 }),
          ],
          notes: ['the right-hand column is cut off'],
        },
      },
    });

    expect(response.status()).toBe(200);
    const reading = (await response.json()) as VisionView;

    expect(reading.source).toBe('supplied');
    expect(reading.written).toBe(1);
    expect(reading.held).toBe(2);
    expect(reading.threshold).toBeGreaterThan(0);

    const held = reading.batch.lines.filter((line) => line.decision === 'pending');
    expect(held).toHaveLength(2);
    expect(held.map((line) => line.reasons)).toEqual([
      ['low-confidence', 'item-unmatched', 'batch-not-read', 'expiry-not-read'],
      ['low-confidence'],
    ]);
    // Nothing held has a receipt, because nothing held was written.
    expect(held.every((line) => line.receipt === null)).toBe(true);

    // The one line the platform could stand behind reached the ledger, and the
    // record says a photograph produced it rather than a person typing.
    const captured = visionMovements(await readFacility(request, districtId, facilityId));
    const writtenLine = captured.find((line) => line.itemId === unambiguous.id);
    expect(writtenLine?.quantity).toBe(13);
    expect(writtenLine?.kind).toBe('receipt');

    // And the quantities on the page that nobody has resolved are absent from
    // what the facility recorded. This is the phase's blocking requirement,
    // asserted against the ledger rather than against the platform's own report.
    expect(captured.some((line) => line.quantity === 7)).toBe(false);
    expect(captured.some((line) => line.quantity === 11)).toBe(false);
  });

  test('the queue shows what was held, and why, beside what was written', async ({ page }) => {
    await page.goto('/vision');

    // The screen states which reader is behind it and what the threshold is,
    // rather than showing a reader that is not there.
    await expect(page.getByTestId('provider-state')).toContainText('fixture');
    await expect(page.getByTestId('provider-state')).toContainText('0.80');

    const written = page.getByTestId('vision-written-line');
    await expect(written).toHaveCount(1);
    await expect(written.first()).toContainText('AI-extracted');
    await expect(written.first()).toContainText(unambiguous.name);
    await expect(written.first()).toContainText('13');
    await expect(written.first()).toHaveAttribute('data-provenance', 'vision');

    const heldLines = page.getByTestId('vision-held-line');
    await expect(heldLines).toHaveCount(2);
    await expect(heldLines.first()).toHaveAttribute(
      'data-reasons',
      'low-confidence,item-unmatched,batch-not-read,expiry-not-read',
    );
    await expect(heldLines.first()).toContainText('read at low confidence');
    // The page's own doubt is repeated to the reader rather than kept in the API.
    await expect(page.getByText('the page was folded over this row')).toBeVisible();
  });

  test('a line a person confirms is written, and a line still missing its batch is not', async ({
    page,
    request,
  }) => {
    await page.goto('/vision');

    const heldLines = page.getByTestId('vision-held-line');

    // The complete line the reader was unsure of: confirming it is the whole
    // decision, and it is written as read.
    await heldLines.nth(1).getByRole('button', { name: 'Accept into the ledger' }).click();
    await expect(page.getByTestId('vision-held-line')).toHaveCount(1);
    await expect(page.getByTestId('vision-written-line')).toHaveCount(2);

    // The smudged line is a different matter: approving it changes nothing the
    // platform can stand behind, and it says so rather than writing a movement
    // with no batch behind it.
    const smudged = page.getByTestId('vision-held-line').first();
    await smudged.getByRole('button', { name: 'Accept into the ledger' }).click();
    await expect(page.getByTestId('vision-refusal')).toContainText('batch-not-read');
    await expect(page.getByTestId('vision-held-line')).toHaveCount(1);

    const captured = visionMovements(await readFacility(request, districtId, facilityId));
    const confirmed = captured.find((line) => line.quantity === 11);
    expect(confirmed?.captureSource).toBe('vision');
    expect(confirmed?.itemName).toBe(unambiguous.name);
    // Still nothing written for the line that is missing its batch.
    expect(captured.some((line) => line.quantity === 7)).toBe(false);
  });

  test('a person supplies what the page did not say, and the line is written', async ({
    page,
    request,
  }) => {
    await page.goto('/vision');

    const smudged = page.getByTestId('vision-held-line').first();

    // Nothing matched the name, so the queue offers the whole catalogue: the
    // person looking at the page is the authority for which medicine it was.
    await smudged.getByLabel('Catalogue entry for line 0').selectOption({ index: 0 });
    await smudged.getByLabel('Batch for line 0').fill('e2e-batch-recovered');
    await smudged.getByLabel('Expiry for line 0').fill('2027-06-30');
    await smudged.getByRole('button', { name: 'Accept into the ledger' }).click();

    await expect(page.getByTestId('vision-empty-queue')).toBeVisible();
    await expect(page.getByTestId('vision-written-line')).toHaveCount(3);

    const captured = visionMovements(await readFacility(request, districtId, facilityId));
    const recovered = captured.find((line) => line.quantity === 7);
    expect(recovered?.captureSource).toBe('vision');
    expect(recovered?.itemId).toBe(catalogue[0]?.id);
  });

  test('the button that would read a photograph says it cannot', async ({ page }) => {
    await page.goto('/vision');

    // No key is configured in this build, so the reasoning provider has nothing
    // to answer with. The platform refuses the read instead of writing anything
    // from a photograph it never read — and the screen says which reader is
    // missing rather than showing one that is not there.
    // Exact, because this page has a section named "Photograph" and another
    // named "Written from a photograph" — the label matcher is a substring
    // match by default and would resolve to three elements.
    await page.getByLabel('Register photograph', { exact: true }).setInputFiles({
      name: 'register.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not really a register'),
    });
    await page.getByRole('button', { name: 'Read the photograph' }).click();

    await expect(page.getByTestId('vision-refusal')).toContainText('no recorded response');
    await expect(page.getByTestId('vision-written-line')).toHaveCount(3);
  });

  test('the movement a photograph produced reads back as extracted, not as typed', async ({
    page,
  }) => {
    // The ledger field the API assertions above check is what the badge on the
    // district surface is built from. Reading it back here is the point of the
    // label: an officer looking at a facility's recent movements can tell a
    // photographed entry from one a person typed, without opening the ledger.
    await page.goto('/visibility');
    await page.getByLabel('District', { exact: true }).selectOption(districtId);

    const captured = page
      .getByTestId('movement-row')
      .filter({ has: page.getByText('Extracted · vision') });
    await expect(captured.first()).toHaveAttribute('data-capture', 'vision');
    // One of them names the medicine this register carried.
    await expect(captured.filter({ hasText: unambiguous.name }).first()).toBeVisible();
  });
});
