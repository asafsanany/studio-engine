import { clientStyleSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, toClientStyle } from './client-style-repository.js';
import type { StudioDb } from './database.js';
import { fakeClock, memoryDb, T0, totalChanges } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return { clock, db, repo: new ClientStyleRepository(db, { clock }) };
}

const ACME = { clientId: 'ed099798f237', client: 'Acme' };
const BETA = { clientId: 'b3b3b3b3b3b3', client: 'Beta' };

describe('ClientStyleRepository: the table', () => {
  it('has the columns of the plan, and a client with no row has no style', () => {
    const { db, repo } = setup();
    const columns = db.sqlite
      .prepare(
        "select name, lower(type) as type, pk, dflt_value from pragma_table_info('client_styles')",
      )
      .all();
    expect(columns).toEqual([
      { name: 'client_id', type: 'text', pk: 1, dflt_value: null },
      { name: 'client', type: 'text', pk: 0, dflt_value: null },
      { name: 'state', type: 'text', pk: 0, dflt_value: "'none'" },
      { name: 'version', type: 'integer', pk: 0, dflt_value: '0' },
      { name: 'updated_at', type: 'integer', pk: 0, dflt_value: null },
      { name: 'error', type: 'text', pk: 0, dflt_value: null },
      { name: 'source_job_id', type: 'text', pk: 0, dflt_value: null },
      { name: 'last_pass', type: 'text', pk: 0, dflt_value: null },
    ]);
    expect(repo.get(ACME.clientId)).toBeNull();
    expect(repo.list()).toEqual([]);
  });
});

describe('ClientStyleRepository.upsert: a new client', () => {
  it('starts at state none, version 0, with nothing else set, stamped now', () => {
    const { repo } = setup();

    const { style, outcome } = repo.upsert(ACME);

    expect(outcome).toBe('created');
    expect(style).toEqual({
      ...ACME,
      state: 'none',
      version: 0,
      updatedAt: T0,
      error: null,
      sourceJobId: null,
      lastPass: null,
    });
    expect(repo.get(ACME.clientId)).toEqual(style);
  });

  it('stores every field it is given, the time included', () => {
    const { repo } = setup();
    const lastPass = { kind: 'learn', jobId: 'a1b2c3d4e5f6' };

    const { style } = repo.upsert({
      ...ACME,
      state: 'failed',
      version: 3,
      updatedAt: '2026-10-18T09:30:00.000Z',
      error: 'Style stopped: the file is missing',
      sourceJobId: 'a1b2c3d4e5f6',
      lastPass,
    });

    expect(style).toEqual({
      ...ACME,
      state: 'failed',
      version: 3,
      updatedAt: '2026-10-18T09:30:00.000Z',
      error: 'Style stopped: the file is missing',
      sourceJobId: 'a1b2c3d4e5f6',
      lastPass,
    });
    expect(repo.get(ACME.clientId)).toEqual(style);
  });

  it('keeps a Hebrew client name exactly', () => {
    const { repo } = setup();
    const input = { clientId: '4d337086919d', client: 'מאפיית הצפון' };
    expect(repo.upsert(input).style.client).toBe('מאפיית הצפון');
    expect(repo.get(input.clientId)?.client).toBe('מאפיית הצפון');
  });

  it('keeps the time to the millisecond and reads it back as the ISO string it was given', () => {
    const { repo } = setup();
    repo.upsert({ ...ACME, updatedAt: '2026-10-18T09:30:00.123Z' });
    expect(repo.get(ACME.clientId)?.updatedAt).toBe('2026-10-18T09:30:00.123Z');
  });
});

