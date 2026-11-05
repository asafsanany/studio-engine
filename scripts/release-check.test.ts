import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkRelease,
  formatReport,
  latestVersionTag,
  type ReleaseCheckInput,
  readGitTags,
} from './release-check';

const entry = (version: string) => ({ version, date: '2026-10-22', items: ['A change.'] });

/** A passing setup: version 0.1.0 with its entry, last tag v0.1.0-dev. */
function input(overrides: Partial<ReleaseCheckInput> = {}): ReleaseCheckInput {
  return {
    version: '0.1.0',
    releases: [entry('0.1.0')],
    tags: ['v0.1.0-dev'],
    allowMajorBump: false,
    ...overrides,
  };
}

describe('checkRelease', () => {
  it('passes when the version has an entry and X matches the last tag', () => {
    const result = checkRelease(input());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.notes.join('\n')).toContain('Version 0.1.0 has a release entry');
    expect(result.notes.join('\n')).toContain('matches the last git tag v0.1.0-dev');
  });

  describe('release entry for the current version', () => {
    it('fails when the current version has no entry', () => {
      const result = checkRelease(input({ version: '0.1.1' }));
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Version 0.1.1 has no release entry');
      expect(result.errors[0]).toContain('packages/shared/src/releases.ts');
    });

    it('fails when there are no entries at all', () => {
      const result = checkRelease(input({ releases: [] }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('Version 0.1.0 has no release entry');
    });

    it('passes when the current version is the newest of several entries', () => {
      const result = checkRelease(
        input({ version: '0.1.1', releases: [entry('0.1.1'), entry('0.1.0')] }),
      );
      expect(result.ok).toBe(true);
    });

    it('fails when an entry is ahead of the package.json version', () => {
      const result = checkRelease(input({ releases: [entry('0.2.0'), entry('0.1.0')] }));
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('release entry for 0.2.0 is ahead');
    });

    it('fails when the package.json version is not X.Y.Z', () => {
      for (const version of ['', '1.0', 'v1.0.0', '1.0.0-beta']) {
        const result = checkRelease(input({ version }));
        expect(result.ok, version).toBe(false);
        expect(result.errors[0]).toContain('must look like 0.1.0');
      }
    });
  });

  describe('order of the entries', () => {
    it('passes strictly decreasing versions (newest first)', () => {
      const releases = [entry('1.0.0'), entry('0.10.0'), entry('0.9.0'), entry('0.1.0')];
      expect(checkRelease(input({ version: '1.0.0', releases, tags: [] })).ok).toBe(true);
    });

    it('fails entries listed oldest first', () => {
      const result = checkRelease(
        input({ version: '0.1.1', releases: [entry('0.1.0'), entry('0.1.1')] }),
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('newest first');
      expect(result.errors.join('\n')).toContain('0.1.1 comes after 0.1.0');
    });

    it('fails entries out of order in the middle', () => {
      const releases = [entry('0.3.0'), entry('0.1.0'), entry('0.2.0')];
      const result = checkRelease(input({ version: '0.3.0', releases }));
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('0.2.0 comes after 0.1.0');
    });

    it('fails a version listed twice', () => {
      const result = checkRelease(input({ releases: [entry('0.1.0'), entry('0.1.0')] }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('lists 0.1.0 twice');
    });

    it('orders by number, not by text', () => {
      // As text "0.9.0" > "0.10.0", so a string compare would wrongly fail this.
      const releases = [entry('0.10.0'), entry('0.9.0')];
      expect(checkRelease(input({ version: '0.10.0', releases, tags: [] })).ok).toBe(true);
    });
  });

  describe('entries that are not valid', () => {
    it('fails an entry with a bad date', () => {
      const releases = [{ ...entry('0.1.0'), date: 'yesterday' }];
      const result = checkRelease(input({ releases }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('is not valid at 0.date');
    });

    it('fails an entry with no items', () => {
      const result = checkRelease(input({ releases: [{ ...entry('0.1.0'), items: [] }] }));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('0.items');
    });

    it('fails something that is not a list', () => {
      expect(checkRelease(input({ releases: { version: '0.1.0' } })).ok).toBe(false);
    });
  });

  describe('X against the last git tag', () => {
    it('fails when X differs from the last tag', () => {
      const result = checkRelease(
        input({ version: '1.0.0', releases: [entry('1.0.0')], tags: ['v0.1.0-dev'] }),
      );
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('X changed');
      expect(result.errors[0]).toContain('v0.1.0-dev');
      expect(result.errors[0]).toContain('ALLOW_MAJOR_BUMP=1');
    });

    it('also fails when X goes down', () => {
      const result = checkRelease(
        input({ version: '0.5.0', releases: [entry('0.5.0')], tags: ['v1.2.3'] }),
      );
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('X changed');
    });

    it('passes a changed X when ALLOW_MAJOR_BUMP=1 is set, and says so', () => {
      const result = checkRelease(
        input({
          version: '1.0.0',
          releases: [entry('1.0.0')],
          tags: ['v0.1.0-dev'],
          allowMajorBump: true,
        }),
      );
      expect(result.ok).toBe(true);
      expect(result.notes.join('\n')).toContain('accepted because ALLOW_MAJOR_BUMP=1');
    });

    it('does not let ALLOW_MAJOR_BUMP excuse a missing entry', () => {
      const result = checkRelease(
        input({ version: '1.0.0', releases: [entry('0.1.0')], allowMajorBump: true }),
      );
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('Version 1.0.0 has no release entry');
    });

    it('lets Y and Z change freely', () => {
      const releases = [entry('0.7.3'), entry('0.1.0')];
      expect(checkRelease(input({ version: '0.7.3', releases })).ok).toBe(true);
    });

    it('compares with the highest version tag, not the first one listed', () => {
      const tags = ['v0.1.0-dev', 'v1.0.0', 'v0.9.0'];
      const releases = [entry('1.2.0')];
      expect(checkRelease(input({ version: '1.2.0', releases, tags })).ok).toBe(true);
      expect(checkRelease(input({ version: '0.9.1', releases: [entry('0.9.1')], tags })).ok).toBe(
        false,
      );
    });

    it('passes with a note when the repository has no tags', () => {
      const result = checkRelease(input({ tags: [] }));
      expect(result.ok).toBe(true);
      expect(result.notes.join('\n')).toContain('No version tag');
    });

    it('passes with a note when only unrelated tags exist', () => {
      const result = checkRelease(input({ tags: ['latest', 'backup-2026'] }));
      expect(result.ok).toBe(true);
      expect(result.notes.join('\n')).toContain('No version tag');
    });

    it('passes with a note when git could not be asked', () => {
      const result = checkRelease(input({ tags: null }));
      expect(result.ok).toBe(true);
      expect(result.notes.join('\n')).toContain('Git could not be asked');
    });
  });

  it('reports every problem at once', () => {
    const result = checkRelease({
      version: '1.0.0',
      releases: [entry('0.1.0'), entry('0.2.0')],
      tags: ['v0.1.0-dev'],
      allowMajorBump: false,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('latestVersionTag', () => {
  it('reads v-prefixed, plain and -dev tags', () => {
    expect(latestVersionTag(['v0.1.0-dev'])).toEqual({ tag: 'v0.1.0-dev', version: '0.1.0' });
    expect(latestVersionTag(['2.0.0'])).toEqual({ tag: '2.0.0', version: '2.0.0' });
  });

  it('picks the highest by number', () => {
    expect(latestVersionTag(['v0.9.0', 'v0.10.0', 'v0.2.0'])?.tag).toBe('v0.10.0');
  });

  it('ignores tags that are not versions', () => {
    expect(latestVersionTag(['latest', 'v1', 'release-2', 'v1.2'])).toBeNull();
    expect(latestVersionTag([])).toBeNull();
  });
});

describe('formatReport', () => {
  it('says passed or FAILED and lists errors before notes', () => {
    const failed = formatReport({ ok: false, errors: ['bad'], notes: ['fyi'] });
    expect(failed).toBe('release:check FAILED\n  ✗ bad\n  - fyi');
    expect(formatReport({ ok: true, errors: [], notes: ['fyi'] })).toBe(
      'release:check passed\n  - fyi',
    );
  });
});

describe('readGitTags', () => {
  let dir: string;
  // A git hook can export GIT_DIR and friends; they must not point the test at the real repo.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...args,
      ],
      { cwd: dir, env, stdio: 'ignore' },
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the tags of a repository', () => {
    git('init', '--quiet');
    git('commit', '--allow-empty', '--quiet', '-m', 'first');
    git('tag', 'v0.1.0-dev');
    git('tag', 'v0.2.0');
    expect(readGitTags(dir, env)?.sort()).toEqual(['v0.1.0-dev', 'v0.2.0']);
  });

  it('gives an empty list for a repository without tags', () => {
    git('init', '--quiet');
    git('commit', '--allow-empty', '--quiet', '-m', 'first');
    expect(readGitTags(dir, env)).toEqual([]);
  });

  it("works from a worktree, which shares the main checkout's tags", () => {
    git('init', '--quiet');
    git('commit', '--allow-empty', '--quiet', '-m', 'first');
    git('tag', 'v0.1.0-dev');
    const tree = join(dir, 'tree');
    git('worktree', 'add', '--quiet', '-b', 'side', tree);
    expect(readGitTags(tree, env)).toEqual(['v0.1.0-dev']);
  });

  it('gives null where there is no git repository', () => {
    // GIT_CEILING_DIRECTORIES stops git from finding a repository in a parent of the temp dir.
    expect(readGitTags(dir, { ...env, GIT_CEILING_DIRECTORIES: tmpdir() })).toBeNull();
  });
});
