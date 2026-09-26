'use client';

import { bodyIn, languageOf, messageFor } from '@civora/i18n';
import { useState } from 'react';

/**
 * Reading an alert aloud, in the language the record holds a body for.
 *
 * The voice is the device's own — `window.speechSynthesis`, no key, no network,
 * nothing off the machine — which is what makes it work in a room with bad wifi
 * and on a phone that has never seen this platform before. What the platform
 * supplies is the part only it knows: **which** body to read and **which** tag to
 * hand the voice.
 *
 * Three refusals, each a result rather than a disabled button:
 *
 *  - the record holds no body in the interface language, so nothing is read.
 *    Reading the English body in a Hindi voice would be the platform lying about
 *    what its own record says, and it is the failure `bodyIn` exists to make
 *    impossible;
 *  - the device has no speech synthesiser at all;
 *  - the tag is not one this build offers, so there is no voice to ask for.
 *
 * The tag handed over is the registry's `speech` field and not its `locale`: a
 * locale carrying an `Intl` numbering-system extension (`hi-IN-u-nu-deva`)
 * matches no installed voice, and a platform that spoke with it would read the
 * sentence in the wrong tongue or not at all.
 */

export interface SpeakButtonProps {
  /** The alert this control belongs to, so the button and its refusal are addressable per row. */
  readonly alertId: string;
  /** The bodies the record actually holds, keyed by language tag. */
  readonly bodies: Readonly<Record<string, string>>;
  /** The language the reader is reading the interface in. */
  readonly language: string;
}

export function SpeakButton({ alertId, bodies, language }: SpeakButtonProps) {
  const [reading, setReading] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const body = bodyIn(bodies, language);

  const stop = (): void => {
    window.speechSynthesis.cancel();
    setReading(false);
  };

  const read = (): void => {
    if (body === null) {
      setRefusal(messageFor(language, 'alert.noBody'));
      return;
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setRefusal(messageFor(language, 'alert.noVoice'));
      return;
    }
    const speech = languageOf(language)?.speech ?? null;
    if (speech === null) {
      setRefusal(messageFor(language, 'alert.noVoice'));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(body);
    utterance.lang = speech;
    utterance.onend = () => {
      setReading(false);
    };
    utterance.onerror = () => {
      setReading(false);
    };
    // One voice at a time: a second row clicked while the first is being read
    // replaces it rather than stacking two sentences over each other.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setRefusal(null);
    setReading(true);
  };

  return (
    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <button
        aria-label={`${messageFor(language, reading ? 'alert.listening' : 'alert.listen')} — ${alertId}`}
        className="rounded border border-slate-700 px-2 py-0.5 text-slate-300 hover:border-slate-500 hover:text-slate-100"
        data-testid={`speak-${alertId}`}
        onClick={reading ? stop : read}
        type="button"
      >
        {messageFor(language, reading ? 'alert.listening' : 'alert.listen')}
      </button>
      {refusal === null ? null : (
        <span className="text-amber-200" data-testid={`speak-refusal-${alertId}`}>
          {refusal}
        </span>
      )}
    </span>
  );
}
