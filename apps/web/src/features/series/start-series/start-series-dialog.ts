import {
  episodeFrom,
  type Job,
  normalizeSeriesName,
  type Series,
  seriesNameFrom,
  seriesNameProblem,
} from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';
import { ApiError } from '@/data';

/**
 * The "Start a series from <job>?" dialog (Series plan §6, board SeriesStart), kept at page level
 * and keyed by job id like the "Use this look" dialog (`use-look-dialog.ts`): a ready row's menu
 * item only asks (`askToStartSeries`); the dialog and its request belong to the page
 * (`StartSeriesDialogHost`), because the list is sorted by Last updated and the row can move to
 * another page while the person decides.
 *
 * One dialog at a time (it is modal), so the state is one target and a phase:
 *
 *   closed   nothing shows (the last target stays in the state while the dialog fades out)
 *   asking   the question is on screen, nothing has been sent (or the server refused the name)
 *   saving   "Start series" was pressed; the request is in flight and the dialog cannot be closed
 *
 * The name is the dialog's too: it starts as the job's name without its number (`seriesNameFrom`)
 * and the person may change it. A name the server refuses with 422 (taken, or not a folder name)
 * goes back to `asking` with the server's words under the input. Any other refusal (409: the job
 * is not ready, is in a series already, or a style or series pass of the client is running) closes
 * the dialog and says why in a message (`deps.refused`); an answer closes it and tells the person
 * with a message that has Undo (`deps.done`).
 */
export type StartSeriesPhase = 'closed' | 'asking' | 'saving';

/** What the dialog says about the job, as it was when the dialog was asked for. */
export interface StartSeriesTarget {
  jobId: string;
  jobName: string;
  clientId: string;
  client: string;
  /** The job's name without its number: what the name input starts as. */
  suggested: string;
  /** The length of the job's export in seconds, for the caption under its still; `null` if unknown. */
  durationSec: number | null;
}

export interface StartSeriesDialogState {
  phase: StartSeriesPhase;
  /** The job the dialog is about, or the last one while it fades out; `null` before any. */
  target: StartSeriesTarget | null;
  /** What is in the name input. */
  name: string;
  /** Why the name can't be used (the server's 422, or the same rule checked here); shown under the input. */
  problem: string | null;
  /** A ready row's menu item: show the question for this job. Ignored while a request is in flight. */
  ask: (job: Job) => void;
  /** The person typed: the name changes and a refusal of the old one goes away. Ignored while saving. */
  setName: (name: string) => void;
  /**
   * "Start series": the question turns into the running request and the name to send is returned.
   * `null` if nothing was asked, the name is empty, or it can't be a folder name (`problem` then says why).
   */
  confirm: () => { jobId: string; name: string } | null;
  /** The request for `jobId` is answered: the dialog closes. */
  settle: (jobId: string) => void;
  /** The server refused the name (422): back to the question, with its words under the input. */
  reject: (jobId: string, problem: string) => void;
  /** "Cancel", Escape or a click outside. Never closes a request that is in flight. */
  dismiss: () => void;
  /** The page is gone: close whatever shows, a running request included (its answer is still told). */
  reset: () => void;
}

/** Everything the request needs from the outside: the server, and a way to tell the person. */
export interface StartSeriesDeps {
  /** `POST /api/jobs/:id/series`; rejects with the server's words (422 for the name, 409 otherwise). */
  startSeries: (variables: { jobId: string; name: string }) => Promise<Series>;
  /** The series is started and learning: "Started the series X…" with Undo. */
  done: (target: StartSeriesTarget, series: Series) => void;
  /** The server refused (other than the name) or could not be reached; its own words are `message`. */
  refused: (target: StartSeriesTarget, message: string) => void;
}

const CLOSED = { phase: 'closed', target: null, name: '', problem: null } as const;

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createStartSeriesDialogStore(
  initial: Partial<Pick<StartSeriesDialogState, 'phase' | 'target' | 'name' | 'problem'>> = {},
): StoreApi<StartSeriesDialogState> {
  return createStore<StartSeriesDialogState>()((set, get) => ({
    ...CLOSED,
    ...initial,

    ask: (job) => {
      // Only an approved job can be the start of a series; the menu offers the item on ready rows alone.
      if (get().phase === 'saving' || job.state !== 'ready') return;
      const suggested = seriesNameFrom(job.name);
      set({
        phase: 'asking',
        target: {
          jobId: job.id,
          jobName: job.name,
          clientId: job.clientId,
          client: job.client,
          suggested,
          durationSec: job.output?.durationSec ?? null,
        },
        name: suggested,
        problem: null,
      });
    },

    setName: (name) => {
      if (get().phase !== 'asking') return;
      set({ name, problem: null });
    },

    confirm: () => {
      const { phase, target, name } = get();
      if (phase !== 'asking' || target === null) return null;
      const normalized = normalizeSeriesName(name);
      if (normalized === '') return null;
      const problem = seriesNameProblem(normalized);
      if (problem !== null) {
        set({ problem });
        return null;
      }
      set({ phase: 'saving', problem: null });
      return { jobId: target.jobId, name: normalized };
    },

    settle: (jobId) => {
      const { phase, target } = get();
      // An answer for a dialog that is no longer there (the page was left meanwhile): nothing to do.
      if (phase !== 'saving' || target?.jobId !== jobId) return;
      set({ phase: 'closed' });
    },

    reject: (jobId, problem) => {
      const { phase, target } = get();
      if (phase !== 'saving' || target?.jobId !== jobId) return;
      set({ phase: 'asking', problem });
    },

    dismiss: () => {
      if (get().phase === 'saving') return;
      set({ phase: 'closed' });
    },

    reset: () => set({ ...CLOSED }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createStartSeriesDialogStore`. */
export const startSeriesDialogStore = createStartSeriesDialogStore();

/** Ask for the dialog for a job (the row's "Start a series from this…" menu item). */
export function askToStartSeries(
  job: Job,
  store: StoreApi<StartSeriesDialogState> = startSeriesDialogStore,
): void {
  store.getState().ask(job);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Start series": sends the request through `deps.startSeries` and tells the person how it went.
 * It runs on the store, not in a component, so the answer lands (and is told) even if the host has
 * unmounted. A 422 is the name's: the dialog stays, with the server's words under the input.
 */
export async function confirmStartSeries(
  deps: StartSeriesDeps,
  store: StoreApi<StartSeriesDialogState> = startSeriesDialogStore,
): Promise<void> {
  const { target } = store.getState();
  const sent = store.getState().confirm();
  if (target === null || sent === null) return;
  let series: Series;
  try {
    series = await deps.startSeries(sent);
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      store.getState().reject(target.jobId, error.message);
      return;
    }
    store.getState().settle(target.jobId);
    deps.refused(target, messageOf(error));
    return;
  }
  store.getState().settle(target.jobId);
  deps.done(target, series);
}

/**
 * The two names after the one a job has, for "Folders named <…> and so on join it on their own.":
 * the series' name (or, while the input is empty, the suggested one) and the next two episode
 * numbers. A job with no number counts as episode 1.
 */
export function nextEpisodeNames(
  name: string,
  target: Pick<StartSeriesTarget, 'jobName' | 'suggested'>,
): [string, string] {
  const base = name.trim() === '' ? target.suggested : name.trim();
  const episode = episodeFrom(target.jobName) ?? 1;
  return [`${base} ${episode + 1}`, `${base} ${episode + 2}`];
}

/** The dialog's state, for the host. */
export function useStartSeriesDialog(
  store: StoreApi<StartSeriesDialogState> = startSeriesDialogStore,
) {
  return useStore(store, (state) => state);
}
