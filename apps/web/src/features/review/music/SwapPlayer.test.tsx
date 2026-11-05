import { describe, expect, it, vi } from 'vitest';
import { renderReview, tagWith } from '../test-helpers';

// A server render shows a lazy component's fallback, so the lazy player is the real one here.
vi.mock('../LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('../PreviewPlayer')).PreviewPlayer,
}));

const { SwapPlayer, landNext, landsOn, placeNext } = await import('./SwapPlayer');

// The review's player that follows its src (Soundtrack: the music's rev is in it): what it does when
// a new player has loaded behind the one on show, and how it looks before there is a second one.

function handle() {
  const calls: string[] = [];
  return {
    calls,
    pause: () => void calls.push('pause'),
    seek: (seconds: number) => void calls.push(`seek ${seconds}`),
    play: () => void calls.push('play'),
  };
}

describe('placeNext', () => {
  it('puts the new player where the old one was and plays on, after stopping the old one', () => {
    const shown = handle();
    const next = handle();
    placeNext({ shown, next, sec: 12.4, playing: true });
    expect(shown.calls).toEqual(['pause']);
    expect(next.calls).toEqual(['seek 12.4', 'play']);
  });

  it('keeps a paused video paused: the new player only goes to the time', () => {
    const shown = handle();
    const next = handle();
    placeNext({ shown, next, sec: 7, playing: false });
    expect(shown.calls).toEqual([]);
    expect(next.calls).toEqual(['seek 7']);
  });

  it('copes with a player that is already gone', () => {
    const next = handle();
    placeNext({ shown: undefined, next, sec: 3, playing: true });
    expect(next.calls).toEqual(['seek 3', 'play']);
    expect(() =>
      placeNext({ shown: handle(), next: undefined, sec: 3, playing: true }),
    ).not.toThrow();
  });
});

describe('landNext', () => {
  it('puts the new player at the fix’s moment and stops it there, after stopping the old one', () => {
    const shown = handle();
    const next = handle();
    landNext({ shown, next, sec: 12.4, playing: true });
    expect(shown.calls).toEqual(['pause']);
    expect(next.calls).toEqual(['seek 12.4', 'pause']);
  });

  it('leaves a paused old player alone, and still goes to the moment (not to where the old one was)', () => {
    const shown = handle();
    const next = handle();
    landNext({ shown, next, sec: 30, playing: false });
    expect(shown.calls).toEqual([]);
    expect(next.calls).toEqual(['seek 30', 'pause']);
  });

  it('never plays on, unlike placeNext', () => {
    const next = handle();
    landNext({ shown: handle(), next, sec: 3, playing: true });
    expect(next.calls).not.toContain('play');
  });

  it('copes with a player that is already gone', () => {
    const next = handle();
    landNext({ shown: undefined, next, sec: 3, playing: true });
    expect(next.calls).toEqual(['seek 3', 'pause']);
    expect(() =>
      landNext({ shown: handle(), next: undefined, sec: 3, playing: true }),
    ).not.toThrow();
  });
});

describe('landsOn: which swap is the fix landing', () => {
  const landing = { rev: 1792705695440, sec: 12.4 };
  const before = '/api/jobs/r1/preview/index.html?r=1';
  const after = '/api/jobs/r1/preview/index.html?r=1&f=1792705695440';

  it('is the first player to carry the new rev: the reload when a fix lands', () => {
    expect(landsOn(landing, before, after)).toBe(true);
    expect(landsOn(landing, '/api/jobs/r1/preview/index.html?r=1&f=1792700000000', after)).toBe(
      true,
    );
  });

  it('is not a swap for another reason: a music pick keeps the time and plays on', () => {
    const picked = '/api/jobs/r1/preview/index.html?r=1&m=1792706000000&f=1792705695440';
    expect(landsOn(landing, after, picked)).toBe(false);
    expect(landsOn(landing, picked, after)).toBe(false);
  });

  it('is not the phone’s MP4 taking over from the live preview of the same fix', () => {
    expect(landsOn(landing, after, '/api/jobs/r1/preview-video.mp4?r=1&f=1792705695440')).toBe(
      false,
    );
  });

  it('is the phone’s live preview taking over from the MP4 of the fix before', () => {
    expect(landsOn(landing, '/api/jobs/r1/preview-video.mp4?r=1&f=1792700000000', after)).toBe(
      true,
    );
    expect(landsOn(landing, '/api/jobs/r1/preview-video.mp4?r=1', after)).toBe(true);
  });

  it('is not a swap to an address without the rev, or when nothing landed', () => {
    expect(landsOn(landing, after, before)).toBe(false);
    expect(landsOn(null, before, after)).toBe(false);
  });
});

describe('<SwapPlayer>', () => {
  const props = {
    src: '/api/jobs/r1/preview/index.html?r=0&m=1792700000000',
    videoWidth: 1080,
    videoHeight: 1920,
    maxWidth: 400,
    maxHeight: 700,
    durationSec: 39,
  };

  it('is one player at the src it is given, in place (nothing hidden, no wrapper)', () => {
    const html = renderReview(<SwapPlayer {...props} />);
    expect(html.match(/<hyperframes-player/g)).toHaveLength(1);
    expect(tagWith(html, '<hyperframes-player')).toContain(
      `src="${props.src.replace('&', '&amp;')}"`,
    );
    expect(html).not.toContain('invisible');
    // The column is the player's own: the same markup as before the swap player (a direct child).
    expect(html.startsWith('<div data-slot="preview-player"')).toBe(true);
  });

  it('gives the player its class, and its poster', () => {
    const html = renderReview(
      <SwapPlayer {...props} className="min-h-0 flex-1" poster="/api/jobs/r1/preview-poster?r=0" />,
    );
    expect(tagWith(html, 'data-slot="preview-player"')).toContain('min-h-0 flex-1');
    expect(html).toContain('data-slot="preview-poster"');
  });
});
