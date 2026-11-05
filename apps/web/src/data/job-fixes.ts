// A job's quick fixes as the page holds them (Quick fixes, QF6): the `['job-fixes', jobId]` query
// (`GET /api/jobs/:id/fixes`: the fixes of the job's next round, oldest first), the `job.fix` event
// that keeps it current, and Undo.
//
// - Nothing is asked while Quick fixes are off (`/api/health`'s `quickFixes`, passed as `enabled`):
//   the hook answers with nothing, and the page shows nothing of fixes, exactly as before.
// - `job.fix` carries the whole fix, so it goes into the cache as it is (no request): it replaces
//   the fix with its id in place or joins the end of the list. A fetch of the list that is in
//   flight may predate the event, so it is made again (job-events.ts). A `hello` invalidates every
//   job's fixes, and a job whose round or state changes (Send and Approve end the round, and the
//   old rows no longer show) is read again, so the list never holds a round that is over.
// - A note's fix is the newest fix with its `noteId`; the server answers oldest first and a new fix
//   joins the end, so the last one of a note wins. The fix runs in the order the notes were added,
//   not the order of the rows, so show a fix under its note, never by its place in the list.
// - `rev` changes whenever a fix lands or is undone (the newest `endedAt` of a fixed or an undone
//   fix): the preview's files change at those moments, so the player loads the cut again (QF7).

import type { Job, JobFixEvent, QuickFix, UndoFixResponse } from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { type Api, ApiError, api } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** Every job-fixes query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_FIXES_KEY = ['job-fixes'] as const;

/** One job's fixes: ['job-fixes', jobId]. */
export function jobFixesKey(jobId: string): readonly ['job-fixes', string] {
  return ['job-fixes', jobId] as const;
}

/**
 * Options of the `['job-fixes', jobId]` query: the fixes of the job's next round, fresh until an
 * event says otherwise (`job.fix` writes them, a `hello` invalidates them). A 4xx (404 for a job
 * that is gone, or Quick fixes that are off) will not change by asking again, so it is not retried.
 */
