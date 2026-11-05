// What each push says and where it opens (board MPings). Only a job's name, its client and what
// happened: nothing else about the job leaves the Mac.

import {
  generatePing,
  groupOf,
  isArchived,
  type Job,
  PUSH_URLS,
  type PushNotifyKey,
  type PushPayload,
  STEP_LABELS,
} from '@studio/shared';

/** The `tag` of the pings that are about the queue and not about a job. */
export const QUEUE_EMPTY_TAG = 'queue-empty';

/** A usage limit is a failure (pipeline/failure.ts) whose message starts like this. */
const USAGE_LIMIT_FAILURE = /^Claude usage limit reached/i;

/** Whether a failed job stopped on the Claude usage limit, which clears by itself once it resets. */
export function isUsageLimitFailure(job: Pick<Job, 'error'>): boolean {
  return job.error !== null && USAGE_LIMIT_FAILURE.test(job.error);
}

/** "<job> · <client>". */
function nameAndClient(job: Pick<Job, 'name' | 'client'>): string {
  return `${job.name} · ${job.client}`;
}

/** The ping for `kind` about `job` (the queue's ping needs no job), without the badge. */
export function pingFor(kind: PushNotifyKey, job: Job | null): Omit<PushPayload, 'badge'> {
  switch (kind) {
    case 'queueEmpty':
      return {
        title: 'Queue is empty',
        body: 'Everything you dropped in is done.',
        url: PUSH_URLS.jobs,
        tag: QUEUE_EMPTY_TAG,
      };
    case 'review':
      return job === null
        ? never(kind)
        : {
            title: 'Ready to review',
            body: nameAndClient(job),
            url: PUSH_URLS.review(job.id),
            tag: job.id,
          };
    case 'approved':
      return job === null
        ? never(kind)
        : {
            title: 'Approved · ready to send',
            body: nameAndClient(job),
            url: PUSH_URLS.sheet(job.id),
            tag: job.id,
          };
    case 'failed': {
      if (job === null) return never(kind);
      // Generated videos (GN9, board GNPhone): a job that stopped in Generate says what to do.
      const generate = generatePing(job);
      if (generate !== null) {
        return { ...generate, url: PUSH_URLS.sheet(job.id), tag: job.id };
      }
      // A usage limit says so in the title (board MPings), whatever step it hit.
      const usageLimit = isUsageLimitFailure(job);
      return {
        title: usageLimit
          ? 'Failed · Claude usage limit'
          : job.failedAt === null
            ? 'Failed'
            : `Failed at ${STEP_LABELS[job.failedAt]}`,
        body: usageLimit ? `${nameAndClient(job)} · retry once it resets` : nameAndClient(job),
        url: PUSH_URLS.sheet(job.id),
        tag: job.id,
      };
    }
  }
}

function never(kind: PushNotifyKey): never {
  throw new Error(`The ${kind} ping is about a job.`);
}

/**
 * The count on the app icon: the jobs in Review plus the ones that need attention (held, failed,
 * cancelled), archived ones left out. The same count as the Mac's header summary.
 */
export function badgeCount(jobs: Iterable<Pick<Job, 'state' | 'delivery' | 'archivedAt'>>): number {
  let count = 0;
  for (const job of jobs) {
    if (isArchived(job)) continue;
    if (job.state === 'review' || groupOf(job) === 'attention') count += 1;
  }
  return count;
}
