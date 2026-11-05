import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FontChangedEvent, Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { FontRepository } from '../db/font-repository.js';
import { fakeClock, memoryDb, rawRow } from '../db/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import type { RunContext, Runner, RunOutcome } from '../pipeline/runner.js';
import type { FontService } from './font-service.js';
import {
  backfillFontUses,
  FONT_USES_BACKFILL_MARKER,
  fontUseRound,
  libraryFamilies,
  recordFontUses,
  withFontUses,
} from './font-uses.js';
import { fakeFontService, makeFontFamilySummary } from './test-utils.js';

// "Used in" for fonts (FN17): the rows a finished edit leaves, the event, the hook after a run and
// the one-time backfill. Real files in a temp inbox, a real repository on an in-memory database.

let root: string;
let dataDir: string;
let db: StudioDb;
let repo: FontRepository;
const warn = vi.fn();
const info = vi.fn();
const logger = { info, warn, error: vi.fn() };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-font-uses-'));
  dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  db = memoryDb();
  let n = 0;
  // Ids in the order they are made, so a row listed by id is listed in the order it was recorded.
  repo = new FontRepository(db, {
    clock: fakeClock(),
    newId: () => (++n).toString(16).padStart(12, '0'),
  });
  warn.mockClear();
  info.mockClear();
});

afterEach(async () => {
  if (db.sqlite.open) db.close();
  await rm(root, { recursive: true, force: true });
});

const inbox = () => join(root, 'inbox');

