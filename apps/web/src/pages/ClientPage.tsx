import type { SeriesSummary } from '@studio/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLayoutEffect, useMemo } from 'react';
import { ClientAvatar } from '@/components/ClientAvatar';
import { FileText } from '@/components/icons';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  jobsUnreachable,
  useClientSeries,
  useClients,
  useIsAdmin,
  useOrphanDeliveries,
  useSeriesEnabled,
} from '@/data';
import { AssignClientDialogHost } from '@/features/clients/assign/AssignClientDialogHost';
import { ClientMoreMenu } from '@/features/clients/ClientMoreMenu';
import {
  type ClientSummary,
  findClient,
  jobCountText,
  summarizeClients,
} from '@/features/clients/clients';
import { DeleteClientDialogHost } from '@/features/clients/DeleteClientDialogHost';
import { type HeaderFacts, headerFacts } from '@/features/clients/instagram/head-view';
import { InstagramDialogHost } from '@/features/clients/instagram/InstagramDialog';
import { InstagramHeaderFacts } from '@/features/clients/instagram/InstagramHeaderFacts';
import { InstagramSection } from '@/features/clients/instagram/InstagramSection';
import {
  showsInstagram,
  useInstagramSection,
} from '@/features/clients/instagram/use-instagram-section';
import { NoJobsYet } from '@/features/clients/NoJobsYet';
import { RenameClientDialogHost } from '@/features/clients/RenameClientDialogHost';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { JobsListSection } from '@/features/jobs/JobsListSection';
import { SECTION_HEADING_CLASS, SeriesList } from '@/features/series/SeriesList';
import { seriesCountText } from '@/features/series/series-text';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { jobsUiStore } from '@/stores/jobs-ui';
import { PAGE_LINK_CLASS } from './NotFoundPage';

const NO_SERIES: readonly SeriesSummary[] = [];

/**
 * The client's name and "3 jobs · last job 12 min ago" ("0 jobs" for a client with none), beside
 * the avatar, and the Style button on the right: it opens the client's Style page. After it the ⋯
 * (`ClientMoreMenu`): the client's row menu of the Clients list. A client that has series says so
 * after the jobs: "6 jobs · 2 series · last job 1 min ago".
 *
 * A client with an Instagram account (and the switch on) has the handle as a link to it and the
 * followers before the jobs, and the bio in a line under: "@falcon.fpv · 12,480 followers · 6 jobs ·
 * last job 2 d ago"; its Instagram picture is drawn at 56 px. Without one the header is as it was.
 */
