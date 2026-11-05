import { type ClientRow, relativeTime } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { ClientAvatar } from '@/components/ClientAvatar';
import { useNow } from '@/components/jobs/use-now';
import { EngineReconnecting } from '@/components/shell/EngineReconnecting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { jobsUnreachable, useClients, useEngineReconnecting } from '@/data';
import {
  type ClientSummary,
  clientsBodyState,
  clientsFooterText,
  filterClients,
  jobCountText,
  summarizeClients,
} from '@/features/clients/clients';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { UnreachableJobs } from '@/features/jobs/JobsListStates';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type ClientsUiStore, clientsUiStore } from '@/stores/clients-ui';
import { inSentence } from './phone-clients';

const NO_CLIENTS: readonly ClientRow[] = [];

/** The row's rule, as the boards draw it: a hair of white. */
const RULE = 'border-white/8';

/**
 * The Clients tab on the phone (board MClients): the page `/clients` shows in place of the Mac's
 * table on the phone layout. This is the data around `PhoneClientsView`: the client list the
 * server sent (every client folder of the inbox, with jobs or without), whether the engine is out
 * of reach, and the "Reconnecting…" line.
 */
export function PhoneClientsPage() {
  const { data: clients, isError, failureCount, refetch } = useClients();
  const reconnecting = useEngineReconnecting();
  return (
    <PhoneClientsView
      clients={clients}
      failed={jobsUnreachable({ data: clients, isError, failureCount })}
      onRetry={() => void refetch()}
      reconnecting={reconnecting}
    />
  );
}

export interface PhoneClientsViewProps {
  /** The client list from `useClients()`: `undefined` until the first load. */
  clients: readonly ClientRow[] | undefined;
  /** The first load failed (the engine cannot be reached). Read only while `clients` is `undefined`. */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state. */
  onRetry?: () => void;
  /** The engine has been out of reach for a while: the header says so. */
  reconnecting?: boolean;
  /** The store the search lives in. Tests pass their own; the app uses the Clients page's. */
  store?: StoreApi<ClientsUiStore>;
  /** How long the first load may take before skeleton rows appear (default 250 ms). */
  skeletonDelayMs?: number;
}

/**
 * The page itself. Top to bottom, in a block that stays under the notch while the rows scroll: the
 * header ("Clients" and a 44 px ghost Search button) and, open under it, the search field (40 px,
 * 16 px text). Then 64 px rows, each a link to the client: the avatar, the name, "5 jobs · last job
 * 3 min ago" and a chevron; and the footer, "3 clients" ("2 of 3 clients" while the search leaves
 * some out). The order is the Mac's: newest last job first. The search is the Clients page's own
 * (the store), and closing the field ends it. New client stays on the Mac. The page reaches the
 * screen's edges: the shell pads its page area, so the page takes that padding back.
 */
export function PhoneClientsView({
  clients,
  failed = false,
  onRetry,
  reconnecting = false,
  store = clientsUiStore,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: PhoneClientsViewProps) {
  const search = useStore(store, (state) => state.search);
  const setSearch = useStore(store, (state) => state.setSearch);
  // The field is open when a search is already typed (it is kept while the person is on another page).
  const [searchOpen, setSearchOpen] = useState(search !== '');
  const [focusSearch, setFocusSearch] = useState(false);
  const searchId = useId();

  const all = useMemo(() => summarizeClients(clients ?? NO_CLIENTS), [clients]);
  const shown = useMemo(() => filterClients(all, search), [all, search]);
  const bodyState = clientsBodyState({ clients, failed, matching: shown.length });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);

  return (
    <div
      data-slot="phone-clients-page"
      className="-mx-4 -mt-4 flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <div
        data-slot="phone-clients-top"
        // Stays at the top of the scroller (below the notch, which the shell pads) while the rows scroll.
        className="sticky top-0 z-10 bg-background"
      >
        <header className="flex h-[52px] items-center pr-1.5 pl-4">
          <h1 className="flex-1 text-2xl leading-tight font-semibold tracking-[-0.02em]">
            Clients
          </h1>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Search clients"
            aria-expanded={searchOpen}
            onClick={() => {
              // Closing the field ends the search.
              if (searchOpen) setSearch('');
              setFocusSearch(!searchOpen);
              setSearchOpen(!searchOpen);
            }}
            className={cn('size-11', searchOpen && 'bg-accent dark:bg-accent')}
          >
            <Search className="size-5" aria-hidden="true" />
          </Button>
        </header>

        <EngineReconnecting reconnecting={reconnecting} className="px-4 has-[p]:pb-2" />

        {searchOpen && (
          <div className="px-4 pb-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
              />
              <label htmlFor={searchId} className="sr-only">
                Search clients
              </label>
              <Input
                id={searchId}
                type="search"
                dir="auto"
                autoFocus={focusSearch}
                autoComplete="off"
                placeholder="Search clients"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-10 border-input bg-white/[0.045] pl-9 text-base shadow-none focus-visible:ring-0 dark:bg-white/[0.045]"
              />
            </div>
          </div>
        )}
      </div>

      <div className="pb-3">
        {bodyState === 'loading' && showSkeleton && <PhoneLoadingClientRows />}
        {bodyState === 'unreachable' && <UnreachableJobs onRetry={() => onRetry?.()} />}
        {bodyState === 'empty' && <EmptyClients />}
        {bodyState === 'no-match' && (
          <p className="px-4 py-6 text-muted-foreground">No matching clients.</p>
        )}
        {bodyState === 'rows' && (
          <ul aria-label="Clients" className={cn('flex flex-col border-t', RULE)}>
            {shown.map((client) => (
              <PhoneClientRow key={client.clientId} client={client} />
            ))}
          </ul>
        )}
        {(bodyState === 'rows' || bodyState === 'no-match') && (
          <p className="px-4 py-3 text-[13px] text-muted-foreground tabular-nums">
            {clientsFooterText(shown.length, all.length)}
          </p>
        )}
      </div>
    </div>
  );
}

