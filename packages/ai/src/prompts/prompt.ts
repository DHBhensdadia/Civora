import type { Fact, ImageInput, ReasoningRequest } from '@civora/domain';
import type { ZodType } from 'zod';

/**
 * Prompt assets: the versioned instructions the reasoning layer is asked with.
 *
 * A prompt is a file, not a string literal at the call site, for the same reason
 * a schema is: an answer produced by a particular wording has to be attributable
 * to that wording afterwards, and a recording captured against one revision must
 * not be replayed against another. So each prompt declares a task (what it is),
 * a version (which revision of the words and the output shape), and the schema
 * the answer is validated against — one definition, used by the request the
 * model receives *and* by the validator that decides whether it may leave the
 * adapter.
 *
 * The request's `task` is the composed `task@version`, and that is the key the
 * cache, the fixture corpus and the evaluation selector all read. Two
 * consequences worth stating: bumping a version costs a new fixture rather than
 * silently reusing an old recording, and a prompt cannot be edited without
 * invalidating the answers that were cached against it.
 */

/** Instructions every narrative prompt carries, because they are not optional. */
export const JSON_ONLY =
  'Reply with JSON only, conforming to the required schema. Do not wrap it in prose or a code fence.';

/**
 * The grounding rule, in the words the model is asked with.
 *
 * It is repeated in every narrative prompt rather than assembled into one shared
 * paragraph, because a model that is asked to write in Hindi is still being
 * constrained by this sentence and a reader of the prompt file should be able to
 * see the whole instruction in one place. The sentence forbids arithmetic, not
 * merely invention: a rounded figure is a figure the fact set does not contain,
 * and the grounding assertion would refuse it.
 */
export const NO_INVENTED_NUMBERS = [
  'Every numeral you write must appear, exactly as written, in the facts block below.',
  'Do not compute, sum, average, round, convert, extrapolate or estimate any number:',
  'if a quantity you want is not in the facts, describe it in words instead of naming a figure.',
  'Do not state a facility, item, district or date that is not named in the facts either.',
].join(' ');

/** Per-call parameters a task cannot be asked without. */
export type PromptParameter = Fact;

/** What a caller supplies to one prompt. */
export interface PromptInput {
  /** The only admissible source of quantities in narrative output. */
  readonly facts?: readonly Fact[] | undefined;
  /** Images to read, base64-encoded with their MIME type. */
  readonly images?: readonly ImageInput[] | undefined;
  /**
   * Task parameters — the language to write in, the driver being explained, the
   * pair a transfer is between.
   *
   * Rendered beside the instructions rather than into the fact block, and
   * labelled so, because they are identifiers and choices rather than measured
   * quantities: an advisory may not cite "language" as a source of a number.
   */
  readonly context?: readonly PromptParameter[] | undefined;
}

/** A prompt asset, before it is given a request builder. */
export interface PromptSpec<T> {
  /** Stable name of the task: `stock-extraction`. The fixture corpus is filed under this. */
  readonly task: string;
  /** Which revision of the instructions and the output schema this is. */
  readonly version: number;
  /** The system instruction, in full. */
  readonly instructions: string;
  /** The shape the answer must satisfy, and the schema the model is constrained by. */
  readonly schema: ZodType<T>;
}

/** A prompt asset that can be asked. */
export interface Prompt<T> extends PromptSpec<T> {
  /** `task@version` — the cache key, the fixture key and the evaluation selector. */
  readonly id: string;
  request(input?: PromptInput): ReasoningRequest<T>;
}

/** Render per-call parameters, kept visibly apart from the facts. */
export function contextTextOf(context: readonly PromptParameter[]): string {
  const lines = context.map((parameter) => `- ${parameter.key}: ${String(parameter.value)}`);
  return ['Task parameters (not a source of quantities, and not citable):', ...lines].join('\n');
}

/**
 * Declare a prompt asset.
 *
 * `id` is composed here rather than written out, so the task, the version and
 * the key the fixture corpus uses cannot drift apart — the failure that would
 * matter most, because it would replay the wrong recording silently.
 */
export function definePrompt<T>(spec: PromptSpec<T>): Prompt<T> {
  const id = `${spec.task}@${String(spec.version)}`;

  return {
    ...spec,
    id,
    request(input: PromptInput = {}): ReasoningRequest<T> {
      const context = input.context ?? [];
      return {
        task: id,
        instructions:
          context.length === 0
            ? spec.instructions
            : `${spec.instructions}\n\n${contextTextOf(context)}`,
        schema: spec.schema,
        facts: input.facts ?? [],
        images: input.images ?? [],
      };
    },
  };
}
