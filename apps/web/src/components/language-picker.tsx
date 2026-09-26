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
      <label className="flex items-center gap-1 text-slate-400">
        <span className="sr-only">Interface language</span>
        <select
          aria-label="Interface language"
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
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
      <span data-testid="interface-language" className="font-mono text-slate-500">
        {languageLabelOf(current)}
      </span>
      {refusal === null ? null : (
        <span data-testid="language-refusal" className="text-amber-200">
          {refusal}
        </span>
      )}
    </span>
  );
}
