import type { AnalyticsNoteTopic } from '@studio/shared';

// What "What your notes are about" says: a row per topic with the length of its bar and the clients
// under it, and the line about notes that have no topic yet. Pure functions of the answer.

/** What the card says when no review note has been sent. */
export const NO_NOTES_YET = 'No review notes yet';

/** One row of the ranking. */
export interface NoteTopicRow {
  topic: string;
  /** Sent notes with this topic. */
  count: number;
  /** The bar's length as a share of the biggest topic's, in percent (the first row is 100). */
  barPercent: number;
  /** The clients that got these notes, most notes first, as the line under the bar says them. */
  clients: string;
  /** The whole story for a hover: the topic, how many notes and each client's count. */
  title: string;
}

/** The rows of the ranking, in the order they come (the engine sends the biggest topic first). */
export function noteTopicRows(topics: readonly AnalyticsNoteTopic[]): NoteTopicRow[] {
  const biggest = Math.max(1, ...topics.map((topic) => topic.count));
  return topics.map(({ topic, count, clients }) => ({
    topic,
    count,
    barPercent: Math.round((count / biggest) * 1000) / 10,
    clients: clients.map((entry) => entry.client).join(', '),
    title: [
      `${topic}: ${count} ${count === 1 ? 'note' : 'notes'}`,
      ...clients.map((entry) => `${entry.client} ${entry.count}`),
    ].join(' · '),
  }));
}

/** "9 notes not grouped yet", or `null` when every note has a topic. */
export function notGroupedText(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'note' : 'notes'} not grouped yet`;
}