/** "5 jobs · last job 3 min ago"; a client with no job yet says "0 jobs" and nothing more. */
export function PhoneClientMeta({
  client,
}: {
  client: Pick<ClientSummary, 'jobCount' | 'lastJobAt'>;
}) {
  const now = useNow();
  const last = client.lastJobAt === null ? '' : inSentence(relativeTime(client.lastJobAt, now));
  return (
    <>
      {jobCountText(client.jobCount)}
      {last !== '' && client.lastJobAt !== null && (
        <>
          {' · last job '}
          <time dateTime={client.lastJobAt}>{last}</time>
        </>
      )}
    </>
  );
}

/**
 * One client: the whole row is a link to its page, at least 64 px tall. The avatar (40 px), the
 * name (16 px, 500, one line with an ellipsis; Hebrew reads right to left) over the muted jobs line
 * (13 px), and the chevron.
 */
function PhoneClientRow({ client }: { client: ClientSummary }) {
  return (
    <li data-client-id={client.clientId}>
      <Link
        to="/clients/$clientId"
        params={{ clientId: client.clientId }}
        className={cn(
          'flex min-h-16 items-center gap-3 border-b py-2 pr-3 pl-4 outline-none transition-colors duration-150 ease-in-out focus-visible:bg-muted/50 active:bg-muted/50',
          RULE,
        )}
      >
        <ClientAvatar client={client.name} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <Bidi className="truncate text-base leading-[22px] font-medium">{client.name}</Bidi>
          <span className="truncate text-[13px] text-muted-foreground tabular-nums">
            <PhoneClientMeta client={client} />
          </span>
        </span>
        <ChevronRight className="size-[18px] flex-none text-zinc-500" aria-hidden="true" />
      </Link>
    </li>
  );
}

/** "No clients yet." The inbox holds no client folder. New client is a Mac thing, so it says where. */
function EmptyClients() {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 px-4 text-center">
      <p className="font-medium">No clients yet.</p>
      <p className="text-pretty text-muted-foreground">
        Make a folder for one on your Mac:{' '}
        <code className="font-mono text-[13px] text-foreground">Studio Inbox/&lt;Client&gt;</code>.
      </p>
    </div>
  );
}

/** How many placeholder rows draw while the first answer is on its way. */
export const PHONE_SKELETON_CLIENT_ROWS = 6;

const NAME_BAR = ['w-40', 'w-32', 'w-44', 'w-36'] as const;

/** Placeholder rows, 64 px high on the real rows' grid. Screen readers get one "Loading clients…". */
function PhoneLoadingClientRows() {
  return (
    <ul aria-label="Clients" aria-busy="true" className={cn('flex flex-col border-t', RULE)}>
      {Array.from({ length: PHONE_SKELETON_CLIENT_ROWS }, (_, row) => (
        <li
          // The rows are identical and never reorder, so the index is the right key.
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
          key={row}
          data-skeleton-row=""
          className={cn('flex min-h-16 items-center gap-3 border-b py-2 pr-3 pl-4', RULE)}
        >
          {row === 0 && (
            <span role="status" className="sr-only">
              Loading clients…
            </span>
          )}
          <Skeleton className="size-10 flex-none rounded-full motion-reduce:animate-none" />
          <div className="flex flex-col gap-1.5">
            <Skeleton
              className={cn('h-4 motion-reduce:animate-none', NAME_BAR[row % NAME_BAR.length])}
            />
            <Skeleton className="h-3.5 w-36 motion-reduce:animate-none" />
          </div>
        </li>
      ))}
    </ul>
  );
}
