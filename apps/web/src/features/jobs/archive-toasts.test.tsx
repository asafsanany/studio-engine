import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import { ACTION_ERROR_MS } from './cells/ActionError';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const {
  ARCHIVE_TOAST_MS,
  ARCHIVE_TOAST_STYLE,
  ARCHIVED_PAID_TOAST_ID,
  announceArchived,
  announceArchivedPaid,
  announceArchiveUndoRefused,
  announceLeftArchive,
  announceUnarchived,
  archiveToastId,
} = await import('./archive-toasts');

const job = makeJob({ id: 'job-1', name: 'מיתוס או אמת 2', state: 'ready', placeInLine: null });

beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

/** The first (and only) toast of `fn`: what it says, and how it was asked for. */
function shown(fn: ReturnType<typeof vi.fn>) {
  expect(fn).toHaveBeenCalledOnce();
  const [message, options] = fn.mock.calls[0] as [React.ReactNode, Record<string, unknown>];
  return { text: renderToStaticMarkup(message), options };
}

const undoOf = (options: Record<string, unknown>) =>
  options.action as { label: string; onClick: () => void } | undefined;

/** The width a message asks sonner for (`--width`), or undefined when it keeps sonner's. */
const widthOf = (options: Record<string, unknown>) =>
  (options.style as Record<string, string> | undefined)?.['--width'];

describe('the width of the messages about the archive', () => {
  it('is the board’s 420 px, so "Archived “<name>” · it still counts on Money" is one line', () => {
    expect(ARCHIVE_TOAST_STYLE).toEqual({ '--width': '420px' });
  });

  it('applies to every message that says something happened, with or without Undo', () => {
    announceArchived(job, () => {});
    announceArchivedPaid(2, () => {});
    announceUnarchived(job, () => {});
    announceLeftArchive(makeJob({ id: 'job-1', name: 'x', state: 'queued' }));
    const widths = sonner.toast.mock.calls.map(([, options]) =>
      widthOf(options as Record<string, unknown>),
    );
    expect(widths).toEqual(['420px', '420px', '420px', '420px']);
  });
});

describe('announceArchived', () => {
  it('says “Archived “<name>” · it still counts on Money”, the name in <bdi>', () => {
    announceArchived(job, () => {});
    expect(shown(sonner.toast).text).toBe(
      'Archived “<bdi>מיתוס או אמת 2</bdi>” · it still counts on Money',
    );
  });

  it('lasts 7 seconds and has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announceArchived(job, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect(ARCHIVE_TOAST_MS).toBe(7000);
    expect(undoOf(options)?.label).toBe('Undo');
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('draws Undo as the quiet outlined button of the other messages, not sonner’s inverted one', () => {
    announceArchived(job, () => {});
    const { options } = shown(sonner.toast);
    expect((options.classNames as { actionButton: string }).actionButton).toContain(
      'border-white/15!',
    );
  });

  it('replaces the earlier message of the same job, and leaves other jobs’ messages alone', () => {
    announceArchived(job, () => {});
    announceArchived({ ...job, id: 'job-2' }, () => {});
    const ids = sonner.toast.mock.calls.map(([, options]) => (options as { id: string }).id);
    expect(ids).toEqual([archiveToastId('archived', 'job-1'), archiveToastId('archived', 'job-2')]);
  });
});

describe('announceArchivedPaid', () => {
  it('says “Archived 3 paid videos · they still count on Money”', () => {
    announceArchivedPaid(3, () => {});
    expect(shown(sonner.toast).text).toBe('Archived 3 paid videos · they still count on Money');
  });

  it('lasts 7 seconds, has Undo, and has an id of its own', () => {
    const undo = vi.fn();
    announceArchivedPaid(2, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect(options.id).toBe(ARCHIVED_PAID_TOAST_ID);
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });
});

describe('announceUnarchived', () => {
  const back = (overrides: Parameters<typeof makeJob>[0]) =>
    announceUnarchived(makeJob({ id: 'job-1', name: 'שאלות נפוצות 1', ...overrides }), () => {});

  it('says “Back in Paid: “<name>””, the tab by the job’s stage', () => {
    back({
      state: 'ready',
      placeInLine: null,
      delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
    });
    expect(shown(sonner.toast).text).toBe('Back in Paid: “<bdi>שאלות נפוצות 1</bdi>”');
  });

  it.each([
    ['approved', { state: 'ready', placeInLine: null, delivery: null }, 'Approved'],
    ['delivered', { state: 'ready', placeInLine: null, delivery: makeJobDelivery() }, 'Delivered'],
    ['a review job', { state: 'review', placeInLine: null }, 'Review'],
    ['a failed job', { state: 'failed', placeInLine: null }, 'Needs attention'],
    ['a cancelled job', { state: 'cancelled', placeInLine: null }, 'Needs attention'],
    ['a held job', { state: 'held', placeInLine: null }, 'Needs attention'],
  ] as const)('puts %s back in %s', (_, overrides, tab) => {
    back(overrides);
    expect(shown(sonner.toast).text).toBe(`Back in ${tab}: “<bdi>שאלות נפוצות 1</bdi>”`);
  });

  it('lasts 7 seconds and has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announceUnarchived(job, undo);
    const { options } = shown(sonner.toast);
    expect(options.duration).toBe(7000);
    expect(options.id).toBe(archiveToastId('unarchived', 'job-1'));
    undoOf(options)?.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });
});

describe('announceLeftArchive', () => {
  it('says “Left the archive: “<name>” is queued again”, with the state the job is in now', () => {
    announceLeftArchive(makeJob({ id: 'job-1', name: 'טיוטה ישנה', state: 'queued' }));
    expect(shown(sonner.toast).text).toBe(
      'Left the archive: “<bdi>טיוטה ישנה</bdi>” is queued again',
    );
  });

  it.each([
    ['editing', 'editing'],
    ['arriving', 'arriving'],
    ['queued', 'queued'],
  ] as const)('says “%s” for a job that is %s', (state, word) => {
    announceLeftArchive(makeJob({ name: 'X', state }));
    expect(shown(sonner.toast).text).toBe(`Left the archive: “<bdi>X</bdi>” is ${word} again`);
  });

  it('has no Undo: the server took the job out by itself', () => {
    announceLeftArchive(makeJob({ id: 'job-1', name: 'X', state: 'queued' }));
    const { options } = shown(sonner.toast);
    expect(undoOf(options)).toBeUndefined();
    expect(options.duration).toBe(7000);
    expect(options.id).toBe(archiveToastId('left', 'job-1'));
  });
});

describe('announceArchiveUndoRefused', () => {
  it('says “Couldn’t undo “<name>””, then the server’s words, as an error message', () => {
    announceArchiveUndoRefused([job], 'Cannot archive “X” while it is editing.');
    const { text, options } = shown(sonner.toast.error);
    expect(text).toBe('Couldn&#x27;t undo “<bdi>מיתוס או אמת 2</bdi>”');
    expect(options.description).toBe('Cannot archive “X” while it is editing.');
    expect(options.duration).toBe(ACTION_ERROR_MS);
  });

  it('counts the videos when there are several', () => {
    announceArchiveUndoRefused([job, { ...job, id: 'job-2' }], 'Server unreachable.');
    expect(sonner.toast.error.mock.calls[0]?.[0]).toBe("Couldn't undo for 2 videos");
  });
});
