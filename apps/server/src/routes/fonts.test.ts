import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  FONT_MESSAGES,
  FONT_MIME_TYPES,
  fontFamilyDetailSchema,
  fontsListResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { FontRepository } from '../db/font-repository.js';
import { memoryDb } from '../db/test-utils.js';
import {
  createDisabledFontService,
  createFontService,
  type FontService,
} from '../fonts/font-service.js';
import { FIXTURE_FONTS } from '../fonts/font-test-utils.js';
import { makeLibrary, makeStandardLibrary, type TempLibrary } from '../fonts/library/test-utils.js';
import {
  fakeFontService,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
  makeFontStageItem,
} from '../fonts/test-utils.js';

// The Fonts routes (FN1): every route of the plan's API calls its service method and turns the
// answer into HTTP. The real service is still a stub, so the routes are driven by a fake one.

const ok = <Body>(body: Body, status: 200 | 201 = 200) => ({ ok: true as const, status, body });
const refuse = (status: 400 | 404 | 409 | 413 | 500, error: string) => ({
  ok: false as const,
  status,
  error,
});

function appWith(service: FontService) {
  return createApp({ fonts: true, fontsRoutes: { service } });
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('the Fonts routes while the switch is off', () => {
  const everyRoute = [
    ['GET', '/api/fonts'],
    ['GET', '/api/fonts/heebo'],
    ['GET', '/api/fonts/file/3f9a1c7e5b20'],
    ['POST', '/api/fonts/heebo/reveal'],
    ['DELETE', '/api/fonts/heebo'],
    ['DELETE', '/api/fonts/requests/a3c19e0b7d44'],
    ['POST', '/api/fonts/stage'],
    ['DELETE', '/api/fonts/stage/abc'],
    ['POST', '/api/fonts/import'],
  ] as const;

  it('answer 404 "Fonts are off." for every Fonts path, and never ask the service', async () => {
    const list = vi.fn();
    const service = fakeFontService({ list });
    const app = createApp({ fonts: false, fontsRoutes: { service } });

    for (const [method, path] of everyRoute) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.off });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('are off too for an app given the switch but not the routes, or the routes but not the switch', async () => {
    expect((await createApp({ fonts: true }).request('/api/fonts')).status).toBe(404);
    const unswitched = createApp({ fontsRoutes: { service: fakeFontService() } });
    expect((await unswitched.request('/api/fonts')).status).toBe(404);
    // fontsInNotes alone mounts nothing either.
    const inNotes = createApp({ fontsInNotes: true, fontsRoutes: { service: fakeFontService() } });
    expect((await inNotes.request('/api/fonts')).status).toBe(404);
  });

  it('are refused the same way by the disabled service', async () => {
    const service = createDisabledFontService();
    expect(service.enabled).toBe(false);
    const off = { ok: false, status: 404, error: FONT_MESSAGES.off };
    expect(await service.list()).toEqual(off);
    expect(await service.get('heebo')).toEqual(off);
    expect(await service.file('abc')).toEqual(off);
    expect(await service.reveal('heebo')).toEqual(off);
    expect(await service.remove('heebo')).toEqual(off);
    expect(await service.stage({ stageId: 'abc', dir: '/nowhere' }, [])).toEqual(off);
    expect(await service.cancelStage('abc')).toEqual(off);
    expect(await service.importStaged('abc', ['karantina'])).toEqual(off);
  });
});

describe('GET /api/fonts', () => {
  it('answers what the service lists', async () => {
    const list = {
      families: [makeFontFamilySummary()],
      catalog: [],
      requests: [makeFontRequest()],
    };
    const app = appWith(fakeFontService({ list: async () => ok(list) }));

    const res = await app.request('/api/fonts');

    expect(res.status).toBe(200);
    expect(fontsListResponseSchema.parse(await res.json())).toEqual(list);
  });

  it('passes a refusal on as { error } with its status', async () => {
    const app = appWith(
      fakeFontService({ list: async () => refuse(500, FONT_MESSAGES.fileMissing) }),
    );
    const res = await app.request('/api/fonts');
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: FONT_MESSAGES.fileMissing });
  });
});

