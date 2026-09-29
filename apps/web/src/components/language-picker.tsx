'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { languageLabelOf } from '@civora/i18n';

/**
 * Which language the interface reads in.
 *
 * A control in the header rather than on each form, because it is a property of
 * the person: a health worker who reads Tamil reads every surface in Tamil until
 * they say otherwise, and a language that had to be re-chosen on each page is a
 * language nobody keeps.
 *
 * The write goes to `/api/language`, which validates the choice and refuses an
 * unsupported one by name, and the surface is re-read after it — so the header,
 * the capture form and the alert inbox cannot end up in three different
 * languages, which is what a purely client-side switch produces.
 *
 * The resolved language is **named beside the control** and stays visible at
 * every breakpoint, because the one reader who most needs to see it is the one
 * looking at a page rendered in a tongue they did not choose.
 */

export interface LanguagePickerProps {
  readonly current: string;
  readonly offered: readonly { readonly code: string; readonly label: string }[];
}

export function LanguagePicker({ current, offered }: LanguagePickerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const choose = async (language: string): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      const response = await fetch('/api/language', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language }),
      });
      const body = (await response.json()) as { detail?: string; language?: string };
      if (!response.ok) {
        setRefusal(body.detail ?? `the platform answered ${String(response.status)}`);
        return;
      }
      router.refresh();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'the request did not complete');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2 text-xs">
      <label className="flex items-center gap-2">
        <span className="sr-only">Interface language</span>
        <select
          aria-label="Interface language"
          className="min-h-11 rounded-full border border-hairline bg-paper-raised px-3 text-xs text-ink transition-colors duration-150 hover:border-accent disabled:opacity-40"
          disabled={busy}
          onChange={(event) => {
            void choose(event.target.value);
          }}
          value={current}
        >
          {offered.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </label>
      <span data-testid="interface-language" className="font-mono text-ink-subtle">
        {languageLabelOf(current)}
      </span>
      {refusal === null ? null : (
        <span data-testid="language-refusal" className="text-signal-watch">
          {refusal}
        </span>
      )}
    </span>
  );
}
