// The topic pass (Analytics plan, AN4): gives every sent review note a short English topic, so the
// Analytics page can say what the notes are about. It runs in the background and never blocks
// anything:
//
//   - `trigger()` asks for a pass. The triggers are a Send (the review service's `onSent`) and the
//     engine start; they are debounced (30 s by default), so a burst of Sends makes one run.
//   - A pass takes the sent notes that have text and no topic yet (a voice note counts once it has
//     its transcript), at most MAX_NOTES_PER_PASS of them, oldest first, and asks the runner, one
//     small headless Sonnet run, for a topic per note, given the topics already in use so that it
//     reuses them. Only one pass runs at a time; a trigger during a pass runs another when it ends.
//   - The answer is parsed strictly (note-topics-prompt.ts) and only topics for notes of the batch
//     are kept. A pass that fails is logged and does nothing else: the notes stay "not grouped
//     yet" and the next trigger tries again. With nothing to group no run is started, so asking
//     twice costs nothing.

import type { ReviewNote } from '@studio/shared';
import type { JobRepository, NoteRepository } from '../db/index.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { SILENT_LOGGER } from '../pipeline/claude-process.js';
import { noteTopicsUsage } from '../usage/app-usage.js';
import type { NoteTopicStore } from './note-topics.js';
import { buildTopicsPrompt, parseTopicsAnswer, type TopicNote } from './note-topics-prompt.js';
import type { NoteTopicRunner } from './note-topics-run.js';

/** Notes in one run: a bigger backlog takes several passes, one after the other. */
export const MAX_NOTES_PER_PASS = 60;
/** Topics shown to the model as already in use, the most used first. */
export const MAX_TOPICS_IN_USE = 60;
export const TOPIC_DEBOUNCE_MS = 30_000;

export interface NoteTopicPassOptions {
  notes: Pick<NoteRepository, 'listAllSent'>;
  /** For the client of a note's job. */
  jobs: Pick<JobRepository, 'get'>;
  store: Pick<NoteTopicStore, 'get' | 'add'>;
  runner: NoteTopicRunner;
  /** Wait after the last trigger before a pass starts. Default 30 s. */
  debounceMs?: number;
  /** Default: nothing is logged. */
  logger?: RunnerLogger;
}

/** What one pass did. */
export type NoteTopicPassResult =
  | { status: 'nothing' }
  | { status: 'grouped'; grouped: number; asked: number }
  | { status: 'failed'; error: string };

export class NoteTopicPass {
  private readonly options: NoteTopicPassOptions;
  private readonly logger: RunnerLogger;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<NoteTopicPassResult> | null = null;
  private again = false;
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(options: NoteTopicPassOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.debounceMs = options.debounceMs ?? TOPIC_DEBOUNCE_MS;
  }

  /** Asks for a pass once things have been quiet for the debounce. Never throws. */
  trigger(): void {
    if (this.stopped) return;
    if (this.current !== null) {
      this.again = true;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
  }

  /**
   * Runs a pass now, or, when one is running, waits for it and returns its result. Never throws:
   * a pass that breaks is a `failed` result and a log line.
   */
  run(): Promise<NoteTopicPassResult> {
    if (this.current !== null) return this.current;
    const pass = this.pass().finally(() => {
      this.current = null;
      // Notes were sent while it ran, or a backlog is left: the next pass is debounced like any.
      if (this.again && !this.stopped) {
        this.again = false;
        this.trigger();
      }
    });
    this.current = pass;
    return pass;
  }

  /** Stops waiting for a pass, stops the one that runs and waits until it has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller.abort();
    await this.current;
  }

  /** The sent notes that have text and no topic, oldest first, with their client. */
  private unlabelled(): { notes: TopicNote[]; waiting: number } {
    const topics = this.options.store.get();
    const clients = new Map<string, string>();
    const clientOf = (note: ReviewNote): string => {
      let client = clients.get(note.jobId);
      if (client === undefined) {
        client = this.options.jobs.get(note.jobId)?.client ?? 'unknown';
        clients.set(note.jobId, client);
      }
      return client;
    };
    const all: TopicNote[] = [];
    for (const note of this.options.notes.listAllSent()) {
      if (note.text === null || Object.hasOwn(topics, note.id)) continue;
      all.push({ id: note.id, client: clientOf(note), text: note.text });
    }
    return { notes: all.slice(0, MAX_NOTES_PER_PASS), waiting: all.length };
  }

  private topicsInUse(): string[] {
    const counts = new Map<string, number>();
    for (const topic of Object.values(this.options.store.get())) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOPICS_IN_USE)
      .map(([topic]) => topic);
  }

  private async pass(): Promise<NoteTopicPassResult> {
    try {
      if (this.stopped) return { status: 'nothing' };
      const { notes, waiting } = this.unlabelled();
      if (notes.length === 0) return { status: 'nothing' };

      const outcome = await this.options.runner.run({
        prompt: buildTopicsPrompt(notes, this.topicsInUse()),
        usage: noteTopicsUsage(notes.length),
        signal: this.controller.signal,
      });
      if (!outcome.ok) return this.failed(outcome.error);
      const answer = parseTopicsAnswer(outcome.text, new Set(notes.map((note) => note.id)));
      if (!answer.ok) return this.failed(answer.error);

      const grouped = await this.options.store.add(answer.topics);
      this.logger.info(
        { asked: notes.length, grouped, dropped: answer.dropped },
        'grouped review notes into topics',
      );
      // More notes than one run takes: carry on with the rest, unless this run got nowhere.
      if (waiting > notes.length && grouped > 0) this.again = true;
      return { status: 'grouped', grouped, asked: notes.length };
    } catch (err) {
      return this.failed(err instanceof Error ? err.message : String(err));
    }
  }

  private failed(error: string): NoteTopicPassResult {
    // A pass the engine stopped is not a failure.
    if (!this.stopped) {
      this.logger.warn({ error }, 'could not group the review notes into topics; will try again');
    }
    return { status: 'failed', error };
  }
}
