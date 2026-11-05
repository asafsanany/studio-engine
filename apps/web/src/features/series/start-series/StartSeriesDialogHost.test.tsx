import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { createTestQueryClient, makeSeries } from '@/data/test-utils';

// Same stand-in for the Radix alert dialog as in StartSeriesDialog.test.tsx.
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

const { StartSeriesDialogHost, startSeriesDeps } = await import('./StartSeriesDialogHost');
const { confirmStartSeries, createStartSeriesDialogStore, startSeriesDialogStore } = await import(
  './start-series-dialog'
);

const TARGET = {
  jobId: 'faq-5',
  jobName: 'שאלות נפוצות 5',
  clientId: 'client-1',
  client: 'עו״ד דוד לוי',
  suggested: 'שאלות נפוצות',
  durationSec: 34,
};

const STARTED = makeSeries({ id: 'abc123abc123', name: 'שאלות נפוצות', formatJobId: 'faq-5' });

/** A server render reads a store's initial state, so each test builds a store already in its state. */
function host(state: Parameters<typeof createStartSeriesDialogStore>[0]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <StartSeriesDialogHost store={createStartSeriesDialogStore(state)} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  startSeriesDialogStore.getState().reset();
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

describe('<StartSeriesDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host({})).toBe('');
  });

  it('shows nothing once the dialog has closed, though it remembers the job for the fade-out', () => {
    expect(host({ phase: 'closed', target: TARGET, name: 'שאלות נפוצות' })).toBe('');
  });

  it('shows the question for the job a row asked about, with the name already typed', () => {
    const markup = host({ phase: 'asking', target: TARGET, name: 'שאלות נפוצות' });
    expect(markup).toContain('Start a series from <bdi>שאלות נפוצות 5</bdi>?');
    expect(markup).toContain('value="שאלות נפוצות"');
  });

  it('shows the server’s refusal of the name under the input', () => {
    const markup = host({
      phase: 'asking',
      target: TARGET,
      name: 'שאלות נפוצות',
      problem: 'This client already has a series called שאלות נפוצות.',
    });
    expect(markup).toContain('This client already has a series called שאלות נפוצות.');
  });

  it('shows the request in flight: Start series is a spinner and cannot be pressed again', () => {
    const markup = host({ phase: 'saving', target: TARGET, name: 'שאלות נפוצות' });
    expect(markup).toContain('animate-spin');
    expect(markup).toMatch(/data-role="confirm" disabled/);
  });
});

describe('confirm → toast → Undo, over the host’s dependencies', () => {
  function asking() {
    const store = createStartSeriesDialogStore({
      phase: 'asking',
      target: TARGET,
      name: 'שאלות נפוצות',
    });
    return store;
  }

  it('starts the series, tells the person with an Undo, and Undo takes the series back', async () => {
    const start = vi.fn(() => Promise.resolve(STARTED));
    const undo = vi.fn(() => Promise.resolve());
    const store = asking();
    await confirmStartSeries(startSeriesDeps({ start, undo }), store);

    expect(start).toHaveBeenCalledExactlyOnceWith({ jobId: 'faq-5', name: 'שאלות נפוצות' });
    expect(store.getState().phase).toBe('closed');
    expect(sonner.toast).toHaveBeenCalledOnce();
    const [message, options] = sonner.toast.mock.calls[0] as [
      React.ReactNode,
      Record<string, unknown>,
    ];
    expect(renderToStaticMarkup(message)).toBe(
      'Started the series <bdi>שאלות נפוצות</bdi>. Its format is being learned from <bdi>שאלות נפוצות 5</bdi>.',
    );
    expect(options.duration).toBe(10_000);

    // Undo is pressed within the ten seconds.
    const action = options.action as { label: string; onClick: () => void };
    expect(undo).not.toHaveBeenCalled();
    action.onClick();
    expect(undo).toHaveBeenCalledExactlyOnceWith({
      seriesId: 'abc123abc123',
      clientId: 'client-1',
    });
    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledTimes(2));
    const [undone] = sonner.toast.mock.calls[1] as [React.ReactNode];
    expect(renderToStaticMarkup(undone)).toBe('Took back the series <bdi>שאלות נפוצות</bdi>.');
  });

  it('says so when Undo comes too late', async () => {
    const undo = vi.fn(() => Promise.reject(new ApiError(409, 'It is too late to undo this.')));
    const store = asking();
    await confirmStartSeries(
      startSeriesDeps({ start: () => Promise.resolve(STARTED), undo }),
      store,
    );
    const [, options] = sonner.toast.mock.calls[0] as [unknown, Record<string, unknown>];
    (options.action as { onClick: () => void }).onClick();
    await vi.waitFor(() => expect(sonner.toast.error).toHaveBeenCalledOnce());
    expect(sonner.toast.error.mock.calls[0]?.[1]).toMatchObject({
      description: 'It is too late to undo this.',
    });
  });

  it('shows the server’s name refusal in the dialog, not in a message', async () => {
    const store = asking();
    const start = () => Promise.reject(new ApiError(422, 'Name taken.'));
    await confirmStartSeries(startSeriesDeps({ start, undo: vi.fn() }), store);
    expect(store.getState()).toMatchObject({ phase: 'asking', problem: 'Name taken.' });
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it('says why in a message when the server refuses the job (409)', async () => {
    const store = asking();
    const start = () => Promise.reject(new ApiError(409, 'This job is already in a series.'));
    await confirmStartSeries(startSeriesDeps({ start, undo: vi.fn() }), store);
    expect(store.getState().phase).toBe('closed');
    expect(sonner.toast.error.mock.calls[0]?.[0]).toBe("Couldn't start the series");
    expect(sonner.toast.error.mock.calls[0]?.[1]).toMatchObject({
      description: 'This job is already in a series.',
    });
  });
});