function ClientHeader({
  client,
  seriesCount,
  instagram,
}: {
  client: ClientSummary;
  seriesCount: number;
  instagram: HeaderFacts | null;
}) {
  return (
    // The name's side takes the room the buttons leave (`flex-1`), so a long bio is cut instead of
    // pushing Style and the ⋯ under the name.
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ClientAvatar
          client={client.name}
          size="lg"
          // The board's 56 px circle for the Instagram picture (the initials are that size too
          // while it loads); a client without one keeps the 40 px initials.
          photoClassName="data-[size=lg]:size-14 *:text-base!"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <Bidi as="h1" className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            {client.name}
          </Bidi>
          <p className="text-muted-foreground">
            {instagram !== null && <InstagramHeaderFacts facts={instagram} />}
            {jobCountText(client.jobCount)}
            {seriesCount > 0 && ` · ${seriesCountText(seriesCount)}`}
            {client.lastJobAt !== null && (
              <>
                {' '}
                · last job <RelativeTime iso={client.lastJobAt} />
              </>
            )}
          </p>
          {instagram?.bio != null && (
            // `dir="auto"` (Bidi) gives a Hebrew bio its right-to-left reading order; `text-start`
            // lets it sit at the start of that direction, not flush left as `.bidi` does for names.
            // One line, cut at its end; the whole bio is in the tooltip.
            <Bidi
              as="p"
              title={instagram.bio}
              className="truncate text-start text-[13px] text-muted-foreground"
            >
              {instagram.bio}
            </Bidi>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" asChild>
          <Link to="/clients/$clientId/style" params={{ clientId: client.clientId }}>
            <FileText aria-hidden="true" />
            Style
          </Link>
        </Button>
        <ClientMoreMenu client={client} />
      </div>
    </div>
  );
}

/** The header's place while the client list is on its way: shown only once the wait is noticeable. */
function ClientHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-10 rounded-full motion-reduce:animate-none" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-36 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** An id the client list does not hold: a mistyped address, or a client whose folder is gone. */
export function NoSuchClient() {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-md border text-center">
      <p className="font-medium">No such client.</p>
      <Link to="/clients" className={PAGE_LINK_CLASS}>
        Back to Clients
      </Link>
    </div>
  );
}

/**
 * A client's page: who it is (avatar, name, how many jobs and when the last arrived), then the
 * Jobs list with only this client's jobs. The list is the Jobs page's own (rows, row actions,
 * right-click menu, note dialog, paging), without the client's name in each row; there are no
 * status tabs or search. A client with no job yet has "No jobs yet." in place of the list.
 *
 * A client that has series (and only while series are on) shows them first, as a quiet "Series"
 * list whose rows open the series page, and puts a "Jobs" heading over the list. A client with
 * none, or with series off, has neither heading: the page is as it was.
 *
 * While Clients × Instagram is on the page shows an Instagram section under the header: for a client
 * with an account the scan, the range, four tiles and two charts; for one without, "Add their
 * Instagram", which opens the Instagram… dialog. The section puts the "Jobs" heading over the list
 * too. With the switch off nothing of it shows.
 *
 * The client comes from the client list, as on the Clients page. Until the list has loaded the
 * page cannot tell a client from a mistyped address, so it shows the jobs list's own loading and
 * "Can't reach the engine." states and nothing else.
 *
 * A delivered video of the client whose folder was deleted is still payable and is a row of the
 * list (CVP-204), so a client whose only videos are such ones shows the list, not "No jobs yet."
 * (its job count, which counts folders, says 0).
 */
export function ClientPage({ clientId }: { clientId: string }) {
  const { data: rows, isError, failureCount } = useClients();
  const { data: withoutFolder } = useOrphanDeliveries();
  const owedWithoutFolder =
    withoutFolder?.some((video) => video.clientId === clientId && video.delivery.paidOn == null) ??
    false;
  const client = useMemo(
    () => (rows ? findClient(summarizeClients(rows), clientId) : undefined),
    [rows, clientId],
  );
  const unreachable = jobsUnreachable({ data: rows, isError, failureCount });
  // Nothing is asked while series are off, and nothing cached is drawn either.
  const seriesOn = useSeriesEnabled();
  const { data: clientSeries } = useClientSeries(clientId);
  const series = seriesOn && clientSeries !== undefined ? clientSeries : NO_SERIES;
  // Nothing is asked while Clients × Instagram is off, and nothing cached is drawn either.
  const instagram = useInstagramSection(clientId);
  const hasInstagram = showsInstagram(instagram.data);
  const showSkeleton = useDelayedFlag(rows === undefined && !unreachable, SKELETON_DELAY_MS);
  const admin = useIsAdmin();
  const navigate = useNavigate();

  // The list's page number is shared with the Jobs page: a client's page starts on its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `clientId` is the trigger, not something the effect reads
  useLayoutEffect(() => {
    jobsUiStore.getState().setPageIndex(0);
  }, [clientId]);

  if (rows !== undefined && client === undefined) return <NoSuchClient />;

  const hasSeries = series.length > 0;
  // A list above the jobs (series, Instagram) gives the jobs a heading and the page a little more air.
  const hasSections = hasSeries || hasInstagram;
  const noJobs = client?.jobCount === 0 && !owedWithoutFolder;
  return (
    <TooltipProvider>
      <div className={cn('flex flex-col', hasSections ? 'gap-7' : 'gap-6')}>
        {client ? (
          <ClientHeader
            client={client}
            seriesCount={series.length}
            instagram={headerFacts(instagram.data)}
          />
        ) : (
          showSkeleton && <ClientHeaderSkeleton />
        )}
        {client && <InstagramSection clientId={clientId} state={instagram} />}
        {client && instagram.on && <InstagramDialogHost />}
        {/* The dialogs of the ⋯ menu's Assign to…, Rename… and Delete… (the admin's). A renamed
            client has a new id, so its page moves there; a deleted one goes back to the list. */}
        {client && admin && <AssignClientDialogHost />}
        {client && admin && (
          <RenameClientDialogHost
            afterRename={(renamed) =>
              void navigate({
                to: '/clients/$clientId',
                params: { clientId: renamed.clientId },
                replace: true,
              })
            }
          />
        )}
        {client && admin && (
          <DeleteClientDialogHost afterDelete={() => navigate({ to: '/clients' })} />
        )}
        {hasSeries && <SeriesList clientId={clientId} series={series} />}
        {noJobs ? (
          <>
            <NoJobsYet />
            {/* The jobs list draws the page's messages; without it the dialogs here need their own. */}
            {(admin || instagram.on) && <Toaster />}
          </>
        ) : hasSections ? (
          <section aria-labelledby="client-jobs" className="flex flex-col gap-2">
            <h2 id="client-jobs" className={SECTION_HEADING_CLASS}>
              Jobs
            </h2>
            <div className="flex flex-col gap-4">
              <JobsListSection clientId={clientId} />
            </div>
          </section>
        ) : (
          <div className="flex flex-col gap-4">
            <JobsListSection clientId={clientId} />
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
