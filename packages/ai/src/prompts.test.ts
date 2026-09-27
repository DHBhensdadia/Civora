import {
  advisoryDraftSchema,
  driverExplanationSchema,
  roundNarrativeSchema,
  stockExtractionSchema,
  transferRationaleSchema,
  voiceCaptureCommandSchema,
} from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  NO_INVENTED_NUMBERS,
  PROMPTS,
  advisoryPrompt,
  definePrompt,
  driverExplanationPrompt,
  federationNarrativePrompt,
  promptById,
  stockExtractionPrompt,
  transferRationalePrompt,
  voiceCommandPrompt,
} from './prompts';
import type { Prompt } from './prompts';
import { factsTextOf, interactionRequestFor } from './request';

/**
 * The prompt corpus, held to what the phase file requires of it: versioned
 * assets rather than inline strings, each with a system instruction and an
 * explicit output schema.
 *
 * Two things are asserted here that are easy to get wrong and expensive to
 * discover late. First, the schema a prompt sends is the *same object* the
 * platform validates the answer with — one definition, so the instruction and
 * the validator cannot drift. Second, the identifier a prompt is filed under is
 * composed from its task and its version, so a fixture recorded against one
 * revision can never be replayed against another.
 */

/** Every prompt asset, typed individually so each keeps its output type. */
const ALL = [
  stockExtractionPrompt,
  voiceCommandPrompt,
  advisoryPrompt,
  driverExplanationPrompt,
  transferRationalePrompt,
  federationNarrativePrompt,
] as const;

/** The JSON schema a prompt's own schema is bridged into. */
function bridged<T>(prompt: Prompt<T>): Record<string, unknown> {
  return interactionRequestFor(prompt.request(), 'gemini-3.8-flash').response_format.schema;
}

