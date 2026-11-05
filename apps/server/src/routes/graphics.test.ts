import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  deleteGraphicResponseSchema,
  GRAPHIC_MESSAGES,
  type GraphicDetail,
  graphicBusyMessage,
  graphicDetailSchema,
  graphicListResponseSchema,
  revealGraphicResponseSchema,
} from '@studio/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphicRefsDir, graphicsRoot } from '../graphics/graphic-folders.js';
import { type GraphicHarness, type HarnessOptions, makeHarness } from '../graphics/test-utils.js';
import { createGraphicsRoutes } from './graphics.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The graphics API over the real service, worker, folders and repository (a temp inbox, in-memory
// database) with a stand-in runner: bodies, statuses and the words of every refusal.

const harnesses: GraphicHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

const MAX_BYTES = 1_000;

function setup(options: HarnessOptions = {}): { h: GraphicHarness; app: Hono } {
  const h = makeHarness(options);
  harnesses.push(h);
  const app = new Hono().route(
    '/api/graphics',
    createGraphicsRoutes({ service: h.service, maxUploadBytes: MAX_BYTES }),
  );
  return { h, app };
}

type Fields = { text?: string; effort?: string; files?: Record<string, string> };

function form({ text, effort, files = {} }: Fields): FormData {
  const body = new FormData();
  if (text !== undefined) body.append('text', text);
  if (effort !== undefined) body.append('effort', effort);
  for (const [name, content] of Object.entries(files))
    body.append('files[]', new File([content], name));
  return body;
}

const post = (app: Hono, path: string, fields: Fields): Promise<Response> =>
  Promise.resolve(app.request(`/api/graphics${path}`, { method: 'POST', body: form(fields) }));

