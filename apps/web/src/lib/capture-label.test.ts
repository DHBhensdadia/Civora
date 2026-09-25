import { CAPTURE_SOURCES } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { captureBadge } from './capture-label';

/**
 * What a movement's badge is allowed to say on a record surface.
 *
 * The rule this file holds is the one the surface cannot check for itself: that
 * every source the platform can store is named in the reader's language, that
 * the two reading paths do not claim more than the field supports, and that
 * generated history stays labelled as generated where it sits beside a capture.
 */

describe('a movement’s capture badge', () => {
  it('names every source the platform can store, and never with a raw value', () => {
    for (const source of CAPTURE_SOURCES) {
      const badge = captureBadge(source);
      // A raw enum value on screen is the failure mode this guards: it reads as
      // an unmapped field rather than as an answer.
      expect(badge.label).not.toBe(source);
      expect(badge.label.length).toBeGreaterThan(0);
      expect(badge.tone).not.toBe('unknown');
    }
  });

  it('keeps a capture from a person readable as different from one a machine read', () => {
    // The distinction the record surface exists to make: was this extracted or
    // typed? If these ever collapse to one label the badge has stopped working.
    const extracted = captureBadge('vision');
    const spoken = captureBadge('voice');
    const typed = captureBadge('manual');

    expect(new Set([extracted.label, spoken.label, typed.label]).size).toBe(3);
    expect(extracted.tone).toBe('extracted');
    expect(spoken.tone).toBe('extracted');
    expect(typed.tone).toBe('typed');
  });

  it('does not claim a model read the page, because the field cannot say that', () => {
    // `captureSource` records the channel, not the reader: a supplied reading and
    // a model reading both arrive as `vision`. A badge asserting `AI-extracted`
    // over the record would be claiming evidence the record does not carry.
    expect(captureBadge('vision').label.toLowerCase()).not.toContain('ai');
  });

  it('labels generated history as generated when it sits beside a capture', () => {
    expect(captureBadge('simulation').label).toBe('Simulated');
    expect(captureBadge('simulation').tone).toBe('generated');
  });

  it('shows a source it does not know as itself rather than as the nearest known one', () => {
    const badge = captureBadge('telepathy');
    expect(badge).toEqual({ label: 'telepathy', tone: 'unknown' });
  });
});
