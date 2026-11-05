import type { Job, Series, SeriesSummary } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The "Use <job> as the format?" dialog (Series plan §6), kept at page level and keyed by job id
 * like the "Use this look" dialog (`use-look-dialog.ts`): a ready episode's menu item only asks
 * (`askToUseAsFormat`); the dialog and its request belong to the page (`UseAsFormatDialogHost`),
 * because the list is sorted by Last updated and the row can move to another page while the person
 * decides.
 *
 * One dialog at a time (it is modal), so the state is one target and a phase:
 *
 *   closed   nothing shows (the last target stays in the state while the dialog fades out)
 *   asking   the question is on screen, nothing has been sent
 *   saving   "Use as format" was pressed; the request is in flight and the dialog cannot be closed
 *
 * The request ends the dialog either way: an answer closes it and tells the person that the
 * series is learning its new format (`deps.done`), and a refusal (409: the job is not a ready
 * episode of the series, the series or the client's style is being learned) closes it and says
 * why in a message (`deps.refused`).
 */
export type UseAsFormatPhase = 'closed' | 'asking' | 'saving';

/** What the dialog says about the episode and its series, as it was when the dialog was asked for. */
export interface UseAsFormatTarget {
  jobId: string;
  jobName: string;
  clientId: string;
  seriesId: string;
  seriesName: string;
  /** The job the series' format comes from now (the "Now" still). */
  formatJobId: string;
  formatJobName: string;
}

export interface UseAsFormatDialogState {
  phase: UseAsFormatPhase;
  /** The episode the dialog is about, or the last one while it fades out; `null` before any. */
  target: UseAsFormatTarget | null;
  /** A ready episode's menu item: show the question for this job. Ignored while a request is in flight. */
  ask: (job: Job, series: Pick<SeriesSummary, 'id' | 'name' | 'formatJobId' | 'formatJob'>) => void;
  /** "Use as format": the question for `jobId` turns into the running request. `false` if it was not asked. */
  confirm: (jobId: string) => boolean;
  /** The request for `jobId` is answered: the dialog closes. */
  settle: (jobId: string) => void;
  /** "Cancel", Escape or a click outside. Never closes a request that is in flight. */
  dismiss: () => void;
  /** The page is gone: close whatever shows, a running request included (its answer is still told). */
  reset: () => void;
}

/** Everything the request needs from the outside: the server, and a way to tell the person. */
export interface UseAsFormatDeps {
  /** `POST /api/series/:id/format`; rejects with the server's words (409). */
  setFormat: (variables: { seriesId: string; jobId: string }) => Promise<Series>;
  /** The series is learning its new format. */
  done: (target: UseAsFormatTarget, series: Series) => void;
  /** The server refused or could not be reached; its own words are `message`. */
  refused: (target: UseAsFormatTarget, message: string) => void;
}

const CLOSED = { phase: 'closed', target: null } as const;

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createUseAsFormatDialogStore(
  initial: Partial<Pick<UseAsFormatDialogState, 'phase' | 'target'>> = {},
): StoreApi<UseAsFormatDialogState> {
  return createStore<UseAsFormatDialogState>()((set, get) => ({
    ...CLOSED,
    ...initial,

    ask: (job, series) => {
      // Only a ready episode of the series that is not its format yet can become the format; the
      // menu offers the item on those rows alone.
      if (get().phase === 'saving') return;
      if (job.state !== 'ready' || job.seriesId !== series.id || series.formatJobId === job.id) {
        return;
      }
      set({
        phase: 'asking',
        target: {
          jobId: job.id,
          jobName: job.name,
          clientId: job.clientId,
          seriesId: series.id,
          seriesName: series.name,
          formatJobId: series.formatJobId,
          formatJobName: series.formatJob,
        },
      });
    },

    confirm: (jobId) => {
      const { phase, target } = get();
      if (phase !== 'asking' || target?.jobId !== jobId) return false;
      set({ phase: 'saving' });
      return true;
    },

    settle: (jobId) => {
      const { phase, target } = get();
      // An answer for a dialog that is no longer there (the page was left meanwhile): nothing to do.
      if (phase !== 'saving' || target?.jobId !== jobId) return;
      set({ phase: 'closed' });
    },

    dismiss: () => {
      if (get().phase === 'saving') return;
      set({ phase: 'closed' });
    },

    reset: () => set({ ...CLOSED }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createUseAsFormatDialogStore`. */
export const asFormatDialogStore = createUseAsFormatDialogStore();

/** Ask for the dialog for an episode (the row's "Use as the series format…" menu item). */
export function askToUseAsFormat(
  job: Job,
  series: Pick<SeriesSummary, 'id' | 'name' | 'formatJobId' | 'formatJob'>,
  store: StoreApi<UseAsFormatDialogState> = asFormatDialogStore,
): void {
  store.getState().ask(job, series);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Use as format": sends the request through `deps.setFormat`, closes the dialog when it is
 * answered and tells the person how it went. It runs on the store, not in a component, so the
 * answer lands (and is told) even if the host has unmounted.
 */
export async function confirmUseAsFormat(
  deps: UseAsFormatDeps,
  store: StoreApi<UseAsFormatDialogState> = asFormatDialogStore,
): Promise<void> {
  const { target } = store.getState();
  if (target === null || !store.getState().confirm(target.jobId)) return;
  let series: Series;
  try {
    series = await deps.setFormat({ seriesId: target.seriesId, jobId: target.jobId });
  } catch (error) {
    store.getState().settle(target.jobId);
    deps.refused(target, messageOf(error));
    return;
  }
  store.getState().settle(target.jobId);
  deps.done(target, series);
}

/** The dialog's state, for the host. */
export function useUseAsFormatDialog(
  store: StoreApi<UseAsFormatDialogState> = asFormatDialogStore,
) {
  return useStore(store, (state) => state);
}
