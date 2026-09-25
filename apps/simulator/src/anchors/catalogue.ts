import type { Item, ItemCategory } from '@civora/domain';
import { parseNlemExtract } from '@civora/interop';
import type { NlemCareMarker, NlemItemRow } from '@civora/interop';

import { RETRIEVAL_DATE } from './sources';

/**
 * The item catalogue, anchored on the National List of Essential Medicines.
 *
 * The rows below are what the published list carries: a section code, a generic
 * name, a dosage form, a strength and the list's own level-of-care markers. The
 * fields it does not carry — unit of consumption, storage class, shelf life,
 * pack size and the consumption figures that turn routine prescribing and a
 * surveillance surge into a demand lift — are not written here at all. They are
 * derived by the importer in `@civora/interop`, so the catalogue the
 * demonstration runs on is produced by the same code that would consume a real
 * extract of the list. Anything else would make the importer's deployability
 * unprovable.
 *
 * One gap is deliberate: Oral Rehydration Salts are absent because their
 * section code could not be extracted from the parsed document. They are not
 * replaced with an invented code. See `sources.ts`.
 */

export type { CareLevel, ItemCategory, StorageClass } from '@civora/domain';
export {
  ROUTINE_UNITS_PER_THOUSAND_PER_DAY,
  UNITS_PER_CASE_BY_CATEGORY,
  buildCatalogue,
  parseNlemExtract,
} from '@civora/interop';

/** `section`, generic name, dosage form, strength, category, level markers. */
type ItemRow = readonly [string, string, string, string, ItemCategory, readonly NlemCareMarker[]];

/** Listed at every level of care. */
const ALL: readonly NlemCareMarker[] = ['P', 'S', 'T'];
/** Listed only where referral care is available. */
const REFERRAL: readonly NlemCareMarker[] = ['S', 'T'];

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
  ['5.1.6', 'Magnesium sulphate', 'injection', '500 mg/mL', 'maternal-health', REFERRAL],
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
  ['8.2.2', 'Heparin', 'injection', '5000 IU/mL', 'cardiovascular', REFERRAL],
  ['8.2.5', 'Tranexamic acid', 'injection', '100 mg/mL', 'maternal-health', ALL],
  ['8.2.6', 'Warfarin', 'tablet', '5 mg', 'cardiovascular', REFERRAL],
  ['10.3.1', 'Amlodipine', 'tablet', '5 mg', 'cardiovascular', ALL],
  ['10.3.2', 'Enalapril', 'tablet', '5 mg', 'cardiovascular', ALL],
  ['10.4.4', 'Noradrenaline', 'injection', '2 mg/mL', 'cardiovascular', REFERRAL],
  ['10.4.5', 'Spironolactone', 'tablet', '25 mg', 'cardiovascular', ALL],
  ['10.6.1', 'Atorvastatin', 'tablet', '10 mg', 'cardiovascular', ALL],
  ['15.1', 'Furosemide', 'oral liquid', '10 mg/mL', 'cardiovascular', ALL],
  ['16.1', 'Budesonide', 'inhaler', '100 mcg', 'other', ALL],
  ['17.1.1', 'Omeprazole', 'capsule', '20 mg', 'other', ALL],
  ['17.2.3', 'Ondansetron', 'oral liquid', '2 mg/5 mL', 'other', REFERRAL],
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
  ['22.2.2', 'Nifedipine', 'tablet', '10 mg', 'maternal-health', REFERRAL],
  ['24.1.4', 'Ipratropium', 'inhaler', '20 mcg', 'other', ALL],
  ['24.1.6', 'Salbutamol', 'inhaler', '100 mcg', 'other', ALL],
  ['25.1.5', 'Ringer lactate', 'iv fluid', 'as per IP', 'iv-fluid', ALL],
  ['26.2', 'Calcium carbonate', 'tablet', '500 mg', 'other', ALL],
  ['26.8', 'Vitamin A', 'capsule', '200 000 IU', 'other', ALL],
];

const toRow = (row: ItemRow): NlemItemRow => ({
  section: row[0],
  genericName: row[1],
  form: row[2],
  strength: row[3],
  category: row[4],
  levels: [...row[5]],
});

/**
 * The extract, in the shape an upload of the published list would arrive in.
 *
 * Built as a plain object rather than passed straight to the importer so the
 * demonstration's catalogue travels the same path as an imported file: through
 * the document schema, and out through the derivation rules.
 */
const NLEM_EXTRACT = {
  sourceId: 'nlem2022',
  title: 'National List of Essential Medicines 2022',
  retrievedOn: RETRIEVAL_DATE,
  items: ITEM_ROWS.map(toRow),
};

export const ITEMS: readonly Item[] = parseNlemExtract(NLEM_EXTRACT).items;

export const ITEM_BY_ID: ReadonlyMap<string, Item> = new Map(ITEMS.map((item) => [item.id, item]));

/** The levels of care NLEM lists an item for, in the domain's own vocabulary. */
const hasLevel = (item: Item, level: string): boolean =>
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