describe('GET /api/fonts/:slug', () => {
  it('asks the service for the slug and answers the family', async () => {
    const get = vi.fn(async () => ok(makeFontFamilyDetail()));
    const app = appWith(fakeFontService({ get }));

    const res = await app.request('/api/fonts/heebo');

    expect(res.status).toBe(200);
    expect(fontFamilyDetailSchema.parse(await res.json())).toEqual(makeFontFamilyDetail());
    expect(get).toHaveBeenCalledWith('heebo');
  });

  it('answers a slug the service does not know with its 404', async () => {
    const app = appWith(fakeFontService({ get: async () => refuse(404, FONT_MESSAGES.notFound) }));
    const res = await app.request('/api/fonts/nothing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: FONT_MESSAGES.notFound });
  });
});

describe('GET /api/fonts/file/:fileId', () => {
  it('sends the file the service names, with its type', async () => {
    const path = join(FIXTURE_FONTS, 'Outfit-Bold.ttf');
    const file = vi.fn(async () => ok({ path, format: 'ttf' as const, mtimeMs: 1 }));
    const app = appWith(fakeFontService({ file }));

    const res = await app.request('/api/fonts/file/3f9a1c7e5b20?v=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(FONT_MIME_TYPES.ttf);
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(path))).toBe(true);
    expect(file).toHaveBeenCalledWith('3f9a1c7e5b20');
  });

  describe("the cache rules (`?v=` against the file's modified time)", () => {
    const path = join(FIXTURE_FONTS, 'Outfit-Bold.ttf');
    const mtimeMs = 1_729_843_200_123;
    const appFor = () =>
      appWith(fakeFontService({ file: async () => ok({ path, format: 'ttf' as const, mtimeMs }) }));

    it('lets the browser keep the file for good when v is its modified time', async () => {
      const res = await appFor().request(`/api/fonts/file/3f9a1c7e5b20?v=${mtimeMs}`);

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(path))).toBe(true);
    });

    it('sends the file but tells the browser to ask again when v is not its modified time', async () => {
      for (const query of ['?v=1729843200122', '?v=', '?v=abc', '?v=1729843200123.5', '']) {
        const res = await appFor().request(`/api/fonts/file/3f9a1c7e5b20${query}`);
        expect(res.status, query).toBe(200);
        expect(res.headers.get('cache-control'), query).toBe('no-cache');
        expect(res.headers.get('content-type'), query).toBe('font/ttf');
        await res.arrayBuffer();
      }
    });

    it('sends each format with its own type', async () => {
      for (const [file, format] of [
        ['Outfit-Bold.ttf', 'ttf'],
        ['Outfit-Bold.woff', 'woff'],
        ['Outfit-Bold.woff2', 'woff2'],
      ] as const) {
        const app = appWith(
          fakeFontService({
            file: async () => ok({ path: join(FIXTURE_FONTS, file), format, mtimeMs }),
          }),
        );
        const res = await app.request(`/api/fonts/file/x?v=${mtimeMs}`);
        expect(res.headers.get('content-type'), file).toBe(FONT_MIME_TYPES[format]);
        await res.arrayBuffer();
      }
      expect(FONT_MIME_TYPES).toMatchObject({
        otf: 'font/otf',
        ttf: 'font/ttf',
        woff: 'font/woff',
        woff2: 'font/woff2',
      });
    });

    it('answers 404 with the message when the file went away after the service looked', async () => {
      const app = appWith(
        fakeFontService({
          file: async () => ok({ path: join(FIXTURE_FONTS, 'gone.ttf'), format: 'ttf', mtimeMs }),
        }),
      );

      const res = await app.request('/api/fonts/file/x');

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: FONT_MESSAGES.fileNotFound });
    });

    it('answers an id the service does not know with its 404, and no cache header', async () => {
      const app = appWith(
        fakeFontService({ file: async () => refuse(404, FONT_MESSAGES.fileNotFound) }),
      );

      const res = await app.request(`/api/fonts/file/nothing?v=${mtimeMs}`);

      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBeNull();
    });
  });

  it('is not taken for a family called "file"', async () => {
    const file = vi.fn(async () => refuse(404, FONT_MESSAGES.fileNotFound));
    const get = vi.fn(async () => ok(makeFontFamilyDetail()));
    const app = appWith(fakeFontService({ file, get }));

    const res = await app.request('/api/fonts/file/unknown-id');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: FONT_MESSAGES.fileNotFound });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('POST /api/fonts/:slug/reveal and DELETE /api/fonts/:slug', () => {
  it('reveal asks the service for the slug', async () => {
    const reveal = vi.fn(async () => ok({ ok: true as const }));
    const app = appWith(fakeFontService({ reveal }));

    const res = await app.request('/api/fonts/heebo/reveal', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reveal).toHaveBeenCalledWith('heebo');
  });

  it('delete asks the service for the slug and answers where the files went', async () => {
    const remove = vi.fn(async () => ok({ ok: true as const, where: '~/.Trash' }));
    const app = appWith(fakeFontService({ remove }));

    const res = await app.request('/api/fonts/heebo', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, where: '~/.Trash' });
    expect(remove).toHaveBeenCalledWith('heebo');
  });

  it('pass the refusals on', async () => {
    const app = appWith(
      fakeFontService({
        reveal: async () => refuse(500, FONT_MESSAGES.revealFailed),
        remove: async () => refuse(404, FONT_MESSAGES.notFound),
      }),
    );
    const reveal = await app.request('/api/fonts/heebo/reveal', { method: 'POST' });
    expect([reveal.status, await reveal.json()]).toEqual([
      500,
      { error: FONT_MESSAGES.revealFailed },
    ]);
    const remove = await app.request('/api/fonts/heebo', { method: 'DELETE' });
    expect([remove.status, await remove.json()]).toEqual([404, { error: FONT_MESSAGES.notFound }]);
  });
});

