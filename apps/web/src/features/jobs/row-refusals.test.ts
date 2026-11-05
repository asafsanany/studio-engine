import {
  MutationObserver,
  type MutationObserverOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Api, ApiError } from '@/data/api';
import {
  deliverJobMutationOptions,
  undeliverJobMutationOptions,
  undoPaidMutationOptions,
} from '@/data/delivery-mutations';
import { jobActionMutationOptions } from '@/data/job-action';
import { createTestQueryClient, deferred, makeJob } from '@/data/test-utils';
import { REFUSABLE_ACTIONS, type RefusedAction, watchRefusedActions } from './row-refusals';

// These run the real mutations of the data layer against a server that answers when the test says,
// and stand in for a row with what a row is to a mutation: a `MutationObserver` that is subscribed
// while the row is mounted (this is what `useMutation` does) and unsubscribed when it unmounts.

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/**
 * A server that holds every request until `answer` is called, then turns it down with `error`, or,
 * when there is none, accepts it.
 */
function fakeServer(error?: Error) {
  const gate = deferred();
  const api: Api = {
    runJobAction: async () => {
      await gate.promise;
      if (error) throw error;
      return makeJob();
    },
    listJobs: () => Promise.reject(new Error('not asked')),
    saveNote: () => Promise.reject(new Error('not asked')),
    saveEffort: () => Promise.reject(new Error('not asked')),
    renameJob: () => Promise.reject(new Error('not asked')),
    renameClient: () => Promise.reject(new Error('not asked')),
    deleteClient: () => Promise.reject(new Error('not asked')),
    saveReviewEffort: () => Promise.reject(new Error('not asked')),
    archiveJobs: () => Promise.reject(new Error('not asked')),
    unarchiveJobs: () => Promise.reject(new Error('not asked')),
    deliverJob: async () => {
      await gate.promise;
      if (error) throw error;
      return makeJob();
    },
    deleteJob: async () => {},
    undeliverJob: async () => {
      await gate.promise;
      if (error) throw error;
      return makeJob();
    },
    markPaid: () => Promise.reject(new Error('not asked')),
    listOrphanDeliveries: () => Promise.reject(new Error('not asked')),
    undoPaid: async () => {
      await gate.promise;
      if (error) throw error;
      return [makeJob()];
    },
    getHealth: () => Promise.reject(new Error('not asked')),
    getMe: () => Promise.reject(new Error('not asked')),
    getMoney: () => Promise.reject(new Error('not asked')),
    getMoneyPrice: () => Promise.reject(new Error('not asked')),
    getAnalytics: () => Promise.reject(new Error('not asked')),
    listNotes: () => Promise.reject(new Error('not asked')),
    addNote: () => Promise.reject(new Error('not asked')),
    addVoiceNote: () => Promise.reject(new Error('not asked')),
    patchNote: () => Promise.reject(new Error('not asked')),
    deleteNote: () => Promise.reject(new Error('not asked')),
    listClients: () => Promise.reject(new Error('not asked')),
    createClient: () => Promise.reject(new Error('not asked')),
    addReviewTime: () => Promise.reject(new Error('not asked')),
    revealClient: () => Promise.reject(new Error('not asked')),
    getTeam: () => Promise.reject(new Error('not asked')),
    addTeamUser: () => Promise.reject(new Error('not asked')),
    updateTeamUser: () => Promise.reject(new Error('not asked')),
    removeTeamUser: () => Promise.reject(new Error('not asked')),
    getSettings: () => Promise.reject(new Error('not asked')),
    saveSettings: () => Promise.reject(new Error('not asked')),
    restartEngine: () => Promise.reject(new Error('not asked')),
    setClientAssignees: () => Promise.reject(new Error('not asked')),
    getJobSteps: () => Promise.reject(new Error('not asked')),
    getJobVersions: () => Promise.reject(new Error('not asked')),
    restoreJobVersion: () => Promise.reject(new Error('not asked')),
    revealJob: () => Promise.reject(new Error('not asked')),
    getSentNotes: () => Promise.reject(new Error('not asked')),
    getJobStock: () => Promise.reject(new Error('not asked')),
    getJobFeed: () => Promise.reject(new Error('not asked')),
    getClientStyle: () => Promise.reject(new Error('not asked')),
    uploadStyleFiles: () => Promise.reject(new Error('not asked')),
    retryClientStyle: () => Promise.reject(new Error('not asked')),
    applyLook: () => Promise.reject(new Error('not asked')),
    undoClientStyle: () => Promise.reject(new Error('not asked')),
    getJobGenerate: () => Promise.reject(new Error('not asked')),
    getGenerateHistory: () => Promise.reject(new Error('not asked')),
    getGenerateReviewPlan: () => Promise.reject(new Error('not asked')),
    getJobMusic: () => Promise.reject(new Error('not asked')),
    makeMusic: () => Promise.reject(new Error('not asked')),
    pickMusic: () => Promise.reject(new Error('not asked')),
    getNoSong: () => Promise.reject(new Error('not asked')),
    retryNoSong: () => Promise.reject(new Error('not asked')),
    getJobFixes: () => Promise.reject(new Error('not asked')),
    undoFix: () => Promise.reject(new Error('not asked')),
  };
  return { api, answer: () => gate.resolve() };
}

/** The mutation a row builds for an action: a job action, or a change of the job's stage. */
function optionsFor(api: Api, action: (typeof REFUSABLE_ACTIONS)[number] | 'cancel') {
  switch (action) {
    case 'deliver':
      return deliverJobMutationOptions({ queryClient, api });
    case 'undeliver':
      return undeliverJobMutationOptions({ queryClient, api });
    case 'unpay':
      return undoPaidMutationOptions({ queryClient, api });
    default:
      return jobActionMutationOptions({ queryClient, api, action });
  }
}

