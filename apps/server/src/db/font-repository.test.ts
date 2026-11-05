import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import {
  FONT_USE_ANY_WEIGHT,
  FontRepository,
  type NewFontUse,
  newFontRowId,
} from './font-repository.js';
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
  const repo = new FontRepository(db, { clock, newId: sequentialIds() });
  return { clock, db, repo };
}

const T = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function use(overrides: Partial<NewFontUse> = {}): NewFontUse {
  return {
    family: 'Heebo',
    weight: 700,
    italic: false,
    jobId: 'job-a',
    round: 0,
    source: 'token',
    ...overrides,
  };
}

describe('newFontRowId', () => {
  it('makes 12 hex characters, a new one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newFontRowId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('FontRepository.addUse', () => {
  it('stores a use with its id and the time now', () => {
    const { repo, db } = setup();

    expect(repo.addUse(use())).toBe(true);

    expect(rawRow(db, 'font_uses')).toEqual([
      {
        id: '000000000001',
        family: 'Heebo',
        weight: 700,
        italic: 0,
        job_id: 'job-a',
        round: 0,
        source: 'token',
        at: Date.parse(T0),
      },
    ]);
  });

  it('stores italic as 1 and takes the time it is given', () => {
    const { repo, db } = setup();
    repo.addUse(use({ family: 'Merriweather', weight: 400, italic: true }), T(5000));
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ family: 'Merriweather', italic: 1, at: Date.parse(T(5000)) }),
    ]);
  });

  it('ignores an exact duplicate, whatever the case of the family, and keeps the first time', () => {
    const { repo, db, clock } = setup();
    expect(repo.addUse(use())).toBe(true);
    clock.tick(5000);
    expect(repo.addUse(use())).toBe(false);
    expect(repo.addUse(use({ family: 'heebo' }))).toBe(false);
    expect(repo.addUse(use({ family: '  HEEBO ' }))).toBe(false);
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ family: 'Heebo', at: Date.parse(T0) }),
    ]);
  });

  it('adds a row when anything else differs: weight, italic, job, round or source', () => {
    const { repo, db } = setup();
    repo.addUse(use());
    for (const other of [
      use({ weight: 400 }),
      use({ italic: true }),
      use({ jobId: 'job-b' }),
      use({ round: 1 }),
      use({ source: 'composition' }),
      use({ family: 'Rubik' }),
    ]) {
      expect(repo.addUse(other)).toBe(true);
    }
    expect(rawRow(db, 'font_uses')).toHaveLength(7);
  });

  it('takes weight 0 for a use that names no weight, once per family, job, round and source', () => {
    const { repo, db } = setup();
    const any = (overrides: Partial<NewFontUse> = {}) =>
      use({ weight: FONT_USE_ANY_WEIGHT, source: 'composition', ...overrides });

    expect(FONT_USE_ANY_WEIGHT).toBe(0);
    expect(repo.addUse(any())).toBe(true);
    expect(repo.addUse(any({ family: 'HEEBO' }))).toBe(false);
    expect(repo.addUse(any({ round: 1 }))).toBe(true);
    expect(repo.addUse(use({ source: 'composition' }))).toBe(true);

    expect((rawRow(db, 'font_uses') as { weight: number }[]).map((row) => row.weight)).toEqual([
      0, 0, 700,
    ]);
  });

  it('refuses a use that does not fit, writing nothing', () => {
    const { repo, db } = setup();
    expect(() => repo.addUse(use({ family: '' }))).toThrow();
    expect(() => repo.addUse(use({ weight: 450 }))).toThrow();
    expect(() => repo.addUse(use({ weight: -100 }))).toThrow();
    expect(() => repo.addUse(use({ weight: 1000 }))).toThrow();
    expect(() => repo.addUse(use({ jobId: '' }))).toThrow();
    expect(() => repo.addUse(use({ round: -1 }))).toThrow();
    expect(() => repo.addUse(use({ round: 1.5 }))).toThrow();
    expect(() => repo.addUse(use({ source: 'guess' as 'token' }))).toThrow();
    expect(() => repo.addUse(use(), 'yesterday')).toThrow();
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });
});

