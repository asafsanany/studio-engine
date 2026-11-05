import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { createTestQueryClient, makeSeries } from '@/data/test-utils';

// Same stand-in for the Radix alert dialog as in UseAsFormatDialog.test.tsx.
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

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { UseAsFormatDialogHost, useAsFormatDeps } = await import('./UseAsFormatDialogHost');
const { asFormatDialogStore, confirmUseAsFormat, createUseAsFormatDialogStore } = await import(
  './use-as-format-dialog'
);

const TARGET = {
  jobId: 'episode-6',
  jobName: 'מיתוס או אמת 6',
  clientId: 'client-1',
  seriesId: 'series-1',
  seriesName: 'מיתוס או אמת',
  formatJobId: 'episode-5',
  formatJobName: 'מיתוס או אמת 5',
};

/** A server render reads a store's initial state, so each test builds a store already in its state. */
function host(state: Parameters<typeof createUseAsFormatDialogStore>[0]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <UseAsFormatDialogHost store={createUseAsFormatDialogStore(state)} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  asFormatDialogStore.getState().reset();
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

describe('<UseAsFormatDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host({})).toBe('');
  });

  it('shows nothing once the dialog has closed, though it remembers the episode for the fade-out', () => {
    expect(host({ phase: 'closed', target: TARGET })).toBe('');
  });

  it('shows the question for the episode a row asked about', () => {
    const markup = host({ phase: 'asking', target: TARGET });
    expect(markup).toContain('Use <bdi>מיתוס או אמת 6</bdi> as the format?');
    expect(markup).toContain('/api/jobs/episode-5/still');
  });

  it('shows the request in flight: Use as format is locked', () => {
    const markup = host({ phase: 'saving', target: TARGET });
    expect(markup).toContain('animate-spin');
    expect(markup).toMatch(/data-role="confirm" disabled/);
  });
});

describe('confirm → toast, over the host’s dependencies', () => {
  const asking = () => createUseAsFormatDialogStore({ phase: 'asking', target: TARGET });

  it('sets the format, closes and tells the person', async () => {
    const setFormat = vi.fn(() => Promise.resolve(makeSeries({ state: 'learning' })));
    const store = asking();
    await confirmUseAsFormat(useAsFormatDeps(setFormat), store);
    expect(setFormat).toHaveBeenCalledExactlyOnceWith({
      seriesId: 'series-1',
      jobId: 'episode-6',
    });
    expect(store.getState().phase).toBe('closed');
    const [message] = sonner.toast.mock.calls[0] as [React.ReactNode];
    expect(renderToStaticMarkup(message)).toBe(
      'The format of the series <bdi>מיתוס או אמת</bdi> is being learned from <bdi>מיתוס או אמת 6</bdi>.',
    );
  });

  it('says why in a message when the server refuses (409)', async () => {
    const setFormat = () => Promise.reject(new ApiError(409, 'This series is being learned.'));
    const store = asking();
    await confirmUseAsFormat(useAsFormatDeps(setFormat), store);
    expect(store.getState().phase).toBe('closed');
    expect(sonner.toast.error.mock.calls[0]?.[1]).toMatchObject({
      description: 'This series is being learned.',
    });
  });
});
