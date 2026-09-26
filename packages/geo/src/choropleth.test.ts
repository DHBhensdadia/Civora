import { describe, expect, it } from 'vitest';

import { DEFAULT_CLASS_COUNT, choroplethFor } from './index';

/**
 * Choropleth classes.
 *
 * Two behaviours are the reason this is tested rather than inlined: the
 * **unknown stays unknown** (a region with no reading does not become the palest
 * reading), and the **boundaries are inclusive and total** (every observed value
 * lands in exactly one class, including the maximum, which a naive `floor` drops).
 */

describe('shading a column of figures', () => {
  it('covers the observed range in equal intervals', () => {
    const choropleth = choroplethFor([0, 10], { classCount: 5 });

    expect(choropleth.min).toBe(0);
    expect(choropleth.max).toBe(10);
    expect(choropleth.interval).toBe(2);
    expect(choropleth.classes).toHaveLength(5);
    expect(choropleth.classes[0]).toEqual({ from: 0, to: 2, label: '0 – 2' });
    expect(choropleth.classes[4]).toEqual({ from: 8, to: 10, label: '8 +' });
  });

  it('puts every observed value in exactly one class, including the maximum', () => {
    const values = [0, 1, 2.5, 4, 7, 9.999, 10];
    const choropleth = choroplethFor(values, { classCount: 5 });

    for (const value of values) {
      const index = choropleth.classIndexFor(value);
      expect(index, String(value)).not.toBeNull();
      const band = choropleth.classes[index ?? -1];
      expect(band).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(band?.from ?? 0);
      if (index !== 4) {
        expect(value).toBeLessThanOrEqual(band?.to ?? 0);
      }
    }
    expect(choropleth.classIndexFor(10)).toBe(4);
  });

  it('keeps an unknown value unknown rather than shading it as the smallest', () => {
    const choropleth = choroplethFor([3, 9, null]);

    expect(choropleth.min).toBe(3);
    expect(choropleth.max).toBe(9);
    expect(choropleth.classIndexFor(null)).toBeNull();
    expect(choropleth.classIndexFor(3)).toBe(0);
  });

  it('reports one class when every value is equal, rather than eight identical bands', () => {
    const choropleth = choroplethFor([4, 4, 4]);

    expect(choropleth.uniform).toBe(true);
    expect(choropleth.interval).toBe(0);
    expect(choropleth.classes).toHaveLength(1);
    expect(choropleth.classes[0]?.label).toBe('4');
    expect(choropleth.classIndexFor(4)).toBe(0);
  });

  it('has nothing to say when there is nothing to shade', () => {
    const choropleth = choroplethFor([null, null]);

    expect(choropleth.classes).toEqual([]);
    expect(choropleth.uniform).toBe(true);
    expect(choropleth.classIndexFor(null)).toBeNull();
  });

  it('carries the default number of classes, and a caller can ask for fewer', () => {
    expect(choroplethFor([1, 2]).classes).toHaveLength(DEFAULT_CLASS_COUNT);
    // Fewer than two bands cannot show a distribution; two is the floor.
    expect(choroplethFor([1, 2], { classCount: 1 }).classes).toHaveLength(2);
  });
});
