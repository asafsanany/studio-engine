// The pure rules for the cached notes of one job (query key ['notes', jobId]). Nothing here touches
// React, the network or the query client, so the rules are tested on plain arrays.
//
// The cache holds the job's unsent notes in the server's order (atSec, then createdAt, then id).
// A note that was sent (it has a round) is not in the list any more: Send empties it.

import type { ReviewNote } from '@studio/shared';

/** Every notes query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const NOTES_KEY = ['notes'] as const;

/** One job's unsent notes: ['notes', jobId]. */
export function notesKey(jobId: string): readonly ['notes', string] {
  return ['notes', jobId] as const;
}

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The server's order: atSec, then createdAt, then id. */
export function compareNotes(a: ReviewNote, b: ReviewNote): number {
  return (
    compare(a.atSec, b.atSec) ||
    compare(Date.parse(a.createdAt), Date.parse(b.createdAt)) ||
    compare(a.id, b.id)
  );
}

/** `note` replaces the note with its id or joins the list in order; a sent note (round set) leaves it. */
export function upsertNote(list: readonly ReviewNote[], note: ReviewNote): ReviewNote[] {
  const others = list.filter((existing) => existing.id !== note.id);
  if (note.round !== null) return others;
  const at = others.findIndex((other) => compareNotes(note, other) < 0);
  others.splice(at === -1 ? others.length : at, 0, note);
  return others;
}

/** The list without the note `noteId`. A new array even when `noteId` is not in it. */
export function removeNote(list: readonly ReviewNote[], noteId: string): ReviewNote[] {
  return list.filter((note) => note.id !== noteId);
}
