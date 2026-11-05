import { LUT_MESSAGES, lutDetailSchema, lutSummarySchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { lutPreviewVersion } from '../luts/lut-preview-version.js';
import type { StudioDb } from './database.js';
import {
  LutNameEmptyError,
  LutNameTakenError,
  LutRepository,
  type NewLut,
  newLutId,
  toLutDetail,
  toLutSummary,
} from './lut-repository.js';
import { fakeClock, memoryDb, rawRow, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

/** Ids the tests can predict: 000000000001, 000000000002, … */
function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return n.toString(16).padStart(12, '0');
  };
}

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const repo = new LutRepository(db, { clock, newId: sequentialIds() });
  return { clock, db, repo };
}

const T = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function lutInput(name: string, overrides: Partial<NewLut> = {}): NewLut {
  return {
    name,
    kind: 'look',
    size: 33,
    file: `${name}.cube`,
    bytes: 1_468_006,
    sha256: 'a'.repeat(64),
    sourceName: `${name}.cube`,
    ...overrides,
  };
}

describe('newLutId', () => {
  it('makes 12 hex characters, a new one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLutId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('LutRepository.create', () => {
  it('stores a new LUT with its slug, created and updated now', () => {
    const { repo } = setup();

    const created = repo.create(lutInput('Golden Hour Warm', { sourceName: 'golden hour.CUBE' }));

    expect(created).toEqual({
      id: '000000000001',
      slug: 'golden-hour-warm',
      name: 'Golden Hour Warm',
      kind: 'look',
      size: 33,
      file: 'Golden Hour Warm.cube',
      bytes: 1_468_006,
      sha256: 'a'.repeat(64),
      sourceName: 'golden hour.CUBE',
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    });
    expect(repo.getById(created.id)).toEqual(created);
    expect(repo.getBySlug('golden-hour-warm')).toEqual(created);
  });

  it('cleans the name, and takes a given id', () => {
    const { repo } = setup();
    const created = repo.create(lutInput('  Warm / Cool  ', { id: 'abcdef012345' }));
    expect(created.id).toBe('abcdef012345');
    expect(created.name).toBe('Warm – Cool');
    expect(created.slug).toBe('warm-cool');
  });

  it('gives a name with no Latin letter the slug lut-<first 6 of the id>', () => {
    const { repo } = setup();
    const created = repo.create(lutInput('מראה חם', { id: 'abcdef012345' }));
    expect(created.slug).toBe('lut-abcdef');
    expect(repo.getBySlug('lut-abcdef')?.name).toBe('מראה חם');
  });

  it('refuses an empty name, writing nothing', () => {
    const { repo, db } = setup();
    expect(() => repo.create(lutInput('  ...  '))).toThrow(LutNameEmptyError);
    expect(rawRow(db, 'luts')).toEqual([]);
  });

  it('refuses a name another live LUT has, in any case', () => {
    const { repo } = setup();
    repo.create(lutInput('Golden Hour Warm'));
    expect(() => repo.create(lutInput('golden hour warm'))).toThrow(LutNameTakenError);
    expect(() => repo.create(lutInput('Golden Hour Warm'))).toThrow(LUT_MESSAGES.nameTaken);
    expect(repo.list()).toHaveLength(1);
  });

  it('refuses a name that makes the slug of another LUT', () => {
    const { repo } = setup();
    repo.create(lutInput('Film-Contrast Two'));
    expect(() => repo.create(lutInput('film contrast two!'))).toThrow(LutNameTakenError);
  });

  it('refuses the name or slug of a built-in LUT', () => {
    const { repo } = setup();
    expect(() => repo.create(lutInput('Film contrast'))).toThrow(LutNameTakenError);
    expect(() => repo.create(lutInput('CINEMATIC'))).toThrow(LutNameTakenError);
    expect(() => repo.create(lutInput('s gamut3 to cine'))).toThrow(LutNameTakenError);
    expect(repo.create(lutInput('Film contrast (2)')).slug).toBe('film-contrast-2');
  });

  it('frees a name when its LUT is deleted', () => {
    const { repo } = setup();
    const first = repo.create(lutInput('Golden Hour Warm'));
    expect(repo.softDelete(first.id)).toBe(true);
    const again = repo.create(lutInput('Golden Hour Warm'));
    expect(again.id).not.toBe(first.id);
    expect(again.slug).toBe('golden-hour-warm');
    expect(repo.getBySlug('golden-hour-warm')?.id).toBe(again.id);
  });

  it('never makes an id a deleted LUT had', () => {
    const { repo, db } = setup();
    const first = repo.create(lutInput('One'));
    repo.softDelete(first.id);
    const second = repo.create(lutInput('One'));
    expect(second.id).toBe('000000000002');
    expect(rawRow(db, 'luts')).toHaveLength(2);
  });

  it('refuses a given id that is taken, and fields that do not fit', () => {
    const { repo } = setup();
    repo.create(lutInput('One', { id: 'abcdef012345' }));
    expect(() => repo.create(lutInput('Two', { id: 'abcdef012345' }))).toThrow(/taken/);
    expect(() => repo.create(lutInput('Three', { id: 'nothex' }))).toThrow();
    expect(() => repo.create(lutInput('Three', { size: 1 }))).toThrow();
    expect(() => repo.create(lutInput('Three', { size: 130 }))).toThrow();
    expect(() => repo.create(lutInput('Three', { kind: 'grade' as never }))).toThrow();
    expect(() => repo.create(lutInput('Three', { file: '' }))).toThrow();
    expect(repo.list().map((lut) => lut.name)).toEqual(['One']);
  });
});

describe('LutRepository reads', () => {
  it('lists live LUTs, newest first, ties by newest row', () => {
    const { repo, clock } = setup();
    repo.create(lutInput('First'));
    clock.tick(1000);
    repo.create(lutInput('Second'));
    repo.create(lutInput('Third'));
    const gone = repo.create(lutInput('Gone'));
    repo.softDelete(gone.id);
    expect(repo.list().map((lut) => lut.name)).toEqual(['Third', 'Second', 'First']);
  });

  it('finds nothing for an unknown or deleted LUT', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('One'));
    repo.softDelete(lut.id);
    expect(repo.getById(lut.id)).toBeNull();
    expect(repo.getBySlug('one')).toBeNull();
    expect(repo.getById('ffffffffffff')).toBeNull();
    expect(repo.getBySlug('nope')).toBeNull();
  });

  it('lists the slugs and names Yours cannot take: the live LUTs and the built-in ones', () => {
    const { repo } = setup();
    const mine = repo.create(lutInput('Golden Hour Warm'));
    const slugs = repo.takenSlugs();
    expect(slugs).toContain('golden-hour-warm');
    expect(slugs).toContain('film-contrast');
    expect(slugs).toHaveLength(20);
    expect(repo.takenSlugs(mine.id)).not.toContain('golden-hour-warm');
    expect(repo.takenNames()).toContain('Golden Hour Warm');
    expect(repo.takenNames()).toContain('Film contrast');
    expect(repo.takenNames(mine.id)).not.toContain('Golden Hour Warm');
  });

  it('says whether a name is free', () => {
    const { repo } = setup();
    const mine = repo.create(lutInput('Golden Hour Warm'));
    expect(repo.isNameFree('Soft pastel')).toBe(true);
    expect(repo.isNameFree('golden hour warm')).toBe(false);
    expect(repo.isNameFree('golden hour warm', mine.id)).toBe(true);
    expect(repo.isNameFree('Film Contrast')).toBe(false);
  });
});

