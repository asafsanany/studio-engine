// The topic pass's prompt and its answer (Analytics plan, AN4). The notes go in as JSON lines, so a
// Hebrew note, a quote or a line break in one cannot break the prompt; the answer is one JSON
// array, parsed strictly: anything that is not a topic for a note of this batch is dropped.

import { z } from 'zod';
import { normalizeTopic } from './note-topics.js';

/** One note as the model sees it. */
export interface TopicNote {
  id: string;
  /** The client of the note's job. */
  client: string;
  text: string;
}

/** A note longer than this is cut: a topic needs its gist, not its last paragraph. */
export const NOTE_TEXT_MAX = 500;

/** The prompt for one batch of notes, with the topics already in use (most used first). */
export function buildTopicsPrompt(
  notes: readonly TopicNote[],
  topicsInUse: readonly string[],
): string {
  const lines = notes.map((note) =>
    JSON.stringify({ id: note.id, client: note.client, text: note.text.slice(0, NOTE_TEXT_MAX) }),
  );
  const inUse =
    topicsInUse.length === 0 ? '(none yet)' : topicsInUse.map((t) => `- ${t}`).join('\n');
  return [
    'Give each review note a short topic.',
    '',
    'The notes are feedback a video editor wrote or said while reviewing a client video. Each is free text, in English or Hebrew. A topic says what the note asks to change, in English, as 2 to 4 lowercase words, for example "intro too long", "music too loud" or "subtitle position". It is never a client or a job name, and has no punctuation.',
    '',
    'Reuse a topic from the list below whenever it fits the note, even loosely. Make a new one only when none of them fits.',
    '',
    'Answer with a JSON array and nothing else, no code fence, no comment: one entry per note, [{"id":"<the note\'s id, exactly as given>","topic":"<its topic>"}].',
    '',
    'Topics already in use:',
    inUse,
    '',
    'Notes, one JSON object per line:',
    ...lines,
  ].join('\n');
}

export type TopicsAnswer =
  | {
      ok: true;
      /** Note id to topic: only notes of the batch, each once. */
      topics: Record<string, string>;
      /** How many entries of the answer were dropped. */
      dropped: number;
    }
  | { ok: false; error: string };

const entrySchema = z.object({ id: z.string(), topic: z.unknown() });

/** A code fence round the whole answer is the one thing a model adds even when told not to. */
function unfenced(text: string): string {
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(text.trim());
  return fence?.[1] ?? text.trim();
}

/**
 * The topics in the model's answer. The answer must be a JSON array; an entry counts when it is an
 * object with the id of a note of this batch (not given a topic already by an earlier entry) and a
 * topic that `normalizeTopic` accepts. Fails when the answer is not an array or has no good entry.
 */
export function parseTopicsAnswer(text: string, ids: ReadonlySet<string>): TopicsAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced(text));
  } catch {
    return { ok: false, error: 'the answer is not JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'the answer is not a list' };

  const topics: Record<string, string> = {};
  let dropped = 0;
  for (const item of parsed) {
    const entry = entrySchema.safeParse(item);
    const topic = entry.success ? normalizeTopic(entry.data.topic) : null;
    if (
      !entry.success ||
      topic === null ||
      !ids.has(entry.data.id) ||
      Object.hasOwn(topics, entry.data.id)
    ) {
      dropped++;
      continue;
    }
    topics[entry.data.id] = topic;
  }
  if (Object.keys(topics).length === 0) {
    return { ok: false, error: 'the answer has no usable topic for these notes' };
  }
  return { ok: true, topics, dropped };
}
