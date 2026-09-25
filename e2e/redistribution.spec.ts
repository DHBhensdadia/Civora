import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { readVisibility, sessionCookie } from './support';
import type { Session } from './support';

/**
 * The redistribution workbench, in a browser.
 *
 * Three claims are asserted here and nothing else: that a person can see the
 * plan, the four weightings and the **constraint verdict on every proposal**;
 * that the explanation beside a proposal is either written prose or the
 * writer's own refusal, never an empty space; and that a decision taken through
 * the interface is persisted with its actor, reason and moment and visible in a
 * hash-chained audit view — while decisions the rules do not allow are refused
 * rather than clamped.
 *
 * **This spec owns the proposal decisions.** The store, the plan and the audit
 * chain live in the server process, so a proposal decided here stays decided for
 * every later journey against the same server — including a CI retry. For that
 * reason every test picks the proposal it acts on from the platform's own read
 * rather than naming one, the approval test decides exactly one proposal per
 * execution, and the refusal tests take no new decision at all.
 */

test.describe.configure({ mode: 'serial' });

interface DecisionView {
  readonly decision: 'approved' | 'rejected';
  readonly by: string;
  readonly actorRole: string;
  readonly at: string;
  readonly reason: string | null;
}

interface RowView {
  readonly proposal: {
    readonly id: string;
    readonly quantity: number;
    readonly verdict: string;
    readonly expectedImpact: { readonly assumptions: readonly string[] };
  };
  readonly impact: { readonly assessment: string } | null;
  readonly donor: { readonly name: string; readonly districtId: string };
  readonly receiver: { readonly name: string; readonly districtId: string };
  readonly item: { readonly name: string };
  readonly decision: DecisionView | null;
}

interface RedistributionView {
  readonly auditEvents: readonly {
    readonly action: string;
    readonly subjectId: string;
    readonly actorUid: string;
    readonly actorRole: string;
    readonly at: string;
    readonly reason: string | null;
  }[];
  readonly rows: readonly RowView[];
  readonly strategies: readonly { readonly name: string; readonly chosen: boolean }[];
  readonly chosen: { readonly name: string; readonly decidedBy: string };
  readonly verdict: {
    readonly valid: boolean;
    readonly unchecked: readonly { readonly rule: string }[];
  };
  readonly audit: { readonly valid: boolean; readonly events: number };
}

interface RationaleSetView {
  readonly provider: string;
  readonly proposals: number;
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
}

const read = async (request: APIRequestContext): Promise<RedistributionView> => {
  const response = await request.get('/api/redistribution');
  expect(response.ok()).toBe(true);
  return (await response.json()) as RedistributionView;
};

