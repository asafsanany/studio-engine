// Link to job and Unlink, from a reel's right-click menu: the call, then the message that says
// what happened (with Undo) or why it did not. The row has changed by then (the data layer's
// mutations change the page at once and put it back when the server refuses), so these only add
// the words.
//
// Undo calls the opposite route itself instead of leaning on the row: the message outlives its row
// (the reel moves in the list when the range changes, or the page is left). A refusal of the Undo
// (the video was linked to another reel meanwhile) or an unreachable server is told as a message of
// its own.

import type { InstagramReel } from '@studio/shared';
import { ApiError } from '@/data/api';
import type { LinkReelVariables } from '@/data/instagram-mutations';
import type { TextOptions } from './instagram-text';
import {
  announceReelLinked,
  announceReelLinkRefused,
  announceReelUndoRefused,
  announceReelUnlinked,
  type ReelLinkToastJob,
  type ReelLinkToastReel,
} from './reel-link-toasts';

/** What the flows call: the two mutations, and how the days in the messages are written. */
export interface ReelLinkDeps {
  link(variables: LinkReelVariables): Promise<InstagramReel>;
  unlink(shortcode: string): Promise<InstagramReel>;
  textOptions?: TextOptions;
}

/** The video the engine could not find: its id is no use to the person, so it is left out. */
const JOB_NOT_FOUND = /^Job \S+ not found$/;

/**
 * The words of a refusal. A 409 carries its reason as a plain sentence ("That video is linked to a
 * reel already. Unlink it first."); a video that is gone says so without its id; an unreachable
 * server says that.
 */
export function refusalWords(error: unknown): string {
  if (error instanceof ApiError && error.status === 404 && JOB_NOT_FOUND.test(error.message)) {
    return 'That video is not there any more.';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Link the reel to the video: `Linked “<name>” to the reel of Tue 20 Oct`, with Undo (Unlink). A
 * refusal says why in a message of its own. Resolves to whether the link was made.
 */
export async function linkReelToJob(
  deps: ReelLinkDeps,
  reel: ReelLinkToastReel,
  job: ReelLinkToastJob,
): Promise<boolean> {
  try {
    await deps.link({ shortcode: reel.shortcode, jobId: job.id, jobName: job.name });
  } catch (error) {
    announceReelLinkRefused('link', reel, job, refusalWords(error));
    return false;
  }
  announceReelLinked(
    reel,
    job,
    () => {
      void undoWith(reel, () => deps.unlink(reel.shortcode));
    },
    deps.textOptions,
  );
  return true;
}

/**
 * Unlink the reel from its video: `Unlinked “<name>” from the reel of Tue 20 Oct`, with Undo (Link
 * again). A refusal says why. Resolves to whether the reel was unlinked.
 */
export async function unlinkReelFromJob(
  deps: ReelLinkDeps,
  reel: ReelLinkToastReel,
  job: ReelLinkToastJob,
): Promise<boolean> {
  try {
    await deps.unlink(reel.shortcode);
  } catch (error) {
    announceReelLinkRefused('unlink', reel, job, refusalWords(error));
    return false;
  }
  announceReelUnlinked(
    reel,
    job,
    () => {
      void undoWith(reel, () =>
        deps.link({ shortcode: reel.shortcode, jobId: job.id, jobName: job.name }),
      );
    },
    deps.textOptions,
  );
  return true;
}

/** Runs the opposite route; its refusal is a message, its success needs none (the row has changed). */
async function undoWith(
  reel: ReelLinkToastReel,
  route: () => Promise<InstagramReel>,
): Promise<void> {
  try {
    await route();
  } catch (error) {
    announceReelUndoRefused(reel, refusalWords(error));
  }
}
