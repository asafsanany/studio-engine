import { describe, expect, it } from 'vitest';
import { libraryItems } from '@/features/library-picker/test-helpers';
import {
  compareKeyAction,
  type PausedLookState,
  pausedLookPill,
  pausedLookShows,
  pausedLookTarget,
  tenthsOf,
} from './paused-look';

const items = libraryItems();

describe('pausedLookTarget', () => {
  it('is null when the note names no LUT', () => {
    expect(pausedLookTarget('', items)).toBeNull();
    expect(pausedLookTarget('make it warmer', items)).toBeNull();
    expect(pausedLookTarget('show @graphics/name-on-a-white-pill here', items)).toBeNull();
  });

  it('is the LUT the note names', () => {
    expect(pausedLookTarget('Make it @luts/cinematic ', items)).toEqual({
      slug: 'cinematic',
      token: 'luts/cinematic',
      count: 1,
    });
    // A LUT of Yours too.
    expect(pausedLookTarget('@luts/golden-hour-warm', items)?.slug).toBe('golden-hour-warm');
  });

  it('is the last of several, and says how many', () => {
    expect(pausedLookTarget('@luts/cinematic then @luts/film-contrast', items)).toEqual({
      slug: 'film-contrast',
      token: 'luts/film-contrast',
      count: 2,
    });
  });

  it('counts a LUT named twice once, and a later graphic or camera LUT changes nothing', () => {
    const target = pausedLookTarget(
      '@luts/cinematic @luts/film-contrast @luts/cinematic @graphics/name-on-a-white-pill @luts/my-log',
      items,
    );
    expect(target).toEqual({ slug: 'cinematic', token: 'luts/cinematic', count: 2 });
  });

  it('gives a Camera LUT and a token that points at nothing no still', () => {
    // The picker never offers a Camera LUT, so it is not an item.
    expect(pausedLookTarget('@luts/my-log', items)).toBeNull();
    expect(pausedLookTarget('@luts/zzz', items)).toBeNull();
    // An unknown name after a good one leaves the good one.
    expect(pausedLookTarget('@luts/cinematic @luts/zzz', items)?.slug).toBe('cinematic');
  });

  it('only reads a token the way the engine does (at the start or after a space)', () => {
    expect(pausedLookTarget('mail@luts/cinematic', items)).toBeNull();
    expect(pausedLookTarget('(@luts/cinematic)', items)).toBeNull();
  });

  it('finds nothing while the libraries are not loaded', () => {
    expect(pausedLookTarget('@luts/cinematic', [])).toBeNull();
  });
});

describe('pausedLookPill', () => {
  it('names the token, or says it is the last of several', () => {
    expect(pausedLookPill({ token: 'luts/cinematic', count: 1 })).toBe('Previewing luts/cinematic');
    expect(pausedLookPill({ token: 'luts/film-contrast', count: 2 })).toBe(
      'Previewing the last of 2',
    );
    expect(pausedLookPill({ token: 'luts/x', count: 5 })).toBe('Previewing the last of 5');
  });
});

describe('compareKeyAction', () => {
  it('holds on Space and Enter going down and lets go on them coming up', () => {
    expect(compareKeyAction(' ', 'down')).toBe(true);
    expect(compareKeyAction('Enter', 'down')).toBe(true);
    expect(compareKeyAction(' ', 'up')).toBe(false);
    expect(compareKeyAction('Enter', 'up')).toBe(false);
  });

  it('leaves every other key alone', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowLeft', 'k']) {
      expect(compareKeyAction(key, 'down')).toBeNull();
      expect(compareKeyAction(key, 'up')).toBeNull();
    }
  });
});

describe('tenthsOf', () => {
  it('rounds to the nearest tenth of a second and never goes below 0', () => {
    expect(tenthsOf(12.34)).toBe(123);
    expect(tenthsOf(12.35)).toBe(124);
    expect(tenthsOf(0)).toBe(0);
    expect(tenthsOf(-3)).toBe(0);
    expect(tenthsOf(0.04)).toBe(0);
  });
});

describe('pausedLookShows', () => {
  const base: PausedLookState = {
    enabled: true,
    ready: true,
    playing: false,
    busy: false,
    target: { slug: 'cinematic', token: 'luts/cinematic', count: 1 },
    tenths: 123,
    settledTenths: 123,
  };

  it('shows when a LUT is named and the video stands still', () => {
    expect(pausedLookShows(base)).toBe(true);
  });

  it('hides while playing, while the playhead moves, with the switch off or no LUT named', () => {
    expect(pausedLookShows({ ...base, playing: true })).toBe(false);
    // Seeking or dragging: the playhead is not yet where it has stood.
    expect(pausedLookShows({ ...base, tenths: 150 })).toBe(false);
    expect(pausedLookShows({ ...base, settledTenths: null })).toBe(false);
    expect(pausedLookShows({ ...base, enabled: false })).toBe(false);
    expect(pausedLookShows({ ...base, target: null })).toBe(false);
  });

  it('hides before the player is ready and while a voice note has the box’s place', () => {
    expect(pausedLookShows({ ...base, ready: false })).toBe(false);
    expect(pausedLookShows({ ...base, busy: true })).toBe(false);
  });
});