const openWorkbench = async (page: Page): Promise<void> => {
  await page.goto('/redistribution');
  await expect(
    page.getByRole('heading', { name: 'Setu — redistribution workbench' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proposals' })).toBeVisible();
};

const AUDITOR: Session = { role: 'auditor', scopeId: null, label: 'Auditor' };

test.describe('the redistribution workbench', () => {
  test('shows the plan, its weightings, and the verdict on every proposal', async ({
    page,
    request,
  }) => {
    const payload = await read(request);
    expect(
      payload.rows.length,
      'the demonstration dataset is expected to propose transfers',
    ).toBeGreaterThan(0);

    // Reachable from the navigation, like every other surface.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Redistribution', exact: true })).toBeVisible();

    await openWorkbench(page);

    // The honesty statement is on the surface, in the interface's own words.
    // A page that shows a transfer and an approve button without it invites the
    // assumption this platform exists to refuse.
    const honesty = page.getByTestId('ui-honesty');
    await expect(honesty).toBeVisible();
    await expect(honesty).toContainText('A transfer is a proposal, not a command');
    await expect(honesty).toContainText('Nothing on this page moves stock');

    // Four weightings, exactly one chosen, and the fallback says it decided.
    await expect(page.getByTestId('strategy')).toHaveCount(payload.strategies.length);
    await expect(page.getByTestId('strategy')).toHaveCount(4);
    await expect(page.getByTestId('strategy-chosen')).toHaveCount(1);
    await expect(page.getByTestId('chosen-strategy')).toContainText(payload.chosen.name);
    await expect(page.getByTestId('chosen-strategy')).toContainText(payload.chosen.decidedBy);

    // The plan-level verdict, with anything unchecked named rather than folded
    // into "passed".
    const verdict = page.getByTestId('plan-verdict');
    await expect(verdict).toBeVisible();
    await expect(verdict).toContainText('admitted by the validator');
    await expect(verdict).toContainText('Unchecked:');
    if (payload.verdict.unchecked.length > 0) {
      await expect(verdict).toContainText(payload.verdict.unchecked[0]?.rule ?? '');
    }

    // Every proposal carries its constraint verdict on the row, not behind a
    // click — a transfer shown without one invites misplaced trust.
    await expect(page.getByTestId('proposal')).toHaveCount(payload.rows.length);
    for (const row of payload.rows) {
      const entry = page.locator(`[data-proposal="${row.proposal.id}"]`);
      await expect(entry.getByTestId('proposal-verdict')).toContainText(
        'admitted by the validator',
      );
      await expect(entry.getByTestId('proposal-verdict')).toContainText('12 rules checked');
    }

    // The impact estimate is never shown without the assumptions it was computed
    // under, and an unmeasured one says so rather than claiming a figure.
    const first = payload.rows[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const firstEntry = page.locator(`[data-proposal="${first.proposal.id}"]`);
    if (first.impact === null) {
      await expect(firstEntry.getByTestId('impact-unquantified')).toBeVisible();
    } else {
      await expect(firstEntry.getByTestId('impact-assessment')).toHaveText(first.impact.assessment);
    }
    for (const assumption of first.proposal.expectedImpact.assumptions) {
      await expect(firstEntry.getByText(assumption)).toBeVisible();
    }
  });

  test('writes an explanation per proposal, or shows the writer’s refusal', async ({
    page,
    request,
  }) => {
    const response = await request.get('/api/rationales');
    expect(response.ok()).toBe(true);
    const set = (await response.json()) as RationaleSetView;

    expect(set.proposals).toBeGreaterThan(0);
    // The whole set is attempted in one pass, before anybody opens a row.
    expect(set.attempted).toBe(set.proposals);
    expect(set.attempted).toBe(set.written + set.refused);

    await openWorkbench(page);

    if (set.written === 0) {
      // The shipping state with no key: every proposal shows the writer's own
      // sentence rather than an empty space a reader could take for agreement.
      for (const row of (await read(request)).rows) {
        await expect(
          page.locator(`[data-proposal="${row.proposal.id}"]`).getByTestId('rationale-refusal'),
        ).toContainText('no recorded response');
      }
    } else {
      await expect(page.getByTestId('proposal-rationale').first()).toContainText('cites');
    }

    // Asking the writer again is a deliberate act, and it may only be done by a
    // request that says so literally.
    const notARegen = await request.post('/api/rationales', { data: {} });
    expect(notARegen.status()).toBe(400);
    expect(await notARegen.text()).toContain('this route re-asks only when the request says so');

    await page.getByTestId('rationale-regenerate').click();
    await expect(page.getByTestId('rationale-result')).toContainText(
      `for ${String(set.proposals)} proposal(s)`,
    );
    await expect(page.getByTestId('rationale-summary')).toContainText(
      `attempted ${String(set.proposals)}`,
    );
  });

  test('approves a proposal with a reason, and the decision survives a reload', async ({
    page,
    request,
  }) => {
    const before = await read(request);
    const target = before.rows.find((row) => row.decision === null);
    expect(
      target,
      'every proposal in this process is already decided; this journey needs an undecided one',
    ).toBeDefined();
    if (target === undefined) {
      return;
    }

    await openWorkbench(page);
    const entry = page.locator(`[data-proposal="${target.proposal.id}"]`);

    // A decision with no reason is refused as a request, not recorded: an
    // approval nobody can explain afterwards is not auditable.
    await entry.getByRole('button', { name: `Approve proposal ${target.proposal.id}` }).click();
    await expect(page.getByTestId('decision-refusal')).toContainText(
      'a decision has to say why it was made',
    );

    const reason = `approved at the workbench for ${target.item.name}`;
    await entry.getByLabel(`Reason for proposal ${target.proposal.id}`).fill(reason);
    await entry.getByRole('button', { name: `Approve proposal ${target.proposal.id}` }).click();

    // The row now carries the decision, with actor, role, moment and reason.
    const decision = entry.getByTestId('proposal-decision');
    await expect(decision).toContainText('approved');
    await expect(decision).toContainText(reason);
    await expect(decision).toContainText('National control room');
    await expect(decision).toContainText('(national)');

    // The decision is on the server rather than in the page, and the audit view
    // shows it — a read taken after the write, not the write's own response.
    const after = await read(request);
    const moved = after.rows.find((row) => row.proposal.id === target.proposal.id);
    expect(moved?.decision?.decision).toBe('approved');
    expect(moved?.decision?.by).toBe('National control room');
    expect(moved?.decision?.reason).toBe(reason);
    expect(moved?.decision?.at, 'the moment of the decision is recorded').toBeTruthy();

    const event = after.auditEvents.find((candidate) => candidate.subjectId === target.proposal.id);
    expect(event?.action).toBe('transfer-proposal-approved');
    expect(event?.actorUid).toBe('National control room');
    expect(event?.actorRole).toBe('national');
    expect(event?.reason).toBe(reason);
    expect(after.audit.valid).toBe(true);

    // Visible in the audit view after a reload, not only in the response.
    await page.reload();
    await expect(page.getByTestId('audit-chain')).toContainText('The chain holds');
    const auditEntry = page
      .getByTestId('audit-event')
      .filter({ hasText: target.proposal.id })
      .first();
    await expect(auditEntry).toContainText('National control room (national)');
    await expect(auditEntry).toContainText(reason);
  });

  test('refuses decisions the rules do not allow, and changes nothing', async ({ request }) => {
    const before = await read(request);
    const decided = before.rows.find((row) => row.decision !== null);
    expect(
      decided,
      'the approval journey runs first and leaves one decision in this process',
    ).toBeDefined();
    if (decided?.decision == null) {
      return;
    }

    // An auditor reads the record and writes nothing.
    const auditor = await request.post('/api/redistribution/decision', {
      headers: { cookie: sessionCookie(AUDITOR) },
      data: {
        proposalId: decided.proposal.id,
        decision: 'rejected',
        reason: 'looks fine to me',
      },
    });
    expect(auditor.status()).toBe(403);
    expect(await auditor.text()).toContain('an auditor reads the record but does not write to it');

    // A district officer whose district is at neither end of the transfer is
    // refused at district level rather than silently allowed the reach of the
    // control room.
    const visibility = await readVisibility(request);
    const ends = new Set(
      before.rows.flatMap((row) => [row.donor.districtId, row.receiver.districtId]),
    );
    const elsewhere = visibility.districts.find((district) => !ends.has(district.id));
    if (elsewhere !== undefined) {
      const officer = await request.post('/api/redistribution/decision', {
        headers: {
          cookie: sessionCookie({
            role: 'district_officer',
            scopeId: elsewhere.id,
            label: `District officer — ${elsewhere.name}`,
          }),
        },
        data: { proposalId: decided.proposal.id, decision: 'approved', reason: 'our district' },
      });
      // Refused before the decision rule is even reached: a transfer with
      // neither end in their district is outside what this session may read.
      expect(officer.status()).toBe(403);
      expect(await officer.text()).toContain(
        'this transfer is outside the scope this session is responsible for',
      );
    }

    // A proposal is decided once. A second decision is refused with the first
    // one named, rather than overwriting it.
    const again = await request.post('/api/redistribution/decision', {
      data: {
        proposalId: decided.proposal.id,
        decision: 'rejected',
        reason: 'changed my mind',
      },
    });
    expect(again.status()).toBe(409);
    expect(await again.text()).toContain('a decision is taken once');

    // A proposal that does not exist is not a decision either.
    const unknown = await request.post('/api/redistribution/decision', {
      data: {
        proposalId: 'transfer:nowhere:nowhere:nothing:none',
        decision: 'approved',
        reason: 'for a proposal that does not exist',
      },
    });
    expect(unknown.status()).toBe(404);
    expect(await unknown.text()).toContain('no transfer proposal with the identifier');

    // Nothing the refusals touched moved: the first decision is still the one on
    // the record.
    const after = await read(request);
    const unchanged = after.rows.find((row) => row.proposal.id === decided.proposal.id);
    expect(unchanged?.decision?.decision).toBe(decided.decision.decision);
    expect(unchanged?.decision?.reason).toBe(decided.decision.reason);
    expect(unchanged?.decision?.at).toBe(decided.decision.at);
    expect(after.audit.valid).toBe(true);
    expect(after.audit.events).toBe(before.audit.events);
  });
});