describe('DELETE /api/fonts/requests/:id ("Not a font", C52)', () => {
  it('asks the service to dismiss that request and answers { ok: true }', async () => {
    const dismissRequest = vi.fn(async () => ok({ ok: true as const }));
    const app = appWith(fakeFontService({ dismissRequest }));

    const res = await app.request('/api/fonts/requests/a3c19e0b7d44', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dismissRequest).toHaveBeenCalledWith('a3c19e0b7d44');
  });

  it('is not the delete of a family called “requests”: that one has one segment', async () => {
    const dismissRequest = vi.fn(async () => ok({ ok: true as const }));
    const remove = vi.fn(async () => ok({ ok: true as const, where: '~/.Trash' }));
    const app = appWith(fakeFontService({ dismissRequest, remove }));

    await app.request('/api/fonts/requests', { method: 'DELETE' });

    expect(remove).toHaveBeenCalledWith('requests');
    expect(dismissRequest).not.toHaveBeenCalled();
  });

  it('passes the refusal on as { error } with its status', async () => {
    const app = appWith(
      fakeFontService({ dismissRequest: async () => refuse(404, FONT_MESSAGES.requestNotFound) }),
    );

    const res = await app.request('/api/fonts/requests/0123456789ab', { method: 'DELETE' });

    expect([res.status, await res.json()]).toEqual([404, { error: FONT_MESSAGES.requestNotFound }]);
  });

  describe('on the real service and repository', () => {
    function appWithRequests(options: { usedIn?: boolean } = {}) {
      const repo = new FontRepository(memoryDb());
      const published: unknown[] = [];
      const service = createFontService({
        repo,
        inboxPath: '/inbox-that-is-not-there',
        publish: (event) => published.push(event),
        usedIn: options.usedIn ?? true,
        jobName: (jobId) =>
          ({ 'job-a': 'Demo · Horizon FPV', 'job-b': 'Demo · Spring' })[jobId] ?? null,
        logger: { info() {}, warn() {}, error() {} },
      });
      const now = Date.now();
      const falcon = repo.addRequest('Falcon', 'job-a', 0, new Date(now - 3000).toISOString());
      repo.addRequest('Gotham Bold', 'job-a', 0, new Date(now - 2000).toISOString());
      repo.addRequest('Avenir', 'job-b', 0, new Date(now - 1000).toISOString());
      return { app: appWith(service), repo, published, falcon };
    }

    const requestNames = async (app: ReturnType<typeof appWith>) => {
      const body = fontsListResponseSchema.parse(await (await app.request('/api/fonts')).json());
      return body.requests.map((request) => request.name);
    };

    it('dismisses one of three: the list has the other two, and the word is not asked again', async () => {
      const { app, repo, published, falcon } = appWithRequests();
      expect(await requestNames(app)).toEqual(['Avenir', 'Gotham Bold', 'Falcon']);

      const res = await app.request(`/api/fonts/requests/${falcon.id}`, { method: 'DELETE' });

      expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
      expect(await requestNames(app)).toEqual(['Avenir', 'Gotham Bold']);
      expect(published).toEqual([{ type: 'font.request.dismissed', id: falcon.id }]);
      // The next round of the same job keeps the word in its note: nothing comes back.
      expect(repo.recordRequest('Falcon', 'job-a', 1).added).toBe(false);
      expect(await requestNames(app)).toEqual(['Avenir', 'Gotham Bold']);
    });

    it('answers 404 for an id it does not know', async () => {
      const { app } = appWithRequests();
      const res = await app.request('/api/fonts/requests/0123456789ab', { method: 'DELETE' });
      expect([res.status, await res.json()]).toEqual([
        404,
        { error: FONT_MESSAGES.requestNotFound },
      ]);
    });

    it('refuses while notes cannot name a font (fontsInNotes off), and the request stays', async () => {
      const { app, repo, falcon } = appWithRequests({ usedIn: false });
      const res = await app.request(`/api/fonts/requests/${falcon.id}`, { method: 'DELETE' });
      expect([res.status, await res.json()]).toEqual([
        404,
        { error: FONT_MESSAGES.requestNotFound },
      ]);
      expect(repo.openRequests(0)).toHaveLength(3);
    });
  });
});

