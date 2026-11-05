import { SERIES_UNDO_MS } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const {
  announceSeriesRefused,
  announceSeriesStarted,
  announceSeriesUndoRefused,
  announceSeriesUndone,
  startSeriesToastId,
} = await import('./start-series-toasts');

const TARGET = { clientId: 'client-1', jobName: 'שאלות נפוצות 5' };
const SERIES = { name: 'שאלות נפוצות' };

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

describe('announceSeriesStarted', () => {
  it('says "Started the series X. Its format is being learned from J." with both names in <bdi>', () => {
    announceSeriesStarted(TARGET, SERIES, () => {});
    expect(shown(sonner.toast).text).toBe(
      'Started the series <bdi>שאלות נפוצות</bdi>. Its format is being learned from <bdi>שאלות נפוצות 5</bdi>.',
    );
  });

  it('stays for the ten seconds Undo works, and only the newest series’ message stays', () => {
    announceSeriesStarted(TARGET, SERIES, () => {});
    const { options } = shown(sonner.toast);
    expect(SERIES_UNDO_MS).toBe(10_000);
    expect(options.duration).toBe(SERIES_UNDO_MS);
    expect(options.id).toBe(startSeriesToastId('started', 'client-1'));
  });

  it('has an Undo button that runs the undo', () => {
    const undo = vi.fn();
    announceSeriesStarted(TARGET, SERIES, undo);
    const action = shown(sonner.toast).options.action as { label: string; onClick: () => void };
    expect(action.label).toBe('Undo');
    action.onClick();
    expect(undo).toHaveBeenCalledOnce();
  });

  it('draws Undo as the other messages’ quiet outlined button', () => {
    announceSeriesStarted(TARGET, SERIES, () => {});
    const classNames = shown(sonner.toast).options.classNames as { actionButton: string };
    expect(classNames.actionButton).toContain('cursor-pointer');
    expect(classNames.actionButton).toContain('ease-in-out');
  });
});

describe('the other messages', () => {
  it('a refusal is an error message with the server’s words, said for a while', () => {
    announceSeriesRefused(TARGET, 'This job is already in a series.');
    const [title, options] = sonner.toast.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Couldn't start the series");
    expect(options).toMatchObject({
      description: 'This job is already in a series.',
      duration: ACTION_ERROR_MS,
      id: startSeriesToastId('refused', 'client-1'),
    });
  });

  it('Undo working says the series was taken back', () => {
    announceSeriesUndone(TARGET, SERIES);
    expect(shown(sonner.toast).text).toBe('Took back the series <bdi>שאלות נפוצות</bdi>.');
    expect(shown(sonner.toast).options.id).toBe(startSeriesToastId('undone', 'client-1'));
  });

  it('Undo refused (too late) is an error message with the server’s words', () => {
    announceSeriesUndoRefused(TARGET, 'It is too late to undo this.');
    const [title, options] = sonner.toast.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Couldn't take back the series");
    expect(options).toMatchObject({ description: 'It is too late to undo this.' });
  });

  it('gives each kind an id of its own, per client', () => {
    const kinds = ['started', 'refused', 'undone', 'undo-refused'] as const;
    expect(new Set(kinds.map((kind) => startSeriesToastId(kind, 'client-1'))).size).toBe(4);
    expect(startSeriesToastId('started', 'client-1')).not.toBe(
      startSeriesToastId('started', 'client-2'),
    );
  });
});
