import { CivoraError, itemCategorySchema, itemIdSchema, itemSchema } from '@civora/domain';
import type { CareLevel, Item, ItemCategory, StorageClass } from '@civora/domain';
import { z } from 'zod';

/**
 * The importer for the national essential medicines list.
 *
 * Every value in the catalogue has to come from somewhere, and for a health
 * domain the difference between a real one and a plausible-looking invention is
 * the difference between a submission a clinician trusts and one they do not.
 * The section codes, generic names, dosage forms, strengths and level-of-care
 * markers below are what the published list carries. Everything else — the unit
 * of consumption, the storage class, the shelf life, the pack size, and the
 * consumption figures — is derived by the documented rules in this file, and
 * each rule is an entry in the assumptions table of `docs/DATA_PROVENANCE.md`.
 *
 * This lives in `interop` rather than in the generator because it is an
 * interchange concern: the platform has to be able to consume the incumbent
 * list, and the fixture the demonstration runs on should go through exactly the
 * importer a real upload would. A generator with its own private copy of the
 * derivation would prove nothing about the deployability of the importer.
 *
 * One column is not in the published list. NLEM classifies by section, not by
 * therapeutic category, so `category` is carried in the extract as the
 * assumption it is and validated here like any other field.
 */

/** The level-of-care markers the published list uses: primary, secondary, tertiary. */
export const NLEM_CARE_MARKERS = ['P', 'S', 'T'] as const;
export const nlemCareMarkerSchema = z.enum(NLEM_CARE_MARKERS);
export type NlemCareMarker = z.infer<typeof nlemCareMarkerSchema>;

const CARE_LEVEL_BY_MARKER: Readonly<Record<NlemCareMarker, CareLevel>> = {
  P: 'primary',
  S: 'secondary',
  T: 'tertiary',
};

export const nlemItemRowSchema = z.strictObject({
  /** The section code the list prints, e.g. `2.1.5`. */
  section: z.string().trim().min(1),
  genericName: z.string().trim().min(1),
  /** Dosage form, e.g. `tablet`, `injection`, `iv fluid`. */
  form: z.string().trim().min(1),
  strength: z.string().trim().min(1),
  /** Level-of-care markers. An item listed nowhere is not a catalogue entry. */
  levels: z.array(nlemCareMarkerSchema).min(1),
  /** Therapeutic category. An assumption; see this file's header. */
  category: itemCategorySchema,
});

export type NlemItemRow = z.infer<typeof nlemItemRowSchema>;

export const nlemDocumentSchema = z.strictObject({
  /** Identifier of the source this extract came from, matching `sources.ts`. */
  sourceId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  retrievedOn: z.iso.date(),
  items: z.array(nlemItemRowSchema).min(1),
});

export type NlemDocument = z.infer<typeof nlemDocumentSchema>;

/** What an extract yields, and where it says it came from. */
export interface NlemImport {
  readonly sourceId: string;
  readonly title: string;
  readonly retrievedOn: string;
  readonly items: readonly Item[];
}

/**
 * Consumption counted in one dispensing unit, keyed by dosage form.
 * An assumption: the unit the facility's own register counts in.
 */
const UNIT_BY_FORM: Readonly<Record<string, string>> = {
  tablet: 'tablet',
  'chewable tablet': 'tablet',
  'dispersible tablet': 'tablet',
  capsule: 'capsule',
  injection: 'vial',
  'oral liquid': 'bottle',
  inhaler: 'inhaler',
  'iv fluid': 'bag',
  powder: 'sachet',
};

/** Storage class by category. Cold chain is a property of the product, not the form. */
const STORAGE_BY_CATEGORY: Readonly<Record<ItemCategory, StorageClass>> = {
  analgesic: 'ambient',
  antibiotic: 'ambient',
  antimalarial: 'ambient',
  antidiabetic: 'cool',
  cardiovascular: 'ambient',
  rehydration: 'ambient',
  vaccine: 'cold-chain',
  'iv-fluid': 'ambient',
  'maternal-health': 'ambient',
  'programme-tb': 'ambient',
  'programme-hiv': 'ambient',
  other: 'ambient',
};

/**
 * Items that must travel cold regardless of category.
 *
 * Insulin and oxytocin are the ones a broken cold chain actually ruins, and the
 * redistribution rules in Phase 6 need to know. Matched on generic name so the
 * rule survives a change to the identifier scheme.
 */
const COLD_CHAIN_GENERIC_NAMES: ReadonlySet<string> = new Set([
  'insulin (soluble)',
  'insulin glargine',
  'oxytocin',
]);

/** Shelf life in days by dosage form, from manufacture. An assumption. */
const SHELF_LIFE_BY_FORM: Readonly<Record<string, number>> = {
  tablet: 730,
  'chewable tablet': 730,
  'dispersible tablet': 730,
  capsule: 730,
  injection: 540,
  'oral liquid': 365,
  inhaler: 540,
  'iv fluid': 540,
  powder: 730,
};

/** Units per retail pack by dosage form. An assumption, used for transport capacity. */
const PACK_SIZE_BY_FORM: Readonly<Record<string, number>> = {
  tablet: 10,
  'chewable tablet': 10,
  'dispersible tablet': 10,
  capsule: 10,
  injection: 1,
  'oral liquid': 1,
  inhaler: 1,
  'iv fluid': 1,
  powder: 1,
};

