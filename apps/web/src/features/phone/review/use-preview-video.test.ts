import { describe, expect, it } from 'vitest';
import { phonePreviewSrc, previewVideoAnswer } from './use-preview-video';

// The phone's player: the small MP4 when it's ready, the live preview otherwise, and (Soundtrack)
// what happens to both when the music's rev changes.

describe('previewVideoAnswer', () => {
  it('plays the MP4 once it is ready, with the rev it was asked for', () => {
    expect(previewVideoAnswer('ready', false, 456)).toEqual({ state: 'ready', readyRev: 456 });
    expect(previewVideoAnswer('ready', true, undefined)).toEqual({
      state: 'ready',
      readyRev: undefined,
    });
  });

  it('waits for the first MP4 of an opening', () => {
    expect(previewVideoAnswer('making', false, 456)).toEqual({
      state: 'making',
      readyRev: undefined,
    });
  });

  it('plays the live preview while the MP4 is made again after a music change', () => {
    expect(previewVideoAnswer('making', true, 789)).toEqual({
      state: 'unavailable',
      readyRev: undefined,
    });
  });

  it('plays the MP4 asked for the quick fixes’ rev too, and the live preview while a fix’s MP4 is made', () => {
    expect(previewVideoAnswer('ready', true, 456, 9)).toEqual({
      state: 'ready',
      readyRev: 456,
      readyFixRev: 9,
    });
    expect(previewVideoAnswer('ready', true, 456, null).readyFixRev).toBeUndefined();
    expect(previewVideoAnswer('making', true, 456, 9)).toEqual({
      state: 'unavailable',
      readyRev: undefined,
    });
  });

  it('falls back to the live preview when the MP4 cannot be had', () => {
    expect(previewVideoAnswer('unavailable', false, 456).state).toBe('unavailable');
    expect(previewVideoAnswer('unavailable', true, 456).state).toBe('unavailable');
  });
});

describe('phonePreviewSrc', () => {
  const base = { jobId: 'r1', round: 2 };

  it('plays a sample as it is', () => {
    expect(
      phonePreviewSrc({
        ...base,
        src: '/sample/index.html',
        musicRev: 456,
        video: { state: 'ready', readyRev: 456 },
      }),
    ).toBe('/sample/index.html');
  });

  it('plays the MP4 made for its rev, at the round the review opened on', () => {
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: 789,
        video: { state: 'ready', readyRev: 456 },
      }),
    ).toBe('/api/jobs/r1/preview-video.mp4?r=2&m=456');
  });

  it('plays the live preview with the music’s current rev while there is no MP4', () => {
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: 789,
        video: { state: 'unavailable', readyRev: undefined },
      }),
    ).toBe('/api/jobs/r1/preview/index.html?r=2&m=789');
  });

  it('plays the MP4 made for the quick fixes’ rev, and the live preview with the current one', () => {
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: 789,
        fixRev: 12,
        video: { state: 'ready', readyRev: 456, readyFixRev: 9 },
      }),
    ).toBe('/api/jobs/r1/preview-video.mp4?r=2&m=456&f=9');
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: 789,
        fixRev: 12,
        video: { state: 'unavailable', readyRev: undefined },
      }),
    ).toBe('/api/jobs/r1/preview/index.html?r=2&m=789&f=12');
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: undefined,
        fixRev: null,
        video: { state: 'unavailable', readyRev: undefined },
      }),
    ).toBe('/api/jobs/r1/preview/index.html?r=2');
  });

  it('asks as before for a job without music, and while Soundtrack is off', () => {
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: undefined,
        video: { state: 'unavailable', readyRev: undefined },
      }),
    ).toBe('/api/jobs/r1/preview/index.html?r=2');
    expect(
      phonePreviewSrc({
        ...base,
        src: undefined,
        musicRev: undefined,
        video: { state: 'ready', readyRev: undefined },
      }),
    ).toBe('/api/jobs/r1/preview-video.mp4?r=2');
  });
});
