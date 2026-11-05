import { SERIES_MESSAGES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { disabledSeriesService, SERIES_OFF, seriesOk, seriesRefusal } from './series-service.js';

describe('disabledSeriesService', () => {
  it('is off', () => {
    expect(disabledSeriesService.enabled).toBe(false);
  });

  it('refuses every method with 404 "Series are off."', async () => {
    const s = disabledSeriesService;
    const outcomes = await Promise.all([
      s.list('c1'),
      s.get('s1'),
      s.start('j1', 'Weekly'),
      s.useAsFormat('s1', 'j1'),
      s.setJobSeries('j1', 's1'),
      s.setJobSeries('j1', null),
      s.undoStart('s1'),
      s.retry('s1'),
      s.addNotes('s1', 'j1', [{ name: 'notes.md', size: 1 }]),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false, status: 404, error: SERIES_MESSAGES.off });
    }
    expect(SERIES_OFF.error).toBe('Series are off.');
  });

  it('makes no approved episode a format (C26)', async () => {
    expect(await disabledSeriesService.approved({ id: 'j1', seriesId: 's1' } as never)).toBe(false);
  });

  it('never tells anyone about a change, and can be stopped listening to', () => {
    const listener = vi.fn();
    const stop = disabledSeriesService.onChange(listener);
    expect(() => stop()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('seriesOk and seriesRefusal', () => {
  it('build the two kinds of answer a route sends as they are', () => {
    expect(seriesOk({ ok: true })).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(seriesOk({ series: [] }, 202)).toEqual({ ok: true, status: 202, body: { series: [] } });
    expect(seriesRefusal(422, SERIES_MESSAGES.nameTaken)).toEqual({
      ok: false,
      status: 422,
      error: 'A series with this name already exists.',
    });
  });
});
