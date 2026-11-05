import type { Job } from '@studio/shared';
import { Link, useRouter } from '@tanstack/react-router';
import { ChevronLeft, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { ClientAvatar } from '@/components/ClientAvatar';
import { FileText } from '@/components/icons';
import { EngineReconnecting } from '@/components/shell/EngineReconnecting';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  assigneeNames,
  jobsUnreachable,
  useClients,
  useEngineReconnecting,
  useIsAdmin,
  useListedJobs,
  useTeam,
} from '@/data';
import { type ClientSummary, findClient, summarizeClients } from '@/features/clients/clients';
import { NoJobsYet } from '@/features/clients/NoJobsYet';
import { openJobSheet } from '@/features/job-sheet/job-sheet-search';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { NoMatchingJobs, UnreachableJobs } from '@/features/jobs/JobsListStates';
import { RefusedActionsHost } from '@/features/jobs/RefusedActionsHost';
import { lastUpdatedOrder } from '@/features/jobs/sorting';
import { Bidi } from '@/lib/bidi';
import { NoSuchClient } from '@/pages/ClientPage';
import { type JobsUiStore, jobsUiStore } from '@/stores/jobs-ui';
import { PhoneAssignSheet } from './PhoneAssignSheet';
import { PhoneClientMeta } from './PhoneClientsPage';
import { PhoneJobRow } from './PhoneJobRow';
import { PhoneLoadingRows } from './PhoneJobsList';
import {
  clientArchivedButton,
  clientArchivedLead,
  clientArchivedLine,
  clientJobs,
} from './phone-clients';

const NO_JOBS: readonly Job[] = [];

/**
 * A client's page on the phone (board MClient): `/clients/<id>` shows this in place of the Mac's
 * page on the phone layout. The data around `PhoneClientView`: the client list (the client's name,
 * job count and last job), the live job list (`useListedJobs`, which also holds the client's
 * unpaid videos whose folder was deleted), whether the engine is out of reach, and the host that
 * tells a refused action's note as a message (the shell draws the messages). A tap on a row asks
 * for the job's sheet (`?job=`); the phone sheet's host (PH4) opens it.
 */