describe('the prompt corpus', () => {
  it('asks six tasks, each versioned, and each filed under task@version', () => {
    expect(PROMPTS).toHaveLength(6);

    for (const prompt of ALL) {
      expect(prompt.id).toBe(`${prompt.task}@${String(prompt.version)}`);
      expect(prompt.version).toBeGreaterThanOrEqual(1);
      expect(prompt.instructions.trim().length).toBeGreaterThan(0);
    }
  });

  it('cannot file two prompts under one identifier', () => {
    const ids = PROMPTS.map((prompt) => prompt.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([
      'advisory-generation@2',
      'driver-explanation@1',
      'federation-narrative@2',
      'stock-extraction@1',
      'transfer-rationale@2',
      'voice-command-parsing@1',
    ]);
  });

  it('finds a prompt by identifier, and finds nothing for a version nobody wrote', () => {
    expect(promptById('advisory-generation@2')).toBe(advisoryPrompt);
    // A bumped version is a new asset with a new recording behind it; the old
    // identifier must not resolve to the new words either, which is what makes
    // the bump a change of record rather than an edit in place.
    expect(promptById('advisory-generation@1')).toBeUndefined();
    expect(promptById('not-a-task@1')).toBeUndefined();
  });

  it('composes the identifier rather than trusting a hand-written one', () => {
    const prompt = definePrompt({
      task: 'example',
      version: 3,
      instructions: 'Do the thing.',
      schema: advisoryDraftSchema,
    });

    expect(prompt.id).toBe('example@3');
    expect(prompt.request().task).toBe('example@3');
  });
});

describe('the request a prompt builds', () => {
  it('sends the prompt’s own schema, so the answer is validated against what was asked', () => {
    // Identity, not equality: these are the objects the domain exports, which
    // the review queue and the ingest path read too.
    expect(stockExtractionPrompt.schema).toBe(stockExtractionSchema);
    expect(voiceCommandPrompt.schema).toBe(voiceCaptureCommandSchema);
    expect(advisoryPrompt.schema).toBe(advisoryDraftSchema);
    expect(driverExplanationPrompt.schema).toBe(driverExplanationSchema);
    expect(transferRationalePrompt.schema).toBe(transferRationaleSchema);
    expect(federationNarrativePrompt.schema).toBe(roundNarrativeSchema);
  });

  it('carries the facts it was given, and nothing when it was given none', () => {
    const request = advisoryPrompt.request({ facts: [{ key: 'daysOfStock', value: 4 }] });

    expect(request.facts).toEqual([{ key: 'daysOfStock', value: 4 }]);
    expect(advisoryPrompt.request().facts).toEqual([]);
    expect(advisoryPrompt.request().images).toEqual([]);
    expect(advisoryPrompt.request().audio).toEqual([]);
  });

  it('keeps per-call parameters out of the fact block', () => {
    // The language is a task parameter, not a quantity: an advisory may not
    // cite "language" as the source of a figure, and the fact block is what the
    // grounding assertion reads numerals from.
    const payload = interactionRequestFor(
      advisoryPrompt.request({
        facts: [{ key: 'daysOfStock', value: 4 }],
        context: [{ key: 'language', value: 'hi' }],
      }),
      'gemini-3.8-flash',
    );

    expect(payload.system_instruction).toContain('language: hi');
    expect(payload.system_instruction).toContain('not a source of quantities');
    expect(payload.input[0]).toEqual({
      type: 'text',
      text: factsTextOf([{ key: 'daysOfStock', value: 4 }]),
    });
  });

  it('makes two languages two different requests, so neither is answered from the other', () => {
    const request = (language: string): string =>
      JSON.stringify(
        interactionRequestFor(
          advisoryPrompt.request({ context: [{ key: 'language', value: language }] }),
          'm',
        ),
      );

    expect(request('hi')).not.toBe(request('mr'));
  });

  it('passes an image through as its own block, which is how vision intake is asked', () => {
    const payload = interactionRequestFor(
      stockExtractionPrompt.request({ images: [{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }] }),
      'gemini-3.8-flash',
    );

    expect(payload.input[1]).toEqual({
      type: 'image',
      data: 'ZmFrZQ==',
      mime_type: 'image/jpeg',
    });
  });

  it('passes a recording through as its own block, which is how voice intake is asked', () => {
    // The platform does not transcribe first: the recording is what the person
    // produced, and a drug name is often clearer in how it was said than in a
    // transcript of it. So the bytes travel beside the instruction, exactly as a
    // photograph does, and the model is asked to answer with the command schema.
    const payload = interactionRequestFor(
      voiceCommandPrompt.request({ audio: [{ mimeType: 'audio/ogg', data: 'ZmFrZQ==' }] }),
      'gemini-3.8-flash',
    );

    expect(payload.input).toEqual([
      { type: 'text', text: factsTextOf([]) },
      { type: 'audio', data: 'ZmFrZQ==', mime_type: 'audio/ogg' },
    ]);
    expect(payload.system_instruction).toBe(voiceCommandPrompt.instructions);
  });

  it('keeps an image and a recording apart, because they travel in different blocks', () => {
    const payload = interactionRequestFor(
      voiceCommandPrompt.request({
        images: [{ mimeType: 'image/jpeg', data: 'aW1hZ2U=' }],
        audio: [{ mimeType: 'audio/ogg', data: 'YXVkaW8=' }],
      }),
      'gemini-3.8-flash',
    );

    expect(payload.input.slice(1)).toEqual([
      { type: 'image', data: 'aW1hZ2U=', mime_type: 'image/jpeg' },
      { type: 'audio', data: 'YXVkaW8=', mime_type: 'audio/ogg' },
    ]);
  });
});

describe('the schema the model is constrained by', () => {
  it('bridges every prompt into a closed object schema', () => {
    for (const schema of [
      bridged(stockExtractionPrompt),
      bridged(voiceCommandPrompt),
      bridged(advisoryPrompt),
      bridged(driverExplanationPrompt),
      bridged(transferRationalePrompt),
    ]) {
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: expect.any(Array),
      });
    }
  });

  it('requires the citations a narrative answer must carry', () => {
    expect(bridged(advisoryPrompt)).toMatchObject({
      required: expect.arrayContaining([
        'language',
        'title',
        'body',
        'actions',
        'reasoning',
        'citations',
      ]),
    });
    expect(bridged(transferRationalePrompt)).toMatchObject({
      required: expect.arrayContaining(['summary', 'conditions', 'citations']),
    });
  });

  it('leaves a cross-field refinement to the validator, because JSON schema cannot carry it', () => {
    // Zod drops refinements when it emits JSON schema, so the shape the model
    // is constrained by is the object alone. The refinement still decides
    // whether the answer may leave the adapter — which is one more reason a
    // rejected answer is retried with the complaint attached rather than
    // returned.
    const empty = { facilityName: null, registerDate: null, lines: [], notes: [] };

    expect(stockExtractionSchema.safeParse(empty).success).toBe(false);
    expect(JSON.stringify(bridged(stockExtractionPrompt))).not.toContain('must say why');
  });
});

describe('what each prompt is allowed to say about numbers', () => {
  it('forbids invented numerals in every prompt that writes prose', () => {
    for (const prompt of [advisoryPrompt, driverExplanationPrompt, transferRationalePrompt]) {
      expect(prompt.instructions).toContain(NO_INVENTED_NUMBERS);
      expect(prompt.instructions).toContain('Do not compute, sum, average, round');
    }
  });

  it('does not tell the extraction to ground numbers in a fact set it does not have', () => {
    // Its numbers are read off the photograph the person supplied. The rule
    // that keeps them honest is not grounding but the confidence it must give
    // each line and the review queue that reads it.
    expect(stockExtractionPrompt.instructions).not.toContain(NO_INVENTED_NUMBERS);
    expect(stockExtractionPrompt.instructions).toContain('Never guess');
    expect(stockExtractionPrompt.instructions).toContain('confidence');
    expect(voiceCommandPrompt.instructions).not.toContain(NO_INVENTED_NUMBERS);
  });

  it('tells the extractor not to improve the names it reads', () => {
    // A tidied name is a name the catalogue cannot match, which turns a reading
    // error into a new item.
    expect(stockExtractionPrompt.instructions).toContain('Do not expand abbreviations');
    expect(stockExtractionPrompt.instructions).toContain('matches the written name');
  });
});
