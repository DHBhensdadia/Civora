#!/usr/bin/env node

/**
 * Serve the production build the way the container does.
 *
 * `next start` refuses to run against `output: 'standalone'`, and the emitted
 * bundle deliberately excludes static assets because the image copies them in
 * afterwards. This script performs that same copy and then starts the emitted
 * server, so a local end-to-end run exercises the artefact that actually ships
 * rather than something adjacent to it.
 */

import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'apps', 'web');
const nextDir = join(appDir, '.next');
const serverDir = join(nextDir, 'standalone', 'apps', 'web');
const serverEntry = join(serverDir, 'server.js');

if (!existsSync(serverEntry)) {
  console.error('No production build found. Run `pnpm build` first.');
  process.exit(1);
}

const staticDir = join(nextDir, 'static');
if (existsSync(staticDir)) {
  cpSync(staticDir, join(serverDir, '.next', 'static'), { recursive: true });
}

const publicDir = join(appDir, 'public');
if (existsSync(publicDir)) {
  cpSync(publicDir, join(serverDir, 'public'), { recursive: true });
}

await import(pathToFileURL(serverEntry).href);
