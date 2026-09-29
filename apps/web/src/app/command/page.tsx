import { cookies } from 'next/headers';
import Link from 'next/link';

import { PageHeader } from '@/components/page-header';
import { Notice, Panel, StatCard, DataTable, formatCount } from '@/components/ui';
import { ProvenancePanel } from '@/components/provenance-panel';
import { SchematicMap } from '@/components/schematic-map';
import {
  COMMAND_TIERS,
  isCommandTier,
  readCommandTower,
  readDistrictStep,
  readFacilityStep,
  readItemEvidence,
} from '@/lib/command-service';
import type { CommandTier } from '@/lib/command-service';
import { accessTo } from '@/lib/guard';
import { getLiveStore } from '@/lib/live-store';
import { PRESENTATION_COOKIE, PRESENTATION_NOTE, presentationModeFrom } from '@/lib/presentation';
import { provenanceFor } from '@/lib/provenance';
import { SESSION_COOKIE, parseSession } from '@/lib/session';

/**
 * The control tower.
 *
 * The national picture an officer opens first: stock-out risk, bed pressure and
 * reporting gaps by region, district or facility, under three controls — the
 * aggregation tier, a time window the figures are read as of, and the
 * drill-down that walks state → district → facility → item → the batch behind
 * it.
 *
 * The page **assembles** what Phases 3–7 already compute (`command-service.ts`
 * says how and why) and makes three things visible that a dashboard usually
 * hides: which renderer is drawing the map and why, which districts the session
 * is *not* shown, and where every figure came from. The drill-down is a chain of
 * links rather than client-side state, so a step is a URL a person can share, a
 * test can walk, and a refusal can be answered for — and the chain ends in
 * evidence rather than at a dead end: the movements, their batches and the
 * provenance of the record itself.
 */

export const dynamic = 'force-dynamic';

type Param = string | string[] | undefined;

const first = (value: Param): string | undefined =>
  Array.isArray(value) ? value[0] : value === undefined || value === '' ? undefined : value;

const query = (params: Record<string, string | undefined>): string => {
  const search = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&');
  return search === '' ? '' : `?${search}`;
};

const TIER_LABEL: Readonly<Record<CommandTier, string>> = {
  state: 'State',
  district: 'District',
  facility: 'Facility',
};

