import { describe, expect, it, vi } from 'vitest';
import {
  BAR_MAX_PX,
  BAR_MIN_PX,
  computePeaks,
  loadVoicePeaks,
  type PeaksDeps,
  peakBarHeights,
  VOICE_BARS,
} from './voice-peaks';

describe('constants', () => {
  it('are the board’s 28 bars, 4 to 22 px tall', () => {
    expect(VOICE_BARS).toBe(28);
    expect(BAR_MIN_PX).toBe(4);
    expect(BAR_MAX_PX).toBe(22);
  });
});

describe('computePeaks', () => {
  it('gives 28 values, the loudest of them 1', () => {
    const samples = new Float32Array(2800);
    samples[1234] = 0.25;
    samples[50] = 0.125;
    const peaks = computePeaks([samples]);
    expect(peaks).toHaveLength(28);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks[12]).toBe(1); // 1234 / 100 slices
    expect(peaks[0]).toBe(0.5);
  });

  it('rises with a ramp', () => {
    const ramp = Float32Array.from({ length: 2800 }, (_, index) => index / 2800);
    const peaks = computePeaks([ramp]);
    expect(peaks[27]).toBe(1);
    for (let index = 1; index < peaks.length; index++) {
      expect(peaks[index]).toBeGreaterThan(peaks[index - 1] ?? 0);
    }
  });

  it('reads the size of a negative swing, not its sign', () => {
    const peaks = computePeaks([Float32Array.from([0, -0.5, 0.25, 0])], 2);
    expect(peaks).toEqual([1, 0.5]);
  });

  it('gives zeros for silence and for no samples', () => {
    const zeros = new Array(28).fill(0);
    expect(computePeaks([new Float32Array(1000)])).toEqual(zeros);
    expect(computePeaks([new Float32Array(0)])).toEqual(zeros);
    expect(computePeaks([])).toEqual(zeros);
  });

  it('takes the larger sample of two channels', () => {
    const left = Float32Array.from([0.25, 0, 0.125, 0]);
    const right = Float32Array.from([0, 0.5, 0, 0.0625]);
    // Two slices of two samples: the larger of both channels in each (0.5 and 0.125).
    expect(computePeaks([left, right], 2)).toEqual([1, 0.25]);
    expect(computePeaks([right, left], 2)).toEqual([1, 0.25]);
  });

  it('pads with zeros when there are fewer samples than bars', () => {
    const peaks = computePeaks([Float32Array.from([0.5, 1, 0.25])]);
    expect(peaks).toHaveLength(28);
    expect(peaks.slice(0, 3)).toEqual([0.5, 1, 0.25]);
    expect(peaks.slice(3)).toEqual(new Array(25).fill(0));
  });

  it('takes the number of bars it is asked for', () => {
    expect(computePeaks([Float32Array.from([1, 1, 1, 1])], 4)).toEqual([1, 1, 1, 1]);
  });
});

describe('peakBarHeights', () => {
  it('is a flat row of 4 px bars before anything is decoded', () => {
    expect(peakBarHeights(null)).toEqual(new Array(28).fill(4));
  });

  it('maps 0 to 4 px and 1 to 22 px', () => {
    expect(peakBarHeights([0, 1, 0.5], 3)).toEqual([4, 22, 13]);
  });

  it('pads and trims to the number of bars', () => {
    const heights = peakBarHeights([1]);
    expect(heights).toHaveLength(28);
    expect(heights[0]).toBe(22);
    expect(heights.slice(1)).toEqual(new Array(27).fill(4));
  });

  it('keeps the bars inside 4 to 22 px whatever it is given', () => {
    expect(peakBarHeights([-1, 7, Number.NaN], 3)).toEqual([4, 22, 4]);
  });
});

describe('loadVoicePeaks', () => {
  function deps(overrides: Partial<PeaksDeps> = {}) {
    const fetch = vi.fn(async () => new Response(new ArrayBuffer(8)));
    const decode = vi.fn(async () => [Float32Array.from([0, 0.5, 1, 0.25])]);
    return { fetch, decode, all: { fetch, decode, ...overrides } satisfies PeaksDeps };
  }

  it('fetches the audio and gives the peaks of what the decoder returns', async () => {
    const { fetch, decode, all } = deps();
    const peaks = await loadVoicePeaks('/api/a', 'peaks-note-1', all);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/a');
    expect(decode).toHaveBeenCalledOnce();
    expect(peaks).toHaveLength(28);
    expect(peaks.slice(0, 4)).toEqual([0, 0.5, 1, 0.25]);
  });

  it('fetches and decodes once for one key, however many cards ask', async () => {
    const { fetch, decode, all } = deps();
    const [first, second] = await Promise.all([
      loadVoicePeaks('/api/b', 'peaks-note-2', all),
      loadVoicePeaks('/api/b', 'peaks-note-2', all),
    ]);
    const third = await loadVoicePeaks('/api/b', 'peaks-note-2', all);
    expect(fetch).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('keeps a different key apart', async () => {
    const { fetch, all } = deps();
    await loadVoicePeaks('/api/c', 'peaks-note-3', all);
    await loadVoicePeaks('/api/d', 'peaks-note-4', all);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects when the decoder fails, and does not keep the failure', async () => {
    const failing = deps({ decode: vi.fn(async () => Promise.reject(new Error('EncodingError'))) });
    await expect(loadVoicePeaks('/api/e', 'peaks-note-5', failing.all)).rejects.toThrow(
      'EncodingError',
    );

    const working = deps();
    const peaks = await loadVoicePeaks('/api/e', 'peaks-note-5', working.all);
    expect(working.fetch).toHaveBeenCalledOnce();
    expect(peaks).toHaveLength(28);
  });

  it('rejects when the audio does not load, and tries again next time', async () => {
    const missing = deps({ fetch: vi.fn(async () => new Response('', { status: 404 })) });
    await expect(loadVoicePeaks('/api/f', 'peaks-note-6', missing.all)).rejects.toThrow('404');
    expect(missing.decode).not.toHaveBeenCalled();

    const working = deps();
    await loadVoicePeaks('/api/f', 'peaks-note-6', working.all);
    expect(working.fetch).toHaveBeenCalledOnce();
  });
});