describe('ClientStyleRepository.upsert: a client that has a row', () => {
  it('changes the fields it is given and keeps the others', () => {
    const { clock, repo } = setup();
    repo.upsert({
      ...ACME,
      state: 'ready',
      version: 2,
      sourceJobId: 'a1b2c3d4e5f6',
      lastPass: { kind: 'read' },
    });
    clock.tick(5_000);

    const { style, outcome } = repo.upsert({ ...ACME, state: 'analysing' });

    expect(outcome).toBe('updated');
    expect(style).toEqual({
      ...ACME,
      state: 'analysing',
      version: 2,
      updatedAt: '2026-10-20T10:00:05.000Z',
      error: null,
      sourceJobId: 'a1b2c3d4e5f6',
      lastPass: { kind: 'read' },
    });
    expect(repo.get(ACME.clientId)).toEqual(style);
  });

  it('clears error, sourceJobId and lastPass with null', () => {
    const { repo } = setup();
    repo.upsert({
      ...ACME,
      state: 'failed',
      error: 'Style stopped: it timed out',
      sourceJobId: 'a1b2c3d4e5f6',
      lastPass: { kind: 'learn' },
    });

    const { style } = repo.upsert({
      ...ACME,
      state: 'ready',
      error: null,
      sourceJobId: null,
      lastPass: null,
    });

    expect(style).toMatchObject({ state: 'ready', error: null, sourceJobId: null, lastPass: null });
  });

  it('takes the latest spelling of the client name', () => {
    const { repo } = setup();
    const nfc = 'Café';
    const nfd = nfc.normalize('NFD');
    repo.upsert({ clientId: ACME.clientId, client: nfc });

    const { style, outcome } = repo.upsert({ clientId: ACME.clientId, client: nfd });

    expect(outcome).toBe('updated');
    expect(style.client).toBe(nfd);
    expect(repo.list()).toHaveLength(1);
  });

  it('writes nothing when the row already says this, and keeps its time', () => {
    const { clock, db, repo } = setup();
    repo.upsert({ ...ACME, state: 'ready', version: 1, lastPass: { kind: 'read', files: ['a'] } });
    clock.tick(60_000);
    const writes = totalChanges(db);

    const { style, outcome } = repo.upsert({
      ...ACME,
      state: 'ready',
      version: 1,
      lastPass: { kind: 'read', files: ['a'] },
    });

    expect(outcome).toBe('unchanged');
    expect(style.updatedAt).toBe(T0);
    expect(totalChanges(db)).toBe(writes);
  });

  it('moves the time on its own when only the time is given', () => {
    const { repo } = setup();
    repo.upsert({ ...ACME, state: 'ready', version: 1 });

    const { style, outcome } = repo.upsert({ ...ACME, updatedAt: '2026-10-21T08:00:00.000Z' });

    expect(outcome).toBe('updated');
    expect(style).toMatchObject({
      state: 'ready',
      version: 1,
      updatedAt: '2026-10-21T08:00:00.000Z',
    });
  });

  it('only touches its own client', () => {
    const { repo } = setup();
    repo.upsert({ ...ACME, state: 'ready', version: 1 });
    const beta = repo.upsert({ ...BETA, state: 'ready', version: 4 }).style;

    repo.upsert({ ...ACME, state: 'analysing' });

    expect(repo.get(BETA.clientId)).toEqual(beta);
  });
});

describe('ClientStyleRepository.upsert: bad input', () => {
  it.each([
    ['an empty client id', { ...ACME, clientId: '' }],
    ['an empty client name', { ...ACME, client: '' }],
    ['an unknown state', { ...ACME, state: 'learning' }],
    ['a negative version', { ...ACME, version: -1 }],
    ['a fractional version', { ...ACME, version: 1.5 }],
    ['a time that is not ISO', { ...ACME, updatedAt: 'yesterday' }],
    ['an empty error (use null)', { ...ACME, error: '' }],
    ['a last pass that is not an object', { ...ACME, lastPass: 'read' }],
  ])('rejects %s and writes nothing', (_label, input) => {
    const { db, repo } = setup();
    const writes = totalChanges(db);
    expect(() => repo.upsert(input as never)).toThrow();
    expect(totalChanges(db)).toBe(writes);
    expect(repo.list()).toEqual([]);
  });
});

describe('ClientStyleRepository.list', () => {
  it('lists the most recently updated first, and by id when the time is the same', () => {
    const { clock, repo } = setup();
    repo.upsert({ ...BETA, updatedAt: '2026-10-20T09:00:00.000Z' });
    repo.upsert({ ...ACME, updatedAt: '2026-10-20T11:00:00.000Z' });
    clock.tick();
    repo.upsert({ clientId: 'aaaaaaaaaaaa', client: 'Zed', updatedAt: '2026-10-20T09:00:00.000Z' });

    expect(repo.list().map((style) => style.client)).toEqual(['Acme', 'Zed', 'Beta']);
  });
});

describe('toClientStyle', () => {
  it('is the wire ClientStyle: everything but lastPass', () => {
    const { repo } = setup();
    const { style } = repo.upsert({
      ...ACME,
      state: 'ready',
      version: 1,
      lastPass: { kind: 'read' },
    });

    const wire = toClientStyle(style);

    expect(wire).not.toHaveProperty('lastPass');
    expect(clientStyleSchema.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      ...ACME,
      state: 'ready',
      version: 1,
      updatedAt: T0,
      error: null,
      sourceJobId: null,
      pass: null,
    });
  });

  it('says what the pass does while the client is analysing, and nothing once it is over', () => {
    const { repo } = setup();
    const read = { kind: 'read', mode: 'add', files: [{ name: 'logo.png', size: 3 }] };
    const learn = { kind: 'learn', mode: 'create', jobId: 'a1b2c3d4e5f6', job: 'Menu' };

    const reading = toClientStyle(
      repo.upsert({ ...ACME, state: 'analysing', lastPass: read }).style,
    );
    expect(reading.pass).toEqual({
      kind: 'read',
      mode: 'add',
      fileCount: 1,
      jobId: null,
      job: null,
    });
    expect(clientStyleSchema.parse(reading)).toEqual(reading);

    const learning = toClientStyle(repo.upsert({ ...ACME, lastPass: learn }).style);
    expect(learning.pass).toEqual({
      kind: 'learn',
      mode: 'create',
      fileCount: 0,
      jobId: 'a1b2c3d4e5f6',
      job: 'Menu',
    });

    expect(toClientStyle(repo.upsert({ ...ACME, state: 'failed' }).style).pass).toBeNull();
    // A pass that can't be read says nothing rather than something wrong.
    expect(
      toClientStyle(repo.upsert({ ...ACME, state: 'analysing', lastPass: { kind: 'x' } }).style)
        .pass,
    ).toBeNull();
  });
});
