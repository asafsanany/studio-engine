import { describe, expect, it } from 'vitest';
import rootPackage from '../../../package.json' with { type: 'json' };
import {
  compareVersions,
  findRelease,
  formatReleaseDate,
  parseVersion,
  RELEASES,
  type Release,
  releaseSchema,
  releasesSchema,
  releasesToShow,
  versionSchema,
} from './releases.ts';

function release(version: string, items: string[] = [`Change in ${version}.`]): Release {
  return { version, date: '2026-10-22', items };
}

describe('parseVersion', () => {
  it('reads X.Y.Z as three numbers', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('12.0.345')).toEqual([12, 0, 345]);
  });

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-dev',
    '1.2.x',
    '01.2.3',
    '1.2.3 ',
    '-1.2.3',
  ])('rejects %j', (text) => {
    expect(parseVersion(text)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
  });

  it('is 0 for equal versions', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('lets X win over Y and Y over Z', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.1', '0.2.0')).toBe(-1);
  });

  it('throws on something that is not X.Y.Z', () => {
    expect(() => compareVersions('nope', '0.1.0')).toThrow(RangeError);
    expect(() => compareVersions('0.1.0', '1.2')).toThrow(/"1\.2"/);
  });
});

describe('formatReleaseDate', () => {
  it('shows day, short month and year', () => {
    expect(formatReleaseDate('2026-10-22')).toBe('22 Oct 2026');
    expect(formatReleaseDate('2027-01-05')).toBe('5 Jan 2027');
    expect(formatReleaseDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('returns anything else unchanged', () => {
    expect(formatReleaseDate('soon')).toBe('soon');
    expect(formatReleaseDate('2026-13-01')).toBe('2026-13-01');
  });
});

describe('release schema', () => {
  it('accepts a normal entry', () => {
    expect(releaseSchema.safeParse(release('0.1.1')).success).toBe(true);
  });

  it('accepts a screenshot file name', () => {
    expect(
      releaseSchema.safeParse({ ...release('0.1.1'), screenshot: '0.1.1-jobs.png' }).success,
    ).toBe(true);
  });

  it.each([
    ['a v prefix', { ...release('0.1.1'), version: 'v0.1.1' }],
    ['a non-date', { ...release('0.1.1'), date: 'October' }],
    ['an impossible date', { ...release('0.1.1'), date: '2026-02-30' }],
    ['no items', { ...release('0.1.1'), items: [] }],
    ['a blank item', { ...release('0.1.1'), items: ['  '] }],
    ['an unknown key', { ...release('0.1.1'), notes: 'x' }],
    [
      'a screenshot that is not an image file name',
      { ...release('0.1.1'), screenshot: '../a.txt' },
    ],
  ])('rejects %s', (_name, value) => {
    expect(releaseSchema.safeParse(value).success).toBe(false);
  });

  it('only accepts X.Y.Z as a version', () => {
    expect(versionSchema.safeParse('0.1.0').success).toBe(true);
    expect(versionSchema.safeParse('0.1').success).toBe(false);
  });
});

describe('RELEASES (the real release notes)', () => {
  it('is valid', () => {
    expect(releasesSchema.safeParse(RELEASES).error).toBeUndefined();
  });

  it('is newest first with strictly decreasing versions', () => {
    for (let i = 1; i < RELEASES.length; i++) {
      const newer = RELEASES[i - 1] as Release;
      const older = RELEASES[i] as Release;
      expect(
        compareVersions(newer.version, older.version),
        `${newer.version} / ${older.version}`,
      ).toBe(1);
    }
  });

  it('has an entry for the current app version (root package.json)', () => {
    expect(findRelease(RELEASES, rootPackage.version)).toBeDefined();
  });

  it('starts with 0.1.0, the first release of Phase 0', () => {
    expect(RELEASES.at(-1)?.version).toBe('0.1.0');
  });

  it('is written as short plain sentences, three to six per release for 0.1.0', () => {
    const first = findRelease(RELEASES, '0.1.0') as Release;
    expect(first.items.length).toBeGreaterThanOrEqual(3);
    expect(first.items.length).toBeLessThanOrEqual(6);
    for (const item of first.items) expect(item).toMatch(/\.$/);
  });
});

describe('findRelease', () => {
  it('matches the exact version only', () => {
    const list = [release('0.1.1'), release('0.1.0')];
    expect(findRelease(list, '0.1.0')).toBe(list[1]);
    expect(findRelease(list, '0.1')).toBeUndefined();
    expect(findRelease(list, '0.2.0')).toBeUndefined();
  });
});

describe('releasesToShow', () => {
  // Newest first, as in the real file.
  const all = [release('0.2.0'), release('0.1.2'), release('0.1.1'), release('0.1.0')];
  const versions = (list: Release[]) => list.map((r) => r.version);

  it('shows every release after the last seen one, oldest first', () => {
    expect(versions(releasesToShow(all, '0.1.0', '0.2.0'))).toEqual(['0.1.1', '0.1.2', '0.2.0']);
  });

  it('shows a single unseen release on its own', () => {
    expect(versions(releasesToShow(all, '0.1.1', '0.1.2'))).toEqual(['0.1.2']);
  });

  it('shows nothing when the last seen version is the current one', () => {
    expect(releasesToShow(all, '0.2.0', '0.2.0')).toEqual([]);
  });

  it('on a first ever open shows only the current version', () => {
    expect(versions(releasesToShow(all, null, '0.2.0'))).toEqual(['0.2.0']);
    expect(versions(releasesToShow(all, undefined, '0.1.1'))).toEqual(['0.1.1']);
  });

  it('treats a stored value that is not a version like a first open', () => {
    expect(versions(releasesToShow(all, 'garbage', '0.2.0'))).toEqual(['0.2.0']);
    expect(versions(releasesToShow(all, '', '0.2.0'))).toEqual(['0.2.0']);
  });

  it('never shows a release newer than the running app', () => {
    expect(versions(releasesToShow(all, '0.1.0', '0.1.1'))).toEqual(['0.1.1']);
    expect(releasesToShow(all, null, '0.3.0')).toEqual([]);
  });

  it('shows nothing after a downgrade', () => {
    expect(releasesToShow(all, '0.2.0', '0.1.1')).toEqual([]);
  });

  it('compares versions as numbers', () => {
    const list = [release('0.10.0'), release('0.9.0'), release('0.2.0')];
    expect(versions(releasesToShow(list, '0.2.0', '0.10.0'))).toEqual(['0.9.0', '0.10.0']);
  });

  it('skips a version that has no entry', () => {
    const gappy = [release('0.1.2'), release('0.1.0')];
    expect(versions(releasesToShow(gappy, '0.1.0', '0.1.2'))).toEqual(['0.1.2']);
    expect(releasesToShow(gappy, null, '0.1.1')).toEqual([]);
  });

  it('does not reorder or change the list it is given', () => {
    const copy = JSON.parse(JSON.stringify(all)) as Release[];
    releasesToShow(all, '0.1.0', '0.2.0');
    expect(all).toEqual(copy);
  });

  it('returns nothing when the current version is not X.Y.Z', () => {
    expect(releasesToShow(all, '0.1.0', 'dev')).toEqual([]);
  });
});
