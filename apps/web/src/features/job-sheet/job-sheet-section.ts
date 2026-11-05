// A request to open the job sheet at one of its parts: the row menu's "Versions…". The menu only
// asks (`askForVersions`); the sheet's host opens the sheet on that job (it owns the address), and
// the part, once it is on screen for that job, opens itself and scrolls to its place and takes the
// request (`takeSectionRequest`). A request nobody took is dropped after a few seconds, so a job
// whose sheet cannot show the part does not open it the next time the sheet is opened on it.

import { useCallback, useSyncExternalStore } from 'react';

/** The parts of the sheet a row can ask for. */
export type SheetSection = 'versions';

/** A pending request. */
export interface SectionRequest {
  jobId: string;
  section: SheetSection;
  /** When it was made, to let an old one go. */
  at: number;
}

/** How long a request waits for its part to show. */
export const SECTION_REQUEST_TTL_MS = 5_000;

let pending: SectionRequest | null = null;
const listeners = new Set<() => void>();

function set(next: SectionRequest | null): void {
  pending = next;
  for (const listener of [...listeners]) listener();
}

/** Asks for the sheet of this job, opened at its Versions part. */
export function askForVersions(jobId: string, now: number = Date.now()): void {
  set({ jobId, section: 'versions', at: now });
}

/** The request now waiting, or `null`. An old one is not returned. */
export function pendingSectionRequest(now: number = Date.now()): SectionRequest | null {
  return pending !== null && now - pending.at <= SECTION_REQUEST_TTL_MS ? pending : null;
}

/** Takes the request if it is for this job and part: `true` once, then it is gone. */
export function takeSectionRequest(
  jobId: string,
  section: SheetSection,
  now: number = Date.now(),
): boolean {
  const request = pendingSectionRequest(now);
  if (request === null || request.jobId !== jobId || request.section !== section) return false;
  set(null);
  return true;
}

/** Forgets any request (tests). */
export function clearSectionRequest(): void {
  if (pending !== null) set(null);
}

/** The request waiting, re-read when one is made or taken. */
export function useSectionRequest(): SectionRequest | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => pending,
  );
}
