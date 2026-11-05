// The Generate stage's History (Generated videos, GN5): what the stage did, one line per event, in
// `<job>/edit/generate/history.jsonl`. The engine writes it while the stage runs (the step turns
// what it sees in the files into `GenerateHistoryEvent`s, GN0's shape) and the job sheet reads it
// through `GET /api/jobs/:id/generate/history`. The words of each line are `generateHistoryText`'s.
//
// An event happens once: the log remembers what it has written (a Retry or a Resume reads the file
// first), so a voice that was made before the stop is not announced again. Only a stop is not
// deduplicated; every stop is its own line.
//
// A line that is not an event (a half-written one, a stray edit) is skipped when reading.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GENERATE_FILES,
  type GenerateHistoryEvent,
  generateHistoryEventSchema,
} from '@studio/shared';

/** The key an event is remembered by: two events with the same key are one thing that happened. */
export function historyKey(event: GenerateHistoryEvent): string {
  switch (event.kind) {
    case 'clip':
      return `clip:${event.id}:${event.take}`;
    case 'budget':
      return `budget:${event.id}`;
    case 'stopped':
      return `stopped:${event.at}:${event.code}`;
    default:
      return event.kind;
  }
}

/** The path of a job's History file, from its `edit/` folder. */
export function historyPath(editDir: string): string {
  return join(editDir, GENERATE_FILES.history);
}

/** Every event in the job's History file, oldest first; none when there is no file. Never throws. */
export async function readGenerateHistory(editDir: string): Promise<GenerateHistoryEvent[]> {
  let text: string;
  try {
    text = await readFile(historyPath(editDir), 'utf8');
  } catch {
    return [];
  }
  const events: GenerateHistoryEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = generateHistoryEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Not JSON: skipped.
    }
  }
  return events;
}

/** One job's History: remembers what is written and appends what is new. */
export class GenerateHistory {
  private readonly editDir: string;
  private readonly path: string;
  private readonly seen = new Set<string>();
  private loaded = false;

  constructor(editDir: string) {
    this.editDir = editDir;
    this.path = historyPath(editDir);
  }

  /** Reads what is already there. Called once before the first `add`. */
  async load(): Promise<readonly GenerateHistoryEvent[]> {
    const events = await readGenerateHistory(this.editDir);
    this.seen.clear();
    for (const event of events) this.seen.add(historyKey(event));
    this.loaded = true;
    return events;
  }

  /** Whether an event like this one is already written. */
  has(event: GenerateHistoryEvent): boolean {
    return this.seen.has(historyKey(event));
  }

  /** Appends the event unless it is already written. Returns whether it was written. */
  async add(event: GenerateHistoryEvent): Promise<boolean> {
    if (!this.loaded) await this.load();
    const key = historyKey(event);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  }
}
