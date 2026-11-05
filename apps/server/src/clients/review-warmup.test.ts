import { type Job, jobFormatsOf } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewExportStatus } from './review-export.js';
import { ReviewWarmup } from './review-warmup.js';

// The videos of a job in Review, started by the engine (the owner, 26 Oct). The two classes that make
// them are faked: what is tested is who is asked, when, and how many at once.

const jobOf = (id: string, extra: Partial<Job> = {}) =>
  ({ id, state: 'review', ...extra }) as unknown as Job;

/** Exports that stay `making` until the test finishes them, and count how many ran at once. */
function fakeExports(initial: Record<string, ReviewExportStatus['state']> = {}) {
  const states = new Map<string, ReviewExportStatus['state']>(Object.entries(initial));
  const making = new Map<string, Promise<void>>();
  const finishers = new Map<string, () => void>();
  const started: string[] = [];
  let live = 0;
  let mostAtOnce = 0;
  const keyOf = (id: string, formatId?: string) =>
    formatId === undefined ? id : `${id}:${formatId}`;
  const statusOf = (key: string): ReviewExportStatus => {
    const state = states.get(key) ?? 'idle';
    if (state === 'ready') return { state, path: `/${key}.mp4` };
    if (state === 'failed') return { state, message: 'boom' };
    return { state } as ReviewExportStatus;
  };
  return {
    started,
    mostAtOnce: () => mostAtOnce,
    statusFor: async (job: Job, formatId?: string) => statusOf(keyOf(job.id, formatId)),
    start: vi.fn(async (job: Job, formatId?: string): Promise<ReviewExportStatus> => {
      const key = keyOf(job.id, formatId);
      started.push(key);
      states.set(key, 'making');
      live += 1;
      mostAtOnce = Math.max(mostAtOnce, live);
      making.set(
        key,
        new Promise<void>((resolve) => {
          finishers.set(key, () => {
            states.set(key, 'ready');
            live -= 1;
            making.delete(key);
            resolve();
          });
        }),
      );
      return { state: 'making' };
    }),
    idle: async (id: string, formatId?: string) => making.get(keyOf(id, formatId)),
    finish: (id: string, formatId?: string) => finishers.get(keyOf(id, formatId))?.(),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: {
  jobs: Job[];
  exports?: ReturnType<typeof fakeExports>;
  block?: () => string | null;
}) {
  const exports = options.exports ?? fakeExports();
  const videos = { statusFor: vi.fn(async () => ({ state: 'making' as const })) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const byId = new Map(options.jobs.map((job) => [job.id, job]));
  const warmup = new ReviewWarmup({
    videos,
    exports,
    getJob: (id) => byId.get(id) ?? null,
    ...(options.block === undefined ? {} : { block: options.block }),
    logger,
  });
  return { warmup, exports, videos, logger, byId };
}

describe('ReviewWarmup', () => {
  it('starts the small video at once and the full one for a job in Review', async () => {
    const job = jobOf('a');
    const h = setup({ jobs: [job] });
    h.warmup.warm(job);
    await flush();
    expect(h.videos.statusFor).toHaveBeenCalledWith(job);
    expect(h.exports.started).toEqual(['a']);
    h.exports.finish('a');
    await h.warmup.idle();
  });

  it('does nothing for a job that is not in Review', async () => {
    const job = jobOf('a', { state: 'editing' } as Partial<Job>);
    const h = setup({ jobs: [job] });
    h.warmup.warm(job);
    await h.warmup.idle();
    expect(h.videos.statusFor).not.toHaveBeenCalled();
    expect(h.exports.started).toEqual([]);
  });

  it('makes one full video at a time across jobs, in the order they arrived', async () => {
    const [a, b, c] = [jobOf('a'), jobOf('b'), jobOf('c')] as [Job, Job, Job];
    const h = setup({ jobs: [a, b, c] });
    h.warmup.warm(a);
    h.warmup.warm(b);
    h.warmup.warm(c);
    await flush();
    expect(h.exports.started).toEqual(['a']);
    h.exports.finish('a');
    await flush();
    expect(h.exports.started).toEqual(['a', 'b']);
    h.exports.finish('b');
    await flush();
    h.exports.finish('c');
    await h.warmup.idle();
    expect(h.exports.started).toEqual(['a', 'b', 'c']);
    expect(h.exports.mostAtOnce()).toBe(1);
    // Every job still got its small video the moment it was published.
    expect(h.videos.statusFor).toHaveBeenCalledTimes(3);
  });

  it('makes the main format first and then each extra format of the job', async () => {
    const job = jobOf('a', { formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Partial<Job>);
    const h = setup({ jobs: [job] });
    h.warmup.warm(job);
    await flush();
    expect(h.exports.started).toEqual(['a']);
    h.exports.finish('a');
    await flush();
    expect(h.exports.started).toEqual(['a', 'a:1x1']);
    h.exports.finish('a', '1x1');
    await h.warmup.idle();
  });

  it('leaves a current, a running and a failed video alone', async () => {
    const job = jobOf('a', { formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Partial<Job>);
    const failedMain = setup({ jobs: [job], exports: fakeExports({ a: 'failed' }) });
    failedMain.warmup.warm(job);
    await flush();
    // The failed main video is not retried (Export MP4 offers that); the extra format still is.
    expect(failedMain.exports.started).toEqual(['a:1x1']);
    failedMain.exports.finish('a', '1x1');
    await failedMain.warmup.idle();

    const done = setup({ jobs: [job], exports: fakeExports({ a: 'ready', 'a:1x1': 'making' }) });
    done.warmup.warm(job);
    await done.warmup.idle();
    expect(done.exports.started).toEqual([]);
  });

  it('waits while a quick fix or the music is changing the preview, and goes on when published again', async () => {
    const job = jobOf('a');
    let busy: string | null = 'A fix is running.';
    const h = setup({ jobs: [job], block: () => busy });
    h.warmup.warm(job);
    await h.warmup.idle();
    expect(h.videos.statusFor).not.toHaveBeenCalled();
    expect(h.exports.started).toEqual([]);

    busy = null;
    h.warmup.warm(job);
    await flush();
    expect(h.exports.started).toEqual(['a']);
    h.exports.finish('a');
    await h.warmup.idle();
  });

  it('stops before the next format when a fix starts meanwhile', async () => {
    const job = jobOf('a', { formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Partial<Job>);
    let busy: string | null = null;
    const h = setup({ jobs: [job], block: () => busy });
    h.warmup.warm(job);
    await flush();
    busy = 'A fix is running.';
    h.exports.finish('a');
    await h.warmup.idle();
    expect(h.exports.started).toEqual(['a']);
  });

  it('makes no more once the job has left Review', async () => {
    const job = jobOf('a', { formats: jobFormatsOf(['1080x1920', '1080x1080']) } as Partial<Job>);
    const h = setup({ jobs: [job] });
    h.warmup.warm(job);
    await flush();
    h.byId.set('a', { ...job, state: 'ready' } as Job);
    h.exports.finish('a');
    await h.warmup.idle();
    expect(h.exports.started).toEqual(['a']);
  });

  it('looks again when the job is published while its video is being made', async () => {
    const job = jobOf('a');
    const h = setup({ jobs: [job] });
    h.warmup.warm(job);
    await flush();
    h.warmup.warm(job);
    h.exports.finish('a');
    await flush();
    // The first video is current, so the second look finds nothing to make; the job is not queued twice.
    await h.warmup.idle();
    expect(h.exports.started).toEqual(['a']);
  });

  it('makes the video again when the first one was thrown away as stale', async () => {
    const job = jobOf('a');
    const exports = fakeExports();
    const h = setup({ jobs: [job], exports });
    h.warmup.warm(job);
    await flush();
    // A fix landed mid-render: the class threw the file away, so the status is idle again.
    h.warmup.warm(job);
    (exports as unknown as { statusFor: unknown }).statusFor = async () => ({ state: 'idle' });
    exports.finish('a');
    await flush();
    expect(exports.started).toEqual(['a', 'a']);
    exports.finish('a');
    await h.warmup.idle();
  });

  it('logs a failure and carries on with the next job', async () => {
    const [a, b] = [jobOf('a'), jobOf('b')] as [Job, Job];
    const exports = fakeExports();
    exports.start.mockRejectedValueOnce(new Error('no disk'));
    const h = setup({ jobs: [a, b], exports });
    h.warmup.warm(a);
    h.warmup.warm(b);
    await flush();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(exports.started).toEqual(['b']);
    exports.finish('b');
    await h.warmup.idle();
  });

  it('does not throw when the small video cannot be asked for', async () => {
    const job = jobOf('a');
    const h = setup({ jobs: [job] });
    h.videos.statusFor.mockRejectedValueOnce(new Error('gone'));
    expect(() => h.warmup.warm(job)).not.toThrow();
    await flush();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    h.exports.finish('a');
    await h.warmup.idle();
  });

  it('starts nothing after stop', async () => {
    const [a, b] = [jobOf('a'), jobOf('b')] as [Job, Job];
    const h = setup({ jobs: [a, b] });
    h.warmup.warm(a);
    await flush();
    h.warmup.warm(b);
    h.warmup.stop();
    h.exports.finish('a');
    await h.warmup.idle();
    expect(h.exports.started).toEqual(['a']);
    h.warmup.warm(jobOf('c'));
    await h.warmup.idle();
    expect(h.videos.statusFor).toHaveBeenCalledTimes(2);
  });
});
