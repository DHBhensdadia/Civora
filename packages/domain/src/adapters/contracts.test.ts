import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AuthProviderError, ReasoningProviderError } from '../errors';
import type { AuthProvider } from '../ports/auth-provider';
import type { DataProvider } from '../ports/data-provider';
import type { ReasoningProvider } from '../ports/reasoning-provider';
import { FixtureAuthProvider } from './fixture-auth-provider';
import { FixtureReasoningProvider } from './fixture-reasoning-provider';
import { InMemoryDataProvider } from './in-memory-data-provider';

const stockItemSchema = z.object({
  facilityId: z.string().min(1),
  onHand: z.number().int().nonnegative(),
});

type StockItem = z.infer<typeof stockItemSchema>;

const advisorySchema = z.object({
  facilityId: z.string().min(1),
  summary: z.string().min(1),
});

const ADVISORY_TASK = 'stock.advisory';

const createReasoningProvider = (): ReasoningProvider =>
  new FixtureReasoningProvider([
    {
      task: ADVISORY_TASK,
      value: { facilityId: 'facility-demo-0001', summary: 'Two weeks of cover remain.' },
      model: 'recorded-fixture',
    },
  ]);

/** Resolve with the thrown value so a failure can be inspected structurally. */
async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

/**
 * Behaviours every `DataProvider` must exhibit, whatever it is backed by.
 *
 * This is what makes the port a contract rather than a naming convention: an
 * adapter that stores documents but ignores validation, or pages
 * non-deterministically, fails here.
 */
async function expectDataProviderContract(provider: DataProvider): Promise<void> {
  expect(typeof provider.kind).toBe('string');
  expect(provider.kind.length).toBeGreaterThan(0);

  const stock = provider.collection<StockItem>('stock', stockItemSchema);

  await expect(stock.get('absent')).resolves.toBeNull();

  await stock.set('facility-b', { facilityId: 'facility-b', onHand: 4 });
  await stock.set('facility-a', { facilityId: 'facility-a', onHand: 12 });

  await expect(stock.get('facility-a')).resolves.toEqual({
    facilityId: 'facility-a',
    onHand: 12,
  });

  // Listings are ordered by identifier, so a cursor is meaningful.
  await expect(stock.list({ limit: 1 })).resolves.toEqual([
    { facilityId: 'facility-a', onHand: 12 },
  ]);
  await expect(stock.list({ cursor: 'facility-a' })).resolves.toEqual([
    { facilityId: 'facility-b', onHand: 4 },
  ]);

  // A document that violates the collection schema never reaches storage.
  const writeFailure = await captureFailure(
    stock.set('facility-c', { facilityId: '', onHand: -1 }),
  );
  expect(writeFailure).toBeInstanceOf(Error);
  expect((writeFailure as { issues?: readonly unknown[] }).issues).toBeInstanceOf(Array);
  await expect(stock.get('facility-c')).resolves.toBeNull();

  await stock.remove('facility-a');
  await expect(stock.get('facility-a')).resolves.toBeNull();

  await expect(provider.health()).resolves.toMatchObject({ ok: true, kind: provider.kind });
  await expect(provider.close()).resolves.toBeUndefined();
}

/** Behaviours every `AuthProvider` must exhibit. */
async function expectAuthProviderContract(provider: AuthProvider): Promise<void> {
  expect(provider.kind.length).toBeGreaterThan(0);
  await expect(provider.currentPrincipal()).resolves.toBeNull();

  const principal = await provider.signIn({
    email: 'Nurse@PHC.example',
    password: 'demo',
  });
  expect(principal).toMatchObject({
    role: 'phc_staff',
    scope: { facilityId: 'facility-demo-0001' },
  });

  // Scope is resolved by the provider, not supplied by the caller.
  expect(principal.scope.districtId).toBe('district-demo-001');
  await expect(provider.currentPrincipal()).resolves.toMatchObject({ uid: principal.uid });

  await expect(provider.signIn({ email: 'nurse@phc.example', password: '   ' })).rejects.toThrow(
    AuthProviderError,
  );
  await expect(
    provider.signIn({ email: 'unregistered@example.com', password: 'demo' }),
  ).rejects.toThrow(AuthProviderError);

  await provider.signOut();
  await expect(provider.currentPrincipal()).resolves.toBeNull();
}

/** Behaviours every `ReasoningProvider` must exhibit. */
async function expectReasoningProviderContract(provider: ReasoningProvider): Promise<void> {
  expect(provider.kind.length).toBeGreaterThan(0);

  const response = await provider.reason({
    task: ADVISORY_TASK,
    instructions: 'Summarise the stock position without introducing a quantity.',
    schema: advisorySchema,
    facts: [{ key: 'onHand', value: 12 }],
  });

  expect(response.value).toEqual({
    facilityId: 'facility-demo-0001',
    summary: 'Two weeks of cover remain.',
  });
  expect(response.provider).toBe(provider.kind);
  expect(response.model.length).toBeGreaterThan(0);

  // An unrecorded task fails rather than producing an invented answer.
  await expect(
    provider.reason({
      task: 'task.never.recorded',
      instructions: 'Anything.',
      schema: advisorySchema,
      facts: [],
    }),
  ).rejects.toThrow(ReasoningProviderError);
}

describe('local-first adapters satisfy their port contracts', () => {
  it('InMemoryDataProvider', async () => {
    await expectDataProviderContract(new InMemoryDataProvider());
  });

  it('FixtureAuthProvider', async () => {
    await expectAuthProviderContract(new FixtureAuthProvider());
  });

  it('FixtureReasoningProvider', async () => {
    await expectReasoningProviderContract(createReasoningProvider());
  });
});

describe('the adapters refuse bad input rather than degrading', () => {
  it('rejects a fixture that no longer satisfies its schema', async () => {
    const provider = new FixtureReasoningProvider([
      { task: ADVISORY_TASK, value: { facilityId: 'facility-demo-0001' } },
    ]);

    await expect(
      provider.reason({
        task: ADVISORY_TASK,
        instructions: 'Anything.',
        schema: advisorySchema,
        facts: [],
      }),
    ).rejects.toThrow(/no longer satisfies its schema/);
  });

  it('reports which tasks a fixture provider can answer', () => {
    expect(createReasoningProvider()).toMatchObject({ tasks: [ADVISORY_TASK] });
  });

  it('throws when an unknown identity is presented', async () => {
    const provider = new FixtureAuthProvider();
    await expect(provider.signIn({ email: '  ', password: 'demo' })).rejects.toThrow(
      AuthProviderError,
    );
  });
});
