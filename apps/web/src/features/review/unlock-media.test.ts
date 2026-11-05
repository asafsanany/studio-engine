import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlockMedia } from './unlock-media';

/** A stand-in <video>: records play() and pause(); play() rejects as WebKit's does after a pause. */
function fakeMedia({ paused = true } = {}) {
  const calls: string[] = [];
  const media = {
    paused,
    play: vi.fn(() => {
      calls.push('play');
      return Promise.reject(new DOMException('interrupted by pause()', 'AbortError'));
    }),
    pause: vi.fn(() => {
      calls.push('pause');
    }),
  };
  return { media, calls };
}

function fakeDocument(media: object[]) {
  return { querySelectorAll: vi.fn(() => media) } as unknown as Document;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unlockMedia', () => {
  it('calls play() and then pause() on each paused <video> and <audio>, during the tap', () => {
    const video = fakeMedia();
    const audio = fakeMedia();
    const doc = fakeDocument([video.media, audio.media]);
    unlockMedia(doc);
    expect(doc.querySelectorAll).toHaveBeenCalledWith('video, audio');
    expect(video.calls).toEqual(['play', 'pause']);
    expect(audio.calls).toEqual(['play', 'pause']);
  });

  it('unlocks an element only once: the next tap leaves it to the player', () => {
    const video = fakeMedia();
    const doc = fakeDocument([video.media]);
    unlockMedia(doc);
    unlockMedia(doc);
    expect(video.calls).toEqual(['play', 'pause']);
  });

  it('leaves an element that is playing alone', () => {
    const playing = fakeMedia({ paused: false });
    unlockMedia(fakeDocument([playing.media]));
    expect(playing.calls).toEqual([]);
  });

  it('catches the play() promise, which the pause rejects', () => {
    const caught = vi.fn();
    const media = { paused: true, play: () => ({ catch: caught }), pause: vi.fn() };
    unlockMedia(fakeDocument([media]));
    expect(caught).toHaveBeenCalledOnce();
  });

  it('does nothing without a document (the iframe is not there yet)', () => {
    expect(() => unlockMedia(null)).not.toThrow();
    expect(() => unlockMedia(undefined)).not.toThrow();
  });

  it('does nothing outside a tap, so a later tap still unlocks', () => {
    const video = fakeMedia();
    const doc = fakeDocument([video.media]);
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    unlockMedia(doc);
    expect(video.calls).toEqual([]);
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    unlockMedia(doc);
    expect(video.calls).toEqual(['play', 'pause']);
  });
});