describe('the import routes', () => {
  it('POST /stage opens a stage, hands the service the files it received and answers its verdicts', async () => {
    const stageDir = mkdtempSync(join(tmpdir(), 'studio-fonts-route-'));
    try {
      const stageResponse = { stageId: 'stage-1', items: [makeFontStageItem()] };
      const beginStage = vi.fn(async () => ({ stageId: 'stage-1', dir: stageDir }));
      const stage = vi.fn(async () => ok(stageResponse));
      const cancelStage = vi.fn();
      const app = appWith(fakeFontService({ beginStage, stage, cancelStage }));
      const form = new FormData();
      form.append('files[]', new Blob(['abc']), 'Fonts/Heebo/Heebo-Bold.ttf');

      const res = await app.request('/api/fonts/stage', { method: 'POST', body: form });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(stageResponse);
      expect(stage).toHaveBeenCalledWith({ stageId: 'stage-1', dir: stageDir }, [
        { name: 'Fonts/Heebo/Heebo-Bold.ttf', path: join(stageDir, 'f0.upload'), bytes: 3 },
      ]);
      expect(cancelStage).not.toHaveBeenCalled();
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  });

  it('DELETE /stage/:stageId cancels that stage', async () => {
    const cancelStage = vi.fn(async () => ok({ ok: true as const }));
    const app = appWith(fakeFontService({ cancelStage }));

    const res = await app.request('/api/fonts/stage/stage-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cancelStage).toHaveBeenCalledWith('stage-1');
  });

  it('POST /import hands the stage and the chosen items to the service', async () => {
    const answer = { imported: [makeFontFamilySummary({ slug: 'karantina' })], failed: [] };
    const importStaged = vi.fn(async () => ok(answer, 201));
    const app = appWith(fakeFontService({ importStaged }));

    const res = await app.request(
      '/api/fonts/import',
      json({ stageId: 'stage-1', items: ['karantina', 'heebo'] }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(answer);
    expect(importStaged).toHaveBeenCalledWith('stage-1', ['karantina', 'heebo']);
  });

  it('POST /import refuses a body that cannot be read with 400, never asking the service', async () => {
    const importStaged = vi.fn();
    const app = appWith(fakeFontService({ importStaged }));

    for (const body of [
      undefined,
      'not json',
      {},
      { stageId: 'stage-1' },
      { stageId: 'stage-1', items: [] },
      { stageId: '', items: ['a'] },
      { stageId: 'stage-1', items: [3] },
    ]) {
      const res = await app.request('/api/fonts/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body:
          typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: FONT_MESSAGES.badImport });
    }
    expect(importStaged).not.toHaveBeenCalled();
  });

  it('POST /import refuses more items than the limit with 413', async () => {
    const importStaged = vi.fn();
    const app = appWith(fakeFontService({ importStaged }));
    const items = Array.from({ length: 401 }, (_, i) => `item-${i}`);

    const res = await app.request('/api/fonts/import', json({ stageId: 'stage-1', items }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: FONT_MESSAGES.tooManyFiles });
    expect(importStaged).not.toHaveBeenCalled();
  });

  it('are not taken for a family called "stage" or "import"', async () => {
    const get = vi.fn(async () => ok(makeFontFamilyDetail()));
    const cancelStage = vi.fn(async () => ok({ ok: true as const }));
    const app = appWith(fakeFontService({ get, cancelStage }));

    await app.request('/api/fonts/stage/x', { method: 'DELETE' });

    expect(cancelStage).toHaveBeenCalledWith('x');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('the service the engine uses while Fonts are on', () => {
  function service() {
    const db = memoryDb();
    return createFontService({
      repo: new FontRepository(db),
      inboxPath: '/inbox-that-is-not-there',
      publish: () => {},
      usedIn: false,
      logger: { info() {}, warn() {}, error() {} },
    });
  }

  it('says it is on, and lists nothing while _Fonts is empty or missing', async () => {
    const fonts = service();
    expect(fonts.enabled).toBe(true);
    expect(await fonts.list()).toEqual({
      ok: true,
      status: 200,
      body: { families: [], catalog: [], requests: [] },
    });
    expect(await fonts.get('heebo')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.notFound,
    });
    expect(await fonts.file('abc')).toEqual({
      ok: false,
      status: 404,
      error: FONT_MESSAGES.fileNotFound,
    });
  });
});

describe('the three GET routes on a real _Fonts folder', () => {
  const libraries: TempLibrary[] = [];
  afterEach(() => {
    for (const library of libraries.splice(0)) library.cleanup();
  });

  function appOnLibrary() {
    const library = makeStandardLibrary();
    libraries.push(library);
    const service = createFontService({
      repo: new FontRepository(memoryDb()),
      inboxPath: library.inbox,
      publish: () => {},
      usedIn: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    return { library, app: appWith(service) };
  }

  it('GET /api/fonts lists the families, every face and no open requests', async () => {
    const { app } = appOnLibrary();

    const res = await app.request('/api/fonts');

    expect(res.status).toBe(200);
    const list = fontsListResponseSchema.parse(await res.json());
    expect(list.families.map((family) => family.slug)).toEqual([
      'bellefair',
      'oswald',
      'outfit',
      'secular-one',
      'varela-round',
    ]);
    expect(list.catalog).toHaveLength(6);
    expect(list.requests).toEqual([]);
  });

  it('GET /api/fonts/:slug answers a family, and 404 with the message for an unknown one', async () => {
    const { app } = appOnLibrary();

    const found = await app.request('/api/fonts/outfit');
    expect(found.status).toBe(200);
    const detail = fontFamilyDetailSchema.parse(await found.json());
    expect(detail.faces.map((face) => face.name)).toEqual(['Outfit', 'Outfit Bold']);
    expect(detail.usedIn).toBe(0);

    const missing = await app.request('/api/fonts/gotham');
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json())).toEqual({ error: FONT_MESSAGES.notFound });
  });

  it('GET /api/fonts/file/:fileId sends the bytes of the face, immutable at its own version', async () => {
    const { app, library } = appOnLibrary();
    const detail = fontFamilyDetailSchema.parse(
      await (await app.request('/api/fonts/outfit')).json(),
    );
    const bold = detail.faces.find((face) => face.name === 'Outfit Bold');
    expect(bold?.version).toMatch(/^\d+$/);

    const res = await app.request(`/api/fonts/file/${bold?.fileId}?v=${bold?.version}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/ttf');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(
      Buffer.from(await res.arrayBuffer()).equals(
        readFileSync(library.path('English only/Outfit/Outfit-Bold.ttf')),
      ),
    ).toBe(true);

    // The address of a file that has been replaced is another one: the old version is not kept.
    const stale = await app.request(
      `/api/fonts/file/${bold?.fileId}?v=${Number(bold?.version) - 1}`,
    );
    expect(stale.headers.get('cache-control')).toBe('no-cache');
    await stale.arrayBuffer();
  });

  it('GET /api/fonts/file/:fileId takes the type from the file itself, not from its name', async () => {
    const library = makeLibrary();
    libraries.push(library);
    library.putFixture('Outfit/Outfit-Bold.ttf', 'Outfit-Bold.woff2');
    const service = createFontService({
      repo: new FontRepository(memoryDb()),
      inboxPath: library.inbox,
      publish: () => {},
      usedIn: false,
      logger: { info() {}, warn() {}, error() {} },
    });
    const app = appWith(service);
    const detail = fontFamilyDetailSchema.parse(
      await (await app.request('/api/fonts/outfit')).json(),
    );

    const res = await app.request(`/api/fonts/file/${detail.faces[0]?.fileId}`);

    expect(detail.faces[0]?.format).toBe('woff2');
    expect(res.headers.get('content-type')).toBe('font/woff2');
    await res.arrayBuffer();
  });

  it('GET /api/fonts/file/:fileId answers 404 for an id it does not know, and for a path', async () => {
    const { app, library } = appOnLibrary();

    for (const id of [
      '0123456789ab',
      encodeURIComponent(library.path('English only/Outfit/Outfit-Bold.ttf')),
    ]) {
      const res = await app.request(`/api/fonts/file/${id}`);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: FONT_MESSAGES.fileNotFound });
    }
  });

  it('is not taken for a family called "file" when the id is missing', async () => {
    const { app } = appOnLibrary();
    const res = await app.request('/api/fonts/file');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: FONT_MESSAGES.notFound });
  });
});
