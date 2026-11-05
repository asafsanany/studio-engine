import {
  apiErrorSchema,
  GRAPHIC_MESSAGES,
  graphicDetailSchema,
  graphicListResponseSchema,
  healthResponseSchema,
  SETTLE_MS,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type GraphicsApiOptions } from './app.js';
import { disabledSeriesService } from './clients/series-service.js';
import { GraphicRepository } from './db/index.js';
import { memoryDb } from './db/test-utils.js';
import { FakeGraphicRunner } from './graphics/fake-graphic-runner.js';
import { GRAPHICS_ASSETS_DIR } from './graphics/graphic-assets.js';
import { GraphicFolders } from './graphics/graphic-folders.js';
import { createDisabledGraphicService, createGraphicService } from './graphics/graphic-service.js';
import { GraphicWorker } from './graphics/graphic-worker.js';
import type { VoiceTranscriber } from './pipeline/voice-transcriber.js';
import { version } from './version.js';

describe('GET /api/health', () => {
  it('returns ok, the app version, the default settle delay, and every switch off', async () => {
    const res = await createApp().request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version,
      settleMs: SETTLE_MS,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: false,
      luts: false,
      lutsInEdits: false,
      fonts: false,
      fontsInNotes: false,
      quickFixes: false,
      songs: false,
      generate: false,
      draftChat: false,
      instagram: false,
      dms: false,
    });
  });

  it('returns the settle delay the app was given', async () => {
    const res = await createApp({ settleMs: 5000 }).request('/api/health');

    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      version,
      settleMs: 5000,
      series: false,
      jobSheet: false,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
      music: false,
      luts: false,
      lutsInEdits: false,
      fonts: false,
      fontsInNotes: false,
      quickFixes: false,
      songs: false,
      generate: false,
      draftChat: false,
      instagram: false,
      dms: false,
    });
  });

  it('says whether the job sheet is on: the switch the app was given', async () => {
    const off = await createApp({ jobSheet: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).jobSheet).toBe(false);

    const on = await createApp({ jobSheet: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).jobSheet).toBe(true);
  });

  it('says whether analytics is on: the switch the app was given', async () => {
    const off = await createApp({ analytics: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).analytics).toBe(false);

    const on = await createApp({ analytics: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).analytics).toBe(true);
  });

  it('keeps the switches apart', async () => {
    const res = await createApp({ analytics: true }).request('/api/health');
    expect(healthResponseSchema.parse(await res.json())).toMatchObject({
      series: false,
      jobSheet: false,
      analytics: true,
      phone: false,
    });
  });

  it('says whether the phone layout is on: the switch the app was given', async () => {
    const off = await createApp({ phone: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).phone).toBe(false);

    const on = await createApp({ phone: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).phone).toBe(true);
  });

  it('says whether the Graphics switches are on: the switches the app was given', async () => {
    const off = await createApp({ graphics: false, graphicsInEdits: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json())).toMatchObject({
      graphics: false,
      graphicsInEdits: false,
    });

    const graphics = await createApp({ graphics: true }).request('/api/health');
    expect(healthResponseSchema.parse(await graphics.json())).toMatchObject({
      graphics: true,
      graphicsInEdits: false,
    });

    const inEdits = await createApp({ graphicsInEdits: true }).request('/api/health');
    expect(healthResponseSchema.parse(await inEdits.json())).toMatchObject({
      graphics: false,
      graphicsInEdits: true,
    });
  });

  it('says whether the Fonts switches are on: the switches the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json())).toMatchObject({
      fonts: false,
      fontsInNotes: false,
    });

    const fonts = await createApp({ fonts: true }).request('/api/health');
    expect(healthResponseSchema.parse(await fonts.json())).toMatchObject({
      fonts: true,
      fontsInNotes: false,
    });

    const inNotes = await createApp({ fontsInNotes: true }).request('/api/health');
    expect(healthResponseSchema.parse(await inNotes.json())).toMatchObject({
      fonts: false,
      fontsInNotes: true,
    });
  });

  it('says whether Quick fixes are on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).quickFixes).toBe(false);

    const off = await createApp({ quickFixes: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).quickFixes).toBe(false);

    const on = await createApp({ quickFixes: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json())).toMatchObject({
      quickFixes: true,
      fonts: false,
      fontsInNotes: false,
    });
  });

  it('says whether Songs are on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).songs).toBe(false);

    // Songs builds on Soundtrack: asked for without music it says off.
    const noMusic = await createApp({ songs: true }).request('/api/health');
    expect(healthResponseSchema.parse(await noMusic.json())).toMatchObject({
      songs: false,
      music: false,
    });

    const on = await createApp({ songs: true, music: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json())).toMatchObject({ songs: true, music: true });
  });

  it('says whether Generated videos are on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).generate).toBe(false);

    const off = await createApp({ generate: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).generate).toBe(false);

    const on = await createApp({ generate: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json())).toMatchObject({
      generate: true,
      songs: false,
      music: false,
    });
  });

  it('says whether Draft & chat is on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).draftChat).toBe(false);

    const on = await createApp({ draftChat: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).draftChat).toBe(true);
  });

  it('says whether Clients × Instagram is on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).instagram).toBe(false);

    const on = await createApp({ instagram: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).instagram).toBe(true);
  });

  it('says whether the Instagram DMs page exists: only an app given its routes has it', async () => {
    const without = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await without.json()).dms).toBe(false);

    const inbox = {
      read: () => ({
        connection: {
          state: 'off' as const,
          account: null,
          from: ['owner_account'],
          checkedAt: null,
          error: null,
          everySecs: 60,
        },
        items: [],
      }),
      check: async () => inbox.read(),
      item: () => undefined,
      filesDir: '/nowhere',
    };
    const app = createApp({ dmsRoutes: { inbox, revealFile: async () => {} } });
    expect(healthResponseSchema.parse(await (await app.request('/api/health')).json()).dms).toBe(
      true,
    );
    expect((await app.request('/api/dms')).status).toBe(200);
  });

  it('says whether music is on: the switch the app was given, off when not given', async () => {
    const unset = await createApp().request('/api/health');
    expect(healthResponseSchema.parse(await unset.json()).music).toBe(false);

    const off = await createApp({ music: false }).request('/api/health');
    expect(healthResponseSchema.parse(await off.json()).music).toBe(false);

    const on = await createApp({ music: true }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json())).toMatchObject({
      music: true,
      graphics: false,
      graphicsInEdits: false,
    });
  });

  it('says whether series are on: the series service’s own word', async () => {
    const off = await createApp({ series: { series: disabledSeriesService } }).request(
      '/api/health',
    );
    expect(healthResponseSchema.parse(await off.json()).series).toBe(false);

    const on = await createApp({
      series: { series: { ...disabledSeriesService, enabled: true } },
    }).request('/api/health');
    expect(healthResponseSchema.parse(await on.json()).series).toBe(true);
  });

  it('keeps a settle delay of 0 (it is not a missing value)', async () => {
    const res = await createApp({ settleMs: 0 }).request('/api/health');

    expect(healthResponseSchema.parse(await res.json()).settleMs).toBe(0);
  });
});

