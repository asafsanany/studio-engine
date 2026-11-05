// How the Jobs list and the job sheet know about each other. The list opens a sheet (a click or
// Enter on a row) and marks the row whose sheet is open; the sheet's host closes and walks. The
// address (`?job=`) is what they share: the list pushes it, the host reads it. Nothing else passes
// between them.

import { useRouter } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useJobSheetEnabled } from '@/data';
import { closeJobSheet, moveJobSheet, openJobSheet } from './job-sheet-search';

/** What a row can do with the sheet: open its job's. */
export interface JobSheetOpener {
  open(jobId: string): void;
  close(): void;
}

/** The opener rows use; `null` (nothing provides one) is "rows open nothing": the switch is off. */
export const JobSheetOpenerContext = createContext<JobSheetOpener | null>(null);

/**
 * The opener of a list: `null` while the Job sheet switch is off (rows open nothing and the list
 * behaves as before the sheet) and outside a router (a bare render in a test). A list provides it
 * to its rows with `JobSheetOpenerContext`.
 */
export function useJobSheetOpener(): JobSheetOpener | null {
  const enabled = useJobSheetEnabled();
  const router = useRouter({ warn: false });
  return useMemo(
    () =>
      enabled && router
        ? {
            open(jobId: string) {
              void (openId === null ? openJobSheet(router, jobId) : moveJobSheet(router, jobId));
            },
            close() {
              closeJobSheet(router);
            },
          }
        : null,
    [enabled, router],
  );
}

/** The opener of the list this row is in, or `null`. */
export function useRowSheetOpener(): JobSheetOpener | null {
  return useContext(JobSheetOpenerContext);
}

// The id of the job whose sheet is open, kept apart from the router so a row can read it without
// one (rows are rendered on their own in tests) and without re-reading the address. The host
// writes it; rows read it.
let openId: string | null = null;
const listeners = new Set<() => void>();

/** Told by the host: the sheet of this job is open (`null`: none is). */
export function setOpenJobSheetId(id: string | null): void {
  if (id === openId) return;
  openId = id;
  for (const listener of [...listeners]) listener();
}

/** The id of the job whose sheet is open, or `null`. */
export function useOpenJobSheetId(): string | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => openId,
    () => openId,
  );
}
