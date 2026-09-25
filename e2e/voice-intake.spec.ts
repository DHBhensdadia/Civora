import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { districtIdNamed, facilityOfTier, readCatalogue, readVisibility, today } from './support';
import type { CatalogueItem, FacilityView } from './support';

/**
 * Spoken updates, in a browser, with a person in front of the ledger.
 *
 * The requirement this flow exists to satisfy is a negative one, and it is
 * asserted negatively: **nothing reaches the ledger until the person who spoke
 * has confirmed what was heard.** So each journey reads the facility's own ledger
 * around the act and asserts that the quantity nobody has confirmed is unchanged
 * — and because a movement captured by voice is the one capture source the
 * generated record never uses, "not written" is a check against the record rather
 * than against the platform's own response.
 *
 * The parse is *supplied* to the endpoint rather than made by a model, and that
 * is stated rather than disguised: there is no Gemini key in this build, so the
 * configured provider refuses every recording, and one journey asserts that
 * refusal instead of working around it. What is verified here is everything after
 * the parse — the transcript shown back, the questions the platform's own rule
 * raised, the person's answers, and `captureSource: 'voice'` on the records that
 * are finally stored. What is not verified is a model hearing a recording, and no
 * fixture is invented to pretend otherwise.
 *
 * Every journey uses a transcript and a quantity of its own. The queue and the
 * ledger are per server process and shared with whatever else is running against
 * it, and CI retries the whole file against the same server — so a journey that
 * looked for "the" pending proposal or "the" 137th unit would be reading somebody
 * else's attempt.
 */

test.describe.configure({ mode: 'serial' });

const DISTRICT = 'Pune';
const OBSERVED_ON = today();