describe('LutRepository.rename', () => {
  it('changes the name, the file and the slug, and moves updatedAt', () => {
    const { repo, clock } = setup();
    const lut = repo.create(lutInput('Golden Hour Warm'));
    clock.tick(5000);

    const renamed = repo.rename(lut.id, 'Sunset Amber', 'Sunset Amber.cube');

    expect(renamed).toMatchObject({
      id: lut.id,
      name: 'Sunset Amber',
      file: 'Sunset Amber.cube',
      slug: 'sunset-amber',
      createdAt: T0,
      updatedAt: T(5000),
      sourceName: 'Golden Hour Warm.cube',
    });
    expect(repo.getBySlug('golden-hour-warm')).toBeNull();
    expect(repo.getBySlug('sunset-amber')?.id).toBe(lut.id);
  });

  it('allows its own name in another case, and leaves updatedAt when nothing changes', () => {
    const { repo, clock } = setup();
    const lut = repo.create(lutInput('Golden Hour Warm'));
    clock.tick(5000);
    expect(repo.rename(lut.id, 'Golden Hour Warm', 'Golden Hour Warm.cube')?.updatedAt).toBe(T0);
    expect(repo.rename(lut.id, 'golden hour warm', 'golden hour warm.cube')).toMatchObject({
      name: 'golden hour warm',
      slug: 'golden-hour-warm',
      updatedAt: T(5000),
    });
  });

  it('refuses a name another LUT or a built-in one has, an empty name, keeping the old one', () => {
    const { repo } = setup();
    repo.create(lutInput('Taken'));
    const lut = repo.create(lutInput('Mine'));
    expect(() => repo.rename(lut.id, 'taken', 'taken.cube')).toThrow(LutNameTakenError);
    expect(() => repo.rename(lut.id, 'Warm shift', 'Warm shift.cube')).toThrow(LutNameTakenError);
    expect(() => repo.rename(lut.id, ' ', 'x.cube')).toThrow(LutNameEmptyError);
    expect(repo.getById(lut.id)?.name).toBe('Mine');
  });

  it('answers null for an unknown or deleted LUT', () => {
    const { repo } = setup();
    expect(repo.rename('ffffffffffff', 'X', 'X.cube')).toBeNull();
    const lut = repo.create(lutInput('One'));
    repo.softDelete(lut.id);
    expect(repo.rename(lut.id, 'Two', 'Two.cube')).toBeNull();
  });
});

