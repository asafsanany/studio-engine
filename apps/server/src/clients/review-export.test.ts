import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, jobFormatsOf } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extraReviewExportPath, REVIEW_EXPORT_PATH, ReviewExports } from './review-export.js';

let inbox: string;
const job = { id: 'j1', relPath: 'Client/Job' } as unknown as Job;
const jobDir = () => join(inbox, 'Client/Job');

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'review-export-'));
});
afterEach(() => rm(inbox, { recursive: true, force: true }));

async function makePreview() {
  const dir = join(jobDir(), 'edit/preview');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html></html>');
}

const rendering = (renders: { count: number }) => async (_cwd: string, out: string) => {
  renders.count += 1;
  await writeFile(out, 'full-quality');
};

describe('ReviewExports', () => {
  it('has nothing for a job with no preview', async () => {
    const exports = new ReviewExports({ inboxPath: inbox });
    expect(await exports.statusFor(job)).toEqual({ state: 'none' });
  });

  it('is idle until asked, then renders once and is ready', async () => {
    await makePreview();
    const renders = { count: 0 };
    // The render waits to be let go, so the second start meets a render that is still under way
    // (a render that finished at once made this test depend on timing).
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const render = rendering(renders);
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (cwd, out) => {
        await gate;
        await render(cwd, out);
      },
    });
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
    expect(renders.count).toBe(0);

    expect(await exports.start(job)).toEqual({ state: 'making' });
    expect(await exports.start(job)).toEqual({ state: 'making' });
    release();
    await exports.idle(job.id);
    expect(renders.count).toBe(1);
    expect(await exports.statusFor(job)).toEqual({
      state: 'ready',
      path: join(jobDir(), REVIEW_EXPORT_PATH),
    });
  });

  it('goes stale when the composition changes', async () => {
    await makePreview();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(job);
    await exports.idle(job.id);
    const later = new Date(Date.now() + 60_000);
    await utimes(join(jobDir(), 'edit/preview/index.html'), later, later);
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
  });

  it('goes stale when a colour-grade round rewrites cut.mp4, though index.html did not change', async () => {
    await makePreview();
    const cut = join(jobDir(), 'edit/preview/cut.mp4');
    await writeFile(cut, 'old grade');
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(job);
    await exports.idle(job.id);
    expect((await exports.statusFor(job)).state).toBe('ready');
    const later = new Date(Date.now() + 60_000);
    await utimes(cut, later, later);
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
    // Approve does not copy the old grade to edit/final.mp4.
    expect(await exports.useFor(job)).toBe(false);
  });

  it('goes stale when a picture or sound in a sub-folder changes', async () => {
    await makePreview();
    const asset = join(jobDir(), 'edit/preview/assets/logo.png');
    await mkdir(join(jobDir(), 'edit/preview/assets'), { recursive: true });
    await writeFile(asset, 'png');
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(job);
    await exports.idle(job.id);
    const later = new Date(Date.now() + 60_000);
    await utimes(asset, later, later);
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
  });

  it('stays current when only what a render or Finder writes (dot-names) changes', async () => {
    await makePreview();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(job);
    await exports.idle(job.id);
    const later = new Date(Date.now() + 60_000);
    await mkdir(join(jobDir(), 'edit/preview/.hyperframes'), { recursive: true });
    const state = join(jobDir(), 'edit/preview/.hyperframes/video-state.json');
    const finder = join(jobDir(), 'edit/preview/.DS_Store');
    await writeFile(state, '{}');
    await writeFile(finder, '');
    await utimes(state, later, later);
    await utimes(finder, later, later);
    expect((await exports.statusFor(job)).state).toBe('ready');
  });

  it('remembers a failed render until the composition changes', async () => {
    await makePreview();
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async () => {
        throw new Error('boom');
      },
    });
    await exports.start(job);
    await exports.idle(job.id);
    expect(await exports.statusFor(job)).toEqual({ state: 'failed', message: 'boom' });
  });

  it('puts a current export at edit/final.mp4 for Approve, and only then', async () => {
    await makePreview();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    expect(await exports.useFor(job)).toBe(false);
    await exports.start(job);
    await exports.idle(job.id);
    expect(await exports.useFor(job)).toBe(true);
    expect(await readFile(join(jobDir(), 'edit/final.mp4'), 'utf8')).toBe('full-quality');
  });

  // GN7: this export is the main format only, so a job with more than one format never skips its
  // render run for it (the render run makes a video of every format).
  it('is never put at edit/final.mp4 for a job with more than one format', async () => {
    await makePreview();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(job);
    await exports.idle(job.id);
    const two = { ...job, formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Job;
    expect(await exports.statusFor(two)).toMatchObject({ state: 'ready' });
    expect(await exports.useFor(two)).toBe(false);
    await expect(readFile(join(jobDir(), 'edit/final.mp4'), 'utf8')).rejects.toThrow();
    // The same export still serves a job with no second format.
    expect(await exports.useFor(job)).toBe(true);
  });
});

