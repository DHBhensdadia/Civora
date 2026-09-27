import {
  advisoryFactsOf,
  advisoryPrompt,
  generateAdvisory,
  groundingProblems,
  selectReasoningProvider,
} from '@civora/ai';
import {
  adversarialAlert,
  evaluateGrounding,
  goldenSetExitCode,
  loadGoldenSet,
  renderGoldenSetReport,
  renderGroundingReport,
  scoreGoldenSet,
} from '@civora/ai/eval';
import { ITEMS } from '@civora/simulator';

/**
 * `pnpm ai:eval` — the two evaluations the reasoning layer is held to.
 *
 * They answer different questions and fail in different ways, which is why they
 * are one command with two modes rather than one report:
 *
 *  - **`--grounding`** asks whether a check works. It injects an alert whose facts
 *    take the shapes that break a numeral comparison, states for each case whether
 *    a draft must be admitted or refused, and refuses to pass unless every
 *    accepted case stops being accepted once a figure nobody measured is put in
 *    it. No credentials, no corpus, and it belongs in CI.
 *  - **`--golden-set`** asks how accurately the reader read. That question cannot
 *    be answered without a real call, so with no corpus the answer is `NOT
 *    MEASURED`, printed with the reason and with no percentage, and the exit code
 *    says so rather than reporting a pass over nothing.
 *
 * The exit codes are a contract, because CI acts on them:
 *
 *   0  measured and met the stated threshold
 *   1  measured and below it — or a corpus file that cannot be scored
 *   2  not measured; there was nothing legitimate to measure
 *   3  the command was asked for something it does not do
 *
 * `2` is accepted by the CI job while no key exists, and the job prints that it
 * accepted it, so a green log cannot be read as "the accuracy was checked".
 */

const USAGE = `
Evaluate the reasoning layer.

  pnpm ai:eval --grounding             every numeral grounded in the injected fact set
  pnpm ai:eval --golden-set            extraction accuracy against the recorded corpus

Options
  --grounding                 run the grounding assertion over an adversarially injected alert
  --golden-set                score the recorded corpus against its labels
  --corpus <dir>              where the corpus lives (default: eval/golden-set)
  --help                      print this message

--golden-set exits 0 when the measurement met its stated threshold, 1 when it did
not (or when a corpus file cannot be scored) and 2 when there was nothing to
measure. A corpus is only a corpus if every case was captured from a real call;
with no key configured it is empty, and 2 is the honest answer rather than a
percentage over nothing. --grounding needs no credentials and no corpus.
`.trim();

class UsageError extends Error {}

interface Options {
  readonly mode: 'grounding' | 'golden-set' | null;
  readonly corpus: string;
}

function parseArguments(argv: readonly string[]): Options {
  let mode: Options['mode'] = null;
  let corpus = 'eval/golden-set';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--grounding' || argument === '--golden-set') {
      const selected = argument === '--grounding' ? 'grounding' : 'golden-set';
      if (mode !== null && mode !== selected) {
        throw new UsageError('--grounding and --golden-set are two evaluations; ask for one');
      }
      mode = selected;
      continue;
    }
    if (argument === '--corpus') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--corpus needs a directory');
      }
      corpus = value;
      index += 1;
      continue;
    }
    throw new UsageError(`unexpected argument "${argument}"`);
  }

  if (mode === null) {
    throw new UsageError('ask for one evaluation: --grounding or --golden-set');
  }

  return { mode, corpus };
}

/**
 * The writer, asked for an advisory over the injected alert.
 *
 * Included in the grounding run because the assertion and the writer are two
 * different things and the phase asks about both: the cases prove the *check*
 * works, and this shows what a *configured provider* does with the same facts.
 * With no key the answer is a refusal, reported as a refusal — the run still
 * passes, because a writer that cannot write has not written anything ungrounded.
 */
async function reportWriter(lines: string[]): Promise<{ readonly wroteUngroundedNumber: boolean }> {
  const provider = selectReasoningProvider({
    provider: process.env.CIVORA_REASONING_PROVIDER,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL,
  });
  const alert = adversarialAlert();
  const attempt = await generateAdvisory(provider, alert, 'en');

  lines.push(
    'The writer, asked for an advisory over the same alert:',
    `  provider           ${provider.kind}${
      provider.kind === 'fixture' ? ' — refuses every request: no key is configured' : ''
    }`,
    `  task               ${advisoryPrompt.id}, language en`,
    `  status             ${attempt.status}`,
  );

  if (attempt.status === 'refused') {
    lines.push(`  refusal            ${attempt.refusal ?? ''}`, '');
    return { wroteUngroundedNumber: false };
  }

  const body = attempt.draft?.body ?? '';
  const ungrounded = groundingProblems(body, advisoryFactsOf(alert));
  lines.push(
    `  body               ${body}`,
    `  model              ${attempt.model ?? 'not named'}`,
    `  ungrounded numerals ${
      ungrounded.length === 0
        ? 'none — every figure in it is one the alert carries'
        : `FOUND: ${ungrounded.join('; ')}`
    }`,
    '',
  );

  return { wroteUngroundedNumber: ungrounded.length > 0 };
}

async function runGrounding(lines: string[]): Promise<number> {
  const report = evaluateGrounding();
  lines.push(renderGroundingReport(report));

  const written = await reportWriter(lines);

  const code = report.passed && !written.wroteUngroundedNumber ? 0 : 1;
  lines.push(
    code === 0
      ? 'Grounding: PASS — the rule was exercised, kept, and shown refusing a draft with no facts behind it.'
      : 'Grounding: FAIL — see the failing case or the ungrounded body above.',
    `Exit code: ${String(code)}.`,
    '',
  );

  return code;
}

function runGoldenSet(lines: string[], corpus: string): number {
  const load = loadGoldenSet(corpus, ITEMS);
  const report = scoreGoldenSet({ load, catalogue: ITEMS });

  lines.push(renderGoldenSetReport(report));

  return goldenSetExitCode(report);
}

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const lines: string[] = [];

  const code =
    options.mode === 'grounding' ? await runGrounding(lines) : runGoldenSet(lines, options.corpus);

  process.stdout.write(lines.join('\n'));
  return code;
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exitCode = 0;
} else {
  run(argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`\n${error.message}\n\n${USAGE}\n`);
        process.exitCode = 3;
      } else {
        process.stderr.write(
          `\nai:eval failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
