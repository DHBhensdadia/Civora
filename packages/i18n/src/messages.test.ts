import { describe, expect, it } from 'vitest';

import {
  BUNDLES,
  LANGUAGES,
  MESSAGE_KEYS,
  bundleFor,
  defaultBundle,
  languageCodes,
  messageFor,
} from './index';

/**
 * The locale bundles.
 *
 * The tests here are the two claims a bundle makes: that it is **complete**
 * (every key, in every offered language, with something in it), and that it is
 * **the reader's own language** rather than the English one under another tag.
 * The second is the one worth writing down — a copy-paste of the English record
 * under `mr` compiles, passes a naive presence check, and would be discovered by
 * a Marathi reader on stage.
 */

describe('the bundles the capture and alert flows read', () => {
  it('carries one bundle per offered language, and no language twice', () => {
    expect(BUNDLES.map((bundle) => bundle.language).sort()).toEqual([...languageCodes].sort());
    expect(new Set(BUNDLES.map((bundle) => bundle.language)).size).toBe(BUNDLES.length);
  });

  it('carries every key in every bundle, with something in it', () => {
    for (const bundle of BUNDLES) {
      for (const key of MESSAGE_KEYS) {
        const phrase = bundle.messages[key];
        expect(typeof phrase, `${bundle.language} · ${key}`).toBe('string');
        expect(phrase.trim(), `${bundle.language} · ${key}`).not.toBe('');
      }
      // A total record over the key union is what the compiler checks; this
      // catches a key that is present but empty, which the type cannot.
      expect(Object.keys(bundle.messages).sort()).toEqual([...MESSAGE_KEYS].sort());
    }
  });

  it('does not answer a non-English reader in English for every phrase', () => {
    const english = defaultBundle().messages;
    for (const bundle of BUNDLES) {
      if (bundle.language === 'en') {
        continue;
      }
      const translated = MESSAGE_KEYS.filter((key) => bundle.messages[key] !== english[key]);
      // Not every key can differ — a few are numerals or a word that coincides —
      // but a bundle that shares most of its phrases with English is an English
      // bundle wearing another language's tag.
      expect(translated.length, `${bundle.language} shares too much with English`).toBeGreaterThan(
        MESSAGE_KEYS.length * 0.8,
      );
    }
  });

  it('renders dates and numbers in the numbering system its language is written in', () => {
    const hindi = formatSample('hi');
    const bengali = formatSample('bn');
    const tamil = formatSample('ta');

    // Devanagari and Bengali digits, as their scripts are written.
    expect(hindi).toMatch(/[०-९]/u);
    expect(bengali).toMatch(/[০-৯]/u);
    // Tamil is written with Latin digits in official use, so asking for its own
    // numerals would be the affectation. The test says that is deliberate.
    expect(tamil).toMatch(/[0-9]/u);
    expect(tamil).not.toMatch(/[०-९০-৯]/u);
  });

  it('names the locale it renders in, taken from the registry', () => {
    for (const bundle of BUNDLES) {
      const language = LANGUAGES.find((entry) => entry.code === bundle.language);
      expect(language).toBeDefined();
      expect(bundle.locale).toBe(language?.locale ?? '');
      expect(bundle.locale).toContain(bundle.language);
    }
  });

  it("answers an unoffered language with the key's English phrase rather than a key", () => {
    // A surface that asks in a language this build does not offer gets English.
    // What it must never get is `capture.title` on the screen.
    expect(messageFor('fr', 'capture.title')).toBe(defaultBundle().messages['capture.title']);
    expect(bundleFor('fr')).toBeNull();
    expect(bundleFor('hi')?.language).toBe('hi');
  });
});

const formatSample = (language: string): string => {
  const bundle = bundleFor(language);
  if (bundle === null) {
    throw new Error(`no bundle for ${language}`);
  }
  return new Intl.NumberFormat(bundle.locale, { maximumFractionDigits: 0 }).format(94680);
};