describe('FontRepository.usedCounts and usedCount', () => {
  it('counts the distinct jobs that used a family, whatever the weight, round or source', () => {
    const { repo } = setup();
    expect(repo.usedCount('Heebo')).toBe(0);
    repo.addUse(use({ jobId: 'job-a', weight: 700 }));
    repo.addUse(use({ jobId: 'job-a', weight: 400 }));
    repo.addUse(use({ jobId: 'job-a', round: 2 }));
    repo.addUse(use({ jobId: 'job-a', source: 'composition' }));
    repo.addUse(use({ jobId: 'job-b' }));
    repo.addUse(use({ family: 'Rubik', jobId: 'job-a' }));

    expect(repo.usedCount('Heebo')).toBe(2);
    expect(repo.usedCount('Rubik')).toBe(1);
    expect(repo.usedCount('Outfit')).toBe(0);
  });

  it('counts a job that used a family at weight 0 (any) like one that named a weight', () => {
    const { repo } = setup();
    repo.addUse(use({ jobId: 'job-a', weight: FONT_USE_ANY_WEIGHT, source: 'composition' }));
    repo.addUse(use({ jobId: 'job-a', weight: 700 }));
    repo.addUse(use({ jobId: 'job-b', weight: FONT_USE_ANY_WEIGHT, source: 'composition' }));

    expect(repo.usedCount('Heebo')).toBe(2);
    expect([...repo.usedCounts()]).toEqual([['heebo', 2]]);
  });

  it('does not tell the case of a family apart', () => {
    const { repo } = setup();
    repo.addUse(use({ family: 'Heebo', jobId: 'job-a' }));
    repo.addUse(use({ family: 'HEEBO', jobId: 'job-b', weight: 400 }));
    repo.addUse(use({ family: 'heebo', jobId: 'job-a', weight: 300 }));

    expect(repo.usedCount('heebo')).toBe(2);
    expect(repo.usedCount(' Heebo ')).toBe(2);
    expect(repo.usedCounts()).toEqual(new Map([['heebo', 2]]));
  });

  it('keys the map by fontNameKey(family): lower case, doubled spaces collapsed', () => {
    const { repo } = setup();
    repo.addUse(use({ family: 'Noto Sans Hebrew', jobId: 'job-a' }));
    repo.addUse(use({ family: 'Noto  Sans  Hebrew', jobId: 'job-b' }));
    repo.addUse(use({ family: 'Rubik', jobId: 'job-a' }));

    expect(repo.usedCounts()).toEqual(
      new Map([
        ['noto sans hebrew', 2],
        ['rubik', 1],
      ]),
    );
  });

  it('is empty when no job used a font', () => {
    expect(setup().repo.usedCounts()).toEqual(new Map());
  });
});

describe('FontRepository.addRequest', () => {
  it('stores an open request with its id and returns it', () => {
    const { repo, db } = setup();

    const request = repo.addRequest('Gotham Bold', 'job-a', 1);

    expect(request).toEqual({
      id: '000000000001',
      name: 'Gotham Bold',
      jobId: 'job-a',
      round: 1,
      at: T0,
      resolvedAt: null,
      dismissedAt: null,
    });
    expect(rawRow(db, 'font_requests')).toEqual([
      {
        id: '000000000001',
        name: 'Gotham Bold',
        job_id: 'job-a',
        round: 1,
        at: Date.parse(T0),
        resolved_at: null,
        dismissed_at: null,
      },
    ]);
  });

  it('takes the time it is given', () => {
    const { repo } = setup();
    expect(repo.addRequest('Gotham', 'job-a', 0, T(9000)).at).toBe(T(9000));
  });

  it('does not add the same open request twice: the one that is open comes back', () => {
    const { repo, db } = setup();
    const first = repo.addRequest('Gotham Bold', 'job-a', 1);
    expect(repo.addRequest('gotham  bold', 'job-a', 1, T(60_000))).toEqual(first);
    expect(rawRow(db, 'font_requests')).toHaveLength(1);

    // Another job, another round or another name is another request.
    repo.addRequest('Gotham Bold', 'job-b', 1);
    repo.addRequest('Gotham Bold', 'job-a', 2);
    repo.addRequest('Gotham Black', 'job-a', 1);
    expect(rawRow(db, 'font_requests')).toHaveLength(4);
  });

  it('adds the request again once the earlier one was resolved', () => {
    const { repo, db } = setup();
    repo.addRequest('Gotham Bold', 'job-a', 1);
    repo.resolveRequests('Gotham Bold', T(1000));
    const again = repo.addRequest('Gotham Bold', 'job-a', 1, T(2000));
    expect(again).toMatchObject({ id: '000000000002', resolvedAt: null });
    expect(rawRow(db, 'font_requests')).toHaveLength(2);
  });

  it('refuses what does not fit, writing nothing', () => {
    const { repo, db } = setup();
    expect(() => repo.addRequest('', 'job-a', 0)).toThrow();
    expect(() => repo.addRequest('Gotham', '', 0)).toThrow();
    expect(() => repo.addRequest('Gotham', 'job-a', -1)).toThrow();
    expect(() => repo.addRequest('Gotham', 'job-a', 0.5)).toThrow();
    expect(() => repo.addRequest('Gotham', 'job-a', 0, 'last week')).toThrow();
    expect(rawRow(db, 'font_requests')).toEqual([]);
  });
});

