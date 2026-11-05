// What linking a reel to a job (or unlinking it) does to a client's Instagram page, as pure
// functions: the optimistic change the reel's right-click menu makes at once, before the server has
// answered (instagram-mutations.ts). The server's own answer replaces it a moment later.
//
// A reel is ours when it is linked to a job, so linking turns its row, its bar in "Plays of every
// reel" and its band in the engagement chart to ours, and the job leaves the Link to job list.
// What the tiles say (the medians of ours and theirs) is the server's to work out again, so they
// stay as they were until it answers.
//
// Each function hands back the same page object when there is nothing to change (the reel is not on
// the page, the job is unknown), so a cache write can skip it.

import type { ClientInstagram } from '@studio/shared';

/** The video a reel is linked to. */
export interface ReelJob {
  id: string;
  name: string;
}

/** The page with one reel's side (ours or theirs) changed everywhere the page draws it. */
function withReelSide(
  data: ClientInstagram,
  shortcode: string,
  job: ReelJob | null,
  linkable: ClientInstagram['linkableJobs'],
): ClientInstagram {
  const { numbers } = data;
  return {
    ...data,
    reels: data.reels.map((reel) => (reel.shortcode === shortcode ? { ...reel, job } : reel)),
    linkableJobs: linkable,
    numbers:
      numbers === null
        ? null
        : {
            ...numbers,
            plays: numbers.plays.map((point) =>
              point.shortcode === shortcode
                ? { ...point, ours: job !== null, job: job === null ? null : job.name }
                : point,
            ),
            engagement: numbers.engagement.map((point) =>
              point.shortcode === shortcode ? { ...point, ours: job !== null } : point,
            ),
          },
  };
}

/**
 * The page with the reel linked to the job. The job's name is `jobName`, or, when it is not given,
 * the one the page lists for it in `linkableJobs`; with neither (or no such reel) there is nothing
 * to show and the page is returned as it was. A reel that is linked already is left alone: the
 * server refuses it, and its answer says why.
 */
export function withReelLinked(
  data: ClientInstagram,
  shortcode: string,
  jobId: string,
  jobName?: string,
): ClientInstagram {
  const reel = data.reels.find((one) => one.shortcode === shortcode);
  if (reel === undefined || reel.job !== null) return data;
  const name = jobName ?? data.linkableJobs.find((one) => one.jobId === jobId)?.name;
  if (name === undefined) return data;
  return withReelSide(
    data,
    shortcode,
    { id: jobId, name },
    data.linkableJobs.filter((one) => one.jobId !== jobId),
  );
}

/**
 * The page with the reel theirs again. The job it was linked to is not put back in `linkableJobs`
 * (the page does not know when it was delivered or whether it was paid); the answer that follows
 * the change lists it.
 */
export function withReelUnlinked(data: ClientInstagram, shortcode: string): ClientInstagram {
  const reel = data.reels.find((one) => one.shortcode === shortcode);
  if (reel === undefined || reel.job === null) return data;
  return withReelSide(data, shortcode, null, data.linkableJobs);
}
