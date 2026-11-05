import type { Job } from '@studio/shared';
import { type QueryClient, MutationObserver as QueryMutationObserver } from '@tanstack/react-query';
import type { Api } from '@/data/api';
import { archiveJobsMutationOptions, unarchiveJobsMutationOptions } from '@/data/archive-jobs';
import {
  announceArchived,
  announceArchivedPaid,
  announceArchiveUndoRefused,
  announceLeftArchive,
  announceUnarchived,
} from './archive-toasts';

/** What the messages' Undo needs: the routes, and the jobs cache to put their answers in. */
export interface ArchiveChangeDeps {
  api: Api;
  queryClient: QueryClient;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Undo: runs the opposite mutation (the same options the row uses, so the answer goes into the
 * jobs cache and the list is reloaded as for any archive change). It runs it on an observer of its
 * own instead of a row's mutation hook: the message outlives its row (archiving moves the row off
 * the list), and an answer nobody is left to show would be lost. A refusal (409: the job started
 * editing meanwhile) or an unreachable server is told as a message of its own.
 */
async function undoWith(
  deps: ArchiveChangeDeps,
  opposite: 'archive' | 'unarchive',
  jobs: readonly Pick<Job, 'id' | 'name'>[],
): Promise<void> {
  const options =
    opposite === 'archive' ? archiveJobsMutationOptions(deps) : unarchiveJobsMutationOptions(deps);
  try {
    await new QueryMutationObserver(deps.queryClient, options).mutate(jobs.map((job) => job.id));
  } catch (error) {
    announceArchiveUndoRefused(jobs, messageOf(error));
  }
}

/**
 * Archive went through: `Archived “<name>” · it still counts on Money`. Its Undo is Unarchive.
 * `archived` is the job as the server answered.
 */
export function afterArchived(deps: ArchiveChangeDeps, archived: Job): void {
  announceArchived(archived, () => {
    void undoWith(deps, 'unarchive', [archived]);
  });
}

/**
 * Archive all paid went through: `Archived 3 paid videos · they still count on Money`. Its Undo
 * unarchives exactly those videos. `archived` is the jobs as the server answered.
 */
export function afterArchivedAllPaid(deps: ArchiveChangeDeps, archived: readonly Job[]): void {
  announceArchivedPaid(archived.length, () => {
    void undoWith(deps, 'unarchive', archived);
  });
}

/**
 * Unarchive went through: `Back in Paid: “<name>”`. Its Undo is Archive again. `unarchived` is the
 * job as the server answered.
 */
export function afterUnarchived(deps: ArchiveChangeDeps, unarchived: Job): void {
  announceUnarchived(unarchived, () => {
    void undoWith(deps, 'archive', [unarchived]);
  });
}

/**
 * Retry, Resume or Release on an archived job went through: it is in the archive no more
 * (the server took it out). Told as `Left the archive: “<name>” is queued again`, with no Undo.
 * `job` is the job as the server answered.
 */
export function afterLeftArchive(job: Job): void {
  announceLeftArchive(job);
}
