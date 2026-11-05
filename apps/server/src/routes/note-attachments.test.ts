import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addNoteAttachmentResponseSchema,
  type Job,
  type JobEvent,
  NOTE_ATTACHMENTS,
  noteViewSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository } from '../db/index.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import type { HeicToJpeg } from '../pipeline/heic-to-jpeg.js';
import { NOTE_ATTACHMENT_MESSAGES } from '../pipeline/note-attachments.js';
import { makeTempDir } from '../test-temp.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// GET /api/jobs/:id/note and the attachment routes (Songs, SG5): the real repository on an
// in-memory database, the real routes, and the pictures on a real temp folder.

interface Harness {
  app: Hono;
  jobs: JobRepository;
  inbox: string;
}

function harness({
  songs = true,
  maxBytes,
  heicToJpeg,
}: {
  songs?: boolean;
  maxBytes?: number;
  heicToJpeg?: HeicToJpeg;
} = {}): Harness {
  const inbox = makeTempDir('studio-note-attachments-');
  const jobs = new JobRepository(memoryDb());
  const app = createApp({
    songs,
    music: true,
    jobs: { jobs, exportsDir: join(inbox, '_Exports') },
    noteAttachments: {
      jobs,
      inboxPath: inbox,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(heicToJpeg === undefined ? {} : { heicToJpeg }),
    },
  });
  return { app, jobs, inbox };
}

const PATHS: Partial<Record<Job['state'], JobEvent[]>> = {
  arriving: [],
  queued: [{ type: 'SETTLED' }],
  held: [{ type: 'HOLD' }],
  editing: [{ type: 'SETTLED' }, { type: 'START' }],
  review: [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ],
  ready: [
    { type: 'SETTLED' },
    { type: 'START' },
    {
      type: 'SUCCEED',
      output: {
        fileName: 'Northwind Bakery/Spring menu.mp4',
        durationSec: 45.2,
        width: 1080,
        height: 1920,
        sizeBytes: 1000,
      },
    },
  ],
  failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
  cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
};

function seed(h: Harness, state: Job['state'] = 'arriving', name = 'Spring menu'): Job {
  const { job } = h.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  for (const event of PATHS[state] ?? []) h.jobs.applyTransition(job.id, event);
  mkdirSync(join(h.inbox, job.relPath), { recursive: true });
  return h.jobs.get(job.id) as Job;
}

const folderOf = (h: Harness, job: Job) => join(h.inbox, job.relPath, 'edit', NOTE_ATTACHMENTS.dir);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function formWith(file: File | null): FormData {
  const form = new FormData();
  if (file !== null) form.append('file', file);
  return form;
}

const pic = (
  name = 'IMG_4412.PNG',
  type = 'image/png',
  bytes: Uint8Array<ArrayBuffer> | string = PNG,
) => new File([bytes], name, { type });

function upload(h: Harness, id: string, form: FormData | string) {
  return h.app.request(`/api/jobs/${id}/note/attachments`, { method: 'POST', body: form });
}

