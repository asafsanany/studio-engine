// The job chat's service (Draft & chat, DR3): one FeedBuilder per job, fed the job log's new lines.
//
// A job's log only ever grows (job-log.ts appends), so the service keeps where it stopped reading
// (`offset`, in bytes) and reads only what came after: a 90 MB log is read once, in about a
// quarter of a second, and every look after that costs the new lines. A last line without its
// newline yet is kept back until it is whole. A log that got shorter (the job was deleted and its
// id made again) is read again from the start.
//
// The pictures go to `<feedsDir>/<jobId>/img/<name>`, written once: a rebuild after a restart
// makes the same names (feed-builder.ts) and finds them there. A card's file is read when its line
// is read, so while a run goes on the engine looks every few seconds (`start`): the cut list a
// card shows is the one the run wrote then, not the one a later round wrote over it.
//
// The answer adds what the log does not have: the notes each review round was sent with, from the
// notes table, on that round's first divider.
//
// Builders are kept for the last `maxJobs` jobs looked at; one that is dropped is built again from
// its log the next time.

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { JobFeedItem, JobFeedResponse, ReviewNote } from '@studio/shared';
import type { NoteRepository } from '../db/index.js';
import { logger as defaultLogger } from '../logger.js';
import { jobLogPath } from '../pipeline/job-log.js';
import { FeedBuilder } from './feed-builder.js';

/** What a picture's name may be: what the builder makes, and nothing that leaves the folder. */
const PICTURE_NAME = /^L\d+(?:-\d+)*\.(png|jpg|webp|gif)$/;

/** The largest file a card reads. */
const CARD_FILE_BYTES = 2 * 1024 * 1024;

/** How much of the log is read at a time. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export const FEED_TICK_MS = 3_000;

export interface FeedServiceOptions {
  /** `Config.logsDir`: a job's log is `<logsDir>/jobs/<id>.log`. */
  logsDir: string;
  /** Where the chats' pictures go: `<feedsDir>/<jobId>/img/`. */
  feedsDir: string;
  notes: Pick<NoteRepository, 'listSent'>;
  /** The placeholder brief's summary (DR4): a brief that still says it is not read gets no card. */
  pendingBriefSummary?: string | null;
  /** How many jobs' builders are kept. Default 24. */
  maxJobs?: number;
  logger?: Pick<typeof defaultLogger, 'warn'>;
}

interface JobFeed {
  builder: FeedBuilder;
  offset: number;
  decoder: StringDecoder;
  partial: string;
  /** The refresh going on, so two never read the same bytes. */
  reading: Promise<void>;
}

export class FeedService {
  private readonly feeds = new Map<string, JobFeed>();
  private readonly maxJobs: number;
  private readonly logger: Pick<typeof defaultLogger, 'warn'>;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: FeedServiceOptions) {
    this.maxJobs = options.maxJobs ?? 24;
    this.logger = options.logger ?? defaultLogger;
  }

  /** The job's chat as it is now: its log read up to its end first. */
  async feed(jobId: string): Promise<JobFeedResponse> {
    const feed = await this.refresh(jobId);
    return {
      jobId,
      rev: feed.builder.lines,
      items: withNotes(feed.builder.items, this.options.notes.listSent(jobId)),
    };
  }

  /** Where one of the job's pictures is, or null for a name the chat never made or a missing file. */
  picturePath(jobId: string, name: string): string | null {
    if (!PICTURE_NAME.test(name) || !/^[A-Za-z0-9_-]+$/.test(jobId)) return null;
    const path = join(this.pictureDir(jobId), name);
    return existsSync(path) ? path : null;
  }

  /** Reads the job's log up to its end. Never rejects for a log that is not there yet. */
  async refresh(jobId: string): Promise<JobFeed> {
    const feed = this.feedOf(jobId);
    const next = feed.reading.then(() => this.read(jobId, feed));
    feed.reading = next.catch((err: unknown) => {
      this.logger.warn({ jobId, err }, 'the job chat could not read the job log');
    });
    await feed.reading;
    return this.feeds.get(jobId) ?? feed;
  }

  /** Drops a job's builder (the job was deleted or renamed). Its pictures stay until its folder goes. */
  forget(jobId: string): void {
    this.feeds.delete(jobId);
  }

  /**
   * Looks at the running jobs' logs every `intervalMs`, so a card reads its file while the run that
   * wrote it goes on. `running` names them each time.
   */
  start(running: () => readonly string[], intervalMs = FEED_TICK_MS): void {
    this.stop();
    this.timer = setInterval(() => {
      for (const jobId of running()) void this.refresh(jobId);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private pictureDir(jobId: string): string {
    return join(this.options.feedsDir, jobId, 'img');
  }

  private feedOf(jobId: string): JobFeed {
    const known = this.feeds.get(jobId);
    if (known !== undefined) {
      // The most recently looked at go last, so the first one is the one to drop.
      this.feeds.delete(jobId);
      this.feeds.set(jobId, known);
      return known;
    }
    const feed = this.newFeed(jobId);
    this.feeds.set(jobId, feed);
    while (this.feeds.size > this.maxJobs) {
      const oldest = this.feeds.keys().next().value;
      if (oldest === undefined) break;
      this.feeds.delete(oldest);
    }
    return feed;
  }

  private newFeed(jobId: string): JobFeed {
    const dir = this.pictureDir(jobId);
    const builder = new FeedBuilder(
      {
        saveImage: (name, bytes) => {
          const path = join(dir, name);
          if (existsSync(path)) return;
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, bytes);
        },
        readText: readCardFile,
      },
      { pendingBriefSummary: this.options.pendingBriefSummary ?? null },
    );
    return {
      builder,
      offset: 0,
      decoder: new StringDecoder('utf8'),
      partial: '',
      reading: Promise.resolve(),
    };
  }

  private async read(jobId: string, feed: JobFeed): Promise<void> {
    const path = jobLogPath(this.options.logsDir, jobId);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (size < feed.offset) {
      // The log was made again: start this job's chat over.
      const fresh = this.newFeed(jobId);
      Object.assign(feed, { ...fresh, reading: feed.reading });
    }
    if (size === feed.offset) return;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - feed.offset));
      while (feed.offset < size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - feed.offset),
          feed.offset,
        );
        if (bytesRead === 0) break;
        feed.offset += bytesRead;
        const text = feed.partial + feed.decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split('\n');
        feed.partial = lines.pop() ?? '';
        for (const line of lines) feed.builder.push(line);
      }
    } finally {
      await handle.close();
    }
  }
}

/** A card's file, or null when it is missing, too large or not text. */
function readCardFile(path: string): string | null {
  try {
    if (statSync(path).size > CARD_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The items as the API sends them: each round's first divider with the notes it was sent with. */
export function withNotes(
  items: readonly JobFeedItem[],
  sent: readonly ReviewNote[],
): JobFeedItem[] {
  const given = new Set<number>();
  return items.map((item) => {
    if (item.kind !== 'run' || item.run !== 'round' || item.round === null) return item;
    if (given.has(item.round)) return item;
    given.add(item.round);
    const notes = sent.filter((note) => note.round === item.round);
    return notes.length === 0 ? item : { ...item, notes };
  });
}