describe('LutRepository.setKind and softDelete', () => {
  it('changes the kind, and answers null for an unknown LUT', () => {
    const { repo, clock } = setup();
    const lut = repo.create(lutInput('Sony S-Log3 to Rec709'));
    clock.tick(1000);
    expect(repo.setKind(lut.id, 'camera')).toMatchObject({ kind: 'camera', updatedAt: T(1000) });
    expect(repo.setKind('ffffffffffff', 'fix')).toBeNull();
    expect(() => repo.setKind(lut.id, 'grade' as never)).toThrow();
  });

  it('deletes a LUT once: the row stays, marked deleted', () => {
    const { repo, db, clock } = setup();
    const lut = repo.create(lutInput('One'));
    clock.tick(1000);
    expect(repo.softDelete(lut.id)).toBe(true);
    expect(repo.softDelete(lut.id)).toBe(false);
    expect(repo.softDelete('ffffffffffff')).toBe(false);
    expect(repo.list()).toEqual([]);
    expect(rawRow(db, 'luts')).toEqual([
      expect.objectContaining({ id: lut.id, deleted_at: Date.parse(T(1000)) }),
    ]);
  });

  it('keeps the slug unique among live rows in the database itself', () => {
    const { db, repo } = setup();
    const lut = repo.create(lutInput('One'));
    const insert = db.sqlite.prepare(
      `insert into luts (id, slug, name, kind, size, file, bytes, sha256, source_name, created_at, updated_at)
       values (?, 'one', 'Other', 'look', 33, 'o.cube', 1, 'x', 'o.cube', 1, 1)`,
    );
    expect(() => insert.run('000000000099')).toThrow(/UNIQUE/);
    repo.softDelete(lut.id);
    expect(() => insert.run('000000000099')).not.toThrow();
  });
});

