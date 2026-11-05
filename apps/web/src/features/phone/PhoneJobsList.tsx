import type { Job } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ClientAvatar } from '@/components/ClientAvatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { PhoneJobRow } from './PhoneJobRow';
import { type ClientGroup, groupByClient, treeFlags } from './phone-jobs';

/**
 * The rows of the phone jobs list: every job under the tab and the search, with no pager (a
 * phone scrolls). Flat, each row names its client; By client, the jobs sit one step in under their
 * client's header, the clients in order of their latest activity (`groupByClient`).
 */
export function PhoneJobsList({
  jobs,
  byClient,
  onOpen,
}: {
  /** The jobs to show, last updated first. */
  jobs: readonly Job[];
  byClient: boolean;
  onOpen: (jobId: string) => void;
}) {
  if (!byClient) {
    return (
      <ul aria-label="Jobs" className="flex flex-col">
        {jobs.map((job) => (
          <PhoneJobRow key={job.id} job={job} onOpen={onOpen} />
        ))}
      </ul>
    );
  }
  return (
    <>
      {groupByClient(jobs).map((group, index) => (
        <PhoneClientGroup key={group.clientId} group={group} first={index === 0} onOpen={onOpen} />
      ))}
    </>
  );
}

/**
 * One client in the By client view (board MJobs): a 40 px header with the client's avatar (24 px),
 * its name, a link to the client's page, and how many jobs are shown under it; then its rows, one
 * step in. The tree runs from the header's avatar down the left (a 1 px line at x = 27.5 px) and
 * into each row with an elbow (`PhoneJobRow`); the last row ends the line at its elbow.
 */
function PhoneClientGroup({
  group,
  first,
  onOpen,
}: {
  group: ClientGroup;
  first: boolean;
  onOpen: (jobId: string) => void;
}) {
  return (
    <section aria-label={group.client} className={cn(!first && 'mt-3')}>
      <div className="relative flex min-h-10 items-center gap-2.5 px-4">
        <span
          aria-hidden="true"
          className="absolute top-[34px] bottom-0 left-[27.5px] border-l border-[#3F3F46]"
        />
        <ClientAvatar client={group.client} size="sm" />
        {/* The name and the count run on as text in a box that takes the room left of the avatar. A
            box sized to the name itself (an inline-flex link) came out a hair narrower than a short
            Hebrew name in Safari and split it in two ("אוסנ" / "ת"). The link's padding keeps its
            tap target 40 px high. */}
        <div className="min-w-0 flex-1 break-words">
          <Link
            to="/clients/$clientId"
            params={{ clientId: group.clientId }}
            className="py-3 font-semibold outline-none hover:underline focus-visible:underline"
          >
            <bdi>{group.client}</bdi>
          </Link>
          <span className="ml-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
            {group.jobs.length}
          </span>
        </div>
      </div>
      <ul aria-label={`Jobs of ${group.client}`} className="flex flex-col">
        {group.jobs.map((job, index) => (
          <PhoneJobRow
            key={job.id}
            job={job}
            tree={treeFlags(index, group.jobs.length)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

/** Rows of skeleton while the first answer is on its way: the shape of a row, on the same grid. */
export const PHONE_SKELETON_ROWS = 8;

/** The widths of the placeholder names, varied row by row so the block does not look stamped. */
const NAME_BAR = ['w-40', 'w-32', 'w-44', 'w-36'] as const;

/** Eight placeholder rows, 58 px high. Screen readers get one "Loading jobs…". */
export function PhoneLoadingRows() {
  return (
    <ul aria-label="Jobs" aria-busy="true" className="flex flex-col">
      {Array.from({ length: PHONE_SKELETON_ROWS }, (_, row) => (
        <li
          // The rows are identical and never reorder, so the index is the right key.
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
          key={row}
          data-skeleton-row=""
          className="grid min-h-[58px] grid-cols-[24px_minmax(0,1fr)_44px] items-center gap-2.5 py-1.5 pr-1.5 pl-4"
        >
          {row === 0 && (
            <span role="status" className="sr-only">
              Loading jobs…
            </span>
          )}
          <Skeleton className="mx-auto size-4 rounded-full motion-reduce:animate-none" />
          <div className="flex flex-col gap-1.5">
            <Skeleton
              className={cn('h-4 motion-reduce:animate-none', NAME_BAR[row % NAME_BAR.length])}
            />
            <Skeleton className="h-3.5 w-48 motion-reduce:animate-none" />
          </div>
          <span />
        </li>
      ))}
    </ul>
  );
}
