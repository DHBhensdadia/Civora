import type { Item } from '@civora/domain';
import { itemSchema, itemIdSchema } from '@civora/domain';

/**
 * The item catalogue, anchored on the National List of Essential Medicines.
 *
 * Section codes, generic names and dosage forms are read from the NLEM 2022
 * document recorded in `sources.ts`, as are the level-of-care markers: an item
 * NLEM marks `P` is one a primary-level facility is expected to hold, which is
 * what decides whether a sub-centre or a primary health centre stocks it.
 *
 * The fields NLEM does not carry — unit of consumption, shelf life, pack size,
 * storage class, and the consumption figures that turn routine prescribing and
 * a surveillance surge into a demand lift — are derived by the documented rules
 * below rather than typed in per item. Deriving them keeps the assumptions in
 * one readable place instead of scattered across fifty rows, and every
 * derivation is listed in the assumptions table of `docs/DATA_PROVENANCE.md`.
 * The consumption figures are exported because the behavioural model in
 * `behaviour.ts` is the only place they are read.
 *
 * One gap is deliberate: Oral Rehydration Salts are absent because their
 * section code could not be extracted from the parsed document. They are not
 * replaced with an invented code. See `sources.ts`.
 */

export type CareLevel = 'primary' | 'secondary' | 'tertiary';
export type ItemCategory = Item['category'];
export type StorageClass = Item['storage'];

/** `code`, generic name, dosage form, strength, category, NLEM level markers. */
type ItemRow = readonly [string, string, string, string, ItemCategory, readonly CareLevel[]];

const ALL: readonly CareLevel[] = ['primary', 'secondary', 'tertiary'];

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
 * is the roughest figure in the simulator. The values are deliberately
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

