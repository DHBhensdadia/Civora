/**
 * Shared Prettier configuration. The repository root re-exports this file so
 * that every package, script and document is formatted identically.
 */
const config = {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSpacing: true,
  endOfLine: 'lf',
  proseWrap: 'preserve',
};

export default config;
