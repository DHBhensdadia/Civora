/**
 * The mode a demonstration is run in.
 *
 * A demo is a promise about the next five minutes: nothing at click time may
 * depend on a network call to an external service, because the one thing a judge
 * will see fail is the one thing that was left live. So presentation mode does
 * not make the platform do less; it makes explicit **when** the work happens.
 * The advisory bodies are written once, for the whole alert set, in every
 * language the record carries — that is already how `advisory-service` works —
 * and in presentation mode a request to write them again is refused rather than
 * answered with a burst of calls.
 *
 * It is a cookie rather than an environment variable on purpose. An environment
 * variable is a property of the process, so demonstrating both behaviours would
 * mean restarting the server on stage; a cookie is a property of the person
 * demonstrating, and a browser journey can set it per test.
 *
 * The honesty rule is kept: a refusal is a result, and the surface shows the
 * sentence rather than appearing to have done nothing. What presentation mode
 * must never do is pretend a body was written when none was.
 */

export const PRESENTATION_COOKIE = 'civora-presentation';

/** Whether a cookie value asks for presentation mode. */
export const presentationModeFrom = (raw: string | undefined): boolean =>
  raw === '1' || raw === 'true';

/** What the platform says when a click would have started a model call. */
export const PRESENTATION_REFUSAL =
  'presentation mode: the advisory set is written once, ahead of the demonstration, and a click never starts a model call — clear the civora-presentation cookie to ask the writer again';

/** What a surface says about the mode it is in. */
export const PRESENTATION_NOTE =
  'Presentation mode: the advisory set was prepared before the demonstration, and no click on this surface will call out to a model.';
