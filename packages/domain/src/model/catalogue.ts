import { z } from 'zod';

import { itemIdSchema, provenanceSchema, syntheticSchema } from './common';

/**
 * The item catalogue.
 *
 * Generic names, categories and essentiality come from the national essential
 * medicines list rather than being invented: a health-domain reviewer can tell,
 * and an invented drug name discredits everything around it.
 */

export const ITEM_CATEGORIES = [
  'analgesic',
  'antibiotic',
  'antimalarial',
  'antidiabetic',
  'cardiovascular',
  'rehydration',
  'vaccine',
  'iv-fluid',
  'maternal-health',
  'programme-tb',
  'programme-hiv',
  'other',
] as const;

export const itemCategorySchema = z.enum(ITEM_CATEGORIES);
export type ItemCategory = z.infer<typeof itemCategorySchema>;

/**
 * How firmly an item must be stocked.
 *
 * `essential` items are those a facility of the relevant tier is expected never
 * to be without, which is what makes their stock-out a reportable event rather
 * than a nuisance.
 */
export const ESSENTIALITY_TIERS = ['essential', 'programme', 'supplementary'] as const;
export const essentialityTierSchema = z.enum(ESSENTIALITY_TIERS);
export type EssentialityTier = z.infer<typeof essentialityTierSchema>;

/**
 * Storage requirement, which is what constrains a redistribution: a vaccine
 * cannot move to a facility with no working cold chain, however much stock it
 * is short of.
 */
export const STORAGE_CLASSES = ['ambient', 'cool', 'cold-chain'] as const;
export const storageClassSchema = z.enum(STORAGE_CLASSES);
export type StorageClass = z.infer<typeof storageClassSchema>;

/**
 * Levels of care an item belongs at.
 *
 * Taken from the level-of-care markers the national essential medicines list
 * carries against every item, which is what decides whether a sub-centre or a
 * community health centre is expected to hold it. Sending a facility an item
 * that belongs at another level is how stock expires in the wrong store.
 */
export const CARE_LEVELS = ['primary', 'secondary', 'tertiary'] as const;
export const careLevelSchema = z.enum(CARE_LEVELS);
export type CareLevel = z.infer<typeof careLevelSchema>;

export const itemSchema = z
  .strictObject({
    id: itemIdSchema,
    /** Code in the national essential medicines list this item is drawn from. */
    nlemCode: z.string().trim().min(1),
    genericName: z.string().trim().min(1),
    /** Dosage form: tablet, capsule, injection, syrup, solution. */
    form: z.string().trim().min(1),
    /** Strength as written on the label, e.g. `500 mg`. */
    strength: z.string().trim().min(1),
    /** The unit consumption is counted in. */
    unit: z.string().trim().min(1),
    category: itemCategorySchema,
    essentiality: essentialityTierSchema,
    storage: storageClassSchema,
    coldChain: z.boolean(),
    /** Levels of care the item is listed for. At least one. */
    careLevels: z.array(careLevelSchema).min(1),
    /**
     * Shelf life from manufacture to expiry. Consumption and expiry maths use
     * the remaining shelf life of a batch, not this value.
     */
    shelfLifeDays: z.int().positive(),
    packSize: z.int().positive(),
    /**
     * Units consumed per case of the condition this item treats.
     *
     * This is the mapping that turns a surveillance surge into a demand lift.
     * It is a stated, citable assumption for every item: see
     * `docs/DATA_PROVENANCE.md`. Zero means the item is not surge-sensitive.
     */
    unitsPerCase: z.number().nonnegative(),
    /** Conditions this item is dispensed for, by syndrome. */
    syndromes: z.array(z.string().trim().min(1)),
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((item) => item.coldChain === (item.storage === 'cold-chain'), {
    message: 'coldChain must be true exactly when the storage class is cold-chain',
    path: ['coldChain'],
  })
  .refine((item) => item.shelfLifeDays >= 1 && item.shelfLifeDays <= 5 * 365, {
    message: 'shelf life must be between one day and five years',
    path: ['shelfLifeDays'],
  })
  .refine((item) => item.unitsPerCase === 0 || item.syndromes.length > 0, {
    message: 'a surge-sensitive item must name the syndromes it treats',
    path: ['syndromes'],
  });

export type Item = z.infer<typeof itemSchema>;
