import { z } from 'zod';

/** Adapters that can serve the persistence port. */
export const DATA_PROVIDERS = ['in-memory', 'firestore'] as const;
/** Adapters that can serve the identity port. */
export const AUTH_PROVIDERS = ['fixture', 'firebase'] as const;
/** Adapters that can serve the reasoning port. */
export const REASONING_PROVIDERS = ['fixture', 'gemini'] as const;

/**
 * Application configuration.
 *
 * The adapter switches are what make the local-first promise explicit: the
 * defaults need no credentials at all, and selecting a cloud-backed adapter
 * makes its credentials required instead of letting the process start up in a
 * half-configured state.
 */
export const envSchema = z.object({
  appName: z.string().trim().min(1).default('Civora'),
  dataProvider: z.enum(DATA_PROVIDERS).default('in-memory'),
  authProvider: z.enum(AUTH_PROVIDERS).default('fixture'),
  reasoningProvider: z.enum(REASONING_PROVIDERS).default('fixture'),
  firebaseProjectId: z.string().trim().min(1).optional(),
  geminiApiKey: z.string().trim().min(1).optional(),
  geminiModel: z.string().trim().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** A readable environment, e.g. `process.env` or a literal in a test. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** One unmet configuration requirement. */
export interface EnvIssue {
  readonly variable: string;
  readonly message: string;
}

/** Raised when configuration is missing or contradictory. */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const detail = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n');
    super(`invalid environment configuration:\n${detail}`);
    this.name = new.target.name;
    this.issues = issues;
  }
}

/** Maps configuration keys back to the variable a deployer has to set. */
const VARIABLE_NAMES: Readonly<Record<keyof Env, string>> = {
  appName: 'NEXT_PUBLIC_APP_NAME',
  dataProvider: 'CIVORA_DATA_PROVIDER',
  authProvider: 'CIVORA_AUTH_PROVIDER',
  reasoningProvider: 'CIVORA_REASONING_PROVIDER',
  firebaseProjectId: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  geminiApiKey: 'GEMINI_API_KEY',
  geminiModel: 'GEMINI_MODEL',
};

const variableName = (key: PropertyKey): string =>
  typeof key === 'string' && key in VARIABLE_NAMES ? VARIABLE_NAMES[key as keyof Env] : '(root)';

/**
 * Treat an unset variable and an empty one as the same thing.
 *
 * A copied `.env.example` is full of `KEY=` lines, and those must mean
 * "not configured" rather than "configured as the empty string".
 */
const orAbsent = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

function selectSource(source: EnvSource): Record<string, string | undefined> {
  return {
    appName: orAbsent(source.NEXT_PUBLIC_APP_NAME),
    dataProvider: orAbsent(source.CIVORA_DATA_PROVIDER),
    authProvider: orAbsent(source.CIVORA_AUTH_PROVIDER),
    reasoningProvider: orAbsent(source.CIVORA_REASONING_PROVIDER),
    firebaseProjectId: orAbsent(source.NEXT_PUBLIC_FIREBASE_PROJECT_ID),
    geminiApiKey: orAbsent(source.GEMINI_API_KEY),
    geminiModel: orAbsent(source.GEMINI_MODEL),
  };
}

/** Requirements that only apply once a particular adapter is selected. */
function crossFieldIssues(env: Env): EnvIssue[] {
  const issues: EnvIssue[] = [];

  if (env.reasoningProvider === 'gemini') {
    if (env.geminiApiKey === undefined) {
      issues.push({
        variable: 'GEMINI_API_KEY',
        message: 'required when CIVORA_REASONING_PROVIDER is "gemini"',
      });
    }
    if (env.geminiModel === undefined) {
      issues.push({
        variable: 'GEMINI_MODEL',
        message: 'required when CIVORA_REASONING_PROVIDER is "gemini"',
      });
    }
  }

  if (env.dataProvider === 'firestore' || env.authProvider === 'firebase') {
    if (env.firebaseProjectId === undefined) {
      issues.push({
        variable: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
        message: 'required when the firestore or firebase adapter is selected',
      });
    }
  }

  return issues;
}

function toEnvIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): EnvIssue {
  return {
    variable: variableName(issue.path[0] ?? '(root)'),
    message: issue.message,
  };
}

/**
 * Validate a source of configuration and return it typed.
 *
 * Throws `EnvValidationError` listing every problem at once, so a misconfigured
 * deployment is fixed in one pass rather than one variable per restart.
 */
export function loadEnv(source: EnvSource = process.env): Env {
  const parsed = envSchema.safeParse(selectSource(source));

  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues.map(toEnvIssue));
  }

  const issues = crossFieldIssues(parsed.data);
  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return parsed.data;
}

let cached: Env | undefined;

/** Validated configuration for this process, resolved on first use. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}