// Formats (GN7, C65): on a job with two formats Export MP4 is made from the composition of the format
// on show, and kept beside the main one's under its own name.
describe('ReviewExports, one export per format', () => {
  const two = { ...job, formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Job;

  async function makeSquare() {
    const dir = join(jobDir(), 'edit/preview-1x1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<html>square</html>');
  }

  /** A render that remembers where it was asked to render, and what it wrote. */
  const recording = (calls: { cwd: string; out: string }[]) => async (cwd: string, out: string) => {
    calls.push({ cwd, out });
    await writeFile(out, `rendered ${cwd.endsWith('preview-1x1') ? '1:1' : '9:16'}`);
  };

  it('renders the extra format from its own folder into its own file', async () => {
    await makePreview();
    await makeSquare();
    const calls: { cwd: string; out: string }[] = [];
    const exports = new ReviewExports({ inboxPath: inbox, render: recording(calls) });

    expect(await exports.statusFor(two, '1x1')).toEqual({ state: 'idle' });
    expect(await exports.start(two, '1x1')).toEqual({ state: 'making' });
    await exports.idle(two.id, '1x1');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd.endsWith(join('edit', 'preview-1x1'))).toBe(true);
    const path = join(jobDir(), extraReviewExportPath('1x1'));
    expect(path.endsWith(join('edit', 'review-export-1x1.mp4'))).toBe(true);
    expect(await exports.statusFor(two, '1x1')).toEqual({ state: 'ready', path });
    expect(await readFile(path, 'utf8')).toBe('rendered 1:1');
    // Only the finished file is left in edit/, no partial one.
    await expect(readFile(join(jobDir(), 'edit/.review-export-1x1.partial.mp4'))).rejects.toThrow();
  });

  it('keeps the main format’s export apart: rendering one does not make the other ready', async () => {
    await makePreview();
    await makeSquare();
    const calls: { cwd: string; out: string }[] = [];
    const exports = new ReviewExports({ inboxPath: inbox, render: recording(calls) });

    await exports.start(two, '1x1');
    await exports.idle(two.id, '1x1');
    expect(await exports.statusFor(two)).toEqual({ state: 'idle' });

    await exports.start(two);
    await exports.idle(two.id);
    expect(calls.map((call) => call.cwd.endsWith('preview-1x1'))).toEqual([true, false]);
    expect(await exports.statusFor(two)).toEqual({
      state: 'ready',
      path: join(jobDir(), REVIEW_EXPORT_PATH),
    });
    expect(await readFile(join(jobDir(), REVIEW_EXPORT_PATH), 'utf8')).toBe('rendered 9:16');
    expect(await readFile(join(jobDir(), extraReviewExportPath('1x1')), 'utf8')).toBe(
      'rendered 1:1',
    );
  });

  it('shows making for the format being rendered, and idle for the other', async () => {
    await makePreview();
    await makeSquare();
    let release: () => void = () => {};
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (_cwd, out) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await writeFile(out, 'x');
      },
    });
    await exports.start(two, '1x1');
    expect(await exports.statusFor(two, '1x1')).toEqual({ state: 'making' });
    expect(await exports.statusFor(two)).toEqual({ state: 'idle' });
    release();
    await exports.idle(two.id, '1x1');
    expect(await exports.statusFor(two, '1x1')).toMatchObject({ state: 'ready' });
  });

  it('goes stale with its own composition only', async () => {
    await makePreview();
    await makeSquare();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(two, '1x1');
    await exports.idle(two.id, '1x1');
    const later = new Date(Date.now() + 60_000);
    // The main composition changes (a quick fix): the square export is made from the square one.
    await utimes(join(jobDir(), 'edit/preview/index.html'), later, later);
    expect(await exports.statusFor(two, '1x1')).toMatchObject({ state: 'ready' });
    // The square composition changes (the music was copied into it): its export is stale.
    await utimes(join(jobDir(), 'edit/preview-1x1/index.html'), later, later);
    expect(await exports.statusFor(two, '1x1')).toEqual({ state: 'idle' });
  });

  it('remembers a failed render of the extra format without failing the main one', async () => {
    await makePreview();
    await makeSquare();
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (cwd, out) => {
        if (cwd.endsWith('preview-1x1')) throw new Error('square boom');
        await writeFile(out, 'ok');
      },
    });
    await exports.start(two, '1x1');
    await exports.idle(two.id, '1x1');
    expect(await exports.statusFor(two, '1x1')).toEqual({
      state: 'failed',
      message: 'square boom',
    });
    expect(await exports.statusFor(two)).toEqual({ state: 'idle' });
    await exports.start(two);
    await exports.idle(two.id);
    expect(await exports.statusFor(two)).toMatchObject({ state: 'ready' });
    expect(await exports.statusFor(two, '1x1')).toEqual({
      state: 'failed',
      message: 'square boom',
    });
  });

  it('has nothing for a format the job does not have, or one whose composition is not there', async () => {
    await makePreview();
    const renders = { count: 0 };
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering(renders) });
    // No edit/preview-1x1/ yet.
    expect(await exports.statusFor(two, '1x1')).toEqual({ state: 'none' });
    expect(await exports.start(two, '1x1')).toEqual({ state: 'none' });
    await makeSquare();
    // A size the job has not: another extra one, the main format's own id, a job with one format.
    expect(await exports.statusFor(two, '4x5')).toEqual({ state: 'none' });
    expect(await exports.statusFor(two, '9x16')).toEqual({ state: 'none' });
    expect(await exports.start(job, '1x1')).toEqual({ state: 'none' });
    expect(await exports.start(two, '4x5')).toEqual({ state: 'none' });
    expect(renders.count).toBe(0);
  });

  it('still never puts an export at edit/final.mp4 for a job with two formats', async () => {
    await makePreview();
    await makeSquare();
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering({ count: 0 }) });
    await exports.start(two, '1x1');
    await exports.idle(two.id, '1x1');
    await exports.start(two);
    await exports.idle(two.id);
    expect(await exports.useFor(two)).toBe(false);
    await expect(readFile(join(jobDir(), 'edit/final.mp4'), 'utf8')).rejects.toThrow();
  });
});