const call = (app: Hono, method: string, path: string, json?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/graphics${path}`, {
      method,
      ...(json === undefined
        ? {}
        : { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }),
    }),
  );

async function detail(res: Response): Promise<GraphicDetail> {
  expect(res.ok).toBe(true);
  return graphicDetailSchema.parse(await res.json());
}

async function error(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error;
}

/** Creates a graphic and waits until its v1 is made. */
async function made(app: Hono, h: GraphicHarness): Promise<GraphicDetail> {
  const created = await detail(await post(app, '', { text: 'A white pill with the name in it' }));
  await vi.waitFor(() => expect(h.repo.summary(created.id)?.status).not.toBe('making'));
  return detail(await call(app, 'GET', `/${created.id}`));
}

/** The upload folders a request must not leave behind. */
const staging = (h: GraphicHarness): string[] =>
  readdirSync(graphicsRoot(h.inbox)).filter((name) => name.startsWith('.upload-'));

describe('POST /api/graphics', () => {
  it('creates the graphic from the multipart message and answers 201 with its detail', async () => {
    const { h, app } = setup({ holdAll: true });

    const res = await post(app, '', {
      text: '  A white pill with the name in it ',
      effort: 'high',
      files: { 'shot.png': 'png', 'לוגו.svg': '<svg/>' },
    });

    expect(res.status).toBe(201);
    const created = await detail(res);
    expect(created).toMatchObject({ name: 'New graphic', status: 'making', makingVersion: 1 });
    expect(created.messages[0]).toMatchObject({
      role: 'you',
      text: 'A white pill with the name in it',
      effort: 'high',
      refs: ['shot.png', 'לוגו.svg'],
    });
    expect(
      readFileSync(join(graphicRefsDir(h.folders.dirOf('New graphic')), 'לוגו.svg'), 'utf8'),
    ).toBe('<svg/>');
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    expect(h.runner.requests[0]?.message).toMatchObject({
      effort: 'high',
      refs: ['shot.png', 'לוגו.svg'],
    });
    expect(staging(h)).toEqual([]);
  });

  it('takes a message that is only a file, and runs at the default effort without one', async () => {
    const { h, app } = setup();

    const res = await post(app, '', { files: { 'logo.png': 'png' } });

    expect(res.status).toBe(201);
    expect((await detail(res)).messages[0]).toMatchObject({
      text: '',
      refs: ['logo.png'],
      effort: null,
    });
    await vi.waitFor(() => expect(h.runner.requests).toHaveLength(1));
    expect(h.runner.requests[0]?.message.effort).toBe('xhigh');
  });

  it('refuses a message with no text and no file, text that is too long, and an effort that does not exist', async () => {
    const { h, app } = setup();

    const empty = await post(app, '', { text: '   ' });
    expect(empty.status).toBe(400);
    expect(await error(empty)).toBe(GRAPHIC_MESSAGES.textMissing);
    const long = await post(app, '', { text: 'x'.repeat(4001) });
    expect(long.status).toBe(400);
    expect(await error(long)).toBe(GRAPHIC_MESSAGES.textTooLong);
    const huge = await post(app, '', { text: 'x'.repeat(40_000) });
    expect(huge.status).toBe(400);
    expect(await error(huge)).toBe(GRAPHIC_MESSAGES.textTooLong);
    const effort = await post(app, '', { text: 'x', effort: 'max' });
    expect(effort.status).toBe(400);
    expect(await error(effort)).toBe(GRAPHIC_MESSAGES.badMessage);

    expect(h.repo.list()).toEqual([]);
    expect(staging(h)).toEqual([]);
  });

  it('refuses a body that is not multipart', async () => {
    const { app } = setup();

    const res = await call(app, 'POST', '', { text: 'A pill' });

    expect(res.status).toBe(400);
    expect(await error(res)).toBe(GRAPHIC_MESSAGES.badMessage);
  });

  it('refuses more than 5 files with 413, and makes nothing', async () => {
    const { h, app } = setup();
    const files = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`f${n}.png`, 'x']));

    const res = await post(app, '', { text: 'A pill', files });

    expect(res.status).toBe(413);
    expect(await error(res)).toBe(GRAPHIC_MESSAGES.tooManyFiles);
    expect(h.repo.list()).toEqual([]);
    expect(await h.folders.names()).toEqual([]);
    expect(staging(h)).toEqual([]);
  });

  it('takes exactly 5 files', async () => {
    const { app } = setup();
    const files = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`f${n}.png`, 'x']));

    expect((await post(app, '', { text: 'A pill', files })).status).toBe(201);
  });

  it('refuses files that weigh more than the limit together with 413', async () => {
    const { h, app } = setup();

    const res = await post(app, '', {
      text: 'A pill',
      files: { 'a.mov': 'x'.repeat(600), 'b.mov': 'x'.repeat(600) },
    });

    expect(res.status).toBe(413);
    expect(await error(res)).toBe(GRAPHIC_MESSAGES.tooLarge);
    expect(h.repo.list()).toEqual([]);
    expect(staging(h)).toEqual([]);
  });

  it('refuses a file that is not an image, a video, a font or a PDF with 415', async () => {
    const { h, app } = setup();

    const res = await post(app, '', { text: 'A pill', files: { 'macro.exe': 'x' } });

    expect(res.status).toBe(415);
    expect(await error(res)).toBe(GRAPHIC_MESSAGES.badUploadType);
    expect(h.repo.list()).toEqual([]);
    expect(staging(h)).toEqual([]);
  });

  it('takes the images, videos, fonts and PDFs it lists', async () => {
    const { app } = setup();
    const files = { 'a.PNG': 'x', 'b.mov': 'x', 'c.woff2': 'x', 'd.pdf': 'x' };

    expect((await post(app, '', { text: 'A pill', files })).status).toBe(201);
  });
});

describe('GET /api/graphics and /api/graphics/:id', () => {
  it('lists the graphics that are made, newest change first, and gives one with its chat', async () => {
    const { h, app } = setup();
    const first = await made(app, h);

    const list = graphicListResponseSchema.parse(await (await call(app, 'GET', '')).json());
    expect(list.map((graphic) => graphic.id)).toEqual([first.id]);
    expect(list[0]).toMatchObject({ name: 'Name on a white pill', status: 'ready', version: 1 });
    expect(first.messages.map((message) => message.role)).toEqual(['you', 'claude']);

    const missing = await call(app, 'GET', '/0a1b2c3d4e5f');
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe(GRAPHIC_MESSAGES.notFound);
  });
});

describe('POST /api/graphics/:id/messages', () => {
  it('queues the next version and answers 202', async () => {
    const { h, app } = setup();
    const first = await made(app, h);

    const res = await post(app, `/${first.id}/messages`, {
      text: 'Make it blue',
      effort: 'medium',
    });

    expect(res.status).toBe(202);
    expect(await detail(res)).toMatchObject({ status: 'making', makingVersion: 2 });
    await vi.waitFor(() => expect(h.repo.summary(first.id)?.status).toBe('ready'));
    expect(h.runner.requests[1]).toMatchObject({
      version: 2,
      message: { text: 'Make it blue', effort: 'medium' },
    });
  });

  it('answers 409 while it is making, before it reads the body', async () => {
    const { h, app } = setup({ holdAll: true });
    const created = await detail(await post(app, '', { text: 'A pill' }));
    const req = new Request(`http://localhost/api/graphics/${created.id}/messages`, {
      method: 'POST',
      body: form({ text: 'More' }),
    });

    const res = await app.fetch(req);

    expect(res.status).toBe(409);
    expect(await error(res)).toBe(graphicBusyMessage(1, 'send'));
    expect(req.bodyUsed).toBe(false);
    expect(h.repo.messages(created.id)).toHaveLength(2);
    expect(staging(h)).toEqual([]);
  });

  it('answers 404 for an unknown graphic', async () => {
    const { app } = setup();

    const res = await post(app, '/0a1b2c3d4e5f/messages', { text: 'x' });

    expect(res.status).toBe(404);
    expect(await error(res)).toBe(GRAPHIC_MESSAGES.notFound);
  });

  it('checks the files and the text like a new graphic does', async () => {
    const { h, app } = setup();
    const first = await made(app, h);
    const path = `/${first.id}/messages`;

    expect((await post(app, path, {})).status).toBe(400);
    expect((await post(app, path, { text: 'x', files: { 'a.exe': 'x' } })).status).toBe(415);
    expect(
      (await post(app, path, { text: 'x', files: { 'a.mov': 'x'.repeat(2000) } })).status,
    ).toBe(413);
    const withFile = await post(app, path, { files: { 'ref.png': 'png' } });
    expect(withFile.status).toBe(202);
    expect((await detail(withFile)).messages.at(-2)?.refs).toEqual(['ref.png']);
    expect(staging(h)).toEqual([]);
  });
});

