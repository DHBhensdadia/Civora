/**
 * A module-resolution hook that lets Node load this repository's TypeScript.
 *
 * Node can execute TypeScript directly — it erases the types and runs the
 * result — but it resolves an import exactly as written, and this repository
 * writes imports the way a bundler reads them: `./network`, not `./network.ts`.
 * Next, Vite and Vitest all fill that extension in; Node does not, so a script
 * run outside a bundler fails on the first relative import.
 *
 * This hook fills in the same candidates a bundler would try, and does nothing
 * else. Type erasure is left to Node, which is safe here because the TypeScript
 * baseline sets `erasableSyntaxOnly`, so no file in the workspace can use a
 * construct Node would have to transform rather than delete.
 *
 * Synchronous on purpose: it is pure string work with no I/O, and the
 * `registerHooks` API it is registered with requires a synchronous hook.
 */

/** Specifiers that already name a file, and must be left alone. */
const EXTENSIONED = /\.[cm]?[jt]sx?$/;

/** What a bundler tries, in order, when an import names no extension. */
const CANDIDATES = ['.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx'];

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') || EXTENSIONED.test(specifier)) {
    return nextResolve(specifier, context);
  }

  for (const candidate of CANDIDATES) {
    try {
      return nextResolve(`${specifier}${candidate}`, context);
    } catch {
      // Try the next candidate; a genuine failure is reported by the last one.
    }
  }

  return nextResolve(specifier, context);
}
