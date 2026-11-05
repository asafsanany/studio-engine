import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEpisodeJob } from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { announceJobSeriesRefused, seriesPagePath } = await import('./use-series-menu');

beforeEach(() => sonner.toast.error.mockClear());

describe('seriesPagePath', () => {
  it('is the series’ page under its client', () => {
    expect(seriesPagePath('4b16f268bd46', '622212180eef')).toBe(
      '/clients/4b16f268bd46/series/622212180eef',
    );
  });

  it('escapes what the address can’t hold', () => {
    expect(seriesPagePath('a/b', 'c d')).toBe('/clients/a%2Fb/series/c%20d');
  });
});

describe('announceJobSeriesRefused', () => {
  it('says why the job could not change series, in the server’s words', () => {
    announceJobSeriesRefused(makeEpisodeJob(), 'Its edit has already started.');
    const [title, options] = sonner.toast.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Couldn't change the series");
    expect(options).toMatchObject({
      description: 'Its edit has already started.',
      id: `set-job-series:${makeEpisodeJob().id}`,
    });
  });
});
