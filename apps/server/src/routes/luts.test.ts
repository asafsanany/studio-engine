import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  LUT_MESSAGES,
  type LutSummary,
  lutDetailSchema,
  lutListResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type LutsApiOptions } from '../app.js';
import { LutRepository, type NewLut } from '../db/lut-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createFakeLutPreviews } from '../luts/fake-lut-previews.js';
import { createBuiltInLuts } from '../luts/lut-builtin.js';
import {
  type BuiltInLuts,
  createDisabledLutService,
  createLutService,
} from '../luts/lut-service.js';
import { createLutStaging } from '../luts/lut-staging.js';

const opened: ReturnType<typeof memoryDb>[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };

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

function setup(
  // Not what is installed on this Mac: no colour-grade skill, so Built in is empty.
  builtIn: BuiltInLuts = createBuiltInLuts({ skillDir: join(tmpdir(), 'studio-no-such-skill') }),
) {
  const db = memoryDb();
  opened.push(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-luts-'));
  dirs.push(dataDir);
  const repo = new LutRepository(db);
  const previews = createFakeLutPreviews({ dataDir });
  const events: unknown[] = [];
  const service = createLutService({
    repo,
    builtIn,
    staging: createLutStaging({ dataDir }),
    previews,
    inboxPath: '/inbox',
    publish: (event) => events.push(event),
    usedIn: false,
    logger,
  });
  const routes: LutsApiOptions = {
    luts: { service },
    previews: { luts: repo, builtIn, previews, inboxPath: '/inbox' },
  };
  return { repo, routes, service, events };
}

describe('the LUTs routes (the LUTs switch)', () => {
  it('answer 404 "LUTs are off." for every LUTs path while the switch is off', async () => {
    const app = createApp({ luts: false, lutsRoutes: setup().routes });
    for (const [method, path] of [
      ['GET', '/api/luts'],
      ['GET', '/api/luts/golden-hour-warm'],
      ['PATCH', '/api/luts/golden-hour-warm'],
      ['DELETE', '/api/luts/golden-hour-warm'],
      ['POST', '/api/luts/golden-hour-warm/duplicate'],
      ['POST', '/api/luts/golden-hour-warm/reveal'],
      ['GET', '/api/luts/golden-hour-warm/preview/person/after.jpg'],
      ['POST', '/api/luts/stage'],
      ['DELETE', '/api/luts/stage/abc'],
      ['POST', '/api/luts/import'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: LUT_MESSAGES.off });
    }
  });

  it('are off too for an app given the switch but not the routes, or the routes but not the switch', async () => {
    expect((await createApp({ luts: true }).request('/api/luts')).status).toBe(404);
    const unswitched = createApp({ lutsRoutes: setup().routes });
    expect((await unswitched.request('/api/luts')).status).toBe(404);
    // lutsInEdits alone mounts nothing either.
    const inEdits = createApp({ lutsInEdits: true, lutsRoutes: setup().routes });
    expect((await inEdits.request('/api/luts')).status).toBe(404);
  });

  it('list nothing for an empty library: { yours: [], builtIn: [], builtInAvailable: false }', async () => {
    const res = await createApp({ luts: true, lutsRoutes: setup().routes }).request('/api/luts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ yours: [], builtIn: [], builtInAvailable: false });
  });

  it('list Yours newest first with their used words and the New tag', async () => {
    const { repo, routes } = setup();
    const first = repo.create(lutInput('Golden Hour Warm'));
    repo.create(lutInput('Teal Orange Soft'));
    repo.addUse(first.id, 'job-a', 0);
    repo.addUse(first.id, 'job-b', 0);
    const app = createApp({ luts: true, lutsRoutes: routes });

    const list = lutListResponseSchema.parse(await (await app.request('/api/luts')).json());

    expect(list.builtIn).toEqual([]);
    expect(list.builtInAvailable).toBe(false);
    expect(
      list.yours.map((lut) => [lut.slug, lut.owner, lut.used, lut.usedLabel, lut.isNew]),
    ).toEqual([
      ['teal-orange-soft', 'yours', 0, 'Not used yet', true],
      ['golden-hour-warm', 'yours', 2, '2 jobs', true],
    ]);
  });

  it('list the built-in rows the catalog gives, with their used counts', async () => {
    const row = (slug: string, used: number): LutSummary => ({
      slug,
      name: 'Film contrast',
      kind: 'look',
      size: 33,
      owner: 'builtIn',
      used,
      usedLabel: used === 0 ? 'Used by the cinematic look' : `${used} job`,
      addedAt: null,
      isNew: false,
    });
    const builtIn: BuiltInLuts = {
      available: async () => true,
      list: async (counts) => [row('film-contrast', counts.get('film-contrast') ?? 0)],
      get: async () => null,
      cubePath: async () => null,
      cubeFile: async () => null,
    };
    const { repo, routes } = setup(builtIn);
    repo.addUse('film-contrast', 'job-a', 0);

    const res = await createApp({ luts: true, lutsRoutes: routes }).request('/api/luts');

    const list = lutListResponseSchema.parse(await res.json());
    expect(list.builtInAvailable).toBe(true);
    expect(list.builtIn.map((lut) => [lut.slug, lut.used])).toEqual([['film-contrast', 1]]);
  });

  it('check a body before they ask the service: a bad update is 400, a bad import is 400 or 413', async () => {
    const app = createApp({ luts: true, lutsRoutes: setup().routes });
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const noPatch = await send('PATCH', '/api/luts/x', {});
    expect(noPatch.status).toBe(400);
    expect(await noPatch.json()).toEqual({ error: LUT_MESSAGES.badUpdate });

    const notJson = await app.request('/api/luts/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'nope',
    });
    expect(notJson.status).toBe(400);

    const noItems = await send('POST', '/api/luts/import', { stageId: 's', items: [] });
    expect(noItems.status).toBe(400);
    expect(await noItems.json()).toEqual({ error: LUT_MESSAGES.badImport });

    const many = Array.from({ length: 61 }, (_, n) => ({ id: `f${n}`, kind: 'look' }));
    const tooMany = await send('POST', '/api/luts/import', { stageId: 's', items: many });
    expect(tooMany.status).toBe(413);
    expect(await tooMany.json()).toEqual({ error: LUT_MESSAGES.tooManyFiles });
  });
});

describe('createDisabledLutService', () => {
  it('refuses everything with 404 "LUTs are off."', async () => {
    const off = createDisabledLutService();
    expect(off.enabled).toBe(false);
    const stage = { stageId: 's', dir: '/x' };
    for (const outcome of [
      await off.list(),
      await off.get('x'),
      await off.update('x', { kind: 'fix' }),
      await off.remove('x'),
      await off.duplicate('x'),
      await off.reveal('x'),
      await off.stage(stage, []),
      await off.cancelStage('s'),
      await off.importStaged({ stageId: 's', items: [{ id: 'f', kind: 'look' }] }),
    ]) {
      expect(outcome).toEqual({ ok: false, status: 404, error: 'LUTs are off.' });
    }
    await expect(off.beginStage()).rejects.toThrow(LUT_MESSAGES.off);
  });
});

describe('createLutService', () => {
  it('is enabled, and its list is the repository’s Yours and the catalog’s Built in', async () => {
    const { service, repo } = setup();
    expect(service.enabled).toBe(true);
    repo.create(lutInput('Golden Hour Warm'));
    const outcome = await service.list();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(200);
    expect(outcome.body.yours.map((lut) => lut.slug)).toEqual(['golden-hour-warm']);
    expect(lutDetailSchema.safeParse(outcome.body.yours[0]).success).toBe(false);
  });
});
