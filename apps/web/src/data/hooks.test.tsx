import type { ClientRow, Job } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CLIENTS_KEY } from './clients-query';
import { HEALTH_KEY } from './health-query';
import {
  useAddNote,
  useAddVoiceNote,
  useArchiveJobs,
  useClients,
  useCreateClient,
  useDeleteNote,
  useHealth,
  useJobAction,
  useJobs,
  useListedJobs,
  useNotes,
  useOrphanDeliveries,
  usePatchNote,
  useSaveNote,
  useSentNotes,
  useUnarchiveJobs,
} from './hooks';
import { JOBS_KEY } from './jobs-cache';
import { notesKey } from './notes-cache';
import { ORPHANS_KEY } from './orphan-deliveries';
import { sentNotesKey } from './sent-notes';
import { createTestQueryClient, makeJob, makeOrphanDelivery, makeReviewNote } from './test-utils';

// The hooks are thin: the rules live in the modules next to them and are tested there. These only
// check that they are wired to the shared query client. There is no DOM here, so effects (and with
// them the SSE connection and any fetch) do not run.

function renderWithClient(ui: ReactNode, queryClient: QueryClient): string {
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function renderWithCache(ui: ReactNode, jobs?: Job[]): string {
  const queryClient = createTestQueryClient();
  if (jobs) queryClient.setQueryData(JOBS_KEY, jobs);
  return renderWithClient(ui, queryClient);
}

function JobNames() {
  const { data } = useJobs();
  return <p>{data ? data.map((job) => job.name).join(',') : 'not loaded'}</p>;
}

describe('useJobs', () => {
  it('reads the list cached under [jobs]', () => {
    const jobs = [makeJob({ id: '1', name: 'One' }), makeJob({ id: '2', name: 'Two' })];
    expect(renderWithCache(<JobNames />, jobs)).toBe('<p>One,Two</p>');
  });

  it('has no data before the first answer', () => {
    expect(renderWithCache(<JobNames />)).toBe('<p>not loaded</p>');
  });
});

function ListedNames() {
  const { data } = useListedJobs();
  return <p>{data ? data.map((job) => job.name).join(',') : 'not loaded'}</p>;
}

describe('useListedJobs (CVP-204)', () => {
  function render(jobs?: Job[], orphans?: ReturnType<typeof makeOrphanDelivery>[]): string {
    const queryClient = createTestQueryClient();
    if (jobs) queryClient.setQueryData(JOBS_KEY, jobs);
    if (orphans) queryClient.setQueryData(ORPHANS_KEY, orphans);
    return renderWithClient(<ListedNames />, queryClient);
  }

  it('lists the jobs, then the unpaid videos whose folder is gone', () => {
    const jobs = [makeJob({ id: '1', name: 'One' }), makeJob({ id: '2', name: 'Two' })];
    const orphans = [makeOrphanDelivery({ id: 'x', name: 'History check' })];
    expect(render(jobs, orphans)).toBe('<p>One,Two,History check</p>');
  });

  it('is the job list while the videos without a folder have not arrived', () => {
    expect(render([makeJob({ id: '1', name: 'One' })])).toBe('<p>One</p>');
  });

  it('has no data before the job list has arrived, whatever the other list holds', () => {
    expect(render(undefined, [makeOrphanDelivery()])).toBe('<p>not loaded</p>');
  });

  it('leaves out a paid video and one whose folder is back', () => {
    const paid = makeOrphanDelivery({
      id: 'paid',
      name: 'Paid',
      delivery: { ...makeOrphanDelivery().delivery, paidOn: '2026-10-23' },
    });
    const back = makeOrphanDelivery({ id: '1', name: 'Back' });
    expect(render([makeJob({ id: '1', name: 'One' })], [paid, back])).toBe('<p>One</p>');
  });

  it('gives the job list’s own state: its error and failures', () => {
    function State() {
      const { isError, failureCount } = useListedJobs();
      return <p>{`${isError} ${failureCount}`}</p>;
    }
    expect(renderWithCache(<State />)).toBe('<p>false 0</p>');
  });
});

describe('useOrphanDeliveries (CVP-204)', () => {
  it('reads the list cached under [orphan-deliveries]', () => {
    function Names() {
      const { data } = useOrphanDeliveries();
      return <p>{data ? data.map((orphan) => orphan.name).join(',') : 'not loaded'}</p>;
    }
    const queryClient = createTestQueryClient();
    expect(renderWithClient(<Names />, queryClient)).toBe('<p>not loaded</p>');
    queryClient.setQueryData(ORPHANS_KEY, [makeOrphanDelivery({ name: 'History check' })]);
    expect(renderWithClient(<Names />, queryClient)).toBe('<p>History check</p>');
  });
});

describe('useJobAction', () => {
  it('gives an idle mutation that takes a job id', () => {
    function Status() {
      const hold = useJobAction('hold');
      return <p>{`${hold.status} ${typeof hold.mutate}`}</p>;
    }
    expect(renderWithCache(<Status />)).toBe('<p>idle function</p>');
  });

  it('is wired to the health query, so the settle delay gets loaded for the instant Release', () => {
    function Hold() {
      useJobAction('hold');
      return null;
    }
    const queryClient = createTestQueryClient();
    expect(queryClient.getQueryCache().find({ queryKey: HEALTH_KEY })).toBeUndefined();

    renderWithClient(<Hold />, queryClient);

    expect(queryClient.getQueryCache().find({ queryKey: HEALTH_KEY })).toBeDefined();
  });
});

describe('useSaveNote', () => {
  it('gives an idle mutation that takes a job id and a note', () => {
    function Status() {
      const save = useSaveNote();
      return <p>{`${save.status} ${typeof save.mutateAsync}`}</p>;
    }
    expect(renderWithCache(<Status />)).toBe('<p>idle function</p>');
  });
});

describe('useArchiveJobs and useUnarchiveJobs (CVP-196)', () => {
  it('give idle mutations that take the ids of the jobs', () => {
    function Status() {
      const archive = useArchiveJobs();
      const unarchive = useUnarchiveJobs();
      return (
        <p>{`${archive.status} ${typeof archive.mutate} ${unarchive.status} ${typeof unarchive.mutate}`}</p>
      );
    }
    expect(renderWithCache(<Status />)).toBe('<p>idle function idle function</p>');
  });
});

describe('useHealth', () => {
  function SettleMs() {
    const { data } = useHealth();
    return <p>{data ? String(data.settleMs) : 'not loaded'}</p>;
  }

  it('reads the answer cached under [health]', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, { ok: true, version: '0.1.6', settleMs: 5000 });
    expect(renderWithClient(<SettleMs />, queryClient)).toBe('<p>5000</p>');
  });

  it('has no data before the first answer', () => {
    expect(renderWithCache(<SettleMs />)).toBe('<p>not loaded</p>');
  });
});

