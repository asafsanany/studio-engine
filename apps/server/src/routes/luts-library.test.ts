import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  cancelLutStageResponseSchema,
  deleteLutResponseSchema,
  LUT_MESSAGES,
  lutDetailSchema,
  lutImportResponseSchema,
  lutListResponseSchema,
  lutStageResponseSchema,
  revealLutResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { LutRepository } from '../db/lut-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createFakeLutPreviews } from '../luts/fake-lut-previews.js';
import { createBuiltInLuts } from '../luts/lut-builtin.js';
import { createLutService } from '../luts/lut-service.js';
import { createLutStaging } from '../luts/lut-staging.js';
import { make3dl, makeCube, TINT } from '../luts/lut-test-utils.js';
import { LUT_UPLOAD_TOO_MUCH, LutUploadError, receiveLutFiles } from '../luts/lut-upload.js';

const opened: ReturnType<typeof memoryDb>[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `studio-luts-routes-${label}-`));
  dirs.push(dir);
  return dir;
}

function setup() {
  const db = memoryDb();
  opened.push(db);
  const dataDir = tempDir('data');
  const inbox = tempDir('inbox');
  const home = tempDir('home');
  const repo = new LutRepository(db);
  const builtIn = createBuiltInLuts({ skillDir: join(dataDir, 'no-colour-grade'), dataDir });
  const previews = createFakeLutPreviews({ dataDir });
  const revealed: string[] = [];
  const service = createLutService({
    repo,
    builtIn,
    staging: createLutStaging({ dataDir }),
    previews,
    inboxPath: inbox,
    publish() {},
    usedIn: false,
    openFolder: async (path) => {
      revealed.push(path);
    },
    dataDir,
    home,
    logger,
  });
  const app = createApp({
    luts: true,
    lutsRoutes: {
      luts: { service },
      previews: { luts: repo, builtIn, previews, inboxPath: inbox },
    },
  });
  return { app, repo, dataDir, inbox, home, revealed };
}

const file = (name: string, content: string | Uint8Array) =>
  new File([Buffer.from(content)], name, { type: 'application/octet-stream' });

function upload(files: File[]): { method: string; body: FormData } {
  const body = new FormData();
  for (const item of files) body.append('files[]', item, item.name);
  return { method: 'POST', body };
}

async function json<T>(res: Response, parse: (value: unknown) => T): Promise<T> {
  return parse(await res.json());
}

describe('POST /api/luts/stage', () => {
  it('answers one verdict per file and keeps the good ones in a stage folder', async () => {
    const { app, dataDir } = setup();
    const res = await app.request(
      '/api/luts/stage',
      upload([
        file('Golden Hour.cube', makeCube(5, TINT)),
        file('S-Log3 to Rec709.3dl', make3dl(5, TINT)),
        file('broken.cube', 'LUT_3D_SIZE 3\n'),
        file('poster.png', new Uint8Array([1, 2, 3])),
        file('notes.txt', 'hello'),
      ]),
    );
    expect(res.status).toBe(200);
    const body = await json(res, (value) => lutStageResponseSchema.parse(value));
    expect(body.files.map((f) => [f.id, f.name, f.ok, f.error, f.size, f.kindGuess])).toEqual([
      ['f0', 'Golden Hour.cube', true, null, 5, 'look'],
      ['f1', 'S-Log3 to Rec709.3dl', true, null, 5, 'camera'],
      ['f2', 'broken.cube', false, LUT_MESSAGES.badRows, null, 'look'],
      ['f3', 'poster.png', false, LUT_MESSAGES.badExtension, null, 'look'],
      ['f4', 'notes.txt', false, LUT_MESSAGES.badExtension, null, 'look'],
    ]);
    expect(body.files[3]?.bytes).toBe(3);
    expect(readdirSync(join(dataDir, 'lut-staging'))).toEqual([body.stageId]);
  });

  it('flattens a name with folders (a folder pick) to its base name', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/luts/stage',
      upload([
        file('LUTs/Looks/Golden Hour.cube', makeCube(3)),
        file('C:\\luts\\Teal.cube', makeCube(3)),
      ]),
    );
    const body = await json(res, (value) => lutStageResponseSchema.parse(value));
    expect(body.files.map((f) => f.name)).toEqual(['Golden Hour.cube', 'Teal.cube']);
  });

  it('is a verdict, not a failed request, when no file is a LUT', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/luts/stage',
      upload([file('a.png', 'x'), file('b.mov', 'y')]),
    );
    expect(res.status).toBe(200);
    const body = await json(res, (value) => lutStageResponseSchema.parse(value));
    expect(body.files.every((f) => !f.ok && f.error === LUT_MESSAGES.badExtension)).toBe(true);
  });

  it('refuses a file over 40 MB with a verdict and still stages the rest', async () => {
    const { app } = setup();
    const huge = file('huge.cube', new Uint8Array(40 * 1024 * 1024 + 10));
    const res = await app.request('/api/luts/stage', upload([huge, file('ok.cube', makeCube(3))]));
    expect(res.status).toBe(200);
    const body = await json(res, (value) => lutStageResponseSchema.parse(value));
    expect(body.files.map((f) => [f.name, f.ok, f.error])).toEqual([
      ['huge.cube', false, LUT_MESSAGES.tooLarge],
      ['ok.cube', true, null],
    ]);
    expect(body.files[0]?.bytes).toBe(40 * 1024 * 1024 + 10);
  });

  it('is 413 for more than 60 files, and leaves no stage behind', async () => {
    const { app, dataDir } = setup();
    const files = Array.from({ length: 61 }, (_, n) => file(`lut-${n}.cube`, makeCube(2)));
    const res = await app.request('/api/luts/stage', upload(files));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.tooManyFiles });
    expect(readdirSync(join(dataDir, 'lut-staging'))).toEqual([]);
  });

  it('is 400 for a body that is not multipart or has no file, and leaves no stage behind', async () => {
    const { app, dataDir } = setup();
    const notForm = await app.request('/api/luts/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(notForm.status).toBe(400);
    expect(await notForm.json()).toEqual({ error: LUT_MESSAGES.badImport });
    const noFiles = await app.request('/api/luts/stage', { method: 'POST', body: new FormData() });
    expect(noFiles.status).toBe(400);
    const noBody = await app.request('/api/luts/stage', { method: 'POST' });
    expect(noBody.status).toBe(400);
    expect(readdirSync(join(dataDir, 'lut-staging'))).toEqual([]);
  });
});