const ITEM_ROWS: readonly ItemRow[] = [
  ['2.1.5', 'Paracetamol', 'tablet', '500 mg', 'analgesic', ALL],
  ['2.1.3', 'Ibuprofen', 'tablet', '400 mg', 'analgesic', ALL],
  ['2.1.2', 'Diclofenac', 'tablet', '50 mg', 'analgesic', ALL],
  ['2.1.4', 'Mefenamic acid', 'tablet', '250 mg', 'analgesic', ALL],
  ['2.3.1', 'Allopurinol', 'tablet', '100 mg', 'other', ALL],
  ['3.1', 'Adrenaline', 'injection', '1 mg/mL', 'other', ALL],
  ['3.2', 'Cetirizine', 'tablet', '10 mg', 'other', ALL],
  ['3.3', 'Dexamethasone', 'tablet', '4 mg', 'other', ALL],
  ['3.4', 'Hydrocortisone', 'injection', '100 mg', 'other', ALL],
  ['3.6', 'Prednisolone', 'tablet', '20 mg', 'other', ALL],
  ['4.1.1', 'Activated charcoal', 'powder', 'as licensed', 'other', ALL],
  ['4.2.1', 'Atropine', 'injection', '0.6 mg/mL', 'other', ALL],
  ['4.2.7', 'Naloxone', 'injection', '0.4 mg/mL', 'other', ALL],
  ['5.1.1', 'Carbamazepine', 'tablet', '200 mg', 'other', ALL],
  ['5.1.3', 'Diazepam', 'injection', '5 mg/mL', 'other', ALL],
  [
    '5.1.6',
    'Magnesium sulphate',
    'injection',
    '500 mg/mL',
    'maternal-health',
    ['secondary', 'tertiary'],
  ],
  ['5.1.9', 'Phenytoin', 'tablet', '100 mg', 'other', ALL],
  ['5.2.1.1', 'Amitriptyline', 'tablet', '25 mg', 'other', ALL],
  ['6.1.1.1', 'Albendazole', 'chewable tablet', '400 mg', 'other', ALL],
  ['6.1.2.3', 'Ivermectin', 'tablet', '12 mg', 'other', ALL],
  ['6.2.1.1', 'Amoxicillin', 'capsule', '500 mg', 'antibiotic', ALL],
  ['6.2.1.6', 'Cefadroxil', 'tablet', '500 mg', 'antibiotic', ALL],
  ['6.2.1.12', 'Cloxacillin', 'capsule', '500 mg', 'antibiotic', ALL],
  ['6.2.2.1', 'Azithromycin', 'tablet', '500 mg', 'antibiotic', ALL],
  ['6.2.2.2', 'Cefuroxime', 'tablet', '250 mg', 'antibiotic', ALL],
  ['6.2.2.3', 'Ciprofloxacin', 'tablet', '500 mg', 'antibiotic', ALL],
  ['6.2.2.5', 'Clindamycin', 'capsule', '300 mg', 'antibiotic', ALL],
  ['6.2.2.7', 'Doxycycline', 'capsule', '100 mg', 'antibiotic', ALL],
  ['6.2.2.8', 'Gentamicin', 'injection', '80 mg/2 mL', 'antibiotic', ALL],
  ['6.2.2.9', 'Metronidazole', 'tablet', '400 mg', 'antibiotic', ALL],
  ['6.2.2.10', 'Nitrofurantoin', 'capsule', '100 mg', 'antibiotic', ALL],
  ['6.3.1', 'Clofazimine', 'capsule', '100 mg', 'other', ALL],
  ['6.3.2', 'Dapsone', 'tablet', '100 mg', 'other', ALL],
  ['6.4.7', 'Ethambutol', 'tablet', '800 mg', 'programme-tb', ALL],
  ['6.4.9', 'Isoniazid', 'tablet', '300 mg', 'programme-tb', ALL],
  ['6.4.14', 'Pyrazinamide', 'tablet', '1000 mg', 'programme-tb', ALL],
  ['6.4.15', 'Rifampicin', 'capsule', '450 mg', 'programme-tb', ALL],
  ['6.6.1.1', 'Acyclovir', 'tablet', '800 mg', 'other', ALL],
  ['6.10.1.2', 'Artesunate', 'tablet', '50 mg', 'antimalarial', ALL],
  ['6.10.1.4', 'Chloroquine', 'tablet', '150 mg', 'antimalarial', ALL],
  ['6.10.1.6', 'Primaquine', 'tablet', '7.5 mg', 'antimalarial', ALL],
  ['8.1.4', 'Folic acid', 'tablet', '5 mg', 'other', ALL],
  ['8.2.2', 'Heparin', 'injection', '5000 IU/mL', 'cardiovascular', ['secondary', 'tertiary']],
  ['8.2.5', 'Tranexamic acid', 'injection', '100 mg/mL', 'maternal-health', ALL],
  ['8.2.6', 'Warfarin', 'tablet', '5 mg', 'cardiovascular', ['secondary', 'tertiary']],
  ['10.3.1', 'Amlodipine', 'tablet', '5 mg', 'cardiovascular', ALL],
  ['10.3.2', 'Enalapril', 'tablet', '5 mg', 'cardiovascular', ALL],
  ['10.4.4', 'Noradrenaline', 'injection', '2 mg/mL', 'cardiovascular', ['secondary', 'tertiary']],
  ['10.4.5', 'Spironolactone', 'tablet', '25 mg', 'cardiovascular', ALL],
  ['10.6.1', 'Atorvastatin', 'tablet', '10 mg', 'cardiovascular', ALL],
  ['15.1', 'Furosemide', 'oral liquid', '10 mg/mL', 'cardiovascular', ALL],
  ['16.1', 'Budesonide', 'inhaler', '100 mcg', 'other', ALL],
  ['17.1.1', 'Omeprazole', 'capsule', '20 mg', 'other', ALL],
  ['17.2.3', 'Ondansetron', 'oral liquid', '2 mg/5 mL', 'other', ['secondary', 'tertiary']],
  ['17.6.2', 'Zinc sulphate', 'dispersible tablet', '20 mg', 'rehydration', ALL],
  ['18.3.1.2', 'Insulin (soluble)', 'injection', '40 IU/mL', 'antidiabetic', ALL],
  ['18.3.1.4', 'Insulin glargine', 'injection', '100 IU/mL', 'antidiabetic', ALL],
  ['18.3.1.6', 'Metformin', 'tablet', '1000 mg', 'antidiabetic', ALL],
  ['18.6.2', 'Levothyroxine', 'tablet', '50 mcg', 'other', ALL],
  ['19.3.9', 'Tetanus toxoid', 'injection', 'as licensed', 'vaccine', ALL],
  ['19.4.1', 'Rabies vaccine', 'injection', 'as licensed', 'vaccine', ALL],
  ['22.1.3', 'Mifepristone', 'tablet', '200 mg', 'maternal-health', ALL],
  ['22.1.4', 'Misoprostol', 'tablet', '200 mcg', 'maternal-health', ALL],
  ['22.1.5', 'Oxytocin', 'injection', '5 IU/mL', 'maternal-health', ALL],
  ['22.2.2', 'Nifedipine', 'tablet', '10 mg', 'maternal-health', ['secondary', 'tertiary']],
  ['24.1.4', 'Ipratropium', 'inhaler', '20 mcg', 'other', ALL],
  ['24.1.6', 'Salbutamol', 'inhaler', '100 mcg', 'other', ALL],
  ['25.1.5', 'Ringer lactate', 'iv fluid', 'as per IP', 'iv-fluid', ALL],
  ['26.2', 'Calcium carbonate', 'tablet', '500 mg', 'other', ALL],
  ['26.8', 'Vitamin A', 'capsule', '200 000 IU', 'other', ALL],
];

