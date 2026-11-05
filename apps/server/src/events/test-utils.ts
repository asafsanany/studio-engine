// Helpers shared by the event tests. Not part of the server build (see tsconfig.build.json).

import { type Job, type ServerEvent, serverEventSchema } from '@studio/shared';
import type { StreamTimers } from './client-stream.js';

/** A valid `editing` job; tests override what they care about. */
export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'a1b2c3d4e5f6',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    name: 'Spring menu',
    relPath: 'Northwind Bakery/Spring menu',
    state: 'editing',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 14, audio: 1, image: 0, doc: 1 },
    sizeBytes: 1_181_116_006,
    addedAt: '2026-10-20T11:02:10.000Z',
    lastChangeAt: '2026-10-20T13:40:00.000Z',
    settledAt: '2026-10-20T13:41:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-20T13:45:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

/** Timers and a clock driven by hand. `advance` runs whatever falls due, in order. */
export class FakeTimers implements StreamTimers {
  now = 1_000_000;
  private next = 1;
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

  /** `now` for the code under test: `{ now: timers.clock }`. */
  readonly clock = (): number => this.now;

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  /** Timers that have not fired and were not cleared. */
  get pending(): number {
    return this.scheduled.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let earliest: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.scheduled) {
        if (entry[1].at <= target && (earliest === undefined || entry[1].at < earliest[1].at)) {
          earliest = entry;
        }
      }
      if (earliest === undefined) break;
      this.scheduled.delete(earliest[0]);
      this.now = Math.max(this.now, earliest[1].at);
      earliest[1].callback();
    }
    this.now = target;
  }
}

/** Reads the frames of an SSE response, one at a time, with a timeout so a test never hangs. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private pending: Promise<
    Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
  > | null = null;
  /** True once the response body has ended. */
  ended = false;

  constructor(response: Response) {
    if (response.body === null) throw new Error('the response has no body');
    this.reader = response.body.getReader();
  }

  /** Reads until the buffer holds a whole frame or `timeoutMs` passes. */
  private async fill(timeoutMs: number): Promise<void> {
    while (!this.buffer.includes('\n\n') && !this.ended) {
      this.pending ??= this.reader.read();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const result = await Promise.race([this.pending, timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') return;
      this.pending = null;
      if (result.done) this.ended = true;
      else this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }

  /** The next frame as text without its blank-line terminator, or `null` if none comes in time. */
  async frame(timeoutMs = 1_000): Promise<string | null> {
    await this.fill(timeoutMs);
    const end = this.buffer.indexOf('\n\n');
    if (end < 0) return null;
    const frame = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 2);
    return frame;
  }

  /** The next frame, which must be a `data:` frame holding a `ServerEvent`. */
  async event(timeoutMs = 1_000): Promise<ServerEvent> {
    const frame = await this.frame(timeoutMs);
    if (frame === null) throw new Error('no event arrived in time');
    if (!frame.startsWith('data: ')) throw new Error(`not a data frame: ${JSON.stringify(frame)}`);
    return serverEventSchema.parse(JSON.parse(frame.slice('data: '.length)));
  }

  /** Reads frames until the body ends or `timeoutMs` passes with none; returns the data events. */
  async events(timeoutMs = 100): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    for (;;) {
      const frame = await this.frame(timeoutMs);
      if (frame === null) return events;
      if (frame.startsWith('data: ')) {
        events.push(serverEventSchema.parse(JSON.parse(frame.slice('data: '.length))));
      }
    }
  }

  /** Whether nothing arrives for `ms`. */
  async quiet(ms = 100): Promise<boolean> {
    return (await this.frame(ms)) === null;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}
