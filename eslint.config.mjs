import { createEslintConfig } from '@civora/config/eslint';

// One lint entry point for the whole workspace. The TypeScript project service
// is anchored at the repository root so a file is linted against the tsconfig
// nearest to it, whichever package it belongs to.
export default createEslintConfig({
  tsconfigRootDir: import.meta.dirname,
});
