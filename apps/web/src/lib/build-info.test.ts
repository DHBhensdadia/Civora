import { afterEach, describe, expect, it } from 'vitest';

import { COMMIT_NOT_RECORDED, COMMIT_SOURCES, buildIdentity, shortCommit } from './build-info';

/**
 * What the footer is allowed to say about the build it is running on.
 *
 * The rule this file holds is the one a footer cannot check for itself: a commit
 * is printed because the process was given one, never because the source knows a
 * hash — and when no variable carries one, the footer says so in words rather
 * than leaving a blank or borrowing the value of a variable it did not read.
 */

const clear = (): void => {
  for (const name of COMMIT_SOURCES) {
    // Blanked rather than deleted: the reader treats a blank value as absent, and
    // deleting a computed key is a rule this repository's lint configuration
    // refuses in source.
    process.env[name] = '';
  }
};

afterEach(clear);

describe('the build identity', () => {
  it('reads its version from the manifest rather than from a second copy', () => {
    clear();
    expect(buildIdentity().version).toBe('0.1.0');
  });

  it('prints seven characters of a commit, and the whole thing when it is shorter', () => {
    clear();
    process.env.CIVORA_COMMIT = '24499e5c1f0a9b8d7e6f5a4b3c2d1e0f9a8b7c6d';
    expect(buildIdentity().commitLabel).toBe('24499e5');
    expect(buildIdentity().commit).toBe('24499e5c1f0a9b8d7e6f5a4b3c2d1e0f9a8b7c6d');

    clear();
    process.env.CIVORA_COMMIT = 'abc123';
    expect(buildIdentity().commitLabel).toBe('abc123');
  });

  it('prefers our own variable, then the platform’s, then the generic name', () => {
    clear();
    process.env.GIT_COMMIT = 'generic';
    process.env.RENDER_GIT_COMMIT = 'render';
    process.env.CIVORA_COMMIT = 'ours';
    expect(buildIdentity().commit).toBe('ours');

    clear();
    process.env.GIT_COMMIT = 'generic';
    process.env.RENDER_GIT_COMMIT = 'render';
    expect(buildIdentity().commit).toBe('render');

    clear();
    process.env.GIT_COMMIT = 'generic';
    expect(buildIdentity().commit).toBe('generic');
  });

  it('says not recorded when the process was given no commit at all', () => {
    clear();
    const identity = buildIdentity();
    expect(identity.commit).toBeNull();
    expect(identity.commitLabel).toBe(COMMIT_NOT_RECORDED);
    // The label is words, not an empty string or a placeholder hash: a footer
    // that printed `commit ` or `commit unknown` would be a claim of a different
    // kind from a statement that nothing was recorded.
    expect(identity.commitLabel.trim()).toBe(identity.commitLabel);
  });

  it('treats a blank or padded value as absent rather than printing it', () => {
    clear();
    process.env.CIVORA_COMMIT = '   ';
    expect(buildIdentity().commit).toBeNull();

    process.env.CIVORA_COMMIT = '  24499e5  ';
    expect(buildIdentity().commit).toBe('24499e5');
    expect(shortCommit('24499e5')).toBe('24499e5');
  });
});