describe('stop, retry and Use v1 again', () => {
  it('stops a run with 200', async () => {
    const { h, app } = setup({ holdAll: true });
    const created = await detail(await post(app, '', { text: 'A pill' }));
    const claude = created.messages[1]?.id as string;
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    const res = await call(app, 'POST', `/${created.id}/messages/${claude}/stop`);

    expect(res.status).toBe(200);
    expect((await detail(res)).messages[1]).toMatchObject({ status: 'stopped' });
    const again = await call(app, 'POST', `/${created.id}/messages/${claude}/stop`);
    expect(again.status).toBe(409);
    expect(await error(again)).toBe(GRAPHIC_MESSAGES.notMaking);
    const unknown = await call(app, 'POST', `/${created.id}/messages/nope/stop`);
    expect(unknown.status).toBe(404);
    expect(await error(unknown)).toBe(GRAPHIC_MESSAGES.messageNotFound);
  });

  it('retries a failed message with 202, and refuses one that did not fail with 409', async () => {
    const { h, app } = setup();
    h.runner.behaviour = async () => ({ ok: false, error: 'It broke.' });
    const created = await detail(await post(app, '', { text: 'A pill' }));
    await vi.waitFor(() => expect(h.repo.summary(created.id)?.status).toBe('failed'));
    const claude = created.messages[1]?.id as string;
    h.runner.behaviour = undefined;

    const res = await call(app, 'POST', `/${created.id}/messages/${claude}/retry`);

    expect(res.status).toBe(202);
    expect((await detail(res)).messages[1]).toMatchObject({ status: 'making', error: null });
    await vi.waitFor(() => expect(h.repo.summary(created.id)?.status).toBe('ready'));
    const again = await call(app, 'POST', `/${created.id}/messages/${claude}/retry`);
    expect(again.status).toBe(409);
    expect(await error(again)).toBe(GRAPHIC_MESSAGES.notRetryable);
  });

  it('makes a new version from an earlier one with 200, and refuses the ones it should', async () => {
    const { h, app } = setup();
    const first = await made(app, h);
    await post(app, `/${first.id}/messages`, { text: 'Make it blue' });
    await vi.waitFor(() => expect(h.repo.get(first.id)?.version).toBe(2));

    const res = await call(app, 'POST', `/${first.id}/versions/1/restore`);

    expect(res.status).toBe(200);
    const restored = await detail(res);
    expect(restored).toMatchObject({ version: 3 });
    expect(restored.messages.at(-1)?.text).toBe('v1 is back, as v3.');
    expect((await call(app, 'POST', `/${first.id}/versions/3/restore`)).status).toBe(409);
    for (const n of ['9', '0', 'abc', '1.5']) {
      const missing = await call(app, 'POST', `/${first.id}/versions/${n}/restore`);
      expect(missing.status, n).toBe(404);
      expect(await error(missing)).toBe(GRAPHIC_MESSAGES.versionNotFound);
    }
  });
});