// The engine starts the export by itself when a job reaches Review, so Approve and a quick fix can
// meet one that is still rendering.
describe('ReviewExports, an export that is still being made', () => {
  /** A render that waits to be let go. */
  function gated() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release: () => release(), gate };
  }

  it('is waited for by Approve, which then uses it', async () => {
    await makePreview();
    const { release, gate } = gated();
    const renders = { count: 0 };
    const render = rendering(renders);
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (cwd, out) => {
        await gate;
        await render(cwd, out);
      },
    });
    await exports.start(job);
    const used = exports.useFor(job);
    release();
    expect(await used).toBe(true);
    expect(renders.count).toBe(1);
    expect(await readFile(join(jobDir(), 'edit/final.mp4'), 'utf8')).toBe('full-quality');
  });

  it('stops being waited for when the run is cancelled', async () => {
    await makePreview();
    const { release, gate } = gated();
    const render = rendering({ count: 0 });
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (cwd, out) => {
        await gate;
        await render(cwd, out);
      },
    });
    await exports.start(job);
    const controller = new AbortController();
    const used = exports.useFor(job, controller.signal);
    controller.abort();
    expect(await used).toBe(false);
    await expect(readFile(join(jobDir(), 'edit/final.mp4'), 'utf8')).rejects.toThrow();
    release();
    await exports.idle(job.id);
  });

  it('is not used when it failed: the render run makes the video', async () => {
    await makePreview();
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async () => {
        throw new Error('boom');
      },
    });
    await exports.start(job);
    expect(await exports.useFor(job)).toBe(false);
  });

  it('is thrown away when the composition changed while it rendered', async () => {
    await makePreview();
    const later = new Date(Date.now() + 60_000);
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: async (_cwd, out) => {
        await writeFile(out, 'of the old composition');
        // A quick fix lands while the render runs.
        await utimes(join(jobDir(), 'edit/preview/index.html'), later, later);
      },
    });
    await exports.start(job);
    await exports.idle(job.id);
    // Not failed, and no file that would pass for current: the next ask renders again.
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
    await expect(readFile(join(jobDir(), REVIEW_EXPORT_PATH))).rejects.toThrow();
    await expect(readFile(join(jobDir(), 'edit/.review-export.partial.mp4'))).rejects.toThrow();
  });

  it('does not make edit/ again while Delete is still emptying the job folder (C89)', async () => {
    await makePreview();
    const renders = { count: 0 };
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering(renders) });
    expect(await exports.start(job)).toEqual({ state: 'making' });
    // Delete's order: the engine says the job is removed (published before the rm), then `rm -r`
    // takes edit/ out first and the job folder last. The job folder is there, so a mkdir that is not
    // recursive would work and make `edit/` again.
    exports.forget(job.id);
    rmSync(join(jobDir(), 'edit'), { recursive: true, force: true });
    await exports.idle(job.id);
    expect(renders.count).toBe(0);
    expect(existsSync(join(jobDir(), 'edit'))).toBe(false);
    // The removal says nothing about the next video of that name.
    expect(await exports.statusFor(job)).toEqual({ state: 'none' });
  });

  it('stops a render that is under way when the job is removed, and keeps no failure for it (C89)', async () => {
    await makePreview();
    let started!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stopped = false;
    const exports = new ReviewExports({
      inboxPath: inbox,
      render: (_cwd, _out, signal) =>
        new Promise<void>((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => {
            stopped = true;
            reject(new Error('stopped'));
          });
        }),
    });
    await exports.start(job);
    await renderStarted;
    exports.forget(job.id);
    await exports.idle(job.id);
    expect(stopped).toBe(true);
    expect(await exports.statusFor(job)).toEqual({ state: 'idle' });
  });

  it('does not start a render for a job that was removed while the start was under way (C89)', async () => {
    await makePreview();
    const renders = { count: 0 };
    const exports = new ReviewExports({ inboxPath: inbox, render: rendering(renders) });
    // The start takes the job's stop before its first await, and the job is removed meanwhile.
    const starting = exports.start(job);
    exports.forget(job.id);
    await starting;
    await exports.idle(job.id);
    expect(renders.count).toBe(0);
  });
});