describe('FontRepository.recordRequest', () => {
  it('says the request is new the first time and not the second (a retry reads the same note)', () => {
    const { repo, db } = setup();

    const first = repo.recordRequest('Gotham Bold', 'job-a', 1);
    const again = repo.recordRequest('gotham  bold', 'job-a', 1, T(60_000));

    expect(first).toEqual({
      added: true,
      request: expect.objectContaining({ name: 'Gotham Bold', jobId: 'job-a', round: 1 }),
    });
    expect(again).toEqual({ added: false, request: first.request });
    expect(rawRow(db, 'font_requests')).toHaveLength(1);
  });

  it('says a new request is new again once the earlier one was resolved', () => {
    const { repo } = setup();
    repo.recordRequest('Gotham Bold', 'job-a', 1);
    repo.resolveRequests('Gotham Bold', T(1000));
    expect(repo.recordRequest('Gotham Bold', 'job-a', 1, T(2000)).added).toBe(true);
  });
});

describe('FontRepository.dismissRequest ("Not a font", C52)', () => {
  it('dismisses the request: it stops being open and keeps the time it was dismissed', () => {
    const { repo, db } = setup();
    const gotham = repo.addRequest('Gotham Bold', 'job-a', 0);
    const outfit = repo.addRequest('Outfit', 'job-a', 0);
    const falcon = repo.addRequest('Falcon', 'job-b', 0);

    expect(repo.dismissRequest(falcon.id, T(5000))).toBe(1);

    expect(repo.openRequests(0).map((request) => request.id)).toEqual([outfit.id, gotham.id]);
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Gotham Bold', resolved_at: null, dismissed_at: null }),
      expect.objectContaining({ name: 'Outfit', resolved_at: null, dismissed_at: null }),
      expect.objectContaining({
        name: 'Falcon',
        resolved_at: Date.parse(T(5000)),
        dismissed_at: Date.parse(T(5000)),
      }),
    ]);
  });

  it('dismisses the other open requests of the same job for the same name, and nothing else', () => {
    const { repo } = setup();
    const round0 = repo.addRequest('Falcon', 'job-a', 0);
    repo.addRequest('FALCON', 'job-a', 2);
    repo.addRequest('Falcon', 'job-b', 0);
    repo.addRequest('Falcon Cohen', 'job-a', 0);

    expect(repo.dismissRequest(round0.id)).toBe(2);

    expect(repo.openRequests(0).map((request) => [request.name, request.jobId])).toEqual([
      ['Falcon Cohen', 'job-a'],
      ['Falcon', 'job-b'],
    ]);
  });

  it('takes the clock for the time when none is given', () => {
    const { repo, db, clock } = setup();
    const request = repo.addRequest('Falcon', 'job-a', 0);
    clock.tick(3000);
    repo.dismissRequest(request.id);
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ dismissed_at: Date.parse(T(3000)) }),
    ]);
  });

  it('says 0 and changes nothing for a request that is settled already, null for an unknown id', () => {
    const { repo, db } = setup();
    const dismissed = repo.addRequest('Falcon', 'job-a', 0);
    const imported = repo.addRequest('Outfit', 'job-a', 0);
    expect(repo.dismissRequest(dismissed.id, T(1000))).toBe(1);
    repo.resolveRequests('Outfit', T(2000));

    expect(repo.dismissRequest(dismissed.id, T(9000))).toBe(0);
    // An import answered it: it was never "not a font", so it is not marked as dismissed.
    expect(repo.dismissRequest(imported.id, T(9000))).toBe(0);
    expect(repo.dismissRequest('0123456789ab')).toBeNull();

    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ dismissed_at: Date.parse(T(1000)) }),
      expect.objectContaining({ resolved_at: Date.parse(T(2000)), dismissed_at: null }),
    ]);
  });

  it('refuses an empty id or a time that is not one', () => {
    const { repo } = setup();
    expect(() => repo.dismissRequest('')).toThrow();
    expect(() => repo.dismissRequest('0123456789ab', 'soon')).toThrow();
  });

  it('is not answered twice by an import of that name', () => {
    const { repo } = setup();
    const request = repo.addRequest('Falcon', 'job-a', 0);
    repo.dismissRequest(request.id, T(1000));
    expect(repo.resolveRequests('Falcon', T(2000))).toBe(0);
  });
});