describe('PUT /api/graphics/:id', () => {
  it('renames, sets the When line and turns Edits can use it off', async () => {
    const { h, app } = setup();
    const first = await made(app, h);

    const res = await call(app, 'PUT', `/${first.id}`, {
      name: 'Pill',
      when: 'When a name shows.',
      uses: false,
    });

    expect(res.status).toBe(200);
    expect(await detail(res)).toMatchObject({
      name: 'Pill',
      folder: 'Pill',
      when: 'When a name shows.',
      whenEdited: true,
      uses: false,
    });
    expect(existsSync(h.folders.dirOf('Pill'))).toBe(true);
  });

  it('refuses a body that has none of the three, is not JSON, or has a When line that is too long', async () => {
    const { h, app } = setup();
    const first = await made(app, h);

    const none = await call(app, 'PUT', `/${first.id}`, {});
    expect(none.status).toBe(400);
    expect(await error(none)).toBe(GRAPHIC_MESSAGES.badUpdate);
    const notJson = await Promise.resolve(
      app.request(`/api/graphics/${first.id}`, { method: 'PUT', body: 'name=Pill' }),
    );
    expect(notJson.status).toBe(400);
    const long = await call(app, 'PUT', `/${first.id}`, { when: 'x'.repeat(201) });
    expect(long.status).toBe(400);
    expect(await error(long)).toBe(GRAPHIC_MESSAGES.whenTooLong);
  });

  it('answers 422 for a name that is empty or taken, 409 while making, and 404 for an unknown graphic', async () => {
    const { h, app } = setup();
    const first = await made(app, h);
    h.repo.create({ name: 'Taken' });

    const empty = await call(app, 'PUT', `/${first.id}`, { name: '...' });
    expect(empty.status).toBe(422);
    expect(await error(empty)).toBe(GRAPHIC_MESSAGES.nameEmpty);
    const taken = await call(app, 'PUT', `/${first.id}`, { name: 'taken' });
    expect(taken.status).toBe(422);
    expect(await error(taken)).toBe(GRAPHIC_MESSAGES.nameTaken);

    h.runner.holdAll = true;
    await post(app, `/${first.id}/messages`, { text: 'More' });
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));
    const busy = await call(app, 'PUT', `/${first.id}`, { name: 'Another' });
    expect(busy.status).toBe(409);
    expect(await error(busy)).toBe(graphicBusyMessage(2, 'rename'));

    expect((await call(app, 'PUT', '/0a1b2c3d4e5f', { uses: true })).status).toBe(404);
  });
});

describe('duplicate, reveal and delete', () => {
  it('duplicates with 201, reveals with 200 and deletes with 200 and where the folder went', async () => {
    const { h, app } = setup();
    const first = await made(app, h);

    const copy = await call(app, 'POST', `/${first.id}/duplicate`);
    expect(copy.status).toBe(201);
    const copied = await detail(copy);
    expect(copied).toMatchObject({ name: 'Name on a white pill copy', version: 1 });
    expect(copied.messages[0]?.text).toBe('Copied from Name on a white pill v1.');

    const reveal = await call(app, 'POST', `/${first.id}/reveal`);
    expect(reveal.status).toBe(200);
    expect(revealGraphicResponseSchema.parse(await reveal.json())).toEqual({ ok: true });
    expect(h.opened).toEqual([h.folders.dirOf('Name on a white pill')]);

    const del = await call(app, 'DELETE', `/${first.id}`);
    expect(del.status).toBe(200);
    expect(deleteGraphicResponseSchema.parse(await del.json())).toEqual({
      ok: true,
      where: join(h.home, '.Trash', 'Name on a white pill'),
    });
    expect((await call(app, 'GET', `/${first.id}`)).status).toBe(404);
    const list = graphicListResponseSchema.parse(await (await call(app, 'GET', '')).json());
    expect(list.map((graphic) => graphic.id)).toEqual([copied.id]);
  });

  it('answers 404 for an unknown graphic and 409 for a duplicate with nothing to copy', async () => {
    const { h, app } = setup({ holdAll: true });
    const created = await detail(await post(app, '', { text: 'A pill' }));

    const nothing = await call(app, 'POST', `/${created.id}/duplicate`);
    expect(nothing.status).toBe(409);
    expect(await error(nothing)).toBe(GRAPHIC_MESSAGES.nothingToDuplicate);
    for (const [method, path] of [
      ['POST', '/0a1b2c3d4e5f/duplicate'],
      ['POST', '/0a1b2c3d4e5f/reveal'],
      ['DELETE', '/0a1b2c3d4e5f'],
    ] as const) {
      const res = await call(app, method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await error(res)).toBe(GRAPHIC_MESSAGES.notFound);
    }
    expect(h.repo.list()).toHaveLength(1);
  });

  it('stops a run when the graphic is deleted', async () => {
    const { h, app } = setup({ holdAll: true });
    const created = await detail(await post(app, '', { text: 'A pill' }));
    await vi.waitFor(() => expect(h.runner.held).toHaveLength(1));

    const del = await call(app, 'DELETE', `/${created.id}`);

    expect(del.status).toBe(200);
    expect(h.runner.requests[0]?.signal.aborted).toBe(true);
    expect(h.worker.isMaking(created.id)).toBe(false);
  });
});
