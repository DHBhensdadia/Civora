import { CivoraError, itemSchema } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { parseNlemExtract } from './nlem';

/**
 * The importer is the deployability claim, so it is tested as one.
 *
 * Three things have to be true for an importer to be worth anything. It must
 * work on the shape a real extract arrives in — a JSON document, not a typed
 * value the importer was handed by its own test. It must derive what the source
 * does not state, the same way every time. And it must refuse a document it does
 * not recognise, naming the field, rather than importing the rows it happened
 * to understand: a catalogue quietly missing four items is worse than no
 * catalogue, because nothing downstream can tell that anything is absent.
 */

/** An extract in the shape the published list exports to. Parsed, not typed. */
const EXTRACT_JSON = `{
  "sourceId": "nlem2022",
  "title": "National List of Essential Medicines 2022",
  "retrievedOn": "2026-09-25",
  "items": [
    { "section": "2.1.5", "genericName": "Paracetamol", "form": "tablet", "strength": "500 mg", "levels": ["P", "S", "T"], "category": "analgesic" },
    { "section": "8.2.2", "genericName": "Heparin", "form": "injection", "strength": "5000 IU/mL", "levels": ["S", "T"], "category": "cardiovascular" },
    { "section": "19.4.1", "genericName": "Rabies vaccine", "form": "injection", "strength": "as licensed", "levels": ["P", "S", "T"], "category": "vaccine" },
    { "section": "6.4.9", "genericName": "Isoniazid", "form": "tablet", "strength": "300 mg", "levels": ["P"], "category": "programme-tb" }
  ]
}`;

const imported = parseNlemExtract(JSON.parse(EXTRACT_JSON) as unknown);

const itemNamed = (genericName: string) => {
  const item = imported.items.find((candidate) => candidate.genericName === genericName);
  if (item === undefined) {
    throw new Error(`${genericName} is expected to be in the parsed extract`);
  }
  return item;
};

describe('importing an extract of the essential medicines list', () => {
  it('reports where the extract came from', () => {
    expect(imported.sourceId).toBe('nlem2022');
    expect(imported.retrievedOn).toBe('2026-09-25');
    expect(imported.title).toContain('National List of Essential Medicines');
  });

  it('produces records that satisfy the catalogue contract', () => {
    expect(imported.items).toHaveLength(4);
    for (const item of imported.items) {
      expect(itemSchema.safeParse(item).success).toBe(true);
      expect(item.synthetic).toBe(true);
      expect(item.provenance).toEqual({ kind: 'source', reference: 'nlem2022' });
    }
  });

  it('turns the list’s level-of-care markers into levels of care', () => {
    expect(itemNamed('Paracetamol').careLevels).toEqual(['primary', 'secondary', 'tertiary']);
    expect(itemNamed('Heparin').careLevels).toEqual(['secondary', 'tertiary']);
    expect(itemNamed('Isoniazid').careLevels).toEqual(['primary']);
  });

  it('derives the fields the list does not carry, by its documented rules', () => {
    const paracetamol = itemNamed('Paracetamol');
    expect(paracetamol.unit).toBe('tablet');
    expect(paracetamol.storage).toBe('ambient');
    expect(paracetamol.coldChain).toBe(false);
    expect(paracetamol.essentiality).toBe('essential');
    // A surge-sensitive item has to name the syndromes it treats, or a fever
    // surge would lift the demand for something nobody dispenses for a fever.
    expect(paracetamol.syndromes).toEqual(['fever']);
    expect(paracetamol.unitsPerCase).toBeGreaterThan(0);

    const vaccine = itemNamed('Rabies vaccine');
    expect(vaccine.storage).toBe('cold-chain');
    expect(vaccine.coldChain).toBe(true);
    expect(vaccine.unit).toBe('vial');

    // A programme drug is stocked because a programme requires it, not because
    // a patient walked in, and a chronic cardiovascular drug is not lifted by
    // any syndrome.
    expect(itemNamed('Isoniazid').essentiality).toBe('programme');
    expect(itemNamed('Heparin').unitsPerCase).toBe(0);
  });

  it('keys an item by its section code and generic name', () => {
    // Other packages address items by identifier, so the scheme is pinned.
    expect(itemNamed('Paracetamol').id).toBe('nlem-2-1-5-paracetamol');
    expect(itemNamed('Rabies vaccine').id).toBe('nlem-19-4-1-rabies-vaccine');
  });

  it('refuses a document it does not recognise, naming what is wrong', () => {
    const withRow = (row: Record<string, unknown>): unknown => ({
      ...(JSON.parse(EXTRACT_JSON) as Record<string, unknown>),
      items: [row],
    });

    const paracetamol = {
      section: '2.1.5',
      genericName: 'Paracetamol',
      form: 'tablet',
      strength: '500 mg',
      levels: ['P'],
      category: 'analgesic',
    };

    expect(() => parseNlemExtract(withRow({ ...paracetamol, levels: ['X'] }))).toThrow(/levels/);
    expect(() => parseNlemExtract(withRow({ ...paracetamol, levels: [] }))).toThrow(/levels/);
    expect(() => parseNlemExtract(withRow({ ...paracetamol, category: 'homeopathy' }))).toThrow(
      /category/,
    );
    expect(() => parseNlemExtract(withRow({ ...paracetamol, section: undefined }))).toThrow(
      /section/,
    );
    // An unexpected field is a format change, and a silent one would mean the
    // importer stopped reading a column the source started writing.
    expect(() => parseNlemExtract(withRow({ ...paracetamol, excipient: 'lactose' }))).toThrow(
      /excipient|unrecognized/i,
    );

    expect(() => parseNlemExtract({ items: [] })).toThrow(CivoraError);
    expect(() => parseNlemExtract(null)).toThrow(CivoraError);
    expect(() => parseNlemExtract('not a document')).toThrow(CivoraError);
  });
});
