import type { Job } from '@studio/shared';
import { previewUrl, useJobVersions } from '@/data';
import { runningCut } from './job-chat-logic';

/** What a running job's player plays: the cut's composition and its size. */
export interface RunningPlay {
  src: string;
  width: number;
  height: number;
  durationSec: number;
}

/** What a running job's player plays, or nothing yet. */
export interface RunningCut {
  /** The versions' first answer is on its way. */
  loading: boolean;
  /** The cut to play; `null` before the first cut (and while loading). */
  play: RunningPlay | null;
}

/**
 * The cut a running job's chat plays where the video goes (Draft & chat): its saved version
 * (`runningCut`), which the run cannot change under the player (it edits the live composition). A
 * job from before versions has a preview and no version: it plays the live one. A run that ends in
 * Review makes a new version and changes the job, so the list is read again then. Asks nothing
 * while `enabled` is false.
 */
export function useRunningCut(
  job: Pick<Job, 'id' | 'round' | 'preview'>,
  enabled: boolean,
): RunningCut {
  const versions = useJobVersions(job.id, { enabled });
  const loading = enabled && versions.data === undefined && !versions.isError;
  const cut = runningCut(versions.data?.versions ?? []);
  if (cut !== null) {
    return {
      loading,
      play: { src: previewUrl(job.id, job.round, null, '', cut.n), ...sizeOf(cut) },
    };
  }
  if (loading || job.preview === null) return { loading, play: null };
  return { loading, play: { src: previewUrl(job.id, job.round), ...sizeOf(job.preview) } };
}

function sizeOf({ width, height, durationSec }: Omit<RunningPlay, 'src'>) {
  return { width, height, durationSec };
}