describe('unknown routes', () => {
  it('answer a JSON 404 in the shared error shape', async () => {
    const res = await createApp().request('/api/nope');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not found' });
  });

  it('do not mount /api/jobs when the app is given no jobs', async () => {
    const res = await createApp().request('/api/jobs');

    expect(res.status).toBe(404);
  });
});

describe('the graphics routes (the Graphics switch)', () => {
  const opened: ReturnType<typeof memoryDb>[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });

  const transcriber: VoiceTranscriber = {
    kind: 'fake',
    enqueue: async () => ({ text: 'x' }),
    stop: async () => {},
  };

  function graphicsRoutes(): { routes: GraphicsApiOptions; repo: GraphicRepository } {
    const db = memoryDb();
    opened.push(db);
    const repo = new GraphicRepository(db);
    const folders = new GraphicFolders({ inboxPath: '/inbox', dataDir: '/data' });
    const logger = { info() {}, warn() {}, error() {} };
    const worker = new GraphicWorker({
      repo,
      folders,
      runner: new FakeGraphicRunner(),
      publish: () => {},
      logger,
    });
    const service = createGraphicService({
      repo,
      folders,
      worker,
      publish: () => {},
      usedIn: false,
      logger,
    });
    return {
      repo,
      routes: {
        graphics: { service },
        files: { graphics: repo, inboxPath: '/inbox', assetsDir: GRAPHICS_ASSETS_DIR },
        voice: { transcriber, dataDir: '/data' },
      },
    };
  }

  it('answer 404 "Graphics are off." for every graphics path while the switch is off', async () => {
    const app = createApp({ graphics: false, graphicsRoutes: graphicsRoutes().routes });
    for (const [method, path] of [
      ['GET', '/api/graphics'],
      ['POST', '/api/graphics'],
      ['GET', '/api/graphics/3f9a1c2b7d4e'],
      ['POST', '/api/graphics/voice'],
      ['GET', '/api/graphics/3f9a1c2b7d4e/v/1/host.html'],
      ['DELETE', '/api/graphics/3f9a1c2b7d4e'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: GRAPHIC_MESSAGES.off });
    }
  });

  it('are off too for an app given the switch but not the routes', async () => {
    const res = await createApp({ graphics: true }).request('/api/graphics');
    expect(res.status).toBe(404);
  });

  it('list nothing for an empty library while the switch is on', async () => {
    const res = await createApp({
      graphics: true,
      graphicsRoutes: graphicsRoutes().routes,
    }).request('/api/graphics');
    expect(res.status).toBe(200);
    expect(graphicListResponseSchema.parse(await res.json())).toEqual([]);
  });

  it('list the graphics that are not empty, and answer one with its chat', async () => {
    const { repo, routes } = graphicsRoutes();
    const empty = repo.create({ name: 'New graphic' });
    const making = repo.create({ name: 'New graphic (2)' });
    repo.addMessage({ graphicId: making.id, role: 'you', text: 'A title.' });
    repo.addMessage({ graphicId: making.id, role: 'claude', version: 1, status: 'making' });
    const app = createApp({ graphics: true, graphicsRoutes: routes });

    const list = graphicListResponseSchema.parse(await (await app.request('/api/graphics')).json());
    expect(list.map((graphic) => [graphic.id, graphic.status])).toEqual([[making.id, 'making']]);

    const one = await app.request(`/api/graphics/${making.id}`);
    expect(one.status).toBe(200);
    const detail = graphicDetailSchema.parse(await one.json());
    expect(detail.messages.map((message) => message.role)).toEqual(['you', 'claude']);
    expect(detail.usedIn).toBeNull();

    // An empty graphic is not listed, but its page answers.
    expect((await app.request(`/api/graphics/${empty.id}`)).status).toBe(200);
    const unknown = await app.request('/api/graphics/ffffffffffff');
    expect(unknown.status).toBe(404);
    expect(apiErrorSchema.parse(await unknown.json())).toEqual({
      error: GRAPHIC_MESSAGES.notFound,
    });
  });

  it('refuse everything with 404 "Graphics are off." through the disabled service', async () => {
    const off = createDisabledGraphicService();
    expect(off.enabled).toBe(false);
    for (const outcome of [
      await off.list(),
      await off.get('x'),
      await off.create({ text: 'x', effort: null, files: [] }),
      await off.send('x', { text: 'x', effort: null, files: [] }),
      await off.stop('x', 'm'),
      await off.retry('x', 'm'),
      await off.restore('x', 1),
      await off.update('x', { uses: false }),
      await off.duplicate('x'),
      await off.reveal('x'),
      await off.remove('x'),
    ]) {
      expect(outcome).toEqual({ ok: false, status: 404, error: 'Graphics are off.' });
    }
  });
});
