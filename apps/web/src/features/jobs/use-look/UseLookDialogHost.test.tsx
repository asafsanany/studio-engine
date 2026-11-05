import type { ClientStyleResponse } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientStyleKey } from '@/data';
import { createTestQueryClient } from '@/data/test-utils';
import { CANVAS_JOBS } from '../test-jobs';

// Same stand-in for the Radix alert dialog as in UseLookDialog.test.tsx: a portal does not render
// on a server.
vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    AlertDialog: ({ open, children }: Props) =>
      open ? h('div', { 'data-open': '' }, children) : null,
    AlertDialogContent: ({ children }: Props) => h('div', { role: 'alertdialog' }, children),
    AlertDialogHeader: ({ children }: Props) => h('header', null, children),
    AlertDialogTitle: ({ children }: Props) => h('h2', null, children),
    AlertDialogDescription: ({ children }: Props) => h('p', null, children),
    AlertDialogFooter: ({ children }: Props) => h('footer', null, children),
    AlertDialogCancel: ({ disabled, children }: Props) =>
      h('button', { 'data-role': 'cancel', disabled }, children),
    AlertDialogAction: ({ disabled, children }: Props) =>
      h('button', { 'data-role': 'confirm', disabled }, children),
  };
});

const { UseLookDialogHost } = await import('./UseLookDialogHost');
const { createUseLookDialogStore, lookDialogStore } = await import('./use-look-dialog');

/** The job the dialog is about; the client's look comes from `JOBS`' extra "Coach intro reel". */
const TARGET = {
  jobId: 'new-job',
  jobName: 'Menu launch',
  clientId: 'client-kova',
  client: 'Kova Coffee',
};
const JOBS = [
  ...CANVAS_JOBS,
  { ...CANVAS_JOBS[0], id: 'source-job', name: 'Coach intro reel' },
] as typeof CANVAS_JOBS;

const style = (sourceJobId: string | null): ClientStyleResponse => ({
  clientId: TARGET.clientId,
  client: TARGET.client,
  state: 'ready',
  version: 1,
  updatedAt: '2026-10-20T13:00:00.000Z',
  error: null,
  sourceJobId,
  pass: null,
  markdown: null,
});

/**
 * A server render reads a store's initial state, so each test builds its store already in the state
 * it wants to see. `cached` is the client's style as the menu left it in the cache (the host reads
 * it from there; a server render fetches nothing).
 */
function host(
  state: Parameters<typeof createUseLookDialogStore>[0],
  cached?: ClientStyleResponse,
  jobs: typeof JOBS | undefined = JOBS,
) {
  const queryClient = createTestQueryClient();
  if (cached) queryClient.setQueryData(clientStyleKey(TARGET.clientId), cached);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UseLookDialogHost jobs={jobs} store={createUseLookDialogStore(state)} />
    </QueryClientProvider>,
  );
}

const pictures = (markup: string) =>
  [...markup.matchAll(/<img [^>]*src="([^"]*)"/g)].map((match) => match[1]);

afterEach(() => lookDialogStore.getState().reset());

describe('<UseLookDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host({})).toBe('');
  });

  it('shows nothing once the dialog has closed, though it remembers the job for the fade-out', () => {
    expect(host({ phase: 'closed', target: TARGET })).toBe('');
  });

  it('shows the question for the job a row asked about, whichever page the row is on', () => {
    const markup = host({ phase: 'asking', target: TARGET }, style(null));
    expect(markup).toContain('<h2>Use this look for <bdi>Kova Coffee</bdi>?</h2>');
    expect(markup).toContain('<bdi>Menu launch</bdi>');
  });

  it('shows even a job that is not in the list it was given (the dialog keeps its own copy)', () => {
    const markup = host({ phase: 'asking', target: TARGET }, style(null), []);
    expect(markup).toContain('Use this look for');
    expect(pictures(markup)).toContain('/api/jobs/new-job/still');
  });

  it('shows the still of the job the client’s look comes from as Now, with that job’s name from the list', () => {
    const markup = host({ phase: 'asking', target: TARGET }, style('source-job'));
    expect(pictures(markup)).toEqual(['/api/jobs/source-job/still', '/api/jobs/new-job/still']);
    expect(markup).toContain('from <bdi>Coach intro reel</bdi>');
    expect(markup).toContain('from <bdi>Menu launch</bdi>');
  });

  it('shows a "From your files" placeholder as Now when the look was made from files', () => {
    const markup = host({ phase: 'asking', target: TARGET }, style(null));
    expect(pictures(markup)).toEqual(['/api/jobs/new-job/still']);
    expect(markup).toContain('From your files');
    expect(markup).toContain('border-dashed');
  });

  it('shows an empty Now frame, not a placeholder, until the client’s style is read', () => {
    const markup = host({ phase: 'asking', target: TARGET });
    expect(pictures(markup)).toEqual(['/api/jobs/new-job/still']);
    expect(markup).not.toContain('From your files');
  });

  it('shows the request in flight: spinner, both buttons off', () => {
    const markup = host({ phase: 'saving', target: TARGET }, style(null));
    expect(markup).toContain('lucide-loader-circle');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});