async function put(path: string, text: string): Promise<void> {
  const file = join(inbox(), path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** The edit of a job (`<Client>/<Job>`), whose preview names these families. */
async function editOf(relPath: string, ...families: string[]): Promise<void> {
  const css = families.map((family) => `.x { font-family: "${family}", sans-serif }`).join('\n');
  await put(`${relPath}/edit/preview/index.html`, `<style>${css}</style>`);
}

/** The font service as the index tells it: one face per family. */
function libraryOf(...families: string[]): Pick<FontService, 'catalog' | 'list'> {
  return fakeFontService({
    catalog: async () => ({
      faces: families.map((family) => ({
        name: family,
        family,
        weight: 400,
        italic: false,
        file: `${family}/${family}-Regular.ttf`,
        he: true,
      })),
    }),
  });
}

const LIBRARY = libraryOf('Heebo', 'Rubik', 'Secular One', 'Outfit');

const options = () => ({ repo, fonts: LIBRARY, logger });

interface UseRow {
  family: string;
  weight: number;
  italic: number;
  job_id: string;
  round: number;
  source: string;
}

/** The font_uses rows, in the order they were recorded. */
const rows = (): UseRow[] =>
  (rawRow(db, 'font_uses') as UseRow[]).map(
    ({ family, weight, italic, job_id, round, source }) => ({
      family,
      weight,
      italic,
      job_id,
      round,
      source,
    }),
  );

describe('fontUseRound', () => {
  it('is 0 for the edit and the review round for a revise run', () => {
    expect(fontUseRound({ runKind: 'edit', round: 0 })).toBe(0);
    expect(fontUseRound({ runKind: 'edit', round: 2 })).toBe(0);
    expect(fontUseRound({ runKind: 'revise', round: 3 })).toBe(3);
  });
});

describe('libraryFamilies', () => {
  it('asks the index for the families, each once, as it spells them', async () => {
    const fonts = fakeFontService({
      catalog: async () => ({
        faces: ['Heebo', 'Heebo', 'Secular One'].map((family, i) => ({
          name: family,
          family,
          weight: 400 + i * 100,
          italic: false,
          file: `x/${i}.ttf`,
          he: true,
        })),
      }),
    });

    expect(await libraryFamilies(fonts)).toEqual(['Heebo', 'Secular One']);
  });
});

describe('recordFontUses', () => {
  it('writes one composition row per family found: weight 0 (any), upright, round 0', async () => {
    await editOf('Acme/Spring', 'Heebo', 'Secular One', 'Gotham');
    const job = makeJob({ id: 'job-spring', runKind: 'edit' });

    const found = await recordFontUses(options(), job, join(inbox(), 'Acme/Spring'));

    expect(found).toEqual(['Heebo', 'Secular One']);
    expect(rows()).toEqual([
      {
        family: 'Heebo',
        weight: 0,
        italic: 0,
        job_id: 'job-spring',
        round: 0,
        source: 'composition',
      },
      {
        family: 'Secular One',
        weight: 0,
        italic: 0,
        job_id: 'job-spring',
        round: 0,
        source: 'composition',
      },
    ]);
  });

  it('matches only the families the index has', async () => {
    await editOf('Acme/Spring', 'Heebo', 'Rubik');

    await recordFontUses(
      { ...options(), fonts: libraryOf('Rubik') },
      makeJob({ id: 'job-spring' }),
      join(inbox(), 'Acme/Spring'),
    );

    expect(rows().map((row) => row.family)).toEqual(['Rubik']);
  });

  it('records a revise run in its review round', async () => {
    await editOf('Acme/Spring', 'Heebo');
    const dir = join(inbox(), 'Acme/Spring');

    await recordFontUses(options(), makeJob({ id: 'job-spring', runKind: 'edit' }), dir);
    await recordFontUses(
      options(),
      makeJob({ id: 'job-spring', runKind: 'revise', round: 1 }),
      dir,
    );
    await recordFontUses(
      options(),
      makeJob({ id: 'job-spring', runKind: 'revise', round: 2 }),
      dir,
    );

    expect(rows().map((row) => row.round)).toEqual([0, 1, 2]);
    expect(repo.usedCount('Heebo')).toBe(1);
  });

  it('records the same round once, however often the run is repeated', async () => {
    await editOf('Acme/Spring', 'Heebo', 'Rubik');
    const dir = join(inbox(), 'Acme/Spring');
    const job = makeJob({ id: 'job-spring', runKind: 'revise', round: 1 });

    await recordFontUses(options(), job, dir);
    await recordFontUses(options(), job, dir);

    expect(rows()).toHaveLength(2);
  });

  it('counts the distinct jobs: two jobs using Heebo is "Used in 2 jobs"', async () => {
    await editOf('Acme/Spring', 'Heebo', 'Rubik');
    await editOf('Acme/Summer', 'HEEBO');
    await editOf('Acme/Autumn', 'Outfit');

    for (const [id, name] of [
      ['job-spring', 'Spring'],
      ['job-summer', 'Summer'],
      ['job-autumn', 'Autumn'],
    ] as const) {
      await recordFontUses(options(), makeJob({ id }), join(inbox(), 'Acme', name));
    }

    expect(repo.usedCount('Heebo')).toBe(2);
    expect(repo.usedCount('Rubik')).toBe(1);
    expect(repo.usedCount('Outfit')).toBe(1);
    expect(repo.usedCount('Secular One')).toBe(0);
  });

  it('records nothing for an edit with no known font, a job with no edit, or an empty library', async () => {
    await editOf('Acme/Spring', 'Gotham');
    const spring = join(inbox(), 'Acme/Spring');
    expect(await recordFontUses(options(), makeJob(), spring)).toEqual([]);
    expect(await recordFontUses(options(), makeJob(), join(inbox(), 'Acme/Nothing'))).toEqual([]);

    await editOf('Acme/Summer', 'Heebo');
    const summer = join(inbox(), 'Acme/Summer');
    expect(await recordFontUses({ ...options(), fonts: libraryOf() }, makeJob(), summer)).toEqual(
      [],
    );

    expect(rows()).toEqual([]);
  });

  it('goes on past a family that cannot be recorded, and says so', async () => {
    await editOf('Acme/Spring', 'Heebo', 'Rubik');
    const addUse = vi
      .fn<FontRepository['addUse']>()
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementation((use) => repo.addUse(use));

    await recordFontUses(
      { ...options(), repo: { addUse } },
      makeJob({ id: 'job-spring' }),
      join(inbox(), 'Acme/Spring'),
    );

    expect(rows().map((row) => row.family)).toEqual(['Rubik']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-spring', family: 'Heebo' }),
      'could not record a font use',
    );
  });

  describe('telling the browsers', () => {
    function serviceWithCounts() {
      return fakeFontService({
        ...LIBRARY,
        list: vi.fn(async () => ({
          ok: true as const,
          status: 200 as const,
          body: {
            families: [
              makeFontFamilySummary({ slug: 'heebo', name: 'Heebo', used: 2, usedLabel: '2 jobs' }),
              makeFontFamilySummary({ slug: 'rubik', name: 'Rubik', used: 1, usedLabel: '1 job' }),
            ],
            catalog: [],
            requests: [],
          },
        })),
      });
    }

    it('publishes font.changed with the new count for each family that gained a use, while "Used in" shows', async () => {
      await editOf('Acme/Spring', 'Heebo', 'Rubik');
      const events: FontChangedEvent[] = [];
      const dir = join(inbox(), 'Acme/Spring');

      await recordFontUses(
        { ...options(), fonts: serviceWithCounts(), usedIn: true, publish: (e) => events.push(e) },
        makeJob({ id: 'job-spring' }),
        dir,
      );

      expect(events.map((event) => [event.type, event.family.name, event.family.used])).toEqual([
        ['font.changed', 'Heebo', 2],
        ['font.changed', 'Rubik', 1],
      ]);
    });

    it('says nothing for a run that added no use, or while "Used in" is hidden', async () => {
      await editOf('Acme/Spring', 'Heebo');
      const events: FontChangedEvent[] = [];
      const fonts = serviceWithCounts();
      const dir = join(inbox(), 'Acme/Spring');
      const job = makeJob({ id: 'job-spring' });

      await recordFontUses(
        { ...options(), fonts, usedIn: false, publish: (e) => events.push(e) },
        job,
        dir,
      );
      expect(events).toEqual([]);
      expect(fonts.list).not.toHaveBeenCalled();

      // The row is there now: this run adds nothing, so nobody is told.
      await recordFontUses(
        { ...options(), fonts, usedIn: true, publish: (e) => events.push(e) },
        job,
        dir,
      );
      expect(events).toEqual([]);
    });

    it('keeps the uses it recorded when the list cannot be read', async () => {
      await editOf('Acme/Spring', 'Heebo');
      const fonts = fakeFontService({
        ...LIBRARY,
        list: async () => {
          throw new Error('the index is rebuilding');
        },
      });
      const publish = vi.fn();

      const found = await recordFontUses(
        { ...options(), fonts, usedIn: true, publish },
        makeJob({ id: 'job-spring' }),
        join(inbox(), 'Acme/Spring'),
      );

      expect(found).toEqual(['Heebo']);
      expect(rows()).toHaveLength(1);
      expect(publish).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-spring' }),
        'could not tell the browsers about the new font uses',
      );
    });
  });
});

describe('withFontUses', () => {
  const OK: RunOutcome = { ok: true };
  const CONTEXT = { signal: new AbortController().signal, progress: () => {} } as RunContext;

  function run(
    outcome: RunOutcome | Error,
    job: Job,
    recorder = vi.fn(async (_job: Job): Promise<void> => {}),
  ) {
    const inner: Runner = {
      start: vi.fn(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }),
    };
    const wrapped = withFontUses(inner, recorder, logger);
    return { inner, recorder, result: wrapped.start(job, 'start', CONTEXT) };
  }

  it.each(['edit', 'revise'] as const)(
    'records the fonts after a successful %s run',
    async (kind) => {
      const job = makeJob({ runKind: kind });
      const { inner, recorder, result } = run(OK, job);

      expect(await result).toEqual(OK);

      expect(inner.start).toHaveBeenCalledWith(job, 'start', CONTEXT);
      expect(recorder).toHaveBeenCalledWith(job);
    },
  );

  it('passes the preview a run reports through unchanged', async () => {
    const outcome: RunOutcome = {
      ok: true,
      preview: { durationSec: 12, width: 1080, height: 1920 },
    };

    expect(await run(outcome, makeJob()).result).toBe(outcome);
  });

  it('records nothing after a render run, a failed run or a run that threw', async () => {
    const render = run(OK, makeJob({ runKind: 'render' }));
    expect(await render.result).toEqual(OK);
    expect(render.recorder).not.toHaveBeenCalled();

    const failed: RunOutcome = { ok: false, error: 'It broke.', step: 4 };
    const bad = run(failed, makeJob());
    expect(await bad.result).toEqual(failed);
    expect(bad.recorder).not.toHaveBeenCalled();

    const threw = run(new Error('spawn failed'), makeJob());
    await expect(threw.result).rejects.toThrow('spawn failed');
    expect(threw.recorder).not.toHaveBeenCalled();
  });

  it('leaves the run’s outcome alone when recording fails', async () => {
    const recorder = vi.fn(async (_job: Job): Promise<void> => {
      throw new Error('database is locked');
    });

    const { result } = run(OK, makeJob(), recorder);

    expect(await result).toEqual(OK);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'a1b2c3d4e5f6' }),
      'could not record the fonts the edit used',
    );
  });
});

