import { CivoraError, districtIdSchema } from '@civora/domain';
import { z } from 'zod';

/**
 * The importer for the Local Government Directory's administrative units.
 *
 * Every Indian health report is filed against an LGD code: a district's HMIS
 * return is keyed by its district code, a state's by its two-digit state code.
 * The platform's own identifiers are structured but not governmental
 * (`SIM-BIHAR-GAYA-B1`), so a deployment needs a crosswalk, and this is the
 * adapter that builds one. Without it the platform can hold perfect data that
 * cannot be filed, which is the difference between a useful system and a
 * parallel one.
 *
 * The published directory is a flat table with one row per administrative unit —
 * state code and name, then district code and name, then sub-district code and
 * name — and it is republished as units are created, which is why the extract
 * carries the date it was retrieved. The rows below are that shape. What this
 * adapter does *not* invent is a mapping: it matches names to the platform's own
 * units and reports what it could not match, in both directions, because a silent
 * zero-match import is a crosswalk that looks built and files nothing.
 *
 * Three decisions are stated rather than buried:
 *
 *  - **District names are matched case- and space-insensitively**, because a
 *    directory writes `Gaya` where a facility register writes `GAYA` and both
 *    mean the district. Aliases are not invented: `Aurangabad` and `Chhatrapati
 *    Sambhajinagar` are the same district with a new name, and guessing that is
 *    exactly the kind of decision an importer must not make for a ministry.
 *  - **Sub-districts become blocks**, which is what the platform calls that
 *    level. The mapping is one to one and named here.
 *  - **A state whose districts all fail to match is reported as a whole**, since
 *    a state that did not join at all is a different problem from a district
 *    whose name changed.
 */

/** One row of the published directory, as the extract carries it. */
export const lgdUnitSchema = z.strictObject({
  /** Two-digit state code, quoted in the source so a leading zero survives. */
  stateCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, 'a state code is two digits'),
  stateName: z.string().trim().min(1),
  /** District code, unique within the state. */
  districtCode: z.string().trim().min(1),
  districtName: z.string().trim().min(1),
  /** Sub-district (block) code, unique within the district. */
  subdistrictCode: z.string().trim().min(1),
  subdistrictName: z.string().trim().min(1),
});

export type LgdUnit = z.infer<typeof lgdUnitSchema>;

export const lgdDocumentSchema = z.strictObject({
  sourceId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  retrievedOn: z.iso.date(),
  units: z.array(lgdUnitSchema).min(1),
});

export type LgdDocument = z.infer<typeof lgdDocumentSchema>;

/**
 * Field-by-field correspondence between the published row and this platform.
 *
 * Held as a value so it cannot drift from the code: a test asserts it names every
 * field the reader reads, and `docs/INTEROP.md` prints it rather than describing
 * it in prose that ages.
 */
export const LGD_FIELD_MAPPING: readonly {
  readonly source: string;
  readonly target: string;
  readonly note: string;
}[] = [
  {
    source: 'state_code',
    target: 'lgdUnit.stateCode',
    note: 'two digits, kept as text so a leading zero survives',
  },
  {
    source: 'state_name_english',
    target: 'lgdUnit.stateName',
    note: 'matched against the platform region by name; the platform’s region is the state',
  },
  {
    source: 'district_code',
    target: 'lgdUnit.districtCode',
    note: 'the code a district’s HMIS return is keyed by',
  },
  {
    source: 'district_name_english',
    target: 'lgdUnit.districtName',
    note: 'matched to the platform district by normalised name',
  },
  {
    source: 'subdistrict_code',
    target: 'lgdUnit.subdistrictCode',
    note: 'the platform’s block level; one sub-district is one block',
  },
  {
    source: 'subdistrict_name_english',
    target: 'lgdUnit.subdistrictName',
    note: 'recorded for a deployment whose block names differ from a register’s',
  },
];

/** The normalisation two names are compared under, stated once. */
export const normalisedName = (name: string): string =>
  name.trim().toLowerCase().replaceAll(/\s+/g, ' ').replaceAll(/[.]/g, '');

/** What an extract yields: the rows, and where the file says they came from. */
export interface LgdImport {
  readonly sourceId: string;
  readonly title: string;
  readonly retrievedOn: string;
  readonly units: readonly LgdUnit[];
}

/**
 * Parse an extract of the directory.
 *
 * `unknown` rather than a typed value, because the caller is a file upload or a
 * fixture and neither is trustworthy. A document that does not match is refused
 * with the failing paths named.
 */
export function parseLgdExtract(document: unknown): LgdImport {
  const parsed = lgdDocumentSchema.safeParse(document);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CivoraError(`the administrative directory is not in a recognised shape — ${detail}`);
  }

  return {
    sourceId: parsed.data.sourceId,
    title: parsed.data.title,
    retrievedOn: parsed.data.retrievedOn,
    units: parsed.data.units,
  };
}

/** One of the platform's districts, as the crosswalk needs it. */
export interface PlatformDistrict {
  readonly id: string;
  readonly name: string;
  readonly regionId: string;
}

/** The identifier a deployment builds from the directory, for its own districts. */
export const lgdDistrictId = (stateCode: string, districtCode: string): string =>
  districtIdSchema.parse(`lgd-${stateCode}-${districtCode}`);

export interface CodesForDistrict {
  readonly districtId: string;
  readonly districtCode: string;
  readonly subdistricts: readonly { readonly code: string; readonly name: string }[];
}

export interface LgdCrosswalk {
  readonly codes: readonly CodesForDistrict[];
  /** Government units no platform district matched, by name. */
  readonly unmatchedGovernment: readonly string[];
  /** Platform districts no government unit matched, by name. */
  readonly unmatchedPlatform: readonly string[];
}

/**
 * Join the directory to the platform's districts by name.
 *
 * The report of what did not match is the point of the return value rather than
 * an afterthought: a crosswalk that silently covers four of thirty-eight
 * districts is a crosswalk that will be discovered during a reporting deadline.
 */
export function crosswalk(
  imported: LgdImport,
  districts: readonly PlatformDistrict[],
): LgdCrosswalk {
  const governmentByName = new Map<string, LgdUnit>();
  const subdistrictsByDistrict = new Map<string, { code: string; name: string }[]>();

  for (const unit of imported.units) {
    governmentByName.set(normalisedName(unit.districtName), unit);
    const collected = subdistrictsByDistrict.get(unit.districtCode) ?? [];
    collected.push({ code: unit.subdistrictCode, name: unit.subdistrictName });
    subdistrictsByDistrict.set(unit.districtCode, collected);
  }

  const codes: CodesForDistrict[] = [];
  const matched = new Set<string>();

  for (const district of [...districts].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const unit = governmentByName.get(normalisedName(district.name));
    if (unit === undefined) {
      continue;
    }
    matched.add(unit.districtCode);
    codes.push({
      districtId: district.id,
      districtCode: unit.districtCode,
      subdistricts: subdistrictsByDistrict.get(unit.districtCode) ?? [],
    });
  }

  const unmatchedPlatform = districts
    .filter((district) => governmentByName.get(normalisedName(district.name)) === undefined)
    .map((district) => district.name);

  const unmatchedGovernment = imported.units
    .filter((unit) => !matched.has(unit.districtCode))
    .map((unit) => `${unit.stateName} · ${unit.districtName}`);

  return {
    codes,
    unmatchedGovernment: [...new Set(unmatchedGovernment)].sort(),
    unmatchedPlatform: [...new Set(unmatchedPlatform)].sort(),
  };
}