describe('a dismissed name is not recorded again (C52)', () => {
  it('stays out in the same round and in every later round of the same job, whatever the case', () => {
    const { repo, db } = setup();
    const first = repo.recordRequest('Falcon', 'job-a', 0);
    repo.dismissRequest(first.request.id, T(1000));

    const sameRound = repo.recordRequest('falcon', 'job-a', 0, T(2000));
    const laterRound = repo.recordRequest('Falcon', 'job-a', 3, T(3000));

    expect(sameRound.added).toBe(false);
    expect(sameRound.request.id).toBe(first.request.id);
    expect(laterRound.added).toBe(false);
    expect(laterRound.request.id).toBe(first.request.id);
    expect(rawRow(db, 'font_requests')).toHaveLength(1);
    expect(repo.openRequests(0)).toEqual([]);
  });

  it('still records the name for another job, and another name for the same job', () => {
    const { repo } = setup();
    const first = repo.recordRequest('Falcon', 'job-a', 0);
    repo.dismissRequest(first.request.id);

    expect(repo.recordRequest('Falcon', 'job-b', 0).added).toBe(true);
    expect(repo.recordRequest('Gotham Bold', 'job-a', 1).added).toBe(true);
  });

  it('asks again after an import answered it (that name was a font once, and is gone)', () => {
    const { repo } = setup();
    repo.recordRequest('Outfit', 'job-a', 0);
    repo.resolveRequests('Outfit', T(1000));
    expect(repo.recordRequest('Outfit', 'job-a', 1, T(2000)).added).toBe(true);
  });

  it('keeps one request per round for a name nobody dismissed', () => {
    const { repo } = setup();
    expect(repo.recordRequest('Falcon', 'job-a', 0).added).toBe(true);
    expect(repo.recordRequest('Falcon', 'job-a', 1).added).toBe(true);
    expect(repo.recordRequest('Falcon', 'job-a', 1).added).toBe(false);
  });
});

describe('FontRepository.openRequests', () => {
  it('lists the requests nobody resolved that are newer than the cutoff, newest first', () => {
    const { repo } = setup();
    repo.addRequest('Old', 'job-a', 0, T(-8 * DAY));
    repo.addRequest('Edge', 'job-a', 0, T(-7 * DAY));
    repo.addRequest('Recent', 'job-a', 0, T(-1 * DAY));
    repo.addRequest('Newest', 'job-b', 2, T(0));

    const open = repo.openRequests(Date.parse(T(-7 * DAY)));

    expect(open.map((request) => request.name)).toEqual(['Newest', 'Recent']);
    expect(open[0]).toMatchObject({
      jobId: 'job-b',
      round: 2,
      at: T(0),
      resolvedAt: null,
      dismissedAt: null,
    });
  });

  it('keeps the order of writing for requests made in the same millisecond', () => {
    const { repo } = setup();
    repo.addRequest('First', 'job-a', 0);
    repo.addRequest('Second', 'job-a', 0);
    repo.addRequest('Third', 'job-a', 0);
    expect(repo.openRequests(0).map((request) => request.name)).toEqual([
      'Third',
      'Second',
      'First',
    ]);
  });

  it('leaves out the resolved ones, and is empty when there are none', () => {
    const { repo } = setup();
    expect(repo.openRequests(0)).toEqual([]);
    repo.addRequest('Gotham', 'job-a', 0);
    repo.addRequest('Outfit', 'job-a', 0);
    repo.resolveRequests('Outfit');
    expect(repo.openRequests(0).map((request) => request.name)).toEqual(['Gotham']);
  });
});

describe('FontRepository.resolveRequests', () => {
  it('resolves every open request with that name, whatever the case, and says how many', () => {
    const { repo, db } = setup();
    repo.addRequest('Outfit Bold', 'job-a', 0);
    repo.addRequest('outfit bold', 'job-b', 1);
    repo.addRequest('Outfit', 'job-c', 0);
    repo.addRequest('Gotham', 'job-a', 0);

    expect(repo.resolveRequests('OUTFIT BOLD', T(5000))).toBe(2);

    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Outfit Bold', resolved_at: Date.parse(T(5000)) }),
      expect.objectContaining({ name: 'outfit bold', resolved_at: Date.parse(T(5000)) }),
      expect.objectContaining({ name: 'Outfit', resolved_at: null }),
      expect.objectContaining({ name: 'Gotham', resolved_at: null }),
    ]);
  });

  it('takes the clock for the time when none is given', () => {
    const { repo, db, clock } = setup();
    repo.addRequest('Outfit', 'job-a', 0);
    clock.tick(3000);
    repo.resolveRequests('Outfit');
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ resolved_at: Date.parse(T(3000)) }),
    ]);
  });

  it('does not touch a request that is already resolved, and says 0 for an unknown name', () => {
    const { repo, db } = setup();
    repo.addRequest('Outfit', 'job-a', 0);
    expect(repo.resolveRequests('Outfit', T(1000))).toBe(1);
    expect(repo.resolveRequests('Outfit', T(9000))).toBe(0);
    expect(repo.resolveRequests('Nothing')).toBe(0);
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ resolved_at: Date.parse(T(1000)) }),
    ]);
  });

  it('refuses an empty name or a time that is not one', () => {
    const { repo } = setup();
    expect(() => repo.resolveRequests('')).toThrow();
    expect(() => repo.resolveRequests('Outfit', 'soon')).toThrow();
  });
});
