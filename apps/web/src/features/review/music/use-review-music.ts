import type { MusicView } from '@studio/shared';
import { useRef } from 'react';
import { useJobMusic, useMusicEnabled } from '@/data';

/** A job's music as Review's player and footer read it. */
export interface ReviewMusic {
  /** The job's music; `null` for a job without music.json, `undefined` until it is known or while Soundtrack is off. */
  music: MusicView | null | undefined;
  /** What goes into the preview's URL (`previewUrl(id, round, rev)`); `undefined` when there is no music. */
  rev: number | undefined;
  /**
   * The first answer is on its way. The player waits for it, so it is not loaded once without the
   * music's `rev` and then again with it.
   */
  settling: boolean;
}

/**
 * The job's music for Review (Mac and phone): the view, its `rev` and whether the first answer is
 * still on its way. While `hold` is true the `rev` stays as it was: the dialog is fading out or a
 * Send or Approve is on its way, and the player must not reload for a change the engine makes
 * after that (the job leaves Review, and the preview is another cut by then).
 */
export function useReviewMusic(jobId: string, hold = false): ReviewMusic {
  const on = useMusicEnabled();
  const query = useJobMusic(jobId);
  // Nothing of music while Soundtrack is off, even if an answer is still in the cache.
  const music = on ? query.data : undefined;
  const held = useRef(music?.rev);
  if (!hold) held.current = music?.rev;
  return {
    music,
    rev: held.current,
    settling: query.isPending && query.fetchStatus === 'fetching',
  };
}