/** A stable identifier from an NLEM code and a generic name. */
const itemId = (code: string, genericName: string): string =>
  `nlem-${code.replace(/\./g, '-')}-${genericName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const buildItem = (row: ItemRow): Item => {
  const [code, genericName, form, strength, category, careLevels] = row;
  const id = itemId(code, genericName);
  const coldChain =
    STORAGE_BY_CATEGORY[category] === 'cold-chain' ||
    COLD_CHAIN_GENERIC_NAMES.has(genericName.toLowerCase());
  const syndromes = SYNDROMES_BY_CATEGORY[category];

  return itemSchema.parse({
    id: itemIdSchema.parse(id),
    nlemCode: code,
    genericName,
    form,
    strength,
    unit: UNIT_BY_FORM[form] ?? 'unit',
    category,
    essentiality: category === 'programme-tb' ? 'programme' : 'essential',
    careLevels: [...careLevels],
    storage: coldChain ? 'cold-chain' : STORAGE_BY_CATEGORY[category],
    coldChain,
    shelfLifeDays: SHELF_LIFE_BY_FORM[form] ?? 540,
    packSize: PACK_SIZE_BY_FORM[form] ?? 1,
    unitsPerCase: syndromes.length === 0 ? 0 : UNITS_PER_CASE_BY_CATEGORY[category],
    syndromes,
    synthetic: true,
    provenance: { kind: 'source', reference: 'nlem2022' },
  });
};

export const ITEMS: readonly Item[] = ITEM_ROWS.map(buildItem);

export const ITEM_BY_ID: ReadonlyMap<string, Item> = new Map(ITEMS.map((item) => [item.id, item]));

const hasLevel = (item: Item, level: CareLevel): boolean =>
  (item.careLevels as readonly string[]).includes(level);

/** The categories a community-level facility actually dispenses. An assumption. */
const COMMUNITY_CATEGORIES: ReadonlySet<ItemCategory> = new Set<ItemCategory>([
  'analgesic',
  'rehydration',
  'antibiotic',
]);

/**
 * The items a facility of a given tier is expected to hold.
 *
 * NLEM marks each item with the levels of care it belongs at, and the mapping
 * from facility tier to level is administrative rather than clinical: a primary
 * health centre is a primary-level facility, a community health centre carries
 * secondary care. The community tier carries a short list of the categories it
 * actually dispenses, which is why a sub-centre is not sent a statin it will
 * never prescribe.
 */
export function itemsForTier(tier: 'SHC' | 'AAM' | 'PHC' | 'CHC'): readonly Item[] {
  if (tier === 'CHC') {
    return ITEMS.filter((item) => hasLevel(item, 'primary') || hasLevel(item, 'secondary'));
  }

  if (tier === 'SHC' || tier === 'AAM') {
    return ITEMS.filter(
      (item) =>
        hasLevel(item, 'primary') && COMMUNITY_CATEGORIES.has(item.category) && !item.coldChain,
    );
  }

  return ITEMS.filter((item) => hasLevel(item, 'primary'));
}
