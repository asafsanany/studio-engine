import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoteDialogStore, noteDialogStore } from '../note-dialog';
import { CANVAS_JOBS } from '../test-jobs';
import { renderCell } from './test-helpers';

// Same stand-in for the Radix dialog as in NoteDialog.test.tsx: a portal does not render on a server.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children }: Props) => h('div', { role: 'dialog' }, children),
    DialogHeader: ({ children }: Props) => h('header', null, children),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children }: Props) => h('p', null, children),
    DialogFooter: ({ children }: Props) => h('footer', null, children),
  };
});

const { NoteDialogHost } = await import('./NoteDialogHost');

const JOB = { id: 'j2', name: 'Class schedule', client: 'Arc Fitness' };

// A server render reads a store's initial state, so each test builds its store already in the
// state it wants to see.
const host = (store: ReturnType<typeof createNoteDialogStore>) =>
  renderCell(<NoteDialogHost jobs={CANVAS_JOBS} store={store} />);

afterEach(() => noteDialogStore.getState().reset());

describe('<NoteDialogHost>', () => {
  it('shows nothing while no row has asked', () => {
    expect(host(createNoteDialogStore())).toBe('');
  });

  it('shows nothing while the Hold is on its way: the dialog opens when it is answered', () => {
    expect(host(createNoteDialogStore({ phase: 'holding', job: JOB }))).toBe('');
  });

  it('shows nothing for a request that has not been taken yet (the host starts it in an effect)', () => {
    expect(host(createNoteDialogStore({ asked: CANVAS_JOBS[1] }))).toBe('');
  });

  it('shows the dialog for the job, whichever row (or page) it is on', () => {
    const markup = host(
      createNoteDialogStore({ phase: 'writing', job: JOB, text: 'Use the second take.' }),
    );
    expect(markup).toContain('Note for the editor');
    expect(markup).toContain('Class schedule');
    expect(markup).toContain('Arc Fitness');
    expect(markup).toContain('Use the second take.</textarea>');
  });

  it('shows even a job that is not in the list it was given (the dialog keeps its own copy)', () => {
    const markup = host(
      createNoteDialogStore({ phase: 'writing', job: { ...JOB, id: 'not-here' } }),
    );
    expect(markup).toContain('Note for the editor');
  });

  it('says the job waits only when this dialog is the one holding it', () => {
    const holding = host(createNoteDialogStore({ phase: 'writing', job: JOB, held: true }));
    expect(holding).toContain('This job waits while you write. Saving puts it back in line.');
    const notHolding = host(createNoteDialogStore({ phase: 'writing', job: JOB, held: false }));
    expect(notHolding).not.toContain('This job waits');
  });

  it('shows the spinner and disables both buttons while the note is on its way', () => {
    const markup = host(createNoteDialogStore({ phase: 'saving', job: JOB, held: true }));
    expect(markup).toContain('lucide-loader-circle');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it('shows why a save failed, inside the dialog, with the text still there', () => {
    const markup = host(
      createNoteDialogStore({
        phase: 'writing',
        job: JOB,
        text: 'My note',
        error: 'Cannot edit the note of a job that is editing.',
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Cannot edit the note of a job that is editing.');
    expect(markup).toContain('My note</textarea>');
  });

  it('shows nothing once the dialog has closed, though the store still remembers the job', () => {
    expect(host(createNoteDialogStore({ phase: 'closed', job: JOB, text: 'Old' }))).toBe('');
  });
});
