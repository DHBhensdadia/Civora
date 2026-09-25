import { describe, expect, it } from 'vitest';

import { itemIdSchema } from '../model/common';
import type { Item } from '../model/catalogue';
import { anItem } from '../testing/factories';
import { matchItemByName } from './match';

/**
 * Turning what somebody wrote into a catalogue identity.
 *
 * The cases below are the ones a paper register actually produces — a
 * capitalised name, a trailing dosage form, a strength the platform also stocks
 * at another strength, a name that belongs to nothing. What matters is the last
 * of those: the function is allowed to say it does not know, and that is a
 * better answer than the closest entry.
 */

const atStrength = (id: string, genericName: string, strength: string): Item =>
  anItem({ id: itemIdSchema.parse(id), genericName, strength });

const CATALOGUE: readonly Item[] = [
  anItem(),
  atStrength('item-amoxicillin-250', 'Amoxicillin', '250 mg'),
  atStrength('item-amoxicillin-500', 'Amoxicillin', '500 mg'),
  atStrength('item-ors', 'Oral Rehydration Salts', '21.8 g'),
];

describe('matching a written name', () => {
  it('finds the item however the page capitalised and spaced it', () => {
    for (const written of [
      'Paracetamol',
      'PARACETAMOL',
      'paracetamol 500 mg',
      'Tab. Paracetamol',
    ]) {
      const match = matchItemByName(written, CATALOGUE);
      expect(match).toMatchObject({ kind: 'matched' });
      expect(match.kind === 'matched' && match.item.genericName).toBe('Paracetamol');
    }
  });

  it('prefers the strength the page states over the other entry with the same name', () => {
    const match = matchItemByName('Amoxicillin 500 mg capsules', CATALOGUE);

    expect(match.kind === 'matched' && match.item.id).toBe('item-amoxicillin-500');
  });

  it('says it is ambiguous when two entries fit equally well, and names them', () => {
    const match = matchItemByName('Amoxicillin', CATALOGUE);

    expect(match.kind).toBe('ambiguous');
    expect(match.kind === 'ambiguous' && match.candidates.map((item) => item.id).sort()).toEqual([
      'item-amoxicillin-250',
      'item-amoxicillin-500',
    ]);
  });

  it('does not match a name that shares no word with any item', () => {
    expect(matchItemByName('Cough syrup', CATALOGUE)).toEqual({ kind: 'unmatched' });
  });

  it('ignores words it does not recognise, which is why the written name is shown beside the match', () => {
    // The catalogue's identity is the generic name and the strength, so a page
    // that names a form the catalogue does not stock still resolves to the
    // generic entry — "Paracetamol syrup" matches the tablet. That is a real
    // limit of matching on two fields, and the mitigation is that the line is
    // confirmed with what was read written next to what it was matched to.
    expect(matchItemByName('Paracetamol syrup', CATALOGUE)).toMatchObject({ kind: 'matched' });
  });

  it('says nothing matched rather than returning the nearest entry', () => {
    expect(matchItemByName('Zinc sulphate', CATALOGUE)).toEqual({ kind: 'unmatched' });
    expect(matchItemByName('   ', CATALOGUE)).toEqual({ kind: 'unmatched' });
    expect(matchItemByName('Paracetamol', [])).toEqual({ kind: 'unmatched' });
  });

  it('matches a multi-word generic name in the order the page wrote it', () => {
    const match = matchItemByName('ORS (Oral Rehydration Salts) 21.8 g', CATALOGUE);

    expect(match.kind === 'matched' && match.item.id).toBe('item-ors');
  });
});