describe('LutRepository uses', () => {
  it('counts the distinct jobs that used a LUT, whatever the round', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('One'));
    expect(repo.usedCount(lut.id)).toBe(0);
    repo.addUse(lut.id, 'job-a', 0);
    repo.addUse(lut.id, 'job-a', 1);
    repo.addUse(lut.id, 'job-b', 2);
    expect(repo.usedCount(lut.id)).toBe(2);
    expect(repo.usedCount('film-contrast')).toBe(0);
  });

  it('records the same use once, and moves its time', () => {
    const { repo, db, clock } = setup();
    repo.addUse('film-contrast', 'job-a', 0);
    clock.tick(5000);
    repo.addUse('film-contrast', 'job-a', 0);
    expect(rawRow(db, 'lut_uses')).toEqual([
      { lut_key: 'film-contrast', job_id: 'job-a', round: 0, at: Date.parse(T(5000)) },
    ]);
    repo.addUse('film-contrast', 'job-a', 0, T(9000));
    expect(rawRow(db, 'lut_uses')).toEqual([expect.objectContaining({ at: Date.parse(T(9000)) })]);
  });

  it('counts a built-in LUT by its slug and a LUT of Yours by its id, in one map', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('One'));
    repo.addUse(lut.id, 'job-a', 0);
    repo.addUse(lut.id, 'job-b', 0);
    repo.addUse('film-contrast', 'job-a', 0);
    repo.addUse('film-contrast', 'job-a', 1);
    expect(repo.usedCounts()).toEqual(
      new Map([
        [lut.id, 2],
        ['film-contrast', 1],
      ]),
    );
    expect(setup().repo.usedCounts()).toEqual(new Map());
  });

  it('keeps the uses of a deleted LUT', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('One'));
    repo.addUse(lut.id, 'job-a', 0);
    repo.softDelete(lut.id);
    expect(repo.usedCount(lut.id)).toBe(1);
  });

  it('refuses a use that does not fit', () => {
    const { repo } = setup();
    expect(() => repo.addUse('', 'job-a', 0)).toThrow();
    expect(() => repo.addUse('film-contrast', '', 0)).toThrow();
    expect(() => repo.addUse('film-contrast', 'job-a', -1)).toThrow();
    expect(() => repo.addUse('film-contrast', 'job-a', 1.5)).toThrow();
    expect(() => repo.addUse('film-contrast', 'job-a', 0, 'yesterday')).toThrow();
  });
});

describe('toLutSummary and toLutDetail', () => {
  it('writes the list line: Yours, the used words, the added time and the New tag', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('Golden Hour Warm'));

    const fresh = toLutSummary(lut, 0, T(60_000));
    expect(lutSummarySchema.parse(fresh)).toEqual({
      slug: 'golden-hour-warm',
      name: 'Golden Hour Warm',
      kind: 'look',
      size: 33,
      owner: 'yours',
      used: 0,
      usedLabel: 'Not used yet',
      addedAt: T0,
      isNew: true,
      // 8 hex characters of a hash of the file's sha256 and the kind: the page puts it on the stills.
      previewKey: lutPreviewVersion('a'.repeat(64), 'look'),
    });
    expect(fresh.previewKey).toMatch(/^[0-9a-f]{8}$/);
    expect(toLutSummary({ ...lut, kind: 'camera' }, 0).previewKey).not.toBe(fresh.previewKey);
    expect(toLutSummary({ ...lut, sha256: 'not a hash' }, 0).previewKey).toBeNull();
    expect(toLutSummary(lut, 3, T(31 * 60_000))).toMatchObject({
      used: 3,
      usedLabel: '3 jobs',
      isNew: false,
    });
    expect(toLutSummary(lut, 1, T(31 * 60_000)).usedLabel).toBe('1 job');
  });

  it('writes the pane: the file, the size facts, the bytes and Used in', () => {
    const { repo } = setup();
    const lut = repo.create(lutInput('Golden Hour Warm'));

    const detail = toLutDetail(lut, 2, 2, T(60_000));

    expect(lutDetailSchema.parse(detail)).toEqual({
      ...toLutSummary(lut, 2, T(60_000)),
      description: '',
      note: null,
      file: 'Golden Hour Warm.cube',
      sizeLabel: '33 × 33 × 33',
      bytes: 1_468_006,
      usedIn: 2,
    });
    expect(toLutDetail(lut, 2, null, T(60_000)).usedIn).toBeNull();
  });
});
