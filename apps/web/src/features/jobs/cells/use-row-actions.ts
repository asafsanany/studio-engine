import { type Effort, isArchived, type Job } from '@studio/shared';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { toast } from 'sonner';
import {
  api,
  useArchiveJobs,
  useDeliverJob,
  useJobAction,
  useSaveEffort,
  useSetReviewEffort,
  useUnarchiveJobs,
  useUndeliverJob,
  useUndoPaid,
} from '@/data';
import { ARCHIVE_JOBS_MUTATION_KEY, UNARCHIVE_JOBS_MUTATION_KEY } from '@/data/archive-jobs';
import { JOB_ACTION_MUTATION_KEY } from '@/data/job-action';
import {
  afterArchived,
  afterArchivedAllPaid,
  afterLeftArchive,
  afterUnarchived,
} from '../archive-changes';
import { askToCancel } from '../cancel-dialog';
import { afterDelivered, afterUndelivered, afterUnpaid } from '../delivery-changes';
import { announceApproved, announceUnapproved } from '../delivery-toasts';
import type { MutationRowAction, StageRowAction } from './row-actions';

/** What a row can run itself: a job action, or a change of the job's stage. */
export type RunnableRowAction = MutationRowAction | StageRowAction;

/**
 * What a row can do, shared by the row's two places that do it: the button in its Action cell and
 * its right-click menu. One hook per row (`useRowActions`, called by `JobRow`), so a request sent
 * from the menu disables the button, and a refusal is explained under the button whichever of the
 * two sent it.
 *
 * The job sheet calls the hook for its job too. `busy` is shared between the two (it reads the
 * mutation cache for the job's id), so a press in the sheet also disables the row's button, and the
 * other way round. A refusal is not shared: it stays with the hook that sent the request, so it is
 * shown where the press happened.
 */
export interface RowActions {
  /**
   * Do a server action on the row's job. Cancel does not act at once: it asks for the "Stop this
   * edit?" dialog (`askToCancel`), whose question and request belong to the page
   * (`CancelDialogHost`), because the row can move to another page while the dialog is open. A
   * stage change (Mark delivered, Not delivered yet, Not paid yet) is told in a message with Undo
   * once the server has done it.
   */
  run: (action: RunnableRowAction) => void;
  /**
   * Sets the effort level of the row's job (`null` is Default). A refusal (the job started editing
   * in the meantime) is a toast with the server's explanation.
   */
  setEffort: (effort: Effort | null) => void;
  /**
   * Sets the effort of the row's job's review rounds (Quick fixes; `null` is Auto). The menu shows
   * the choice at once; a refusal (the job left Review) puts it back, with a toast that says why.
   */
  setReviewEffort: (effort: Effort | null) => void;
  /**
   * Archives the row's job. Like a stage change it waits for the server, then says
   * `Archived “<name>” · it still counts on Money`, with Undo (Unarchive). A refusal (409: the job
   * started editing meanwhile) is explained under the button.
   */
  archive: () => void;
  /** Takes the row's job out of the archive: `Back in Paid: “<name>”`, with Undo (Archive). */
  unarchive: () => void;
  /**
   * Archives these jobs (Archive all paid: the paid jobs that are not archived, the row's among
   * them): `Archived 3 paid videos · they still count on Money`, with Undo for exactly these.
   */
  archiveAllPaid: (ids: readonly string[]) => void;
  /**
   * A request for this row's job is on its way, from this hook or from any other one for the same
   * job (the row and its sheet): the other actions wait for the answer.
   */
  busy: boolean;
  /** Why the server refused the last request (409, server unreachable), or `null`. */
  refusal: string | null;
  /** Clears the refusal (Escape, a click anywhere, the timeout, or a new request). */
  dismissRefusal: () => void;
}

/** A refusal stays on the mutation, where the row (or, once it has left, the page) tells it. */
const refusedElsewhere = () => {};

/**
 * The actions that take an archived job out of the archive on their own (the server clears
 * `archivedAt` when a job is saved into arriving, queued or editing): Retry, Resume and Release.
 * The others cannot reach an archived job: it is never arriving, queued or editing.
 */
const LEAVES_ARCHIVE: ReadonlySet<string> = new Set(['retry', 'resume', 'release']);

/**
 * Whether `mutation` is a request about the job `id`, the kind that makes its buttons wait: a job
 * action (start, hold, release, cancel, resume, retry, send notes, approve, unapprove) or a stage change
 * (Mark delivered, Not delivered yet, Not paid yet), which all carry the job's id as their
 * variable under the `job-action` key; or an archive or unarchive, whose variable is the list of
 * ids it covers (Archive all paid covers several jobs, each of which waits). The effort and Mark
 * paid are not among them: neither ever disabled a row's buttons.
 */
export function isRequestForJob(
  mutation: {
    options: { mutationKey?: readonly unknown[] };
    state: { variables?: unknown };
  },
  id: string,
): boolean {
  const scope = mutation.options.mutationKey?.[0];
  const { variables } = mutation.state;
  if (scope === JOB_ACTION_MUTATION_KEY) return variables === id;
  if (scope === ARCHIVE_JOBS_MUTATION_KEY || scope === UNARCHIVE_JOBS_MUTATION_KEY) {
    return Array.isArray(variables) && variables.includes(id);
  }
  return false;
}