function remove(h: Harness, id: string, name: string) {
  return h.app.request(`/api/jobs/${id}/note/attachments/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

const list = (h: Harness, id: string) => h.app.request(`/api/jobs/${id}/note`);

describe('with the Songs switch off', () => {
  it('has no note view and no attachment routes: each path is the ordinary 404', async () => {
    const h = harness({ songs: false });
    const job = seed(h);
    for (const [method, path] of [
      ['GET', `/api/jobs/${job.id}/note`],
      ['POST', `/api/jobs/${job.id}/note/attachments`],
      ['DELETE', `/api/jobs/${job.id}/note/attachments/a.png`],
      ['GET', `/api/jobs/${job.id}/note/attachments/a.png`],
    ] as const) {
      const res = await h.app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('leaves the note’s own PUT alone', async () => {
    const h = harness({ songs: false });
    const job = seed(h);
    const res = await h.app.request(`/api/jobs/${job.id}/note`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Keep it short.' }),
    });
    expect(res.status).toBe(200);
    expect(h.jobs.get(job.id)?.note).toBe('Keep it short.');
  });

  it('is off too when Soundtrack is off, whatever songs says', async () => {
    const inbox = makeTempDir('studio-note-attachments-');
    const jobs = new JobRepository(memoryDb());
    const app = createApp({
      songs: true,
      music: false,
      jobs: { jobs, exportsDir: join(inbox, '_Exports') },
      noteAttachments: { jobs, inboxPath: inbox },
    });
    const { job } = jobs.upsertFromScan(makeScan());
    const res = await app.request(`/api/jobs/${job.id}/note`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('GET /api/jobs/:id/note', () => {
  it('answers the note and no pictures for a job that has none', async () => {
    const h = harness();
    const job = seed(h);
    const res = await list(h, job.id);
    expect(res.status).toBe(200);
    expect(noteViewSchema.parse(await res.json())).toEqual({ note: null, attachments: [] });
  });

  it('answers the saved note and the pictures, oldest first', async () => {
    const h = harness();
    const job = seed(h);
    h.jobs.setNote(job.id, '  Use the song from the reel.  ');
    await upload(h, job.id, formWith(pic('first.png')));
    await upload(h, job.id, formWith(pic('second.jpg', 'image/jpeg')));

    const view = noteViewSchema.parse(await (await list(h, job.id)).json());
    expect(view.note).toBe('Use the song from the reel.');
    expect(view.attachments.map((a) => a.name)).toEqual(['first.png', 'second.jpg']);
    expect(view.attachments[0]?.bytes).toBe(PNG.length);
  });

  it('works in every state: it only reads', async () => {
    const h = harness();
    const job = seed(h, 'editing');
    expect((await list(h, job.id)).status).toBe(200);
  });

  it('is 404 for an unknown job', async () => {
    const res = await list(harness(), 'nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'There is no job nope.' });
  });
});

describe('POST /api/jobs/:id/note/attachments', () => {
  it('keeps the picture in edit/brief/from-you/ under its own name and answers 201 with it', async () => {
    const h = harness();
    const job = seed(h);

    const res = await upload(h, job.id, formWith(pic('IMG_4412.PNG')));

    expect(res.status).toBe(201);
    const kept = addNoteAttachmentResponseSchema.parse(await res.json());
    expect(kept).toMatchObject({ name: 'IMG_4412.PNG', bytes: PNG.length });
    const file = join(folderOf(h, job), 'IMG_4412.PNG');
    expect(existsSync(file)).toBe(true);
    expect(new Uint8Array(readFileSync(file))).toEqual(PNG);
    // Nothing else is left in the folder: the upload's own partial file is gone.
    expect(readdirSync(folderOf(h, job))).toEqual(['IMG_4412.PNG']);
  });

  it('keeps Hebrew names and names with spaces', async () => {
    const h = harness();
    const job = seed(h);
    for (const name of ['צילום מסך 2026-10-25 בשעה 14.03.png', 'my reel shot.JPG']) {
      const res = await upload(h, job.id, formWith(pic(name)));
      expect(res.status, name).toBe(201);
      expect(((await res.json()) as { name: string }).name).toBe(name);
      expect(existsSync(join(folderOf(h, job), name)), name).toBe(true);
    }
  });

  it('numbers a name that is taken: " 2", " 3", whatever the case', async () => {
    const h = harness();
    const job = seed(h);
    const names: string[] = [];
    for (const name of ['image.png', 'image.png', 'IMAGE.PNG', 'image.png']) {
      const res = await upload(h, job.id, formWith(pic(name)));
      names.push(((await res.json()) as { name: string }).name);
    }
    expect(names).toEqual(['image.png', 'image 2.png', 'IMAGE 3.PNG', 'image 4.png']);
  });

  it('keeps every picture when two uploads of one name arrive together', async () => {
    const h = harness();
    const job = seed(h);
    const answers = await Promise.all(
      [1, 2, 3].map(() => upload(h, job.id, formWith(pic('image.png')))),
    );
    expect(answers.map((res) => res.status)).toEqual([201, 201, 201]);
    const names = (await Promise.all(answers.map((res) => res.json()))).map(
      (body) => (body as { name: string }).name,
    );
    expect(new Set(names)).toEqual(new Set(['image.png', 'image 2.png', 'image 3.png']));
  });

  it('makes the name safe: no folders, no leading dot, no control characters', async () => {
    const h = harness();
    const job = seed(h);
    const names: string[] = [];
    for (const name of ['../../escape.png', '/etc/passwd.png', '.hidden.png', 'a\u0000b\nc.png']) {
      const res = await upload(h, job.id, formWith(pic(name)));
      expect(res.status, name).toBe(201);
      names.push(((await res.json()) as { name: string }).name);
    }
    expect(names).toEqual(['escape.png', 'passwd.png', 'hidden.png', 'a b c.png']);
    expect(readdirSync(join(h.inbox, job.relPath))).toEqual(['edit']);
    expect(readdirSync(folderOf(h, job)).sort()).toEqual([
      'a b c.png',
      'escape.png',
      'hidden.png',
      'passwd.png',
    ]);
  });

  it.each(['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'])('accepts a .%s picture', async (ext) => {
    const h = harness();
    const job = seed(h);
    const res = await upload(h, job.id, formWith(pic(`shot.${ext}`, '', PNG)));
    expect(res.status).toBe(201);
  });

  it('keeps a HEIC as a JPEG when the engine can convert one, and answers the JPEG’s name', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 7, 0xff, 0xd9]);
    const convert = vi.fn<HeicToJpeg>(async (_from, to) => {
      writeFileSync(to, jpeg);
    });
    const h = harness({ heicToJpeg: convert });
    const job = seed(h);

    // Safari can say "image/heic", "image/heif" or nothing at all for a HEIC.
    const answers: string[] = [];
    for (const [name, type] of [
      ['IMG_4412.HEIC', 'image/heic'],
      ['IMG_4412.heic', ''],
      ['blob', 'image/heif'],
    ] as const) {
      const res = await upload(h, job.id, formWith(pic(name, type, 'heic bytes')));
      expect(res.status, name).toBe(201);
      const kept = addNoteAttachmentResponseSchema.parse(await res.json());
      expect(kept.bytes).toBe(jpeg.length);
      answers.push(kept.name);
    }

    expect(answers).toEqual(['IMG_4412.jpg', 'IMG_4412 2.jpg', 'blob.jpg']);
    expect(convert).toHaveBeenCalledTimes(3);
    expect(readdirSync(folderOf(h, job)).sort()).toEqual([
      'IMG_4412 2.jpg',
      'IMG_4412.jpg',
      'blob.jpg',
    ]);
    // The JPEG is what GET serves, with the JPEG’s type.
    const shown = await h.app.request(`/api/jobs/${job.id}/note/attachments/IMG_4412.jpg`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toContain('image/jpeg');
  });

  it('says 400 “couldn’t be read” for a HEIC the converter cannot read, and keeps nothing', async () => {
    const h = harness({
      heicToJpeg: async () => {
        throw new Error('Cannot extract image from file.');
      },
    });
    const job = seed(h);
    const res = await upload(h, job.id, formWith(pic('IMG_4412.heic', 'image/heic', 'not a heic')));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.unreadable });
    expect(readdirSync(folderOf(h, job))).toEqual([]);
  });

  it('gives a picture with no extension the one its type says', async () => {
    const h = harness();
    const job = seed(h);
    const res = await upload(h, job.id, formWith(pic('blob', 'image/png')));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe('blob.png');
  });

  it('refuses a file that is not a picture, with a plain 400', async () => {
    const h = harness();
    const job = seed(h);
    const refused = [
      pic('notes.pdf', 'application/pdf'),
      pic('clip.mp4', 'video/mp4'),
      pic('shot.png', 'application/pdf'),
      pic('script.js', 'text/javascript'),
      pic('noextension', ''),
    ];
    for (const file of refused) {
      const res = await upload(h, job.id, formWith(file));
      expect(res.status, file.name).toBe(400);
      expect(await res.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.type });
    }
    expect(existsSync(folderOf(h, job))).toBe(false);
  });

  it('refuses an empty picture and a body that is no form', async () => {
    const h = harness();
    const job = seed(h);
    const empty = await upload(h, job.id, formWith(pic('empty.png', 'image/png', '')));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.empty });

    const noFile = await upload(h, job.id, formWith(null));
    expect(noFile.status).toBe(400);
    expect(await noFile.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.form });

    const text = await h.app.request(`/api/jobs/${job.id}/note/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"file":"x"}',
    });
    expect(text.status).toBe(400);
  });

  it('refuses a picture over the size limit, with a plain 400', async () => {
    const h = harness({ maxBytes: 1024 });
    const job = seed(h);
    const ok = await upload(
      h,
      job.id,
      formWith(pic('small.png', 'image/png', new Uint8Array(1024))),
    );
    expect(ok.status).toBe(201);

    const big = await upload(
      h,
      job.id,
      formWith(pic('big.png', 'image/png', new Uint8Array(1025))),
    );
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.tooBig });
    expect(readdirSync(folderOf(h, job))).toEqual(['small.png']);

    const huge = await upload(
      h,
      job.id,
      formWith(pic('huge.png', 'image/png', new Uint8Array(200 * 1024))),
    );
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.tooBig });
  });

  it('says 15 MB in its words for the real limit', () => {
    expect(NOTE_ATTACHMENT_MESSAGES.tooBig).toBe('That picture is over 15 MB.');
  });

  it('refuses a seventh picture, and a delete makes room again', async () => {
    const h = harness();
    const job = seed(h);
    for (let n = 1; n <= NOTE_ATTACHMENTS.maxFiles; n += 1) {
      expect((await upload(h, job.id, formWith(pic(`shot-${n}.png`)))).status).toBe(201);
    }
    const seventh = await upload(h, job.id, formWith(pic('shot-7.png')));
    expect(seventh.status).toBe(400);
    expect(await seventh.json()).toEqual({ error: NOTE_ATTACHMENT_MESSAGES.tooMany });

    expect((await remove(h, job.id, 'shot-1.png')).status).toBe(200);
    expect((await upload(h, job.id, formWith(pic('shot-7.png')))).status).toBe(201);
  });

  it('never keeps more than the limit when uploads arrive together', async () => {
    const h = harness();
    const job = seed(h);
    const answers = await Promise.all(
      Array.from({ length: 9 }, (_, n) => upload(h, job.id, formWith(pic(`shot-${n}.png`)))),
    );
    const statuses = answers.map((res) => res.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(NOTE_ATTACHMENTS.maxFiles);
    expect(statuses.filter((status) => status === 400)).toHaveLength(3);
    expect(readdirSync(folderOf(h, job))).toHaveLength(NOTE_ATTACHMENTS.maxFiles);
  });

  it.each(['arriving', 'queued', 'held', 'failed', 'cancelled'] as const)(
    'works while the job is %s',
    async (state) => {
      const h = harness();
      const job = seed(h, state);
      expect((await upload(h, job.id, formWith(pic()))).status).toBe(201);
    },
  );

  it.each(['editing', 'review', 'ready'] as const)(
    'is 409 once the job is %s, with the words the note’s PUT uses',
    async (state) => {
      const h = harness();
      const job = seed(h, state);

      const res = await upload(h, job.id, formWith(pic()));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `Cannot edit the note of a job that is ${state}.`,
      });
      expect(existsSync(folderOf(h, job))).toBe(false);
    },
  );

  it('is 404 for an unknown job', async () => {
    const h = harness();
    const res = await upload(h, 'nope', formWith(pic()));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/jobs/:id/note/attachments/:name', () => {
  it('removes the picture and answers { ok: true }', async () => {
    const h = harness();
    const job = seed(h);
    await upload(h, job.id, formWith(pic('a.png')));
    await upload(h, job.id, formWith(pic('b.png')));

    const res = await remove(h, job.id, 'a.png');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(readdirSync(folderOf(h, job))).toEqual(['b.png']);
    const view = noteViewSchema.parse(await (await list(h, job.id)).json());
    expect(view.attachments.map((a) => a.name)).toEqual(['b.png']);
  });

  it('finds a Hebrew name with spaces, sent percent-encoded', async () => {
    const h = harness();
    const job = seed(h);
    const name = 'צילום מסך 14.03.png';
    await upload(h, job.id, formWith(pic(name)));
    expect((await remove(h, job.id, name)).status).toBe(200);
    expect(existsSync(join(folderOf(h, job), name))).toBe(false);
  });

  it('is 404 for a picture that is not on the note, a name that cannot be one, and an unknown job', async () => {
    const h = harness();
    const job = seed(h);
    writeFileSync(join(h.inbox, job.relPath, 'footage.png'), 'x');
    for (const name of [
      'missing.png',
      'footage.png',
      '..',
      '../footage.png',
      '%2e%2e%2ffootage.png',
    ]) {
      const res = await h.app.request(`/api/jobs/${job.id}/note/attachments/${name}`, {
        method: 'DELETE',
      });
      expect(res.status, name).toBe(404);
    }
    expect((await remove(h, 'nope', 'a.png')).status).toBe(404);
    expect(existsSync(join(h.inbox, job.relPath, 'footage.png'))).toBe(true);
  });

  it('is 409 once the job is editing, and the picture stays', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    await upload(h, job.id, formWith(pic('a.png')));
    h.jobs.applyTransition(job.id, { type: 'START' });

    const res = await remove(h, job.id, 'a.png');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot edit the note of a job that is editing.' });
    expect(existsSync(join(folderOf(h, job), 'a.png'))).toBe(true);
  });
});

describe('GET /api/jobs/:id/note/attachments/:name', () => {
  it('serves the picture inline with its type, and never lets a browser guess', async () => {
    const h = harness();
    const job = seed(h);
    await upload(h, job.id, formWith(pic('shot.PNG')));

    const res = await h.app.request(`/api/jobs/${job.id}/note/attachments/shot.PNG`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('is 404 for a picture that is not there, and still served in a state that forbids edits', async () => {
    const h = harness();
    const job = seed(h);
    await upload(h, job.id, formWith(pic('shot.png')));
    h.jobs.applyTransition(job.id, { type: 'SETTLED' });
    h.jobs.applyTransition(job.id, { type: 'START' });

    expect((await h.app.request(`/api/jobs/${job.id}/note/attachments/shot.png`)).status).toBe(200);
    expect((await h.app.request(`/api/jobs/${job.id}/note/attachments/other.png`)).status).toBe(
      404,
    );
  });
});