export function PhoneClientPage({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { data: clients, isError: clientsFailed, failureCount: clientsFailures } = useClients();
  const { data: jobs, isError, failureCount, refetch } = useListedJobs();
  const reconnecting = useEngineReconnecting();
  const admin = useIsAdmin();
  const { data: team } = useTeam();
  const [assigning, setAssigning] = useState(false);
  const client = useMemo(
    () => (clients ? findClient(summarizeClients(clients), clientId) : undefined),
    [clients, clientId],
  );
  return (
    <>
      <PhoneClientView
        clientId={clientId}
        client={client}
        clientsLoaded={clients !== undefined}
        jobs={jobs}
        failed={
          jobsUnreachable({
            data: clients,
            isError: clientsFailed,
            failureCount: clientsFailures,
          }) || jobsUnreachable({ data: jobs, isError, failureCount })
        }
        onRetry={() => void refetch()}
        reconnecting={reconnecting}
        onOpenJob={(jobId) => void openJobSheet(router, jobId)}
        assignment={
          admin && client !== undefined
            ? { names: assigneeNames(team, clientId), onAssign: () => setAssigning(true) }
            : undefined
        }
      />
      {admin && (
        <PhoneAssignSheet
          client={assigning && client !== undefined ? { clientId, name: client.name } : null}
          onClose={() => setAssigning(false)}
        />
      )}
      {/* Only watches: the shell draws the messages, and holds Mark paid's sheet. */}
      <RefusedActionsHost jobs={jobs} toaster={false} />
    </>
  );
}

export interface PhoneClientViewProps {
  clientId: string;
  /** The client, from the client list; `undefined` while the list is on its way or has no such client. */
  client: ClientSummary | undefined;
  /** The client list has arrived (so an unknown `client` is a mistyped address, not a wait). */
  clientsLoaded: boolean;
  /** The job list: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** The first load failed (the engine cannot be reached). */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state. */
  onRetry?: () => void;
  /** The engine has been out of reach for a while: the page says so. */
  reconnecting?: boolean;
  /** A tap on a row. */
  onOpenJob: (jobId: string) => void;
  /**
   * The admin's: who the client is assigned to (`undefined` until the team is known; empty is
   * "Unassigned") and the Assign to… button. Left out for an editor.
   */
  assignment?: { names: readonly string[] | undefined; onAssign: () => void };
  /** The store Show archived lives in (the Mac's Jobs one: the switch is shared). */
  store?: StoreApi<JobsUiStore>;
  /** How long the first load may take before skeleton rows appear (default 250 ms). */
  skeletonDelayMs?: number;
}

/**
 * The page. Top to bottom: the "‹ Clients" link (44 px, back to the list); the client (a 48 px
 * avatar, the name, "5 jobs · last job 3 min ago", and an outlined Style button that opens the
 * client's style); then the client's jobs as the phone list's flat rows, with no client in them,
 * no status tabs and no search; and the line that offers the archived ones ("2 archived · Show",
 * and "Hide archived" while they are shown). Show archived is the Mac's remembered switch.
 *
 * Until the client list arrives the page can't tell a client from a mistyped address, so it shows
 * the header's skeleton (after a moment) or "Can't reach the engine."; then "No such client." for
 * an id the list does not hold. A client with no job at all says "No jobs yet." in place of the
 * rows. The page reaches the screen's edges: the shell pads its page area, so the page takes that
 * padding back.
 */
export function PhoneClientView({
  clientId,
  client,
  clientsLoaded,
  jobs,
  failed = false,
  onRetry,
  reconnecting = false,
  onOpenJob,
  assignment,
  store = jobsUiStore,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: PhoneClientViewProps) {
  const showArchived = useStore(store, (state) => state.showArchived);
  const setShowArchived = useStore(store, (state) => state.setShowArchived);

  const ordered = useMemo(() => lastUpdatedOrder(jobs ?? NO_JOBS), [jobs]);
  const rows = useMemo(
    () => clientJobs(ordered, clientId, showArchived),
    [ordered, clientId, showArchived],
  );
  const archivedLine = useMemo(
    () => clientArchivedLine(ordered, clientId, showArchived),
    [ordered, clientId, showArchived],
  );
  const hasJobs = useMemo(
    () => ordered.some((job) => job.clientId === clientId),
    [ordered, clientId],
  );

  const unreachable = failed && (!clientsLoaded || jobs === undefined);
  const waiting = !unreachable && (!clientsLoaded || (client !== undefined && jobs === undefined));
  const showSkeleton = useDelayedFlag(waiting, skeletonDelayMs);
  const unknown = clientsLoaded && client === undefined;

  return (
    <div
      data-slot="phone-client-page"
      className="-mx-4 -mt-4 flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <div
        // Stays at the top of the scroller (below the notch, which the shell pads) while the jobs scroll.
        className="sticky top-0 z-10 bg-background"
      >
        <div className="flex h-11 items-center px-2">
          <Button
            asChild
            variant="ghost"
            // The ghost button's own padding for a button with an icon (px-3) would win over pl-1 / pr-2.5.
            className="h-11 gap-0.5 pr-2.5 pl-1 text-[15px] font-medium has-[>svg]:pr-2.5 has-[>svg]:pl-1"
          >
            <Link to="/clients">
              <ChevronLeft className="size-5" aria-hidden="true" />
              Clients
            </Link>
          </Button>
        </div>
        <EngineReconnecting reconnecting={reconnecting} className="px-4 has-[p]:pb-2" />
      </div>

      {client !== undefined && (
        <header data-slot="phone-client-header" className="flex items-center gap-3 px-4 pt-1 pb-4">
          <ClientAvatar
            client={client.name}
            size="lg"
            className="data-[size=lg]:size-12 *:text-base!"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Bidi
              as="h1"
              className="truncate text-2xl leading-tight font-semibold tracking-[-0.02em]"
            >
              {client.name}
            </Bidi>
            <p className="text-[13px] text-muted-foreground tabular-nums">
              <PhoneClientMeta client={client} />
            </p>
          </div>
          <Button asChild variant="outline" className="h-10 flex-none gap-2 px-3 text-sm">
            <Link to="/clients/$clientId/style" params={{ clientId }}>
              <FileText aria-hidden="true" />
              Style
            </Link>
          </Button>
        </header>
      )}
      {client !== undefined && assignment !== undefined && (
        <button
          type="button"
          data-slot="phone-client-assign"
          onClick={assignment.onAssign}
          className="flex min-h-12 w-full cursor-pointer items-center gap-3 border-t border-white/8 px-4 text-left text-[15px] transition-colors duration-150 ease-in-out active:bg-white/5"
        >
          <UserPlus aria-hidden="true" className="size-5 flex-none text-muted-foreground" />
          <span className="flex-1 font-medium">Assign to…</span>
          {assignment.names !== undefined && (
            <bdi
              data-slot="phone-client-assigned"
              className="min-w-0 truncate text-[13px] text-muted-foreground"
            >
              {assignment.names.length === 0 ? 'Unassigned' : assignment.names.join(', ')}
            </bdi>
          )}
        </button>
      )}
      {client === undefined && showSkeleton && waiting && <ClientHeaderSkeleton />}

      <div className="border-t border-white/8 pb-3">
        {unreachable && <UnreachableJobs onRetry={() => onRetry?.()} />}
        {unknown && (
          <div className="px-4 pt-4">
            <NoSuchClient />
          </div>
        )}
        {client !== undefined && jobs === undefined && !unreachable && showSkeleton && (
          <PhoneLoadingRows />
        )}
        {client !== undefined && jobs !== undefined && !hasJobs && (
          <div className="px-4 pt-4">
            <NoJobsYet />
          </div>
        )}
        {client !== undefined && jobs !== undefined && hasJobs && rows.length === 0 && (
          <NoMatchingJobs />
        )}
        {rows.length > 0 && (
          <ul aria-label={`Jobs of ${client?.name ?? ''}`} className="flex flex-col pt-1">
            {rows.map((job) => (
              <PhoneJobRow key={job.id} job={job} showClient={false} onOpen={onOpenJob} />
            ))}
          </ul>
        )}
        {archivedLine !== null && (
          <p className="flex min-h-11 items-center px-4 text-[13px] text-muted-foreground">
            {clientArchivedLead(archivedLine)}
            <Button
              type="button"
              variant="link"
              onClick={() => setShowArchived(!archivedLine.shown)}
              className="-ml-1 h-11 px-2 text-[13px] font-medium text-foreground underline underline-offset-3"
            >
              {clientArchivedButton(archivedLine)}
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}

/** The header's place while the client list is on its way: shown only once the wait is noticeable. */
function ClientHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 pt-1 pb-4">
      <Skeleton className="size-12 flex-none rounded-full motion-reduce:animate-none" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-36 motion-reduce:animate-none" />
      </div>
    </div>
  );
}
