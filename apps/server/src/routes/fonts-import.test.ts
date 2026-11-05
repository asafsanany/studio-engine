import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  cancelFontStageResponseSchema,
  FONT_MESSAGES,
  fontImportResponseSchema,
  fontStageResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { FontRepository } from '../db/font-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createFontService } from '../fonts/font-service.js';
import { fontStagingRoot } from '../fonts/font-staging.js';
import { buildFont, fixtureFont } from '../fonts/font-test-utils.js';
import { makeLibrary, type TempLibrary } from '../fonts/library/test-utils.js';

// The import routes on the real Fonts service (FN4): a multipart upload as the browser sends it (a
// folder pick sends every file under its path inside the folder), the verdicts, the import and the
// cancel, all over HTTP against a temp inbox and a temp data folder.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const library: TempLibrary = makeLibrary();
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-font-routes-'));
  cleanups.push(() => {
    rmSync(dataDir, { recursive: true, force: true });
    library.cleanup();
  });
  const repo = new FontRepository(memoryDb());
  const service = createFontService({
    repo,
    inboxPath: library.inbox,
    dataDir,
    publish: () => {},
    usedIn: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const app = createApp({ fonts: true, fontsRoutes: { service } });
  return { app, library, dataDir };
}

type Part = { name: string; data: string | Uint8Array };

function formWith(parts: Part[]): FormData {
  const form = new FormData();
  for (const { name, data } of parts) form.append('files[]', new Blob([data]), name);
  return form;
}

const stageRequest = (app: ReturnType<typeof setup>['app'], body: RequestInit['body']) =>
  app.request('/api/fonts/stage', { method: 'POST', body });

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const stages = (dataDir: string): string[] => {
  try {
    return readdirSync(fontStagingRoot(dataDir));
  } catch {
    return [];
  }
};

describe('POST /api/fonts/stage', () => {
  it('reads a folder pick: groups by the family inside, ignores .DS_Store and a licence, names the broken file', async () => {
    const { app, dataDir } = setup();
    const res = await stageRequest(
      app,
      formWith([
        { name: 'Pack/.DS_Store', data: 'junk' },
        { name: 'Pack/Outfit/Outfit-Regular.ttf', data: fixtureFont('Outfit-Regular.ttf') },
        { name: 'Pack/Outfit/OFL.txt', data: 'SIL Open Font License' },
        { name: 'Pack/Outfit/Outfit-Bold.ttf', data: fixtureFont('Outfit-Bold.ttf') },
        { name: 'Pack/Broken export.ttf', data: fixtureFont('broken-cut-short.ttf') },
        { name: 'Pack/__MACOSX/._Outfit-Bold.ttf', data: 'apple' },
      ]),
    );

    expect(res.status).toBe(200);
    const body = fontStageResponseSchema.parse(await res.json());
    expect(body.items).toEqual([
      {
        id: 'i0',
        name: 'Outfit',
        files: 2,
        he: false,
        weights: [400, 700],
        bytes: 47_844 + 48_340,
        status: 'new',
        info: '2 files · English only · 0.1 MB',
      },
      {
        id: 'i1',
        name: 'Broken export.ttf',
        files: 1,
        he: false,
        weights: [],
        bytes: 2048,
        status: 'bad',
        info: 'Not a font: the file is cut short.',
      },
    ]);
    expect(stages(dataDir)).toEqual([body.stageId]);
  });

  it('says so for a lone file that is not a font', async () => {
    const { app } = setup();
    const res = await stageRequest(app, formWith([{ name: 'notes.txt', data: 'hello' }]));
    const body = fontStageResponseSchema.parse(await res.json());
    expect(body.items).toEqual([
      {
        id: 'i0',
        name: 'notes.txt',
        files: 1,
        he: false,
        weights: [],
        bytes: 5,
        status: 'bad',
        info: 'Not a font: only .ttf, .otf, .woff and .woff2 files.',
      },
    ]);
  });

  it('answers a folder of only junk with no items, and the stage can be deleted', async () => {
    const { app, dataDir } = setup();
    const res = await stageRequest(
      app,
      formWith([
        { name: 'Pack/.DS_Store', data: 'junk' },
        { name: 'Pack/OFL.txt', data: 'licence' },
      ]),
    );
    expect(res.status).toBe(200);
    const body = fontStageResponseSchema.parse(await res.json());
    expect(body.items).toEqual([]);
    expect(stages(dataDir)).toEqual([body.stageId]);
    const del = await app.request(`/api/fonts/stage/${body.stageId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(stages(dataDir)).toEqual([]);
  });

  it('refuses a form with no file, and a body that is not multipart, with 400 and no stage left', async () => {
    const { app, dataDir } = setup();
    const empty = new FormData();
    empty.append('note', 'hi');
    const none = await stageRequest(app, empty);
    expect(none.status).toBe(400);
    expect(apiErrorSchema.parse(await none.json())).toEqual({ error: FONT_MESSAGES.badImport });

    const notForm = await app.request('/api/fonts/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notForm.status).toBe(400);
    expect(await notForm.json()).toEqual({ error: FONT_MESSAGES.badImport });

    const bare = await app.request('/api/fonts/stage', { method: 'POST' });
    expect(bare.status).toBe(400);
    expect(stages(dataDir)).toEqual([]);
  });

  it('refuses an upload over the size limit by its Content-Length with 413, before reading it', async () => {
    const { app, dataDir } = setup();
    const res = await app.request('/api/fonts/stage', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(500 * 1024 * 1024),
      },
      body: '--x--',
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: FONT_MESSAGES.stageTooLarge });
    expect(stages(dataDir)).toEqual([]);
  });
});

describe('POST /api/fonts/import and DELETE /api/fonts/stage/:stageId', () => {
  it('copies the chosen families into _Fonts and answers the families', async () => {
    const { app, library, dataDir } = setup();
    const staged = fontStageResponseSchema.parse(
      await (
        await stageRequest(
          app,
          formWith([
            { name: 'Fonts/SecularOne-Regular.ttf', data: fixtureFont('SecularOne-Regular.ttf') },
            { name: 'Fonts/Outfit-Bold.ttf', data: fixtureFont('Outfit-Bold.ttf') },
          ]),
        )
      ).json(),
    );
    expect(staged.items.map((item) => [item.id, item.name])).toEqual([
      ['i0', 'Outfit'],
      ['i1', 'Secular One'],
    ]);

    const res = await app.request(
      '/api/fonts/import',
      json({ stageId: staged.stageId, items: ['i0', 'i1'] }),
    );

    expect(res.status).toBe(201);
    const body = fontImportResponseSchema.parse(await res.json());
    expect(body.failed).toEqual([]);
    expect(body.imported.map((family) => [family.slug, family.he])).toEqual([
      ['outfit', false],
      ['secular-one', true],
    ]);
    expect(readFileSync(library.path('English only/Outfit/Outfit-Bold.ttf'))).toEqual(
      fixtureFont('Outfit-Bold.ttf'),
    );
    expect(existsSync(library.path('Hebrew + English/Secular One/SecularOne-Regular.ttf'))).toBe(
      true,
    );
    expect(stages(dataDir)).toEqual([]);

    // The new families are in the list and their files can be fetched.
    const list = (await (await app.request('/api/fonts')).json()) as {
      families: { slug: string }[];
    };
    expect(list.families.map((family) => family.slug)).toEqual(['outfit', 'secular-one']);
  });

  it('answers 404 for a stage that is gone, 400 for a body that cannot be read', async () => {
    const { app } = setup();
    const gone = await app.request(
      '/api/fonts/import',
      json({ stageId: 'aaaaaaaaaaaa', items: ['i0'] }),
    );
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: FONT_MESSAGES.stageNotFound });

    const bad = await app.request('/api/fonts/import', json({ stageId: 'aaaaaaaaaaaa' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: FONT_MESSAGES.badImport });
  });

  it('keeps the stage when an item failed, so the same ids can be sent again', async () => {
    const { app, library } = setup();
    const bold = buildFont({
      id1: 'Rubik',
      id2: 'Bold',
      id16: 'Rubik',
      id17: 'Bold',
      weightClass: 700,
    });
    const a = fontStageResponseSchema.parse(
      await (await stageRequest(app, formWith([{ name: 'a.ttf', data: bold }]))).json(),
    );
    const other = Buffer.from(bold);
    other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 0xff;
    const b = fontStageResponseSchema.parse(
      await (await stageRequest(app, formWith([{ name: 'b.ttf', data: other }]))).json(),
    );
    await app.request('/api/fonts/import', json({ stageId: a.stageId, items: ['i0'] }));

    const res = await app.request('/api/fonts/import', json({ stageId: b.stageId, items: ['i0'] }));

    expect(res.status).toBe(200);
    const body = fontImportResponseSchema.parse(await res.json());
    expect(body.imported).toEqual([]);
    expect(body.failed).toEqual([
      {
        id: 'i0',
        error: 'You already have a different Rubik Bold. Delete it first to replace it.',
      },
    ]);
    // Still there to cancel, and nothing of b is in _Fonts.
    expect(existsSync(library.path('English only/Rubik/b.ttf'))).toBe(false);
    const del = await app.request(`/api/fonts/stage/${b.stageId}`, { method: 'DELETE' });
    expect(cancelFontStageResponseSchema.parse(await del.json())).toEqual({ ok: true });
  });

  it('cancels a stage, once', async () => {
    const { app, dataDir } = setup();
    const staged = fontStageResponseSchema.parse(
      await (
        await stageRequest(
          app,
          formWith([{ name: 'Outfit-Bold.ttf', data: fixtureFont('Outfit-Bold.ttf') }]),
        )
      ).json(),
    );
    expect(stages(dataDir)).toEqual([staged.stageId]);

    const first = await app.request(`/api/fonts/stage/${staged.stageId}`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(stages(dataDir)).toEqual([]);

    const second = await app.request(`/api/fonts/stage/${staged.stageId}`, { method: 'DELETE' });
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: FONT_MESSAGES.stageNotFound });
  });
});

describe('the import routes while the switch is off', () => {
  it('answer 404 "Fonts are off." and make no staging folder', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-font-routes-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const app = createApp({ fonts: false });
    for (const [method, path] of [
      ['POST', '/api/fonts/stage'],
      ['DELETE', '/api/fonts/stage/aaaaaaaaaaaa'],
      ['POST', '/api/fonts/import'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: FONT_MESSAGES.off });
    }
    expect(stages(dataDir)).toEqual([]);
  });
});
