import {
  GRAPHIC_MESSAGES,
  graphicDetailSchema,
  graphicMessageSchema,
  graphicSummarySchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import {
  GraphicNameEmptyError,
  GraphicNameTakenError,
  GraphicRepository,
  newGraphicId,
  toGraphicMessage,
} from './graphic-repository.js';
import { JobRepository } from './job-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, T0 } from './test-utils.js';

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
  const repo = new GraphicRepository(db, { clock, newId: sequentialIds() });
  return { clock, db, repo };
}

const T = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

describe('newGraphicId', () => {
  it('makes 12 hex characters, a new one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGraphicId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('GraphicRepository.create', () => {
  it('stores a new graphic with no version, Edits can use it on, created and updated now', () => {
    const { repo } = setup();

    const created = repo.create({ name: 'New graphic' });

    expect(created).toEqual({
      id: '000000000001',
      name: 'New graphic',
      folder: 'New graphic',
      kind: null,
      lengthSec: null,
      variables: [],
      when: '',
      whenEdited: false,
      version: null,
      uses: true,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    });
    expect(repo.get(created.id)).toEqual(created);
  });

  it('cleans the name, and takes a given id, folder and switch', () => {
    const { repo } = setup();
    const created = repo.create({
      id: 'abcdef012345',
      name: '  Name / role  ',
      folder: 'Folder',
      uses: false,
    });
    expect(created).toMatchObject({
      id: 'abcdef012345',
      name: 'Name – role',
      folder: 'Folder',
      uses: false,
    });
  });

  it('stores times as integer ms and the switches as 0/1', () => {
    const { db, repo } = setup();
    repo.create({ name: 'Pill' });
    expect(rawRow(db, 'graphics')).toEqual([
      expect.objectContaining({
        created_at: Date.parse(T0),
        updated_at: Date.parse(T0),
        deleted_at: null,
        uses: 1,
        when_edited: 0,
        variables: '[]',
      }),
    ]);
  });

  it('refuses a name another live graphic has, in any case, and an empty one', () => {
    const { repo } = setup();
    repo.create({ name: 'Name on a white pill' });

    expect(() => repo.create({ name: 'NAME ON A WHITE PILL' })).toThrow(GraphicNameTakenError);
    expect(() => repo.create({ name: 'NAME ON A WHITE PILL' })).toThrow(GRAPHIC_MESSAGES.nameTaken);
    expect(() => repo.create({ name: '  ..  ' })).toThrow(GraphicNameEmptyError);
    expect(repo.list()).toHaveLength(1);
  });

  it('lets a deleted graphic’s name be used again', () => {
    const { repo } = setup();
    const first = repo.create({ name: 'Pill' });
    repo.softDelete(first.id);
    expect(repo.create({ name: 'pill' }).name).toBe('pill');
  });

  it('never gives a new graphic the id of a deleted one', () => {
    const { db, clock } = setup();
    const ids = ['000000000001', '000000000001', '000000000002'];
    const repo = new GraphicRepository(db, { clock, newId: () => ids.shift() ?? 'ffffffffffff' });
    const first = repo.create({ name: 'One' });
    repo.softDelete(first.id);
    expect(repo.create({ name: 'Two' }).id).toBe('000000000002');
  });
});

describe('GraphicRepository reads', () => {
  it('lists the live graphics, newest change first', () => {
    const { repo, clock } = setup();
    const a = repo.create({ name: 'A' });
    clock.tick();
    const b = repo.create({ name: 'B' });
    clock.tick();
    const c = repo.create({ name: 'C' });
    clock.tick();
    repo.setUses(a.id, false);
    repo.softDelete(b.id);

    expect(repo.list().map((graphic) => graphic.name)).toEqual(['A', 'C']);
    expect(repo.get(b.id)).toBeNull();
    expect(repo.get('ffffffffffff')).toBeNull();
    expect(repo.liveNames()).toEqual(['A', 'C']);
    expect(repo.liveNames(c.id)).toEqual(['A']);
  });

  it('says whether a name is free, comparing it cleaned and without regard to case', () => {
    const { repo } = setup();
    const pill = repo.create({ name: 'Pill: big' });
    expect(repo.isNameFree('pill– BIG')).toBe(false);
    expect(repo.isNameFree('pill: big')).toBe(false);
    expect(repo.isNameFree('Pill: big', pill.id)).toBe(true);
    expect(repo.isNameFree('Other')).toBe(true);
  });
});

describe('GraphicRepository changes', () => {
  it('renames a graphic and its folder, and refuses a name another graphic has', () => {
    const { repo, clock } = setup();
    const pill = repo.create({ name: 'New graphic' });
    repo.create({ name: 'Title' });
    clock.tick(5_000);

    expect(repo.rename(pill.id, 'Name on a white pill')).toMatchObject({
      name: 'Name on a white pill',
      folder: 'Name on a white pill',
      updatedAt: T(5_000),
    });
    expect(repo.rename(pill.id, 'Shown', 'Folder (2)')).toMatchObject({
      name: 'Shown',
      folder: 'Folder (2)',
    });
    expect(() => repo.rename(pill.id, 'title')).toThrow(GraphicNameTakenError);
    expect(() => repo.rename(pill.id, '  ')).toThrow(GraphicNameEmptyError);
    // Its own name in another case is fine.
    expect(repo.rename(pill.id, 'SHOWN')?.name).toBe('SHOWN');
    expect(repo.rename('ffffffffffff', 'X')).toBeNull();
  });

  it('turns Edits can use it off and on, moving updatedAt only when it changed', () => {
    const { repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    clock.tick();
    expect(repo.setUses(pill.id, true)?.updatedAt).toBe(T0);
    expect(repo.setUses(pill.id, false)).toMatchObject({ uses: false, updatedAt: T(1_000) });
    expect(repo.setUses('ffffffffffff', false)).toBeNull();
  });

  it('keeps the owner’s When line, which runs then no longer overwrite', () => {
    const { repo } = setup();
    const pill = repo.create({ name: 'Pill' });

    repo.setVersion(pill.id, { version: 1, when: 'From the run.' });
    expect(repo.get(pill.id)).toMatchObject({ when: 'From the run.', whenEdited: false });

    expect(repo.setWhen(pill.id, '  Openers only.  ')).toMatchObject({
      when: 'Openers only.',
      whenEdited: true,
    });
    repo.setVersion(pill.id, { version: 2, when: 'From the next run.' });
    expect(repo.get(pill.id)).toMatchObject({ version: 2, when: 'Openers only.' });

    expect(() => repo.setWhen(pill.id, 'x'.repeat(201))).toThrow();
    expect(repo.setWhen('ffffffffffff', 'x')).toBeNull();
  });

  it('records a version and what its about.json said', () => {
    const { repo } = setup();
    const pill = repo.create({ name: 'Pill' });
    const variables = [{ id: 'name', label: 'Name', default: 'דנה לוי' }];

    expect(
      repo.setVersion(pill.id, {
        version: 1,
        kind: 'lower-third',
        lengthSec: 3.5,
        variables,
        when: 'The first time a person is named.',
      }),
    ).toMatchObject({
      version: 1,
      kind: 'lower-third',
      lengthSec: 3.5,
      variables,
      when: 'The first time a person is named.',
    });
    // "Use v1 again": only the version moves.
    expect(repo.setVersion(pill.id, { version: 2 })).toMatchObject({
      version: 2,
      kind: 'lower-third',
      variables,
    });
    expect(() => repo.setVersion(pill.id, { version: 0 })).toThrow();
    expect(() => repo.setVersion(pill.id, { version: 3, kind: 'banner' as 'title' })).toThrow();
    expect(repo.setVersion('ffffffffffff', { version: 1 })).toBeNull();
  });

  it('deletes softly: the row stays, every read but the uses forgets it', () => {
    const { db, repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    repo.addUse(pill.id, 'job000000001', 1);
    clock.tick();

    expect(repo.softDelete(pill.id)).toBe(true);
    expect(repo.softDelete(pill.id)).toBe(false);
    expect(repo.get(pill.id)).toBeNull();
    expect(repo.summary(pill.id)).toBeNull();
    expect(repo.detail(pill.id, { usedIn: true })).toBeNull();
    expect(repo.setUses(pill.id, false)).toBeNull();
    expect(repo.usesCount(pill.id)).toBe(1);
    expect(rawRow(db, 'graphics')).toEqual([
      expect.objectContaining({ id: pill.id, deleted_at: Date.parse(T(1_000)) }),
    ]);
  });
});

describe('GraphicRepository chat', () => {
  it('adds the owner’s message and Claude’s row, in the order written, and updates the graphic', () => {
    const { repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    clock.tick();

    const you = repo.addMessage({
      graphicId: pill.id,
      role: 'you',
      text: 'A lower third.',
      refs: ['pill.png'],
      effort: 'high',
    });
    // The same millisecond: the order written decides.
    const claude = repo.addMessage({
      graphicId: pill.id,
      role: 'claude',
      version: 1,
      status: 'making',
      step: 0,
      startedAt: T(1_000),
    });

    expect(you).toEqual({
      id: you.id,
      graphicId: pill.id,
      role: 'you',
      text: 'A lower third.',
      refs: ['pill.png'],
      effort: 'high',
      version: null,
      status: null,
      step: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: T(1_000),
    });
    expect(graphicMessageSchema.parse(toGraphicMessage(claude))).toEqual(toGraphicMessage(claude));
    expect(repo.messages(pill.id).map((message) => message.id)).toEqual([you.id, claude.id]);
    expect(repo.get(pill.id)?.updatedAt).toBe(T(1_000));
  });

  it('orders the chat by creation time first', () => {
    const { repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    const first = repo.addMessage({ graphicId: pill.id, role: 'you', text: 'One.' });
    clock.tick();
    const second = repo.addMessage({ graphicId: pill.id, role: 'you', text: 'Two.' });
    expect(repo.messages(pill.id).map((message) => message.text)).toEqual(['One.', 'Two.']);
    expect(repo.message(first.id)?.text).toBe('One.');
    expect(repo.message(second.id)?.text).toBe('Two.');
    expect(repo.message('nope')).toBeNull();
    expect(repo.messages('ffffffffffff')).toEqual([]);
  });

  it('changes a message: a step alone leaves the graphic’s time, a status moves it', () => {
    const { repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    const row = repo.addMessage({
      graphicId: pill.id,
      role: 'claude',
      version: 1,
      status: 'making',
      step: 0,
    });
    clock.tick();

    expect(repo.updateMessage(row.id, { step: 1 })?.step).toBe(1);
    expect(repo.get(pill.id)?.updatedAt).toBe(T0);

    clock.tick();
    expect(
      repo.updateMessage(row.id, {
        status: 'done',
        step: null,
        text: 'Made v1.',
        endedAt: T(2_000),
      }),
    ).toMatchObject({ status: 'done', step: null, text: 'Made v1.', endedAt: T(2_000) });
    expect(repo.get(pill.id)?.updatedAt).toBe(T(2_000));

    expect(repo.updateMessage(row.id, {})).toMatchObject({ status: 'done' });
    expect(repo.updateMessage('nope', { step: 1 })).toBeNull();
    expect(() => repo.updateMessage(row.id, { step: 3 as 2 })).toThrow();
  });

  it('records a failure with its error, and clears it on a retry', () => {
    const { repo } = setup();
    const pill = repo.create({ name: 'Pill' });
    const row = repo.addMessage({
      graphicId: pill.id,
      role: 'claude',
      version: 1,
      status: 'making',
    });
    repo.updateMessage(row.id, { status: 'failed', error: GRAPHIC_MESSAGES.timedOut });
    expect(repo.message(row.id)).toMatchObject({
      status: 'failed',
      error: 'It took longer than 20 minutes.',
    });
    expect(repo.updateMessage(row.id, { status: 'making', error: null, step: 0 })).toMatchObject({
      status: 'making',
      error: null,
      step: 0,
    });
  });

  it('finds every message left making, of every graphic', () => {
    const { repo, clock } = setup();
    const a = repo.create({ name: 'A' });
    const b = repo.create({ name: 'B' });
    const left = repo.addMessage({ graphicId: a.id, role: 'claude', version: 1, status: 'making' });
    repo.addMessage({ graphicId: a.id, role: 'you', text: 'x' });
    clock.tick();
    const other = repo.addMessage({
      graphicId: b.id,
      role: 'claude',
      version: 3,
      status: 'making',
    });
    repo.addMessage({ graphicId: b.id, role: 'claude', version: 2, status: 'done' });

    expect(repo.makingMessages().map((message) => message.id)).toEqual([left.id, other.id]);
  });
});

describe('GraphicRepository summaries and details', () => {
  function madeOne(setupResult: ReturnType<typeof setup>) {
    const { repo, clock } = setupResult;
    const pill = repo.create({ name: 'Name on a white pill' });
    repo.addMessage({ graphicId: pill.id, role: 'you', text: 'A lower third.' });
    const run = repo.addMessage({
      graphicId: pill.id,
      role: 'claude',
      version: 1,
      status: 'making',
      step: 0,
    });
    clock.tick();
    repo.updateMessage(run.id, { status: 'done', text: 'Made v1.' });
    repo.setVersion(pill.id, {
      version: 1,
      kind: 'lower-third',
      lengthSec: 3,
      variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
      when: 'The first time a person is named.',
    });
    return pill;
  }

  it('sums a graphic up for the list, its status from its chat', () => {
    const t = setup();
    const pill = madeOne(t);

    const summary = t.repo.summary(pill.id);
    expect(summary).toEqual({
      id: pill.id,
      name: 'Name on a white pill',
      kind: 'lower-third',
      lengthSec: 3,
      version: 1,
      uses: true,
      status: 'ready',
      makingVersion: null,
      failedVersion: null,
      updatedAt: T(1_000),
    });
    expect(graphicSummarySchema.parse(summary)).toEqual(summary);

    t.repo.addMessage({ graphicId: pill.id, role: 'you', text: 'Slower.' });
    const change = t.repo.addMessage({
      graphicId: pill.id,
      role: 'claude',
      version: 2,
      status: 'making',
    });
    expect(t.repo.summary(pill.id)).toMatchObject({ status: 'making', makingVersion: 2 });
    t.repo.updateMessage(change.id, { status: 'failed', error: 'It broke.' });
    expect(t.repo.summary(pill.id)).toMatchObject({
      status: 'failed',
      failedVersion: 2,
      version: 1,
    });
    expect(t.repo.summary('ffffffffffff')).toBeNull();
  });

  it('lists every live graphic’s summary, the empty ones too, newest change first', () => {
    const t = setup();
    const pill = madeOne(t);
    t.clock.tick();
    const empty = t.repo.create({ name: 'New graphic' });
    t.clock.tick();
    const making = t.repo.create({ name: 'New graphic (2)' });
    t.repo.addMessage({ graphicId: making.id, role: 'claude', version: 1, status: 'making' });

    expect(
      t.repo.summaries().map((summary) => [summary.id, summary.status, summary.makingVersion]),
    ).toEqual([
      [making.id, 'making', 1],
      [empty.id, 'empty', null],
      [pill.id, 'ready', null],
    ]);
    t.repo.softDelete(empty.id);
    expect(t.repo.summaries()).toHaveLength(2);
  });

  it('answers [] with no graphics', () => {
    expect(setup().repo.summaries()).toEqual([]);
  });

  it('details a graphic with its chat, and Used in only when asked', () => {
    const t = setup();
    const pill = madeOne(t);
    t.repo.addUse(pill.id, 'job000000001', 1);

    const detail = t.repo.detail(pill.id, { usedIn: false });
    expect(graphicDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      when: 'The first time a person is named.',
      whenEdited: false,
      variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
      usedIn: null,
      folder: 'Name on a white pill',
      createdAt: T0,
    });
    expect(detail?.messages.map((message) => [message.role, message.status])).toEqual([
      ['you', null],
      ['claude', 'done'],
    ]);
    expect(detail?.messages[0]).not.toHaveProperty('graphicId');
    expect(t.repo.detail(pill.id, { usedIn: true })?.usedIn).toBe(1);
  });
});

describe('GraphicRepository uses', () => {
  it('counts each job once, keeping the version of its latest run', () => {
    const { db, repo, clock } = setup();
    const pill = repo.create({ name: 'Pill' });
    expect(repo.usesCount(pill.id)).toBe(0);

    repo.addUse(pill.id, 'job000000001', 1);
    clock.tick();
    repo.addUse(pill.id, 'job000000001', 2, T(5_000));
    repo.addUse(pill.id, 'job000000002', 2);
    repo.addUse('000000000099', 'job000000001', 1);

    expect(repo.usesCount(pill.id)).toBe(2);
    expect(rawRow(db, 'graphic_uses', `graphic_id = '${pill.id}'`)).toEqual([
      { graphic_id: pill.id, job_id: 'job000000001', version: 2, at: Date.parse(T(5_000)) },
      { graphic_id: pill.id, job_id: 'job000000002', version: 2, at: Date.parse(T(1_000)) },
    ]);
    expect(() => repo.addUse(pill.id, 'job000000003', 0)).toThrow();
  });

  it('counts the videos that were archived too, and the ones the graphic was used in by a later run', () => {
    const { db, repo } = setup();
    const pill = repo.create({ name: 'Pill' });
    const jobs = new JobRepository(db);
    const finished = (name: string) => {
      const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', name));
      jobs.applyTransition(job.id, { type: 'SETTLED' });
      jobs.applyTransition(job.id, { type: 'START' });
      return jobs.applyTransition(job.id, {
        type: 'SUCCEED',
        output: {
          fileName: `Northwind Bakery/${name}.mp4`,
          durationSec: 30,
          width: 1080,
          height: 1920,
          sizeBytes: 1_000,
        },
      });
    };
    const spring = finished('Spring menu');
    const summer = finished('Summer menu');
    repo.addUse(pill.id, spring.id, 1);
    repo.addUse(pill.id, summer.id, 1);
    expect(repo.usesCount(pill.id)).toBe(2);

    jobs.archive([spring.id]);

    expect(jobs.get(spring.id)?.archivedAt).not.toBeNull();
    expect(repo.usesCount(pill.id)).toBe(2);
    expect(repo.detail(pill.id, { usedIn: true })?.usedIn).toBe(2);
    // a later run of an archived job is still the same job
    repo.addUse(pill.id, spring.id, 2);
    expect(repo.usesCount(pill.id)).toBe(2);
  });
});
