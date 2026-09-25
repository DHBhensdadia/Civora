#!/usr/bin/env node
/**
 * Nothing the browser downloads may reach the reasoning endpoint or its key.
 *
 * The reasoning layer is reached through `@civora/ai` from server code, and the
 * key is read from the environment by the server process. Both of those are
 * design statements, and a design statement about what is *not* in a bundle is
 * exactly the kind that quietly stops being true — one import from a client
 * component is all it takes. So this reads the built client bundle and looks.
 *
 * It is a build artefact check, not a test: run `pnpm build` first. Two positive
 * controls stop it from passing vacuously, which is the failure mode of every
 * scan of this kind:
 *
 *  - a marker the client bundle **must** contain, so an empty or mis-globbed scan
 *    cannot succeed;
 *  - a marker the *server* bundle must contain, so a marker that was renamed
 *    upstream is detected here rather than reporting an absence it never checked
 *    for.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nextDir = join(root, 'apps', 'web', '.next');
const clientDir = join(nextDir, 'static');
const serverDir = join(nextDir, 'server');

/** Strings that must not be reachable from the browser, and why each matters. */
const FORBIDDEN = [
  {
    marker: 'generativelanguage.googleapis.com',
    why: 'the reasoning endpoint: only the server may call it, so that no client ever needs a key',
  },
  {
    marker: 'GoogleGenAI',
    why: 'the SDK client class: a bundle that can construct one is a bundle that could be handed a key',
  },
  {
    marker: 'GEMINI_API_KEY',
    why: 'the name of the key variable: its presence in a client chunk means server configuration leaked',
  },
  {
    marker: 'CIVORA_REASONING_PROVIDER',
    why: 'server configuration: which adapter runs is not a decision the browser makes',
  },
];

/** A string the client bundle certainly contains, used as a positive control. */
const CLIENT_CONTROL = 'Poorvadarshan';

/** The marker above, which the server bundle must contain for this scan to be meaningful. */
const SERVER_CONTROL = 'generativelanguage.googleapis.com';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under a directory, with its bytes. The bundles here are small. */
async function readTree(dir) {
  const files = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push({ path, text: (await readFile(path)).toString('latin1') });
      }
    }
  };
  await walk(dir);
  return files;
}

if (!(await exists(clientDir))) {
  console.error(
    `no client bundle at ${relative(root, clientDir)} — run \`pnpm build\` first; a check with nothing to read must not pass`,
  );
  process.exit(1);
}

const clientFiles = await readTree(clientDir);
const clientBytes = clientFiles.reduce((total, file) => total + file.text.length, 0);

if (clientFiles.length === 0) {
  console.error(`${relative(root, clientDir)} holds no files; there is nothing to check`);
  process.exit(1);
}

const problems = [];

for (const { marker, why } of FORBIDDEN) {
  const found = clientFiles.filter((file) => file.text.includes(marker));
  if (found.length > 0) {
    problems.push(
      `${marker} is in ${String(found.length)} client file(s) — ${why}\n    ${found
        .map((file) => relative(root, file.path))
        .join('\n    ')}`,
    );
  }
}

// Positive control 1: the scan is reading real client code.
const controlFiles = clientFiles.filter((file) => file.text.includes(CLIENT_CONTROL));
if (controlFiles.length === 0) {
  problems.push(
    `the client bundle does not contain "${CLIENT_CONTROL}", so this scan is not reading the bundle it thinks it is`,
  );
}

// Positive control 2: the marker is detectable in this build at all, and it is
// detectable where it is allowed to be.
let serverHits = 0;
if (await exists(serverDir)) {
  const serverFiles = await readTree(serverDir);
  serverHits = serverFiles.filter((file) => file.text.includes(SERVER_CONTROL)).length;
}
if (serverHits === 0) {
  problems.push(
    `neither bundle contains "${SERVER_CONTROL}", so this check cannot tell absence from a renamed marker — update it deliberately if the SDK changed`,
  );
}

if (problems.length > 0) {
  console.error('the client bundle is not clean:\n');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `checked ${String(clientFiles.length)} client file(s), ${String(clientBytes)} bytes: no reasoning endpoint, no SDK client, no key name, no provider configuration.`,
);
console.log(
  `positive controls: "${CLIENT_CONTROL}" present in the client bundle, "${SERVER_CONTROL}" present in ${String(serverHits)} server file(s) where it belongs.`,
);
