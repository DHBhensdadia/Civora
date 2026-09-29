import { APP_VERSION } from './version';

/**
 * Which build this process is, for the shell's footer.
 *
 * The footer's second row is **build identity** — the version, the commit, the
 * dataset fingerprint and the word for what the data is — because a reader who
 * wants to check a figure needs to know which build produced it, and the bottom
 * of a page is where a reader looks for that.
 *
 * **A commit is read from the environment or it is not claimed.** Nothing here
 * runs `git` (the production build runs in a container with no repository in it)
 * and no hash is written into the source, because a hash copied into a file is a
 * second copy of a fact that goes stale with the next commit. The three names
 * below are the ones that exist in practice: `CIVORA_COMMIT` is ours and is what
 * any deployment can set, `RENDER_GIT_COMMIT` is set by the platform the fallback
 * deployment runs on (ADR 0010), and `GIT_COMMIT` is the generic name build
 * systems export. When none is set the footer says **not recorded**, which is a
 * true sentence rather than an invented value.
 */

/** The environment variables a commit may arrive under, most specific first. */
export const COMMIT_SOURCES = ['CIVORA_COMMIT', 'RENDER_GIT_COMMIT', 'GIT_COMMIT'] as const;

/**
 * An environment variable, read by name.
 *
 * The lookup is by name rather than as `process.env.CIVORA_COMMIT` on purpose: a
 * literal member expression is inlined by the bundler at build time, which would
 * freeze a variable that the container sets at *runtime* — and a build identity
 * that reports the machine it was compiled on is worse than one that reports
 * nothing.
 */
const variable = (name: string): string | null => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

export interface BuildIdentity {
  /** The web application's version, read from its own manifest. */
  readonly version: string;
  /** The commit this process was given, or `null` when it was given none. */
  readonly commit: string | null;
  /** What the footer prints: a short commit, or the words this build can defend. */
  readonly commitLabel: string;
}

/** What a build with no commit in its environment says about itself. */
export const COMMIT_NOT_RECORDED = 'not recorded';

/** Seven characters, which is what every other surface in this repository quotes. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** The identity the footer renders, resolved once per call from the environment. */
export function buildIdentity(): BuildIdentity {
  const commit =
    COMMIT_SOURCES.map((name) => variable(name)).find((value) => value !== null) ?? null;

  return {
    version: APP_VERSION,
    commit,
    commitLabel: commit === null ? COMMIT_NOT_RECORDED : shortCommit(commit),
  };
}
