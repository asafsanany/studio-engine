import {
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/react-table';

/**
 * The TanStack Table v9 features the Clients table uses: sorting and paging. The search narrows the
 * clients before they reach the table (`filterClients`), as the Jobs table does for its search.
 * Three fixed columns need no visibility or resizing.
 */
export const clientsTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type ClientsTableFeatures = typeof clientsTableFeatures;
