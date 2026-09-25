/**
 * `@civora/ai/eval` — the evaluations, kept out of the reasoning layer's own
 * entry point.
 *
 * A subpath rather than part of `@civora/ai`, and for two reasons that are worth
 * stating because the seam looks arbitrary otherwise.
 *
 *  - **Different consumers.** `@civora/ai` is imported by the served application
 *    and by the batch jobs; this is imported by a command and by tests. Keeping it
 *    separate means the web process's module graph never reaches a corpus loader
 *    that reads files.
 *  - **Different standing.** What is in `@civora/ai` is what the platform *runs*.
 *    What is here is how the platform is *checked* — and the two should be
 *    separable when somebody asks whether the second is telling the truth about
 *    the first.
 *
 * The phase asks for two entry points and both live here: the grounding assertion
 * over an adversarially injected alert, and extraction accuracy against a corpus
 * of recorded readings.
 */

export {
  adversarialAlert,
  evaluateGrounding,
  GROUNDING_CASES,
  renderGroundingReport,
  UNGROUNDED_DEMONSTRATION,
  VACUITY_PROBE,
} from './grounding-cases';
export type { GroundingCase, GroundingCaseResult, GroundingReport } from './grounding-cases';

export {
  GOLDEN_DIMENSIONS,
  GOLDEN_EXIT_CODES,
  GOLDEN_THRESHOLDS,
  GoldenCaseRefusal,
  goldenSetExitCode,
  loadGoldenSet,
  renderGoldenSetReport,
  scoreGoldenSet,
} from './golden-set';
export type {
  GoldenCase,
  GoldenCaseScore,
  GoldenDimension,
  GoldenExtractionCase,
  GoldenExtractionLine,
  GoldenFailure,
  GoldenFieldTally,
  GoldenProvenance,
  GoldenSetLoad,
  GoldenSetRefusal,
  GoldenSetReport,
  GoldenTolerance,
  GoldenVerdict,
  GoldenVoiceCase,
} from './golden-set';