/**
 * The row's mutations. `useJobAction` moves the job to its next state at once and puts it back if
 * the server refuses; the refusal stays on the mutation, so it has to live as long as the row does
 * (not as long as the button or the menu item that sent it).
 *
 * A stage change waits for the server (no optimistic update). Its message is told from the promise
 * of the request, not from a callback given to `mutate`: the row can leave the page when the job
 * moves to another tab, and such a callback goes with the row. The job passed in is the one the
 * person acted on: Not delivered yet and Not paid yet need what it had (the price and month taken
 * off, the day it was paid) for their message and their Undo.
 */
export function useRowActions(job: Job): RowActions {
  const queryClient = useQueryClient();
  const mutations = {
    start: useJobAction('start'),
    hold: useJobAction('hold'),
    release: useJobAction('release'),
    resume: useJobAction('resume'),
    retry: useJobAction('retry'),
    approve: useJobAction('approve'),
    unapprove: useJobAction('unapprove'),
    deliver: useDeliverJob(),
    undeliver: useUndeliverJob(),
    unpay: useUndoPaid(),
    archive: useArchiveJobs(),
    unarchive: useUnarchiveJobs(),
  };
  const saveEffort = useSaveEffort();
  const setReviewEffort = useSetReviewEffort(job.id);
  const all = Object.values(mutations);
  // Read from the mutation cache, not from this hook's own mutations: the row and the job's sheet
  // each call this hook, and a request sent through one has to hold back the other's buttons too.
  const busy = useIsMutating({ predicate: (mutation) => isRequestForJob(mutation, job.id) }) > 0;
  const refused = all.find((mutation) => mutation.error !== null);

  function dismissRefusal() {
    for (const mutation of all) if (mutation.error !== null) mutation.reset();
  }

  function runStageChange(kind: StageRowAction['kind']) {
    const deps = { api, queryClient };
    switch (kind) {
      case 'deliver':
        mutations.deliver
          .mutateAsync(job.id)
          .then((delivered) => afterDelivered(deps, delivered), refusedElsewhere);
        break;
      case 'undeliver':
        mutations.undeliver
          .mutateAsync(job.id)
          .then(() => afterUndelivered(deps, job), refusedElsewhere);
        break;
      case 'unpay':
        mutations.unpay.mutateAsync(job.id).then(() => afterUnpaid(deps, job), refusedElsewhere);
        break;
    }
  }

  return {
    run(action) {
      if (action.kind === 'cancel') {
        askToCancel(job.id);
        return;
      }
      dismissRefusal();
      if (action.kind === 'deliver' || action.kind === 'undeliver' || action.kind === 'unpay') {
        runStageChange(action.kind);
      } else if (action.kind === 'approve') {
        // The row leaves the Review tab with this: told from the promise, like a stage change.
        mutations.approve.mutateAsync(job.id).then(announceApproved, refusedElsewhere);
      } else if (action.kind === 'unapprove') {
        // The row leaves the Approved tab with this: told from the promise, like a stage change.
        mutations.unapprove.mutateAsync(job.id).then(announceUnapproved, refusedElsewhere);
      } else if (isArchived(job) && LEAVES_ARCHIVE.has(action.kind)) {
        // The job leaves the archive with this: told from the promise, like a stage change.
        mutations[action.kind].mutateAsync(job.id).then(afterLeftArchive, refusedElsewhere);
      } else {
        mutations[action.kind].mutate(job.id);
      }
    },
    archive() {
      dismissRefusal();
      const deps = { api, queryClient };
      mutations.archive
        .mutateAsync([job.id])
        .then(([archived]) => archived && afterArchived(deps, archived), refusedElsewhere);
    },
    unarchive() {
      dismissRefusal();
      const deps = { api, queryClient };
      mutations.unarchive
        .mutateAsync([job.id])
        .then(([unarchived]) => unarchived && afterUnarchived(deps, unarchived), refusedElsewhere);
    },
    archiveAllPaid(ids) {
      dismissRefusal();
      const deps = { api, queryClient };
      mutations.archive
        .mutateAsync(ids)
        .then((archived) => afterArchivedAllPaid(deps, archived), refusedElsewhere);
    },
    setEffort(effort) {
      saveEffort.mutate(
        { id: job.id, effort },
        {
          onError: (error) =>
            toast.error('Could not change the effort', { description: error.message }),
        },
      );
    },
    setReviewEffort(effort) {
      // Its refusal is said by the mutation itself (a toast, and the old level back).
      setReviewEffort.mutate(effort);
    },
    busy,
    refusal: refused?.error?.message ?? null,
    dismissRefusal,
  };
}

/** The actions of the row an Action cell is in. `null` outside a `JobRow` (a cell on its own). */
export const RowActionsContext = createContext<RowActions | null>(null);

export function useRowActionsContext(): RowActions | null {
  return useContext(RowActionsContext);
}