describe('backfillFontUses', () => {
  const STAGES: Job['delivery'][] = [
    null,
    { deliveredAt: '2026-10-21T10:00:00.000Z', price: 40, currency: 'ILS', paidOn: null },
    { deliveredAt: '2026-10-21T10:00:00.000Z', price: 40, currency: 'ILS', paidOn: '2026-10-22' },
  ];

  const marker = () => join(dataDir, FONT_USES_BACKFILL_MARKER);

  const job = (name: string, overrides: Partial<Job> = {}): Job =>
    makeJob({
      id: `job-${name.toLowerCase()}`,
      name,
      relPath: `Acme/${name}`,
      state: 'ready',
      ...overrides,
    });

  function backfill(jobs: Job[], extra: Partial<Parameters<typeof backfillFontUses>[0]> = {}) {
    return backfillFontUses({
      jobs: { getAll: () => jobs },
      repo,
      fonts: LIBRARY,
      inboxPath: inbox(),
      dataDir,
      logger,
      ...extra,
    });
  }

  it('records the fonts of the finished jobs in round 0: Review, Approved, Delivered and Paid', async () => {
    const jobs = [
      job('Review', { state: 'review', runKind: 'revise', round: 4 }),
      job('Approved', { delivery: STAGES[0] ?? null }),
      job('Delivered', { delivery: STAGES[1] ?? null }),
      job('Paid', { delivery: STAGES[2] ?? null }),
    ];
    for (const { name } of jobs)
      await editOf(`Acme/${name}`, 'Heebo', name === 'Paid' ? 'Rubik' : 'Outfit');

    const done = await backfill(jobs);

    expect(done).toEqual({ jobs: 4, skipped: 0, uses: 8 });
    expect(new Set(rows().map((row) => row.round))).toEqual(new Set([0]));
    expect(new Set(rows().map((row) => row.source))).toEqual(new Set(['composition']));
    expect(new Set(rows().map((row) => row.weight))).toEqual(new Set([0]));
    expect(repo.usedCount('Heebo')).toBe(4);
    expect(repo.usedCount('Rubik')).toBe(1);
    expect(repo.usedCount('Outfit')).toBe(3);
  });

  it('leaves out the jobs that have not finished', async () => {
    const jobs = (['arriving', 'queued', 'held', 'editing', 'failed', 'cancelled'] as const).map(
      (state) => job(state, { state }),
    );
    for (const { name } of jobs) await editOf(`Acme/${name}`, 'Heebo');

    expect(await backfill(jobs)).toEqual({ jobs: 0, skipped: 0, uses: 0 });

    expect(rows()).toEqual([]);
  });

  it('skips a job whose folder is gone, and one that has no edit', async () => {
    await editOf('Acme/Here', 'Heebo');
    await put('Acme/NoEdit/Footage.mp4', 'x');

    const done = await backfill([job('Here'), job('Gone'), job('NoEdit')]);

    expect(done).toEqual({ jobs: 3, skipped: 2, uses: 1 });
    expect(rows().map((row) => row.job_id)).toEqual(['job-here']);
  });

  it('runs once: the marker in the data dir ends every later call', async () => {
    await editOf('Acme/First', 'Heebo');
    expect(existsSync(marker())).toBe(false);

    const first = await backfill([job('First')]);
    expect(first).toEqual({ jobs: 1, skipped: 0, uses: 1 });
    expect(existsSync(marker())).toBe(true);
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({
      jobs: 1,
      skipped: 0,
      uses: 1,
    });
    expect(existsSync(`${marker()}.tmp`)).toBe(false);

    // Another finished job, and a different library, after the marker: nothing is read again.
    await editOf('Acme/Second', 'Rubik');
    const second = await backfill([job('First'), job('Second')]);
    expect(second).toBeNull();
    const third = await backfill([job('Second')], { fonts: libraryOf('Rubik') });
    expect(third).toBeNull();

    expect(rows().map((row) => row.job_id)).toEqual(['job-first']);
  });

  it('a pass that already holds a use records nothing twice', async () => {
    await editOf('Acme/First', 'Heebo');
    repo.addUse({
      family: 'Heebo',
      weight: 0,
      italic: false,
      jobId: 'job-first',
      round: 0,
      source: 'composition',
    });

    expect(await backfill([job('First')])).toEqual({ jobs: 1, skipped: 0, uses: 0 });

    expect(rows()).toHaveLength(1);
  });

  it('waits for a library: no fonts, no read and no marker', async () => {
    await editOf('Acme/First', 'Heebo');

    expect(await backfill([job('First')], { fonts: libraryOf() })).toBeNull();

    expect(existsSync(marker())).toBe(false);
    expect(rows()).toEqual([]);
    // The next boot, with the library there, does it.
    expect(await backfill([job('First')])).toEqual({ jobs: 1, skipped: 0, uses: 1 });
  });

  it('stops without a marker when told to, and a later boot finishes the pass', async () => {
    await editOf('Acme/First', 'Heebo');
    await editOf('Acme/Second', 'Rubik');
    let asked = 0;

    const stopped = await backfill([job('First'), job('Second')], {
      shouldStop: () => ++asked > 1,
    });

    expect(stopped).toBeNull();
    expect(existsSync(marker())).toBe(false);
    expect(rows().map((row) => row.job_id)).toEqual(['job-first']);

    expect(await backfill([job('First'), job('Second')])).toEqual({ jobs: 2, skipped: 0, uses: 1 });
    expect(repo.usedCount('Heebo')).toBe(1);
    expect(repo.usedCount('Rubik')).toBe(1);
  });

  it('goes on past a job that cannot be read, and still marks the pass done', async () => {
    await editOf('Acme/Fine', 'Heebo');
    const addUse = vi
      .fn<FontRepository['addUse']>()
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementation((use) => repo.addUse(use));
    await editOf('Acme/Other', 'Rubik');

    const done = await backfill([job('Fine'), job('Other')], { repo: { addUse } });

    expect(done).toMatchObject({ jobs: 2, uses: 1 });
    expect(existsSync(marker())).toBe(true);
    expect(rows().map((row) => row.family)).toEqual(['Rubik']);
  });

  it('never writes into a job folder: only the marker is new', async () => {
    await editOf('Acme/First', 'Heebo', 'Rubik');
    await put('Acme/First/Footage.mp4', 'x');
    const before = await snapshot(inbox());
    const dataBefore = await readdir(dataDir);

    await backfill([job('First')]);

    expect(await snapshot(inbox())).toEqual(before);
    expect(dataBefore).toEqual([]);
    expect(await readdir(dataDir)).toEqual([FONT_USES_BACKFILL_MARKER]);
  });

  it('makes the data dir if it is not there yet', async () => {
    await rm(dataDir, { recursive: true, force: true });
    await editOf('Acme/First', 'Heebo');

    await backfill([job('First')]);

    expect(existsSync(marker())).toBe(true);
  });
});

/** Every path under `dir` with its size and modified time. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await stat(path);
    out.push(`${path} ${info.size} ${info.mtimeMs}`);
    if (entry.isDirectory()) out.push(...(await snapshot(path)));
  }
  return out.sort();
}
