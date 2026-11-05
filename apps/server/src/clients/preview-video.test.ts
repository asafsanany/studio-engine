import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_VIDEO_PATH, PreviewVideos, runHyperframesRender } from './preview-video.js';

let inbox: string;
const job = { id: 'j1', relPath: 'Client/Job' } as unknown as Job;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'preview-video-'));
});
afterEach(() => rm(inbox, { recursive: true, force: true }));

async function makePreview() {
  const dir = join(inbox, 'Client/Job/edit/preview');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html></html>');
}

describe('PreviewVideos', () => {
  it('has nothing for a job with no preview', async () => {
    const videos = new PreviewVideos({ inboxPath: inbox });
    expect(await videos.statusFor(job)).toEqual({ state: 'none' });
  });

  it('answers making, renders once, then ready', async () => {
    await makePreview();
    let renders = 0;
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async (_cwd, out) => {
        renders += 1;
        await writeFile(out, 'full');
      },
    });
    // `true` stands in for ffmpeg; it writes nothing, so the shrink step cannot rename.
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    await videos.idle(job.id);
    expect(renders).toBe(1);
    const failed = await videos.statusFor(job);
    expect(failed.state).toBe('failed');
  });

  it('is ready while the file is newer than the composition', async () => {
    await makePreview();
    const out = join(inbox, 'Client/Job', PREVIEW_VIDEO_PATH);
    await writeFile(out, 'mp4');
    const videos = new PreviewVideos({ inboxPath: inbox });
    const status = await videos.statusFor(job);
    expect(status).toEqual({ state: 'ready', path: out });
    expect(await readFile(out, 'utf8')).toBe('mp4');
  });

  it('is made again when the baked cut changed, though index.html did not', async () => {
    await makePreview();
    const cut = join(inbox, 'Client/Job/edit/preview/cut.mp4');
    await writeFile(cut, 'old grade');
    const out = join(inbox, 'Client/Job', PREVIEW_VIDEO_PATH);
    await writeFile(out, 'mp4');
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async (_cwd, partial) => {
        await writeFile(partial, 'full');
      },
    });
    expect((await videos.statusFor(job)).state).toBe('ready');
    const later = new Date(Date.now() + 60_000);
    await utimes(cut, later, later);
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    await videos.idle(job.id);
  });

  it('remembers a failed render for the round', async () => {
    await makePreview();
    const videos = new PreviewVideos({
      inboxPath: inbox,
      render: async () => {
        throw new Error('boom');
      },
    });
    await videos.statusFor(job);
    await videos.idle(job.id);
    expect(await videos.statusFor(job)).toEqual({ state: 'failed', message: 'boom' });
  });

  it('does not bring a deleted job folder back while it looks for ffmpeg (C89)', async () => {
    await makePreview();
    let renders = 0;
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async () => {
        renders += 1;
      },
    });
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    // The make is waiting for the lookup of ffmpeg (file system calls that answer on a later turn of
    // the event loop), and the job is deleted meanwhile: Delete removes the whole job folder.
    rmSync(join(inbox, 'Client/Job'), { recursive: true, force: true });
    await videos.idle(job.id);
    expect(renders).toBe(0);
    expect(existsSync(join(inbox, 'Client/Job'))).toBe(false);
    expect(existsSync(join(inbox, 'Client'))).toBe(true);
    // Nobody is left to ask for it, and a job that is asked about again is simply none.
    expect(await videos.statusFor(job)).toEqual({ state: 'none' });
  });

  it('does not make edit/ again while Delete is still emptying the job folder (C89)', async () => {
    await makePreview();
    let renders = 0;
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async () => {
        renders += 1;
      },
    });
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    // What Delete does, in its order: the engine says the job is removed (`job.remove`, published
    // before the rm), then `rm -r` takes edit/ out first and the job folder last. The make is still
    // looking for ffmpeg, and the job folder is there, so a mkdir that is not recursive would work
    // and make `edit/` again, which fails the rm with ENOTEMPTY and leaves it behind.
    videos.forget(job.id);
    rmSync(join(inbox, 'Client/Job/edit'), { recursive: true, force: true });
    await videos.idle(job.id);
    expect(renders).toBe(0);
    expect(existsSync(join(inbox, 'Client/Job/edit'))).toBe(false);
    // The removal says nothing about the next video of that name.
    expect(await videos.statusFor(job)).toEqual({ state: 'none' });
  });

  it('stops a render that is under way when the job is removed, and keeps no failure for it (C89)', async () => {
    await makePreview();
    let started!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let stoppedBy: unknown = null;
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: (_cwd, _out, signal) =>
        new Promise<void>((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => {
            stoppedBy = signal.reason;
            reject(new Error('stopped'));
          });
        }),
    });
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    await renderStarted;
    videos.forget(job.id);
    await videos.idle(job.id);
    expect(stoppedBy).toBeInstanceOf(Error);
    // A job of the same name added again is made from scratch, not told it failed.
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    videos.forget(job.id);
    await videos.idle(job.id);
  });

  it('does not start a render for a job that was removed before the make began (C89)', async () => {
    await makePreview();
    let renders = 0;
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async () => {
        renders += 1;
      },
    });
    // The ask is under way (it takes the job's stop before its first await) when the job is removed.
    const asked = videos.statusFor(job);
    videos.forget(job.id);
    await asked;
    await videos.idle(job.id);
    expect(renders).toBe(0);
  });

  it('refuses a render that was stopped before it started', async () => {
    const stopped = AbortSignal.abort();
    await expect(runHyperframesRender(inbox, ['--help'], stopped)).rejects.toThrow(
      'the render was stopped',
    );
  });

  it('throws away a video of a composition that changed while it rendered', async () => {
    await makePreview();
    let renders = 0;
    const later = new Date(Date.now() + 60_000);
    const videos = new PreviewVideos({
      inboxPath: inbox,
      ffmpegBin: 'true',
      render: async (_cwd, out) => {
        renders += 1;
        await writeFile(out, 'full');
        // A quick fix lands while the first render runs.
        if (renders === 1)
          await utimes(join(inbox, 'Client/Job/edit/preview/index.html'), later, later);
      },
    });
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    await videos.idle(job.id);
    // Not failed (nothing was shrunk or renamed): the next ask makes it again.
    expect(await videos.statusFor(job)).toEqual({ state: 'making' });
    await videos.idle(job.id);
    expect(renders).toBe(2);
  });
});