/**
 * Units dispensed per reported case, averaged over the cases that receive the
 * item.
 *
 * This is the mapping that turns a syndromic surge into a demand lift, and it
 * is the roughest figure in the platform. The values are deliberately
 * fractional where they need to be: a fever case receives several paracetamol
 * but only occasionally an antibiotic, so antibiotics are counted as a fraction
 * of a unit per case rather than a whole one. Reading them as "what one patient
 * is given" would overstate antibiotic consumption tenfold and make every fever
 * surge look like a supply emergency.
 *
 * Order-of-magnitude figures, documented as assumptions; Phase 4 is where they
 * are replaced by anything better.
 */
export const UNITS_PER_CASE_BY_CATEGORY: Readonly<Record<ItemCategory, number>> = {
  analgesic: 3.5,
  antibiotic: 0.22,
  antimalarial: 0.1,
  antidiabetic: 0,
  cardiovascular: 0,
  rehydration: 2.4,
  vaccine: 0,
  'iv-fluid': 0.07,
  'maternal-health': 0,
  'programme-tb': 0,
  'programme-hiv': 0,
  other: 0,
};

/**
 * Units dispensed per 1,000 catchment population per day, before any surge.
 *
 * This is the ordinary, unremarkable consumption of a facility: the chronic
 * prescriptions, the antenatal supplements, the programme drugs. It is what a
 * facility would dispense in a quiet month, and it is separate from
 * `unitsPerCase` so that a surge adds to routine use rather than replacing it.
 *
 * Categories whose items are driven entirely by presentations (analgesics,
 * rehydration, intravenous fluids) carry no routine figure: their demand is the
 * case load, and counting it twice would flatter the surge.
 */
export const ROUTINE_UNITS_PER_THOUSAND_PER_DAY: Readonly<Record<ItemCategory, number>> = {
  analgesic: 1.2,
  antibiotic: 1.5,
  antimalarial: 0,
  antidiabetic: 7,
  cardiovascular: 9,
  rehydration: 0,
  vaccine: 1.5,
  'iv-fluid': 0,
  'maternal-health': 3.5,
  'programme-tb': 0.8,
  'programme-hiv': 0.2,
  other: 2,
};

/**
 * Syndromes whose surge lifts demand for a category, using the syndrome names
 * the domain model defines. An assumption, and the one most worth arguing with.
 */
const SYNDROMES_BY_CATEGORY: Readonly<Record<ItemCategory, readonly string[]>> = {
  analgesic: ['fever'],
  antibiotic: ['fever', 'cough'],
  antimalarial: ['fever'],
  antidiabetic: [],
  cardiovascular: [],
  rehydration: ['diarrhoea'],
  vaccine: [],
  'iv-fluid': ['diarrhoea', 'fever'],
  'maternal-health': [],
  'programme-tb': ['cough'],
  'programme-hiv': [],
  other: [],
};

/** A stable identifier from a section code and a generic name. */
const itemId = (section: string, genericName: string): string =>
  `nlem-${section.replace(/\./g, '-')}-${genericName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * Turn one row of the published list into a catalogue entry.
 *
 * Everything the list does not state is derived here rather than typed per
 * item, so the assumptions stay in one place a reviewer can read instead of
 * being scattered across seventy rows.
 */
export const buildItem = (row: NlemItemRow): Item => {
  const coldChain =
    STORAGE_BY_CATEGORY[row.category] === 'cold-chain' ||
    COLD_CHAIN_GENERIC_NAMES.has(row.genericName.toLowerCase());
  const syndromes = SYNDROMES_BY_CATEGORY[row.category];

  return itemSchema.parse({
    id: itemIdSchema.parse(itemId(row.section, row.genericName)),
    nlemCode: row.section,
    genericName: row.genericName,
    form: row.form,
    strength: row.strength,
    unit: UNIT_BY_FORM[row.form] ?? 'unit',
    category: row.category,
    essentiality: row.category === 'programme-tb' ? 'programme' : 'essential',
    careLevels: row.levels.map((marker) => CARE_LEVEL_BY_MARKER[marker]),
    storage: coldChain ? 'cold-chain' : STORAGE_BY_CATEGORY[row.category],
    coldChain,
    shelfLifeDays: SHELF_LIFE_BY_FORM[row.form] ?? 540,
    packSize: PACK_SIZE_BY_FORM[row.form] ?? 1,
    unitsPerCase: syndromes.length === 0 ? 0 : UNITS_PER_CASE_BY_CATEGORY[row.category],
    syndromes,
    synthetic: true,
    provenance: { kind: 'source', reference: 'nlem2022' },
  });
};

/** Build the catalogue from rows already in the document's shape. */
export const buildCatalogue = (rows: readonly NlemItemRow[]): readonly Item[] =>
  rows.map((row) => buildItem(row));

/**
 * Parse an extract of the published list.
 *
 * Takes `unknown` rather than a typed value on purpose: the caller is a file
 * upload, a fixture, or a fetch, and none of those are trustworthy. A document
 * that does not match the extract's shape is refused with the failing paths
 * named, rather than half-imported — a catalogue that is silently missing four
 * items because their section codes were formatted differently is worse than no
 * catalogue, because nothing downstream can tell.
 */
export function parseNlemExtract(document: unknown): NlemImport {
  const parsed = nlemDocumentSchema.safeParse(document);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CivoraError(
      `the essential medicines extract is not in a recognised shape — ${detail}`,
    );
  }

  return {
    sourceId: parsed.data.sourceId,
    title: parsed.data.title,
    retrievedOn: parsed.data.retrievedOn,
    items: buildCatalogue(parsed.data.items),
  };
}