describe('the whole way: stage, import, list, get, rename, duplicate, reveal, delete', () => {
  it('works through the HTTP routes', async () => {
    const { app, inbox, home, revealed, repo } = setup();
    const send = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });

    // stage → import (2 good, 1 bad)
    const staged = await json(
      await app.request(
        '/api/luts/stage',
        upload([
          file('Golden Hour Warm.cube', makeCube(5, TINT)),
          file('Teal Orange.3dl', make3dl(17, TINT)),
          file('broken.cube', 'x'),
        ]),
      ),
      (value) => lutStageResponseSchema.parse(value),
    );
    const importRes = await send('POST', '/api/luts/import', {
      stageId: staged.stageId,
      items: staged.files.map((f, n) => ({ id: f.id, kind: n === 1 ? 'fix' : 'look' })),
    });
    expect(importRes.status).toBe(201);
    const imported = await json(importRes, (value) => lutImportResponseSchema.parse(value));
    expect(imported.imported.map((lut) => [lut.slug, lut.kind, lut.size])).toEqual([
      ['golden-hour-warm', 'look', 5],
      ['teal-orange', 'fix', 17],
    ]);
    expect(imported.failed).toEqual([{ id: 'f2', error: LUT_MESSAGES.badImportItem }]);
    expect(readdirSync(join(inbox, '_LUTs')).sort()).toEqual([
      'Golden Hour Warm.cube',
      'Teal Orange.cube',
    ]);

    // list
    const list = await json(await send('GET', '/api/luts'), (value) =>
      lutListResponseSchema.parse(value),
    );
    expect(list.yours.map((lut) => lut.slug)).toEqual(['teal-orange', 'golden-hour-warm']);

    // get
    const detail = await json(await send('GET', '/api/luts/golden-hour-warm'), (value) =>
      lutDetailSchema.parse(value),
    );
    expect(detail).toMatchObject({
      file: 'Golden Hour Warm.cube',
      sizeLabel: '5 × 5 × 5',
      usedIn: null,
    });

    // rename (and the old slug is gone)
    const renamed = await send('PATCH', '/api/luts/golden-hour-warm', {
      name: 'Sunset Amber',
      kind: 'camera',
    });
    expect(renamed.status).toBe(200);
    expect(await json(renamed, (value) => lutDetailSchema.parse(value))).toMatchObject({
      slug: 'sunset-amber',
      kind: 'camera',
      file: 'Sunset Amber.cube',
    });
    expect((await send('GET', '/api/luts/golden-hour-warm')).status).toBe(404);
    const taken = await send('PATCH', '/api/luts/sunset-amber', { name: 'Teal Orange' });
    expect(taken.status).toBe(422);
    expect(await taken.json()).toEqual({ error: LUT_MESSAGES.nameTaken });

    // duplicate
    const copy = await send('POST', '/api/luts/sunset-amber/duplicate');
    expect(copy.status).toBe(201);
    expect(await json(copy, (value) => lutDetailSchema.parse(value))).toMatchObject({
      slug: 'sunset-amber-2',
      kind: 'camera',
    });

    // reveal
    const reveal = await send('POST', '/api/luts/sunset-amber/reveal');
    expect(await json(reveal, (value) => revealLutResponseSchema.parse(value))).toEqual({
      ok: true,
    });
    expect(revealed).toEqual([join(inbox, '_LUTs', 'Sunset Amber.cube')]);

    // delete → Trash
    const del = await send('DELETE', '/api/luts/sunset-amber-2');
    expect(del.status).toBe(200);
    const deleted = await json(del, (value) => deleteLutResponseSchema.parse(value));
    expect(deleted.where).toBe(join(home, '.Trash', 'Sunset Amber (2).cube'));
    expect(existsSync(deleted.where)).toBe(true);
    expect((await send('DELETE', '/api/luts/sunset-amber-2')).status).toBe(404);
    expect(repo.list().map((lut) => lut.slug)).toEqual(['teal-orange', 'sunset-amber']);
  });

  it('cancels a stage, and a second cancel is 404', async () => {
    const { app, dataDir } = setup();
    const staged = await json(
      await app.request('/api/luts/stage', upload([file('a.cube', makeCube(3))])),
      (value) => lutStageResponseSchema.parse(value),
    );
    const cancel = await app.request(`/api/luts/stage/${staged.stageId}`, { method: 'DELETE' });
    expect(await json(cancel, (value) => cancelLutStageResponseSchema.parse(value))).toEqual({
      ok: true,
    });
    expect(readdirSync(join(dataDir, 'lut-staging'))).toEqual([]);
    const again = await app.request(`/api/luts/stage/${staged.stageId}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(apiErrorSchema.parse(await again.json()).error).toBe(LUT_MESSAGES.stageNotFound);
    // importing from it is 404 too
    const imported = await app.request('/api/luts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId: staged.stageId, items: [{ id: 'f0', kind: 'look' }] }),
    });
    expect(imported.status).toBe(404);
  });

  it('answers a built-in LUT with 409 while the colour grade is not installed, and a stray slug with 404', async () => {
    const { app } = setup();
    expect((await app.request('/api/luts/film-contrast', { method: 'DELETE' })).status).toBe(409);
    expect((await app.request('/api/luts/film-contrast')).status).toBe(409);
    expect((await app.request('/api/luts/nothing-here', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/luts/nothing-here/reveal', { method: 'POST' })).status).toBe(
      404,
    );
  });
});

describe('receiveLutFiles', () => {
  it('stops an upload past the total limit with 413', async () => {
    const dir = tempDir('upload');
    const request = new Request(
      'http://localhost/x',
      upload([file('a.cube', 'x'.repeat(600)), file('b.cube', 'y'.repeat(600))]),
    );
    const error = await receiveLutFiles(request, { stageDir: dir, maxTotalBytes: 1000 }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(LutUploadError);
    expect(error).toMatchObject({ status: 413, message: LUT_UPLOAD_TOO_MUCH });
  });

  it('counts a non-LUT file in the total but writes nothing for it', async () => {
    const dir = tempDir('upload');
    const request = new Request(
      'http://localhost/x',
      upload([file('a.png', 'x'.repeat(100)), file('b.cube', 'y'.repeat(50))]),
    );
    const files = await receiveLutFiles(request, { stageDir: dir });
    expect(files.map((f) => [f.name, f.bytes])).toEqual([
      ['a.png', 100],
      ['b.cube', 50],
    ]);
    expect(readdirSync(dir)).toEqual(['f1.upload']);
    expect(readFileSync(join(dir, 'f1.upload'), 'utf8')).toBe('y'.repeat(50));
  });

  it('keeps no more than the per-file limit of a big LUT file but reports its real size', async () => {
    const dir = tempDir('upload');
    const request = new Request('http://localhost/x', upload([file('big.cube', 'z'.repeat(300))]));
    const files = await receiveLutFiles(request, { stageDir: dir, maxFileBytes: 100 });
    expect(files[0]?.bytes).toBe(300);
    expect(readFileSync(join(dir, 'f0.upload'), 'utf8')).toBe('');
  });
});
