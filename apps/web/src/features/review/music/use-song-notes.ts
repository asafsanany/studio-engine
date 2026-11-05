import { useState } from 'react';
import { useAddNote, useJobs, useNotes } from '@/data';
import { type SongNote, songNote, TRENDING_NOTE } from './music-text';

// Another song and Pick a trending one in Review's Music list (Songs, canvas page "Songs", board
// SGMusic). Neither changes the music: each adds a Review note, word for word, and the editor re-cuts
// to the song when Send goes (the cuts follow the song, so there is no engine-only swap). The preview
// stays as it is until then.

/** A note about the whole video sits at its start. */
export const SONG_NOTE_AT_SEC = 0;

export interface SongNotes {
  /** Adds "Use [name] instead." / "Use the song from [link] instead." for what was typed; nothing for a blank. `onAdded` runs once the note is in. */
  addSong(input: string, onAdded?: () => void): void;
  /** Adds "Use a trending song that fits the cut." */
  addTrending(onAdded?: () => void): void;
  /** The note this list added last, while it is still among the unsent ones (Send and delete take it away); else `null`. */
  noted: SongNote | null;
  /** The trending note is among the unsent ones, so Pick a trending one has nothing more to add. */
  trendingAdded: boolean;
  /** A note is on its way to the engine. */
  pending: boolean;
  /** The engine's words when it refused the note (the job left Review …). */
  error: string | null;
  /** The client's name, for the status line of a trending pick; `null` until it is known. */
  client: string | null;
}

/**
 * The notes of Another song and Pick a trending one for a job. `enabled` turns off the read of the
 * job's unsent notes while Songs are off (the Review dialog reads them anyway; this shares its cache).
 */
export function useSongNotes(jobId: string, enabled = true): SongNotes {
  const add = useAddNote(jobId);
  const notes = useNotes(jobId, { enabled });
  const client = useJobs().data?.find((job) => job.id === jobId)?.client ?? null;
  const [added, setAdded] = useState<SongNote | null>(null);

  const unsent = notes.data?.map((note) => note.text);
  // While the notes are not known, what this list added counts; once they are, the notes decide
  // (a note that was deleted, or sent, is no longer "added to your notes"). The trending note is
  // known by its words, so it is still said after the list was closed and opened again.
  const trendingAdded =
    unsent === undefined ? added?.kind === 'trending' : unsent.includes(TRENDING_NOTE.text);
  const addedHere =
    added !== null && (unsent === undefined || unsent.includes(added.text)) ? added : null;
  const noted = addedHere ?? (trendingAdded ? TRENDING_NOTE : null);

  function post(note: SongNote, onAdded?: () => void) {
    if (add.isPending) return;
    // `mutateAsync`: the answer is heard even if the list was closed meanwhile (the note is in the cache
    // either way). A refusal is in `add.error`, which the list shows.
    add.mutateAsync({ atSec: SONG_NOTE_AT_SEC, text: note.text }).then(
      () => {
        setAdded(note);
        onAdded?.();
      },
      () => {},
    );
  }

  return {
    addSong(input, onAdded) {
      const note = songNote(input);
      if (note !== null) post(note, onAdded);
    },
    addTrending(onAdded) {
      if (!trendingAdded) post(TRENDING_NOTE, onAdded);
    },
    noted,
    trendingAdded,
    pending: add.isPending,
    error: add.error?.message ?? null,
    client,
  };
}
