// The videos of a job in Review, made as soon as it gets there (the owner, 26 Oct: "when a preview is
// ready for revision, start working on the preview mp4, so that on my phone, or to download, it is
// instant"). Two videos come from the same composition in edit/preview/:
//
//   the small one   edit/preview-lite.mp4    the phone's Review plays and shares it  (PreviewVideos)
//   the full one    edit/review-export.mp4   Export MP4 in the Mac's Review           (ReviewExports)
//
// Both used to be made when someone asked. Now every `job.upsert` of a job in Review comes here:
//
// - The small video starts at once (`PreviewVideos.statusFor` starts it when it is missing or
//   stale), as it did when a job reached Review.
// - The full video of each format (the main one, then each extra format of a job with two or
//   more) waits in one queue for the whole engine, so a few jobs in Review never render the
//   full-quality video all at the same time. Each is made unless it is current already, is being
//   made, or failed for this round of the composition (Export MP4 offers the new try).
// - Nothing starts while a quick fix or the music is still changing the preview (`block`): the job
//   is published again when it ends, and that starts the videos. A render that finds the files
//   changed when it ends is thrown away by the video's own class, and the next pass renders again.
// - A job that leaves Review (Approve, Send notes, Cancel) gets no further video; one already
//   rendering carries on, and Approve uses it instead of rendering again (`ReviewExports.useFor`).
//
// Nothing here throws or makes anything wait: a failure is logged, and the video is then made on
// request exactly as before.

import { extraFormatsOf, type Job } from '@studio/shared';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import type { PreviewVideos } from './preview-video.js';
import type { ReviewExports } from './review-export.js';

export interface ReviewWarmupOptions {
  videos: Pick<PreviewVideos, 'statusFor'>;
  exports: Pick<ReviewExports, 'statusFor' | 'start' | 'idle'>;
  /** The job as it is now, or `null` once it is gone. */
  getJob: (jobId: string) => Job | null;
  /** Why the preview's files are still changing (a quick fix, the music), or `null`. */
  block?: (job: Job) => string | null;
  logger?: RunnerLogger;
}

export class ReviewWarmup {
  private readonly videos: ReviewWarmupOptions['videos'];
  private readonly exports: ReviewWarmupOptions['exports'];
  private readonly getJob: ReviewWarmupOptions['getJob'];
  private readonly block: NonNullable<ReviewWarmupOptions['block']>;
  private readonly logger: RunnerLogger;
  /** Jobs waiting for their full videos, oldest first. */
  private readonly queued = new Set<string>();
  /** The job whose full videos are being made, and whether it was published again meanwhile. */
  private current: string | null = null;
  private again = false;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor({ videos, exports, getJob, block, logger = SILENT_LOGGER }: ReviewWarmupOptions) {
    this.videos = videos;
    this.exports = exports;
    this.getJob = getJob;
    this.block = block ?? (() => null);
    this.logger = logger;
  }

  /** A job was published. Does something only for one in Review. Never throws, never waits. */
  warm(job: Job): void {
    if (this.stopped || job.state !== 'review') return;
    if (this.block(job) !== null) return;
    this.videos.statusFor(job).catch((err: unknown) => {
      this.logger.warn({ jobId: job.id, err }, 'could not start the preview video of a job');
    });
    if (job.id === this.current) {
      this.again = true;
      return;
    }
    this.queued.add(job.id);
    this.running ??= this.drain();
  }

  /** Resolves when nothing is queued or being made by the queue (tests). */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  /** Nothing starts from here on. A render that is under way carries on. */
  stop(): void {
    this.stopped = true;
    this.queued.clear();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const id = this.queued.values().next().value;
        if (id === undefined || this.stopped) return;
        this.queued.delete(id);
        this.current = id;
        try {
          do {
            this.again = false;
            await this.makeFor(id);
          } while (this.again && !this.stopped);
        } catch (err) {
          this.logger.warn({ jobId: id, err }, 'could not make the full video of a job in Review');
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = null;
    }
  }

  /** Makes the full video of each format of the job that has none, one at a time. */
  private async makeFor(id: string): Promise<void> {
    const formats = [undefined, ...extraFormatsOf(this.getJob(id)?.formats).map((one) => one.id)];
    for (const formatId of formats) {
      // Asked again before each: the job may have left Review, or a fix may have started.
      const job = this.getJob(id);
      if (job === null || job.state !== 'review' || this.stopped) return;
      if (this.block(job) !== null) return;
      if ((await this.exports.statusFor(job, formatId)).state !== 'idle') continue;
      await this.exports.start(job, formatId);
      await this.exports.idle(id, formatId);
    }
  }
}
