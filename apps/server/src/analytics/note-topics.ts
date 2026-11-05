// The topic of each sent review note (Analytics plan, AN4): `<dataDir>/note-topics.json`, one
// object from a note's id to a short English topic, e.g. { "3f2a…": "intro too long" }. The
// Analytics page's "What your notes are about" card reads it through `get()`; the topic pass
// (note-topics-pass.ts) writes it.
//
// A note with no entry is "not grouped yet". The file is read afresh on every `get()` (it is small,
// and a topic the owner fixes by hand shows at once); a file that is missing or cannot be read counts as
// empty. Writes are atomic and never replace a topic a note already has, so two passes can never
// disagree about a note.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../review/review-files.js';

export const NOTE_TOPICS_FILE = 'note-topics.json';

export function noteTopicsPath(dataDir: string): string {
  return join(dataDir, NOTE_TOPICS_FILE);
}

/** A note id to its topic. */
export type NoteTopics = Readonly<Record<string, string>>;

const MAX_WORDS = 6;
const MAX_LENGTH = 40;
/** A topic is Latin words, numbers and a little punctuation: English, as the card shows it. */
const TOPIC_WORDS = /^[a-z0-9][a-z0-9'/-]*$/;

/**
 * The topic as the card shows it: trimmed, lowercase, single spaces, no full stop or quotes around
 * it. Returns null for text that is not a short English topic (empty, too long, Hebrew, a sentence).
 */
export function normalizeTopic(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const topic = value
    .normalize('NFC')
    .toLowerCase()
    .replace(/^["'“”‘’\s]+|["'“”‘’.!?,;:\s]+$/g, '')
    .replace(/\s+/g, ' ');
  if (topic === '' || topic.length > MAX_LENGTH) return null;
  const words = topic.split(' ');
  if (words.length > MAX_WORDS || !words.every((word) => TOPIC_WORDS.test(word))) return null;
  return topic;
}

export class NoteTopicStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = noteTopicsPath(dataDir);
  }

  /** Every topic there is, by note id. Entries that are not a note id and a topic are dropped. */
  get(): NoteTopics {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const topics: Record<string, string> = {};
    for (const [id, topic] of Object.entries(parsed)) {
      if (typeof topic === 'string' && topic !== '') topics[id] = topic;
    }
    return topics;
  }

  /**
   * Gives the notes in `added` their topic, unless they have one already, and writes the file once.
   * Returns how many notes got a topic. Throws when the file cannot be written.
   */
  async add(added: NoteTopics): Promise<number> {
    const topics = { ...this.get() };
    let count = 0;
    for (const [id, topic] of Object.entries(added)) {
      if (Object.hasOwn(topics, id)) continue;
      topics[id] = topic;
      count++;
    }
    if (count > 0) await writeFileAtomic(this.path, `${JSON.stringify(topics, null, 2)}\n`);
    return count;
  }
}