export default async function CommandPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, Param>>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  const session = parseSession(jar.get(SESSION_COOKIE)?.value);
  const presentation = presentationModeFrom(jar.get(PRESENTATION_COOKIE)?.value);
  const access = accessTo(session, '/command');

  if (!access.allowed) {
    return (
      <div className="flex flex-col gap-12">
        <Notice
          id="command-refused"
          tone="warning"
          title="This surface is not offered to this role"
        >
          <p>{access.refusal}</p>
          <p>
            The navigation lists what this role is offered. The refusal is the same one the API
            answers with, so a hidden address is not an open one.
          </p>
        </Notice>
      </div>
    );
  }

  const requestedTier = first(params.tier);
  const tier: CommandTier = isCommandTier(requestedTier) ? requestedTier : 'state';
  const districtId = first(params.district);
  const facilityId = first(params.facility);
  const itemId = first(params.item);

  const tower = await readCommandTower(session, { tier });
  const store = await getLiveStore();
  const districtStep =
    districtId === undefined ? null : await readDistrictStep(session, districtId);
  const facilityStep =
    districtId === undefined || facilityId === undefined
      ? null
      : await readFacilityStep(session, districtId, facilityId, itemId);
  const evidenceStep =
    districtId === undefined || facilityId === undefined || itemId === undefined
      ? null
      : await readItemEvidence(session, districtId, facilityId, itemId);

  const scopeSentence = tower.national
    ? 'This session reads every district in the demonstration network.'
    : `This session is scoped: ${formatCount(tower.counts.districts)} district(s) are read and the rest are neither counted nor shown.`;

  return (
    <div className="flex flex-col gap-12">
      <PageHeader label="National command plane" spacing="roomy" title="Control tower">
        <p className="max-w-measure text-lg text-fg-muted">
          Every figure here is assembled from the same projections the surfaces beside it read — the
          ledger, the scored population, the alert set and the seeded network. Nothing on this page
          is recomputed, so a risk score or a plan seen here is the one the intelligence surface and
          the workbench already carry.
        </p>
        <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-xs text-fg-subtle">
          <div className="flex items-baseline gap-2">
            <dt className="uppercase">As of</dt>
            <dd className="text-fg-muted">{tower.asOf}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="uppercase">Scenario</dt>
            <dd className="text-fg-muted">{tower.scenarioId}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="uppercase">Seed</dt>
            <dd className="text-fg-muted">{tower.seed}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="uppercase">Acting as</dt>
            <dd className="text-fg-muted">{session.role}</dd>
          </div>
        </dl>
        <p data-testid="command-scope" className="max-w-measure text-sm text-fg-muted">
          {scopeSentence}
        </p>
      </PageHeader>

      {presentation ? (
        <Notice id="command-presentation" tone="info" title="Presentation mode">
          <p data-testid="presentation-note">{PRESENTATION_NOTE}</p>
          <p>
            Everything on this page is read from the process's own projections; nothing here opens a
            connection. Clearing the <code>civora-presentation</code> cookie returns the platform to
            its ordinary behaviour.
          </p>
        </Notice>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Facilities read"
          value={formatCount(tower.counts.facilities)}
          hint={`${formatCount(tower.counts.districts)} districts · ${formatCount(tower.counts.regions)} regions`}
        />
        <StatCard
          label="Reporting"
          value={`${formatCount(tower.counts.heard)} / ${formatCount(tower.counts.facilities)}`}
          hint={`${formatCount(tower.counts.neverHeard)} never heard from · ${formatCount(tower.counts.stale)} stale`}
        />
        <StatCard
          label="Pairs at risk"
          value={formatCount(tower.counts.atRiskPairs)}
          hint="facility-item pairs in the risk engine's unknown, critical or high band"
        />
        <StatCard
          label="Open alerts"
          value={formatCount(tower.counts.openAlerts)}
          hint="raised, not resolved"
        />
      </section>

      <Panel
        id="tower-map"
        title="Where the risk is"
        description={
          <>
            One marker per region, sized by nothing and shaded by the same classes the legend names.
            The value is <strong>{tower.map.valueLabel}</strong> — a count of pairs the risk engine
            already put in an alerting band, read from the scored population rather than recomputed
            here.
          </>
        }
      >
        <SchematicMap id="tower-map" map={tower.map} />
      </Panel>

      <Panel
        id="tower-change"
        title="What changed on the platform's latest day"
        description={tower.change.note}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Latest day" value={tower.change.day} />
          <StatCard
            label="Movements recorded"
            value={formatCount(tower.change.movements)}
            hint={`across ${formatCount(tower.change.facilitiesReporting)} facility(s)`}
          />
          <StatCard
            label="How they arrived"
            value={
              tower.change.bySource
                .map((source) => `${source.label} ${formatCount(source.count)}`)
                .join(' · ') || 'nothing recorded'
            }
          />
        </div>
        {tower.change.sample.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No movement is recorded on that day yet. The strip fills as captures arrive.
          </p>
        ) : (
          <DataTable
            caption="The newest movements recorded on the platform's latest day"
            columns={[
              { header: 'Facility' },
              { header: 'Item' },
              { header: 'Movement' },
              { header: 'Quantity', numeric: true },
              { header: 'How it arrived' },
            ]}
            rows={tower.change.sample.map((movement) => [
              movement.facilityName,
              movement.itemName,
              movement.kind,
              formatCount(movement.quantity),
              movement.captureSource,
            ])}
          />
        )}
      </Panel>

      <Panel
        id="tower-aggregation"
        title="Aggregation"
        description={
          <>
            The same read, rolled up three ways. A tier is a URL, so a view can be linked to; the
            figures come from one scan of the projections and the rows below are already scoped to
            what this session may read.
          </>
        }
      >
        <nav aria-label="Aggregation tier" className="flex flex-wrap gap-2">
          {COMMAND_TIERS.map((option) => (
            <Link
              key={option}
              href={`/command${query({ tier: option })}`}
              aria-current={option === tier ? 'page' : undefined}
              className={
                option === tier
                  ? 'inline-flex min-h-11 items-center rounded-full border-2 border-accent bg-accent/15 px-4 text-sm text-accent'
                  : 'inline-flex min-h-11 items-center rounded-full border-2 border-ink-600 px-4 text-sm text-fg-muted transition-colors duration-150 hover:border-accent hover:text-accent'
              }
            >
              {TIER_LABEL[option]}
            </Link>
          ))}
        </nav>
        <p className="text-sm text-fg-muted">
          Reading by <span className="font-mono">{tier}</span>:{' '}
          {tier === 'state'
            ? `${formatCount(tower.regions.length)} region row(s)`
            : tier === 'district'
              ? `${formatCount(tower.districts.length)} district row(s)`
              : `${formatCount(tower.facilities.length)} facility row(s), attention first`}
          .
        </p>
        {tier === 'facility' ? (
          <DataTable
            caption="Every facility this session can read, attention first"
            columns={[
              { header: 'Facility' },
              { header: 'District' },
              { header: 'Tier' },
              { header: 'Status' },
              { header: 'Pairs at risk', numeric: true },
              { header: 'Out of stock', numeric: true },
              { header: 'Open alerts', numeric: true },
              { header: 'Drill down' },
            ]}
            rows={tower.facilities.map((fact) => [
              fact.facility.name,
              `${fact.districtName} · ${fact.regionName}`,
              fact.tierLabel,
              fact.status === 'never-heard'
                ? `never heard from (${fact.daysSinceReading ?? '—'} days)`
                : `${fact.status} · ${fact.daysSinceReading ?? '—'} days old`,
              formatCount(fact.atRiskPairs),
              formatCount(fact.itemsOutOfStock),
              formatCount(fact.openAlerts),
              <Link
                key={fact.facility.id}
                className="text-accent underline-offset-4 hover:underline"
                href={`/command${query({ tier, district: fact.districtId, facility: fact.facility.id })}`}
              >
                Open
              </Link>,
            ])}
          />
        ) : (
          <DataTable
            caption="Aggregates per region or district, with the map's own value beside them"
            columns={[
              { header: 'Level' },
              { header: 'Name' },
              { header: 'Facilities', numeric: true },
              { header: 'Never heard from', numeric: true },
              { header: 'Stale', numeric: true },
              { header: 'Pairs at risk', numeric: true },
              { header: 'Bed occupancy' },
              { header: 'Drill down' },
            ]}
            rows={(tier === 'state' ? tower.regions : tower.districts).map((row) => [
              TIER_LABEL[row.level === 'region' ? 'state' : 'district'],
              row.level === 'region' ? row.name : `${row.name} · ${row.parent ?? ''}`,
              formatCount(row.facilities),
              formatCount(row.neverHeard),
              formatCount(row.stale),
              formatCount(row.atRiskPairs),
              row.bedOccupancy === null
                ? 'no reading'
                : `${formatCount(Math.round(row.bedOccupancy * 100))}% of sanctioned beds`,
              row.level === 'region' ? (
                <span key={row.id} className="text-fg-subtle">
                  drill through its districts
                </span>
              ) : (
                <Link
                  key={row.id}
                  className="text-accent underline-offset-4 hover:underline"
                  href={`/command${query({ tier, district: row.id })}`}
                >
                  Open district
                </Link>
              ),
            ])}
          />
        )}
      </Panel>

      {districtStep !== null ? (
        <Panel
          id="tower-district"
          title={
            districtStep.allowed
              ? `${districtStep.district.name} · ${districtStep.district.regionName}`
              : 'District refused'
          }
          description={
            districtStep.allowed ? (
              <>
                The district's facilities, attention first: what the platform cannot see, then the
                worst risk. Each row opens the facility's items, and each item opens the movements
                behind its figure.{' '}
                <Link className="text-accent underline-offset-4 hover:underline" href="/visibility">
                  The visibility surface
                </Link>{' '}
                reads the same district in full.
              </>
            ) : (
              districtStep.refusal
            )
          }
        >
          {districtStep.allowed ? (
            <DataTable
              caption={`Facilities in ${districtStep.district.name}, attention first`}
              columns={[
                { header: 'Facility' },
                { header: 'Tier' },
                { header: 'Reading' },
                { header: 'Items tracked', numeric: true },
                { header: 'Pairs at risk', numeric: true },
                { header: 'Beds' },
                { header: 'Drill down' },
              ]}
              rows={districtStep.facilities.map((fact) => [
                fact.facility.name,
                fact.tierLabel,
                fact.status === 'never-heard'
                  ? 'never heard from'
                  : `read on ${fact.newestReadingOn ?? '—'}`,
                formatCount(fact.itemsTracked),
                formatCount(fact.atRiskPairs),
                fact.bedOccupancy === null
                  ? 'no reading'
                  : `${formatCount(Math.round(fact.bedOccupancy * 100))}% occupied`,
                <Link
                  key={fact.facility.id}
                  className="text-accent underline-offset-4 hover:underline"
                  href={`/command${query({
                    tier,
                    district: fact.districtId,
                    facility: fact.facility.id,
                  })}`}
                >
                  Open facility
                </Link>,
              ])}
            />
          ) : null}
        </Panel>
      ) : null}

      {facilityStep?.allowed ? (
        <Panel
          id="tower-facility"
          title={facilityStep.facility.facility.name}
          description={
            <>
              {facilityStep.facility.tierLabel} in {facilityStep.facility.districtName}. Items are
              ordered by cover, unmeasurable cover last — the same order the visibility surface
              uses. Opening an item shows the risk facts behind it and the movements it was derived
              from.{' '}
              {facilityStep.facility.status === 'never-heard'
                ? 'This facility has not been heard from, so it has no items to show rather than an empty shelf.'
                : null}
            </>
          }
        >
          <DataTable
            caption={`Items at ${facilityStep.facility.facility.name}, worst cover first`}
            columns={[
              { header: 'Item' },
              { header: 'On hand', numeric: true },
              { header: 'In transit', numeric: true },
              { header: 'Days of cover' },
              { header: 'Demand basis' },
              { header: 'Risk band' },
              { header: 'Drill down' },
            ]}
            rows={facilityStep.items.map((item) => [
              item.name,
              formatCount(item.onHand),
              formatCount(item.inTransit),
              item.daysOfStock === null ? 'unknown' : formatCount(Math.round(item.daysOfStock)),
              item.demandBasis,
              item.band ?? 'not scored',
              <Link
                key={item.itemId}
                className="text-accent underline-offset-4 hover:underline"
                href={`/command${query({
                  tier,
                  district: facilityStep.facility.districtId,
                  facility: facilityStep.facility.facility.id,
                  item: item.itemId,
                })}`}
              >
                Show the record
              </Link>,
            ])}
          />
        </Panel>
      ) : null}

      {evidenceStep !== null ? (
        <Panel
          id="tower-evidence"
          title={
            evidenceStep.allowed
              ? `${evidenceStep.item.name} · the record behind the figure`
              : 'Item refused'
          }
          description={
            evidenceStep.allowed ? (
              <>
                The last step of the drill-down, and deliberately not a summary: the day each
                movement belongs to, the day it reached the platform, the batch and its expiry, how
                it was captured and whether the record is simulated. A stock figure and a forecast
                are derivations; this is what they were derived from. The same movements are on the{' '}
                <Link className="text-accent underline-offset-4 hover:underline" href="/visibility">
                  visibility surface
                </Link>{' '}
                and the seeded records are browsable in the{' '}
                <Link className="text-accent underline-offset-4 hover:underline" href="/dataset">
                  dataset inspector
                </Link>
                .
              </>
            ) : (
              evidenceStep.refusal
            )
          }
        >
          {evidenceStep.allowed ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatCard
                  label="On hand"
                  value={formatCount(evidenceStep.item.onHand)}
                  hint={`${evidenceStep.item.unit} · ${formatCount(evidenceStep.item.inTransit)} in transit`}
                />
                <StatCard
                  label="Days of cover"
                  value={
                    evidenceStep.item.daysOfStock === null
                      ? 'unknown'
                      : formatCount(Math.round(evidenceStep.item.daysOfStock))
                  }
                  hint={`demand basis: ${evidenceStep.item.demandBasis}`}
                />
                <StatCard
                  label="Risk band"
                  value={evidenceStep.item.band ?? 'not scored'}
                  hint={
                    evidenceStep.shortfallWindowDays === null
                      ? 'no shortfall window'
                      : `shortfall in ${formatCount(evidenceStep.shortfallWindowDays)} day(s) of a ${formatCount(evidenceStep.horizonDays ?? 0)}-day horizon`
                  }
                />
              </div>

              {evidenceStep.drivers.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  The risk engine recorded no drivers for this pair, which is a result rather than a
                  gap: a pair with no drivers is a pair whose score rests on nothing.
                </p>
              ) : (
                <DataTable
                  caption="The risk drivers behind this pair's band"
                  columns={[
                    { header: 'Driver' },
                    { header: 'Contribution', numeric: true },
                    { header: 'Detail' },
                  ]}
                  rows={evidenceStep.drivers.map((driver) => [
                    driver.driver,
                    formatCount(Math.round(driver.contribution * 100)) + '%',
                    driver.detail,
                  ])}
                />
              )}

              <p data-testid="evidence-count" className="text-sm text-fg-muted">
                {formatCount(evidenceStep.movements.length)} movement(s) for this item at this
                facility, newest first; a facility with none is a facility whose every figure above
                rests on a reading from another item.
              </p>

              {evidenceStep.movements.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No movement is recorded for this pair. The position above therefore rests on the
                  facility&rsquo;s other records, and the demand basis says so.
                </p>
              ) : (
                <DataTable
                  caption="The movements behind this item's stock position"
                  columns={[
                    { header: 'Belongs to day' },
                    { header: 'Reached the platform' },
                    { header: 'Movement' },
                    { header: 'Quantity', numeric: true },
                    { header: 'Batch' },
                    { header: 'Expires' },
                    { header: 'Arrived by' },
                    { header: 'Record' },
                  ]}
                  rows={evidenceStep.movements.map((movement) => [
                    movement.occurredOn,
                    movement.recordedAt.slice(0, 19).replace('T', ' '),
                    movement.kind,
                    formatCount(movement.quantity),
                    movement.batchId ?? '—',
                    movement.expiresOn ?? '—',
                    movement.captureSource,
                    movement.synthetic ? 'simulated' : 'captured',
                  ])}
                />
              )}
            </>
          ) : null}
        </Panel>
      ) : null}

      <ProvenancePanel id="command-provenance" view={provenanceFor(store.info)} size="compact" />
    </div>
  );
}
