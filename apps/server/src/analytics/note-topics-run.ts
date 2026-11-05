// What the topic pass needs from "a Claude run" (Analytics plan, AN4): give it a prompt, get the
// text it answered with. The real one is the headless Claude run (note-topics-claude.ts); tests
// give the pass a stand-in.

import type { AppUsage } from '../usage/usage-log.js';

export interface NoteTopicRunRequest {
  /** The whole prompt: the notes and the topics already in use. */
  prompt: string;
  /** The run's usage tag and line, logged to usage.jsonl once it has ended. */
  usage: AppUsage;
  /** Aborted when the engine shuts down. */
  signal: AbortSignal;
}

export type NoteTopicRunOutcome =
  | { ok: true; text: string }
  /** `error` is one plain line for the log. */
  | { ok: false; error: string };

export interface NoteTopicRunner {
  run(request: NoteTopicRunRequest): Promise<NoteTopicRunOutcome>;
}
