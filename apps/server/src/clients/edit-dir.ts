// The edit/ folder of a job, made for a background video or still that is about to write into it.
//
// Those jobs (the phone's small preview video, the full Export MP4, the file without the song, the
// frame stills) start from a Job they were handed and take a few awaits (finding ffmpeg, a queue)
// before they write. The job may be deleted in between: Delete removes the folder, and a
// `mkdir(edit, { recursive: true })` after that would make `<Client>/<Job>/edit` again. The inbox
// would take the empty folder for a new job, so the deleted job would come back.
//
// Two things keep a deleted job's folder gone (C89):
//
// - `ensureEditDir`: `mkdir` without `recursive` cannot make the job folder itself. It answers ENOENT
//   once the folder is gone, in one step, so there is no gap between a check and the mkdir.
// - `JobStops`: that is not enough while Delete is still emptying the folder. `rm -r` takes `edit/`
//   out first and the job folder last, and in between the folder is there, so the mkdir succeeds and
//   `rm` then fails with ENOTEMPTY and leaves an empty `edit/` behind. The engine tells the makers
//   the moment a job is removed (`job.remove`, published before the rm starts), and a maker that
//   began before that sees its stop aborted and writes nothing.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EDIT_DIR_NAME } from '../inbox/classify.js';

export const JOB_FOLDER_GONE = 'The job folder is gone, so nothing was made in it.';

/** `<jobDir>/edit`, made if it was missing. Throws (and makes nothing) when the job folder itself is gone. */
export async function ensureEditDir(jobDir: string): Promise<string> {
  const editDir = join(jobDir, EDIT_DIR_NAME);
  try {
    await mkdir(editDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(JOB_FOLDER_GONE);
    if (code !== 'EEXIST') throw error;
  }
  return editDir;
}

/**
 * One stop per job, for the makers that write into a job's folder in the background. A request takes
 * the job's stop (`of`) before its first await; `forget` aborts it when the job is removed, so a
 * request that was already under way sees it and stops (a render it started is killed too), while a
 * request made after the removal (the same name added again) gets a fresh stop.
 */
export class JobStops {
  private readonly stops = new Map<string, AbortController>();

  /** The job's stop: the same signal until the job is forgotten. */
  of(jobId: string): AbortSignal {
    let stop = this.stops.get(jobId);
    if (stop === undefined) {
      stop = new AbortController();
      this.stops.set(jobId, stop);
    }
    return stop.signal;
  }

  /** The job was removed: everything that took its stop sees it aborted. */
  forget(jobId: string): void {
    this.stops.get(jobId)?.abort(new Error(JOB_FOLDER_GONE));
    this.stops.delete(jobId);
  }
}
