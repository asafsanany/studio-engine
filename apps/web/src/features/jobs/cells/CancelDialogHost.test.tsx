import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANCEL_NOTES, cancelDialogStore, createCancelDialogStore } from '../cancel-dialog';
import { CANVAS_JOBS } from '../test-jobs';
import { renderCell } from './test-helpers';

// Same stand-in for the Radix dialog as in CancelDialog.test.tsx: a portal does not render on a server.
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
    AlertDialogCancel: ({ disabled, children }: Props) => h('button', { disabled }, children),
    AlertDialogAction: ({ disabled, children }: Props) => h('button', { disabled }, children),
  };
});

const { CancelDialogHost } = await import('./CancelDialogHost');

// A server render reads a store's initial state, so each test builds its store already in the
// state it wants to see.
const host = (store: ReturnType<typeof createCancelDialogStore>) =>
  renderCell(<CancelDialogHost jobs={CANVAS_JOBS} store={store} />);

afterEach(() => cancelDialogStore.getState().reset());

describe('<CancelDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host(createCancelDialogStore())).toBe('');
  });

  it('shows the question once a row has asked, whichever row (or page) the job is on', () => {
    const markup = host(createCancelDialogStore({ jobId: 'j5', phase: 'asking' }));
    expect(markup).toContain('Stop this edit?');
    expect(markup).toContain('Keep editing');
    expect(markup).toContain('Stop edit');
  });

  it('shows the question even for a job that is not in the list it was given', () => {
    // The host does not need the job to draw the question; it only reacts to the job leaving (effect).
    const markup = host(createCancelDialogStore({ jobId: 'not-here', phase: 'asking' }));
    expect(markup).toContain('Stop this edit?');
  });

  it('shows the spinner and "Stopping…" while the stop is in flight, with both buttons off', () => {
    const markup = host(createCancelDialogStore({ jobId: 'j5', phase: 'stopping' }));
    expect(markup).toContain('Stopping…');
    expect(markup).toContain('lucide-loader-circle');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it('shows a note and an OK button once the dialog has turned into one', () => {
    const markup = host(
      createCancelDialogStore({ jobId: 'j5', phase: 'note', note: CANCEL_NOTES.gone }),
    );
    expect(markup).toContain(CANCEL_NOTES.gone.description);
    expect(markup).toContain('>OK<');
    expect(markup).not.toContain('Stop this edit?');
  });

  it("shows the server's reason when the stop was refused", () => {
    const markup = host(
      createCancelDialogStore({
        jobId: 'j5',
        phase: 'note',
        note: {
          title: CANCEL_NOTES.refusedTitle,
          description: 'Only an editing job can be cancelled.',
        },
      }),
    );
    expect(markup).toContain('stop this edit');
    expect(markup).toContain('Only an editing job can be cancelled.');
  });
});
