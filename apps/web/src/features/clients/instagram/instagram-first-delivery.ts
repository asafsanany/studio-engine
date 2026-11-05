// The day a client's first video was delivered, for the Instagram dialog's line under "Working
// together since" ("The first delivery is 12 Oct"): the earliest `deliveredAt` among the client's
// jobs, as a calendar day in the viewer's zone.

import type { Job } from '@studio/shared';
import { localDay, type TextOptions } from './instagram-text';

/**
 * The calendar day (YYYY-MM-DD) of the client's earliest delivery in `jobs`, or `null` when the
 * client has none or the job list is not known yet.
 */
export function firstDeliveryDay(
  jobs: readonly Pick<Job, 'clientId' | 'delivery'>[] | undefined,
  clientId: string,
  options: TextOptions = {},
): string | null {
  let first: number | null = null;
  for (const job of jobs ?? []) {
    if (job.clientId !== clientId || job.delivery === null) continue;
    const at = Date.parse(job.delivery.deliveredAt);
    if (Number.isFinite(at) && (first === null || at < first)) first = at;
  }
  if (first === null) return null;
  const day = localDay(new Date(first).toISOString(), options);
  return day === '' ? null : day;
}