describe('the notes hooks (W5)', () => {
  const note = makeReviewNote({ id: 'n1', jobId: 'job-1', text: 'Slower title' });

  it('useNotes reads the notes cached under [notes, jobId]', () => {
    function NoteTexts() {
      const { data } = useNotes('job-1');
      return <p>{data ? data.map((entry) => entry.text).join(',') : 'not loaded'}</p>;
    }
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(notesKey('job-1'), [note]);

    expect(renderWithClient(<NoteTexts />, queryClient)).toBe('<p>Slower title</p>');
    expect(renderWithClient(<NoteTexts />, createTestQueryClient())).toBe('<p>not loaded</p>');
  });

  it('useNotes of another job does not see them, and { enabled: false } does not fetch', () => {
    function Probe() {
      const query = useNotes('job-2', { enabled: false });
      return <p>{`${query.data ? 'data' : 'none'} ${query.fetchStatus}`}</p>;
    }
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(notesKey('job-1'), [note]);

    expect(renderWithClient(<Probe />, queryClient)).toBe('<p>none idle</p>');
  });

  it.each([
    ['useAddNote', useAddNote],
    ['useAddVoiceNote', useAddVoiceNote],
    ['usePatchNote', usePatchNote],
    ['useDeleteNote', useDeleteNote],
  ])('%s gives an idle mutation', (_name, useHook) => {
    function Status() {
      const mutation = useHook('job-1');
      return <p>{`${mutation.status} ${typeof mutation.mutate}`}</p>;
    }
    expect(renderWithCache(<Status />)).toBe('<p>idle function</p>');
  });
});

describe('the client hooks (C11)', () => {
  function ClientNames() {
    const { data } = useClients();
    return <p>{data ? data.map((row) => row.client).join(',') : 'not loaded'}</p>;
  }

  const rows: ClientRow[] = [
    {
      clientId: 'aaaaaaaaaaaa',
      client: 'Acme',
      jobs: 2,
      lastJobAt: '2026-10-20T11:00:00.000Z',
      style: { state: 'none', updatedAt: null },
    },
    {
      clientId: 'bbbbbbbbbbbb',
      client: 'Fresh Co',
      jobs: 0,
      lastJobAt: null,
      style: { state: 'none', updatedAt: null },
    },
  ];

  it('useClients reads the list cached under [clients], clients with no jobs included', () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(CLIENTS_KEY, rows);
    expect(renderWithClient(<ClientNames />, queryClient)).toBe('<p>Acme,Fresh Co</p>');
  });

  it('useClients has no data before the first answer', () => {
    expect(renderWithCache(<ClientNames />)).toBe('<p>not loaded</p>');
  });

  it('useCreateClient gives an idle mutation that takes a name', () => {
    function Status() {
      const create = useCreateClient();
      return <p>{`${create.status} ${typeof create.mutate}`}</p>;
    }
    expect(renderWithCache(<Status />)).toBe('<p>idle function</p>');
  });
});

describe('useSentNotes (JS1)', () => {
  const note = makeReviewNote({ id: 's1', jobId: 'job-1', round: 1, text: 'Cut the pause' });

  it('reads the sent notes cached under [sent-notes, jobId]', () => {
    function SentTexts() {
      const { data } = useSentNotes('job-1');
      return <p>{data ? data.notes.map((entry) => entry.text).join(',') : 'not loaded'}</p>;
    }
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(sentNotesKey('job-1'), { jobId: 'job-1', notes: [note] });

    expect(renderWithClient(<SentTexts />, queryClient)).toBe('<p>Cut the pause</p>');
    expect(renderWithClient(<SentTexts />, createTestQueryClient())).toBe('<p>not loaded</p>');
  });

  it('does not see the unsent notes of the same job, and { enabled: false } does not fetch', () => {
    function Probe() {
      const query = useSentNotes('job-1', { enabled: false });
      return <p>{`${query.data ? 'data' : 'none'} ${query.fetchStatus}`}</p>;
    }
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(notesKey('job-1'), [note]);

    expect(renderWithClient(<Probe />, queryClient)).toBe('<p>none idle</p>');
  });
});