/** A marker no other execution of this suite can produce. */
const uniqueMarker = (acting: string): string =>
  `marker-${acting}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A quantity this execution owns.
 *
 * Five digits, so the seeded record is extremely unlikely to hold it and a retry
 * cannot collide with its own earlier attempt. It is only ever compared against
 * the API and the ledger, never against the screen, because the interface renders
 * counts in the Indian grouping and `12,345` is not `12345`.
 */
const uniqueQuantity = (): number => 10_000 + Math.floor(Math.random() * 80_000);

/** A spoken update as the command contract defines it. */
const aCommand = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: 'stock_receipt',
  language: 'mr',
  transcript: 'paracetamol cheshees gobe aale',
  itemName: 'Paracetamol 500 mg Tab',
  quantity: 12,
  batchId: 'e2e-voice-batch',
  expiresOn: '2027-12-31',
  adjustmentDirection: null,
  cadre: null,
  bedsTotal: null,
  bedsOccupied: null,
  postsSanctioned: null,
  postsFilled: null,
  presentToday: null,
  confidence: 0.93,
  ambiguities: [],
  ...overrides,
});

/** An item whose spoken name the catalogue can resolve on its own. */
function unambiguousItem(catalogue: readonly CatalogueItem[]): CatalogueItem {
  const counts = new Map<string, number>();
  for (const item of catalogue) {
    const written = `${item.name} ${item.strength}`;
    counts.set(written, (counts.get(written) ?? 0) + 1);
  }

  const item = catalogue.find(
    (candidate) => counts.get(`${candidate.name} ${candidate.strength}`) === 1,
  );
  if (item === undefined) {
    throw new Error('the catalogue has no item whose written name is unambiguous');
  }
  return item;
}

interface ProposalView {
  readonly id: string;
  readonly source: string;
  readonly problems: readonly string[];
  readonly observation: string | null;
  readonly item: { readonly id: string } | null;
  readonly receipt: { readonly idempotencyKey: string } | null;
  readonly command: { readonly transcript: string };
}

interface QueueView {
  readonly proposals: readonly ProposalView[];
}

const postVoice = async (
  request: APIRequestContext,
  data: unknown,
): Promise<{
  status: number;
  body: { outcome?: string; detail?: string; proposal?: ProposalView };
}> => {
  const response = await request.post('/api/voice', { data });
  return {
    status: response.status(),
    body: (await response.json()) as { outcome?: string; detail?: string; proposal?: ProposalView },
  };
};

const readVoiceQueue = async (request: APIRequestContext): Promise<QueueView> => {
  const response = await request.get('/api/voice');
  return (await response.json()) as QueueView;
};

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

const voiceMovements = (facility: FacilityView): FacilityView['reading']['recentMovements'] =>
  facility.reading.recentMovements.filter((line) => line.captureSource === 'voice');

/** How many *spoken* movements the facility's own record holds at this quantity. */
const voiceAt = async (
  request: APIRequestContext,
  quantity: number,
): Promise<FacilityView['reading']['recentMovements']> => {
  const facility = await readFacility(request, districtId, facilityId);
  return voiceMovements(facility).filter((line) => line.quantity === quantity);
};

/** The pending proposal on the screen that carries this transcript, and nothing else. */
const pendingFor = (page: Page, transcript: string) =>
  page.getByTestId('voice-pending').filter({ hasText: transcript });

let districtId: string;
let facilityId: string;
let catalogue: readonly CatalogueItem[];
let unambiguous: CatalogueItem;

test.describe('speaking a stock update', () => {
  test('a spoken update is held for confirmation, and nothing is written yet', async ({
    request,
  }) => {
    districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');
    facilityId = facility.id;

    catalogue = await readCatalogue(request);
    unambiguous = unambiguousItem(catalogue);

    const transcript = uniqueMarker('held');
    const quantity = uniqueQuantity();
    const writtenBefore = await voiceAt(request, quantity);

    const response = await postVoice(request, {
      facilityId,
      observedOn: OBSERVED_ON,
      command: aCommand({
        transcript,
        itemName: `${unambiguous.name} ${unambiguous.strength}`,
        quantity,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('awaiting-confirmation');
    expect(response.body.proposal?.source).toBe('supplied');
    expect(response.body.proposal?.problems).toEqual([]);
    expect(response.body.proposal?.observation).toBe('stock_ledger_entry');
    // Held means held: the proposal carries no receipt, because no receipt exists.
    expect(response.body.proposal?.receipt).toBeNull();

    // And the ledger agrees. This is the assertion that matters — the platform
    // reporting that nothing was written is not evidence.
    expect(await voiceAt(request, quantity)).toEqual(writtenBefore);
  });

  test('the confirmation repeats what was heard, and the write follows a person agreeing', async ({
    page,
    request,
  }) => {
    const transcript = uniqueMarker('confirmed');
    const quantity = uniqueQuantity();

    await postVoice(request, {
      facilityId,
      observedOn: OBSERVED_ON,
      command: aCommand({
        transcript,
        itemName: `${unambiguous.name} ${unambiguous.strength}`,
        quantity,
      }),
    });

    const writtenBefore = (await readVoiceQueue(request)).proposals.filter(
      (proposal) => proposal.receipt !== null,
    ).length;

    await page.goto('/voice');

    const pending = pendingFor(page, transcript);
    await expect(pending).toHaveCount(1);

    // What was heard, verbatim — not tidied, not translated, not summarised.
    await expect(pending).toContainText(`Heard “${transcript}” (mr)`);
    // The update is named before it is written, so the person knows what they are
    // agreeing to rather than which box they are ticking.
    await expect(pending).toContainText('That would be stock arriving');
    await expect(pending).toContainText(unambiguous.name);
    // Nothing is asked, because this update is complete — and it says so.
    await expect(pending).toHaveAttribute('data-problems', '');
    await expect(pending).toContainText('Nothing is outstanding');

    // Nothing is in the record at this point, which is the state the screen is
    // asking the person to change.
    expect(await voiceAt(request, quantity)).toEqual([]);

    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();

    await expect(pendingFor(page, transcript)).toHaveCount(0);
    await expect(page.getByTestId('voice-written-line')).toHaveCount(writtenBefore + 1);
    await expect(page.getByTestId('voice-written-line').first()).toContainText('Heard ·');

    const written = await voiceAt(request, quantity);
    expect(written).toHaveLength(1);
    expect(written[0]?.itemId).toBe(unambiguous.id);
    expect(written[0]?.kind).toBe('receipt');
  });

  test('a name nothing matches is refused until a person says which medicine was meant', async ({
    page,
    request,
  }) => {
    const transcript = uniqueMarker('unmatched');
    const quantity = uniqueQuantity();

    // A name no catalogue entry can be built from. Deliberately not a real
    // medicine: the demonstration catalogue is the national essential medicines
    // list, so a plausible drug name would resolve to something, and this journey
    // is about what the platform does when nothing resolves.
    const spoken = await postVoice(request, {
      facilityId,
      observedOn: OBSERVED_ON,
      command: aCommand({
        transcript,
        itemName: 'Smudged entry, unreadable',
        quantity,
      }),
    });

    expect(spoken.status, JSON.stringify(spoken.body)).toBe(200);
    expect(spoken.body.proposal?.problems).toEqual(['item-unmatched']);
    expect(spoken.body.proposal?.item).toBeNull();

    await page.goto('/voice');
    const pending = pendingFor(page, transcript);
    await expect(pending).toHaveAttribute('data-problems', 'item-unmatched');
    await expect(pending).toContainText('no catalogue entry matches the name that was spoken');

    // Approving a name the catalogue could not resolve changes nothing about it:
    // the platform refuses with the question that is still open rather than
    // picking the closest entry and filing a quantity against it.
    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();
    await expect(page.getByTestId('voice-refusal')).toContainText('item-unmatched');
    await expect(pendingFor(page, transcript)).toHaveCount(1);
    expect(await voiceAt(request, quantity)).toEqual([]);

    // A person looking at the pack is the authority for what was meant. Nothing
    // matched, so the platform offers the whole catalogue rather than a guess.
    await pending.getByLabel(/^Catalogue entry for voice-/).selectOption({ index: 1 });
    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();

    await expect(pendingFor(page, transcript)).toHaveCount(0);

    const written = await voiceAt(request, quantity);
    expect(written).toHaveLength(1);
    expect(written[0]?.itemId).toBe(catalogue[0]?.id);
  });

  test('arriving stock with no batch is refused rather than written with one invented', async ({
    page,
    request,
  }) => {
    const transcript = uniqueMarker('batch');
    const quantity = uniqueQuantity();

    const spoken = await postVoice(request, {
      facilityId,
      observedOn: OBSERVED_ON,
      command: aCommand({
        transcript,
        itemName: `${unambiguous.name} ${unambiguous.strength}`,
        quantity,
        batchId: null,
        expiresOn: null,
      }),
    });

    expect(spoken.status, JSON.stringify(spoken.body)).toBe(200);
    expect(spoken.body.proposal?.problems).toEqual(['batch-not-heard', 'expiry-not-heard']);

    await page.goto('/voice');
    const pending = pendingFor(page, transcript);
    await expect(pending).toHaveAttribute('data-problems', 'batch-not-heard,expiry-not-heard');

    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();
    await expect(page.getByTestId('voice-refusal')).toContainText('batch-not-heard');
    expect(await voiceAt(request, quantity)).toEqual([]);

    // A person holding the pack can supply what the parse could not hear, and the
    // record is written with it. What the platform will not do is invent a lot
    // number for stock that has just arrived.
    await pending.getByLabel(/^Batch for voice-/).fill('e2e-voice-batch-2');
    await pending.getByLabel(/^Expiry for voice-/).fill('2027-06-30');
    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();

    await expect(pendingFor(page, transcript)).toHaveCount(0);

    const written = await voiceAt(request, quantity);
    expect(written).toHaveLength(1);
    expect(written[0]?.captureSource).toBe('voice');
  });

  test('a parse the speaker rejects is kept as evidence and never written', async ({
    page,
    request,
  }) => {
    const transcript = uniqueMarker('rejected');
    const quantity = uniqueQuantity();

    await postVoice(request, {
      facilityId,
      observedOn: OBSERVED_ON,
      command: aCommand({
        transcript,
        itemName: `${unambiguous.name} ${unambiguous.strength}`,
        quantity,
      }),
    });

    await page.goto('/voice');
    const pending = pendingFor(page, transcript);
    await expect(pending).toHaveCount(1);

    await pending.getByRole('button', { name: 'That is not what I said' }).click();

    await expect(pendingFor(page, transcript)).toHaveCount(0);
    // Kept, not deleted: a rejected parse is the platform's only evidence about
    // how the reader performs on real speech, and a queue that removed its own
    // mistakes could not report one.
    await expect(page.getByText('were rejected by the person who spoke')).toBeVisible();
    expect(await voiceAt(request, quantity)).toEqual([]);
  });

  test('the button that would listen says it cannot', async ({ page, request }) => {
    await page.goto('/voice');

    const facility = await readFacility(request, districtId, facilityId);
    const before = voiceMovements(facility).length;

    // No key is configured in this build, so the reasoning provider has nothing
    // to answer with. The platform refuses the recording instead of parsing it
    // from somewhere else — and the screen names the reader that is missing
    // rather than showing a microphone that is not there.
    await page.getByLabel('Voice note', { exact: true }).setInputFiles({
      name: 'report.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('not really a recording'),
    });
    await page.getByRole('button', { name: 'Listen and hold for confirmation' }).click();

    await expect(page.getByTestId('voice-refusal')).toContainText('no recorded response');
    await expect(page.getByTestId('voice-provider-state')).toContainText('fixture');

    const after = voiceMovements(await readFacility(request, districtId, facilityId));
    expect(after.length).toBe(before);
  });
});