export function jobFixesQueryOptions(client: Api, jobId: string) {
  return queryOptions<QuickFix[], ApiError>({
    queryKey: jobFixesKey(jobId),
    queryFn: ({ signal }) => client.getJobFixes(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

// --- the rules (no React, no network: tested on plain values) -------------------------------------

/**
 * `fix` replaces the fix with its id, where that stands, or joins the end of the list. A fix of
 * another round (the list was from the round before) clears the old round's fixes out first.
 */
export function upsertFix(list: readonly QuickFix[], fix: QuickFix): QuickFix[] {
  const sameRound = list.filter((existing) => existing.round === fix.round);
  const at = sameRound.findIndex((existing) => existing.id === fix.id);
  if (at === -1) return [...sameRound, fix];
  const next = [...sameRound];
  next[at] = fix;
  return next;
}

/** The newest fix of each note (the last one of its `noteId`), by note id. */
export function newestFixByNote(fixes: readonly QuickFix[]): Map<string, QuickFix> {
  const byNote = new Map<string, QuickFix>();
  for (const fix of fixes) byNote.set(fix.noteId, fix);
  return byNote;
}

/**
 * When the preview last changed because of a fix, in ms since the epoch: the newest `endedAt` among
 * the fixes that are `fixed` or `undone`. `null` when there is none.
 */
export function fixesRev(fixes: readonly QuickFix[]): number | null {
  let rev: number | null = null;
  for (const fix of fixes) {
    if ((fix.status !== 'fixed' && fix.status !== 'undone') || fix.endedAt === null) continue;
    const at = Date.parse(fix.endedAt);
    if (!Number.isNaN(at) && (rev === null || at > rev)) rev = at;
  }
  return rev;
}

// --- the cache ------------------------------------------------------------------------------------

/** Writes a fix into its job's cached list, when there is one (nothing cached: whoever loads it reads the server). */
export function applyFix(queryClient: QueryClient, fix: QuickFix): void {
  const key = jobFixesKey(fix.jobId);
  if (queryClient.getQueryData<QuickFix[]>(key) !== undefined) {
    queryClient.setQueryData<QuickFix[]>(key, (list) => list && upsertFix(list, fix));
  }
}

/**
 * The `job.fix` event: the fix it carries goes into the cache as it is. A fetch of the list that is
 * in flight may predate the event, so it is made again.
 */
export function applyJobFixEvent(queryClient: QueryClient, event: JobFixEvent): void {
  applyFix(queryClient, event.fix);
  const key = jobFixesKey(event.jobId);
  if (queryClient.isFetching({ queryKey: key }) > 0) {
    // A first load in flight is not replaced by an invalidation (only a fetch that already has
    // data is), so it is cancelled first.
    void queryClient
      .cancelQueries({ queryKey: key })
      .then(() => queryClient.invalidateQueries({ queryKey: key }));
  }
}

// --- the hooks ------------------------------------------------------------------------------------

/** What {@link useJobFixes} answers. */
export interface JobFixes {
  /** This round's fixes, oldest first (the order of the rows, not the order they run in). */
  fixes: QuickFix[];
  /** The newest fix of each note, by note id. */
  byNote: ReadonlyMap<string, QuickFix>;
  /** When the preview last changed because of a fix (ms): the newest `endedAt` of a fixed or undone fix; `null` when none. */
  rev: number | null;
  /** The first answer is in (or the server refused to give one): before that `fixes` is empty because nothing is known yet. */
  loaded: boolean;
}

const NONE: JobFixes = { fixes: [], byNote: new Map(), rev: null, loaded: false };

/**
 * A job's quick fixes (`['job-fixes', jobId]`): this round's fixes, the newest fix of each note and
 * `rev`, kept current by the `job.fix` event. `enabled` is the Quick fixes switch (and whatever
 * else says the job's fixes matter, such as being in Review); off, nothing is asked and the answer
 * is empty.
 */
export function useJobFixes(jobId: string, enabled: boolean): JobFixes {
  const query = useQuery({ ...jobFixesQueryOptions(api, jobId), enabled });
  const data = enabled ? query.data : undefined;
  const loaded = enabled && (data !== undefined || query.isError);
  return useMemo(() => {
    if (data === undefined) return loaded ? { ...NONE, loaded } : NONE;
    return { fixes: data, byNote: newestFixByNote(data), rev: fixesRev(data), loaded };
  }, [data, loaded]);
}

/** The toast of a refused Undo; the server's reason goes under it. */
export const UNDO_FIX_FAILED_TEXT = "Couldn't undo the fix";

export interface UndoFixMutationParams {
  queryClient: QueryClient;
  api: Api;
  jobId: string;
  /** `toast.error` of sonner, or a stand-in in tests. */
  notify: (message: string, options: { description: string }) => void;
}

/**
 * The Undo mutation: the variable is the fix's id. The fix, now undone, goes into the list and the
 * job into the jobs cache; the note's change arrives as `note.upsert` before `job.fix`. A refusal
 * (409: it is not the newest fix, or another one is queued or running) says why through `notify`,
 * in the server's own words, and also rejects `mutateAsync`.
 */
export function undoFixMutationOptions({
  queryClient,
  api: client,
  jobId,
  notify,
}: UndoFixMutationParams) {
  return mutationOptions<UndoFixResponse, ApiError, string>({
    mutationKey: ['undo-fix', jobId],
    mutationFn: (fixId) => client.undoFix(jobId, fixId),
    onSuccess({ fix, job }) {
      applyFix(queryClient, fix);
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
    },
    onError(error) {
      notify(UNDO_FIX_FAILED_TEXT, { description: error.message });
    },
  });
}

/** Undo: `undo.mutate(fixId)` takes the newest fixed fix back. A refusal is a toast with the server's reason. */
export function useUndoFix(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(undoFixMutationOptions({ queryClient, api, jobId, notify: toast.error }));
}
