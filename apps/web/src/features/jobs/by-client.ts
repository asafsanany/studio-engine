import type { Job } from '@studio/shared';
import { toMs } from './sorting';

// The By client view of the jobs list, on the Mac and on the phone: which jobs sit under which
// client, in what order, and where the tree lines run. The two layouts draw it differently; the
// rules are these.

/** One client's jobs under its name in the By client view. */
export interface ClientGroup {
  clientId: string;
  /** The client's name, as the jobs carry it. */
  client: string;
  /** The client's jobs, in the order they were given. */
  jobs: readonly Job[];
}

/**
 * The jobs cut into one group per client, the clients in order of their latest activity, newest
 * first (the latest `updatedAt` among the client's jobs that are given, so a tab or a search that
 * leaves a client one old job puts it by that job). Clients whose latest jobs were updated at the
 * same moment keep the order in which they first appear. Inside a group the jobs keep the order
 * they came in; the list passes them last updated first.
 */
export function groupByClient(jobs: readonly Job[]): ClientGroup[] {
  const groups = new Map<string, { group: ClientGroup & { jobs: Job[] }; latest: number }>();
  for (const job of jobs) {
    let entry = groups.get(job.clientId);
    if (entry === undefined) {
      entry = { group: { clientId: job.clientId, client: job.client, jobs: [] }, latest: 0 };
      groups.set(job.clientId, entry);
    }
    entry.group.jobs.push(job);
    entry.latest = Math.max(entry.latest, toMs(job.updatedAt));
  }
  // Array.prototype.sort is stable, so equal activity keeps the first-seen order of the map.
  return [...groups.values()].sort((a, b) => b.latest - a.latest).map((entry) => entry.group);
}

/** The jobs in the order the By client view shows them: client by client, top to bottom. */
export function byClientOrder(jobs: readonly Job[]): Job[] {
  return groupByClient(jobs).flatMap((group) => group.jobs);
}

/** Where a row sits in its client's tree. A client's only job is both `first` and `last`. */
export interface TreeFlags {
  first: boolean;
  middle: boolean;
  last: boolean;
}

/**
 * The flags of the job at `index` among `count`. Every row draws an elbow into its middle; the
 * line carries on below the elbow unless the row is the `last`, which ends the tree at its elbow.
 */
export function treeFlags(index: number, count: number): TreeFlags {
  const first = index === 0;
  const last = index === count - 1;
  return { first, last, middle: !first && !last };
}

/** Whether the tree line goes on below a row's elbow, to the next row. */
export function treeContinues(flags: TreeFlags): boolean {
  return !flags.last;
}

/** The flags as one word, for the row's `data-tree` and for tests: `only` is first and last. */
export function treePosition(flags: TreeFlags): 'only' | 'first' | 'middle' | 'last' {
  if (flags.first && flags.last) return 'only';
  if (flags.first) return 'first';
  return flags.last ? 'last' : 'middle';
}
