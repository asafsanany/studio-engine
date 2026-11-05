import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { announceFormatChanging, announceFormatRefused, formatToastId } = await import(
  './use-as-format-toasts'
);

const TARGET = { seriesId: 'series-1', seriesName: 'מיתוס או אמת', jobName: 'מיתוס או אמת 6' };

beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
});

describe('announceFormatChanging', () => {
  it('says the format is being learned from the episode, with both names in <bdi>', () => {
    announceFormatChanging(TARGET);
    const [message, options] = sonner.toast.mock.calls[0] as [
      React.ReactNode,
      Record<string, unknown>,
    ];
    expect(renderToStaticMarkup(message)).toBe(
      'The format of the series <bdi>מיתוס או אמת</bdi> is being learned from <bdi>מיתוס או אמת 6</bdi>.',
    );
    expect(options.id).toBe(formatToastId('done', 'series-1'));
    // There is nothing to undo: the old format is in the series' history.
    expect(options.action).toBeUndefined();
  });
});

describe('announceFormatRefused', () => {
  it('is an error message with the server’s words, said for a while', () => {
    announceFormatRefused(TARGET, 'This series is being learned.');
    const [title, options] = sonner.toast.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Couldn't use this episode as the format");
    expect(options).toMatchObject({
      description: 'This series is being learned.',
      duration: ACTION_ERROR_MS,
      id: formatToastId('refused', 'series-1'),
    });
  });

  it('gives each kind an id of its own, per series', () => {
    expect(formatToastId('done', 'series-1')).not.toBe(formatToastId('refused', 'series-1'));
    expect(formatToastId('done', 'series-1')).not.toBe(formatToastId('done', 'series-2'));
  });
});
