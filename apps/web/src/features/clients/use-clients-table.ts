import type { ClientRow } from '@studio/shared';
import { functionalUpdate, type PaginationState, useTable } from '@tanstack/react-table';
import { useEffect, useMemo } from 'react';
import { type StoreApi, useStore } from 'zustand';
import type { ClientsUiStore } from '@/stores/clients-ui';
import { lastPageIndex } from '../jobs/pagination';
import {
  type AssignedLookup,
  type ClientSummary,
  filterClients,
  summarizeClients,
} from './clients';
import { clientColumns } from './columns';
import { clientsTableFeatures } from './table-features';

/** Clients per page: pagination shows from the 26th client on. */
export const CLIENTS_PAGE_SIZE = 25;

const NO_CLIENTS: readonly ClientRow[] = [];

/**
 * The Clients table: TanStack Table v9 controlled entirely by the Clients UI store (`sorting` and
 * `pageIndex`), over the client list the server sent and narrowed by the store's search.
 * The page index is kept inside the last page, so a client going away on page 2 shows page 1.
 */
export function useClientsTable({
  clients: rows,
  store,
  assignedTo,
  instagram = false,
}: {
  /** The client list from the data layer; `undefined` until the first load. */
  clients: readonly ClientRow[] | undefined;
  store: StoreApi<ClientsUiStore>;
  /**
   * The admin's "Assigned to" column: who each client is assigned to. Given (even before the team
   * is known) the column shows; left out (an editor) there is no such column.
   */
  assignedTo?: AssignedLookup;
  /**
   * The Instagram view (Clients × Instagram is on, board CLList L1): Followers, This week and Ours
   * vs theirs take the place of Jobs and Last job, and the clients with no readable account start
   * under the others.
   */
  instagram?: boolean;
}) {
  const search = useStore(store, (s) => s.search);
  const sorting = useStore(store, (s) => s.sorting);
  const storedPageIndex = useStore(store, (s) => s.pageIndex);
  const setSorting = useStore(store, (s) => s.setSorting);
  const setPageIndex = useStore(store, (s) => s.setPageIndex);

  const clients = useMemo(
    () => summarizeClients(rows ?? NO_CLIENTS, assignedTo, { accountsFirst: instagram }),
    [rows, assignedTo, instagram],
  );
  const withAssigned = assignedTo !== undefined;
  const columns = useMemo(() => clientColumns(withAssigned, instagram), [withAssigned, instagram]);
  const data = useMemo<ClientSummary[]>(() => filterClients(clients, search), [clients, search]);

  const lastPage = lastPageIndex(CLIENTS_PAGE_SIZE, data.length);
  const pageIndex = Math.min(storedPageIndex, lastPage);
  useEffect(() => {
    if (pageIndex !== storedPageIndex) setPageIndex(pageIndex);
  }, [pageIndex, storedPageIndex, setPageIndex]);
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex, pageSize: CLIENTS_PAGE_SIZE }),
    [pageIndex],
  );

  const table = useTable({
    features: clientsTableFeatures,
    columns,
    data,
    getRowId: (client) => client.clientId,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: (updater) =>
      setPageIndex(
        (previous) =>
          functionalUpdate(updater, { pageIndex: previous, pageSize: CLIENTS_PAGE_SIZE }).pageIndex,
      ),
    // Every column starts in its natural direction and the click flips it; nothing is "unsorted".
    enableSortingRemoval: false,
    enableMultiSort: false,
    // The store resets the page when the search or sorting changes. Live updates must not send
    // the user back to page 1.
    autoResetPageIndex: false,
  });

  return {
    table,
    /** Every client, whatever the search says. */
    clientCount: clients.length,
    /** Clients after the search, before paging. */
    total: data.length,
    pageCount: lastPage + 1,
    pageIndex,
    setPageIndex,
  };
}