/** A row's `useMutation(action)`: `mount()` is the row being on the page, `mutate` a click. */
function row(api: Api, action: (typeof REFUSABLE_ACTIONS)[number] | 'cancel') {
  // Each kind of mutation has a result and a context of its own; a row's observer reads neither.
  const observer = new MutationObserver(
    queryClient,
    optionsFor(api, action) as MutationObserverOptions<unknown, Error, string, unknown>,
  );
  let unmount: (() => void) | undefined;
  return {
    observer,
    mount: () => {
      unmount = observer.subscribe(() => {});
    },
    unmount: () => unmount?.(),
    click: (jobId: string) => observer.mutate(jobId).catch(() => {}),
  };
}

/** Let the mutation's own callbacks finish: they run in promise steps after the answer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function watch() {
  const refusals: RefusedAction[] = [];
  const stop = watchRefusedActions(queryClient, (refused) => refusals.push(refused));
  return { refusals, stop };
}

describe('watchRefusedActions: the row has left the page', () => {
  it.each(REFUSABLE_ACTIONS)(
    'reports a refused %s with the job and the server’s reason',
    async (action) => {
      const { refusals } = watch();
      const server = fakeServer(new ApiError(409, 'Only a queued job can be held.'));
      const cell = row(server.api, action);
      cell.mount();

      const answered = cell.click('j2');
      cell.unmount(); // the row moved to another page while the request was out
      server.answer();
      await answered;
      await settle();

      expect(refusals).toEqual([
        { jobId: 'j2', action, message: 'Only a queued job can be held.' },
      ]);
    },
  );

  it('reports a request the server could not be reached for, in the network’s words', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(0, 'Cannot reach the Studio Engine server.'));
    const cell = row(server.api, 'retry');
    cell.mount();

    const answered = cell.click('j7');
    cell.unmount();
    server.answer();
    await answered;

    expect(refusals).toEqual([
      { jobId: 'j7', action: 'retry', message: 'Cannot reach the Studio Engine server.' },
    ]);
  });

  it('reports a refusal for a row that went away and came back, whose new cell knows nothing of it', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(404, 'There is no such job.'));
    const first = row(server.api, 'resume');
    first.mount();
    const answered = first.click('j8');

    first.unmount(); // off the page...
    row(server.api, 'resume').mount(); // ...and back on it, as a fresh cell with fresh observers
    server.answer();
    await answered;

    expect(refusals).toEqual([{ jobId: 'j8', action: 'resume', message: 'There is no such job.' }]);
  });

  it('reports each refusal of several rows', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(409, 'No.'));
    const first = row(server.api, 'hold');
    const second = row(server.api, 'release');
    first.mount();
    second.mount();
    const answered = [first.click('j1'), second.click('j3')];
    first.unmount();
    second.unmount();
    server.answer();
    await Promise.all(answered);

    expect(refusals.map(({ jobId, action }) => `${action} ${jobId}`).sort()).toEqual([
      'hold j1',
      'release j3',
    ]);
  });
});

describe('watchRefusedActions: the row is still there', () => {
  it('reports nothing, because the row’s tooltip has the answer', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(409, 'Only a queued job can be held.'));
    const cell = row(server.api, 'hold');
    cell.mount();

    const answered = cell.click('j2');
    server.answer();
    await answered;
    await settle();

    expect(refusals).toEqual([]);
    // What the tooltip reads: the row’s own mutation carries the same words.
    expect(cell.observer.getCurrentResult().error?.message).toBe('Only a queued job can be held.');
  });

  it('reports nothing for any action while its row is mounted', async () => {
    const { refusals } = watch();
    for (const action of REFUSABLE_ACTIONS) {
      const server = fakeServer(new ApiError(409, 'No.'));
      const cell = row(server.api, action);
      cell.mount();
      const answered = cell.click('j2');
      server.answer();
      await answered;
    }
    expect(refusals).toEqual([]);
  });

  it('reports nothing once the tooltip has been dismissed either (the answer was already shown)', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(409, 'No.'));
    const cell = row(server.api, 'hold');
    cell.mount();
    const answered = cell.click('j2');
    server.answer();
    await answered;
    cell.observer.reset(); // Escape, a click elsewhere, or the timeout
    expect(refusals).toEqual([]);
  });
});

describe('watchRefusedActions: what is not its business', () => {
  it('never reports Cancel: the cancel dialog says so itself', async () => {
    const { refusals } = watch();
    const server = fakeServer(new ApiError(409, 'Only an editing job can be cancelled.'));
    const cell = row(server.api, 'cancel');
    cell.mount();
    const answered = cell.click('j5');
    cell.unmount();
    server.answer();
    await answered;
    expect(refusals).toEqual([]);
  });

  it('reports nothing for a request the server accepted, even if its row is gone', async () => {
    const { refusals } = watch();
    const accepting = fakeServer();
    const cell = row(accepting.api, 'hold');
    cell.mount();
    const answered = cell.click('j2');
    cell.unmount();
    accepting.answer();
    await answered;
    expect(refusals).toEqual([]);
  });

  it('stops reporting once it is stopped', async () => {
    const { refusals, stop } = watch();
    const server = fakeServer(new ApiError(409, 'No.'));
    const cell = row(server.api, 'hold');
    cell.mount();
    const answered = cell.click('j2');
    cell.unmount();
    stop(); // the page is left
    server.answer();
    await answered;
    expect(refusals).toEqual([]);
  });
});
