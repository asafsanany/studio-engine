import { describe, expect, it } from 'vitest';
import {
  acceptTimeUpdate,
  changeVolume,
  clampSpeed,
  clampTime,
  controlLabels,
  DEFAULT_SPEED,
  DEFAULT_VOLUME,
  formatPlayhead,
  formatSpeed,
  isSoundOn,
  MAX_SPEED,
  MIN_SPEED,
  PLAYER_SKELETON_DELAY_MS,
  SEEK_NEAR_SEC,
  SEEK_SETTLE_MS,
  TIMELINE_LABEL,
  TIMELINE_THUMB_PX,
  timelineLeft,
  toggleMute,
  VOLUME_LABEL,
} from './player-state';

describe('constants', () => {
  it('are the board and spec numbers', () => {
    expect(DEFAULT_VOLUME).toBe(0.8);
    expect(PLAYER_SKELETON_DELAY_MS).toBe(300);
    expect(TIMELINE_THUMB_PX).toBe(12);
    expect(TIMELINE_LABEL).toBe('Position in the video');
    expect(VOLUME_LABEL).toBe('Volume');
  });
});

describe('formatPlayhead', () => {
  it.each([
    [0, 6, '0:00'],
    [0.99, 6, '0:00'],
    [1, 6, '0:01'],
    [5.9, 6, '0:05'],
    [5.96, 6, '0:06'],
    [6, 6, '0:06'],
    [27.6, 27.6, '0:28'],
    [65.2, 120, '1:05'],
    [-1, 6, '0:00'],
    [Number.NaN, 6, '0:00'],
  ])('(%s of %s) reads %s', (current, duration, text) => {
    expect(formatPlayhead(current, duration)).toBe(text);
  });

  it('floors with no known length, and reads 0:00 for nonsense', () => {
    expect(formatPlayhead(2.9, 0)).toBe('0:02');
    expect(formatPlayhead(Number.NaN, 0)).toBe('0:00');
    expect(formatPlayhead(Number.POSITIVE_INFINITY, 0)).toBe('0:00');
  });
});

describe('clampTime', () => {
  it('keeps a time between 0 and the duration', () => {
    expect(clampTime(3, 6)).toBe(3);
    expect(clampTime(0, 6)).toBe(0);
    expect(clampTime(6, 6)).toBe(6);
    expect(clampTime(-2, 6)).toBe(0);
    expect(clampTime(9, 6)).toBe(6);
  });

  it('gives 0 for nonsense and for a duration of 0', () => {
    expect(clampTime(Number.NaN, 6)).toBe(0);
    expect(clampTime(Number.POSITIVE_INFINITY, 6)).toBe(0);
    expect(clampTime(3, 0)).toBe(0);
    expect(clampTime(3, -1)).toBe(0);
    expect(clampTime(3, Number.NaN)).toBe(0);
  });
});

describe('timelineLeft', () => {
  it('centres a point where Radix puts the thumb, inside the track', () => {
    expect(timelineLeft(0, 6)).toBe('calc(0% + 6px)');
    expect(timelineLeft(1.5, 6)).toBe('calc(25% + 3px)');
    expect(timelineLeft(3, 6)).toBe('calc(50% + 0px)');
    expect(timelineLeft(6, 6)).toBe('calc(100% - 6px)');
  });

  it('follows the thumb width', () => {
    expect(timelineLeft(0, 6, 8)).toBe('calc(0% + 4px)');
    expect(timelineLeft(6, 6, 8)).toBe('calc(100% - 4px)');
  });

  it('rounds to three decimals', () => {
    expect(timelineLeft(1, 3)).toBe('calc(33.333% + 2px)');
    expect(timelineLeft(2.4, 6)).toBe('calc(40% + 1.2px)');
  });

  it('clamps past the ends, and puts everything at the start without a length', () => {
    expect(timelineLeft(9, 6)).toBe('calc(100% - 6px)');
    expect(timelineLeft(-3, 6)).toBe('calc(0% + 6px)');
    expect(timelineLeft(Number.NaN, 6)).toBe('calc(0% + 6px)');
    expect(timelineLeft(3, 0)).toBe('calc(0% + 6px)');
  });
});

describe('toggleMute', () => {
  it('mutes a playing sound and remembers the volume', () => {
    expect(toggleMute({ muted: false, volume: 0.5 })).toEqual({ muted: true, volume: 0.5 });
  });

  it('unmutes to the volume it had', () => {
    expect(toggleMute({ muted: true, volume: 0.5 })).toEqual({ muted: false, volume: 0.5 });
  });

  it('unmutes from volume 0 to the default, 80 %', () => {
    expect(toggleMute({ muted: false, volume: 0 })).toEqual({ muted: false, volume: 0.8 });
    expect(toggleMute({ muted: true, volume: 0 })).toEqual({ muted: false, volume: 0.8 });
  });
});

describe('changeVolume', () => {
  it('sets the volume and unmutes (dragging up)', () => {
    expect(changeVolume(0.4)).toEqual({ volume: 0.4, muted: false });
    expect(changeVolume(1)).toEqual({ volume: 1, muted: false });
  });

  it('mutes at 0 (dragging down)', () => {
    expect(changeVolume(0)).toEqual({ volume: 0, muted: true });
  });

  it('keeps the volume between 0 and 1', () => {
    expect(changeVolume(3)).toEqual({ volume: 1, muted: false });
    expect(changeVolume(-1)).toEqual({ volume: 0, muted: true });
    expect(changeVolume(Number.NaN)).toEqual({ volume: 0, muted: true });
  });
});

describe('isSoundOn', () => {
  it('is on only when not muted and above 0', () => {
    expect(isSoundOn({ muted: false, volume: 0.8 })).toBe(true);
    expect(isSoundOn({ muted: true, volume: 0.8 })).toBe(false);
    expect(isSoundOn({ muted: false, volume: 0 })).toBe(false);
  });
});

describe('controlLabels', () => {
  const state = { playing: false, soundOn: true, fullscreen: false };

  it('names Play, Mute and Full screen at the start', () => {
    const labels = controlLabels(state);
    expect(labels.play).toEqual({ label: 'Play', tooltip: 'Play (Space)' });
    expect(labels.mute).toEqual({ label: 'Mute', tooltip: 'Mute (M)' });
    expect(labels.fullscreen).toEqual({ label: 'Full screen', tooltip: 'Full screen (F)' });
  });

  it('names Pause, Unmute and Exit full screen in the other states', () => {
    const labels = controlLabels({ playing: true, soundOn: false, fullscreen: true });
    expect(labels.play).toEqual({ label: 'Pause', tooltip: 'Pause (Space)' });
    expect(labels.mute).toEqual({ label: 'Unmute', tooltip: 'Unmute (M)' });
    expect(labels.fullscreen).toEqual({
      label: 'Exit full screen',
      tooltip: 'Exit full screen (F or Esc)',
    });
  });
});

describe('acceptTimeUpdate', () => {
  // A seek to 4 s, made at 1000 ms on the performance clock.
  const seek = { seekTarget: 4, seekAt: 1000 };

  it('has the numbers of the item: near is 0.25 s, the wait is 300 ms', () => {
    expect(SEEK_NEAR_SEC).toBe(0.25);
    expect(SEEK_SETTLE_MS).toBe(300);
  });

  it('drops a stale earlier time that arrives right after a seek', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 1 })).toBe(false);
    expect(acceptTimeUpdate({ ...seek, now: 1150, reported: 3.2 })).toBe(false);
    expect(acceptTimeUpdate({ ...seek, now: 1299, reported: 0 })).toBe(false);
  });

  it('drops a stale later time too (a seek backwards)', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 5.5 })).toBe(false);
  });

  it('takes a time near the target', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 4 })).toBe(true);
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 3.9 })).toBe(true);
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 4.25 })).toBe(true);
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 3.75 })).toBe(true);
  });

  it('drops a time just outside the near range', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 4.26 })).toBe(false);
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: 3.74 })).toBe(false);
  });

  it('takes any time once the wait is over', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1300, reported: 1 })).toBe(true);
    expect(acceptTimeUpdate({ ...seek, now: 5000, reported: 0 })).toBe(true);
    expect(acceptTimeUpdate({ ...seek, now: 5000, reported: 9 })).toBe(true);
  });

  it('takes everything when no seek is pending', () => {
    expect(acceptTimeUpdate({ seekTarget: null, seekAt: null, now: 1010, reported: 1 })).toBe(true);
    expect(acceptTimeUpdate({ seekTarget: null, seekAt: null, now: 0, reported: 99 })).toBe(true);
  });

  it('judges a seek to 0 and a seek to the end by the same range', () => {
    expect(acceptTimeUpdate({ seekTarget: 0, seekAt: 0, now: 50, reported: 2.4 })).toBe(false);
    expect(acceptTimeUpdate({ seekTarget: 0, seekAt: 0, now: 50, reported: 0.1 })).toBe(true);
    expect(acceptTimeUpdate({ seekTarget: 6, seekAt: 0, now: 50, reported: 5.9 })).toBe(true);
  });

  it('drops a nonsense time within the wait, and takes it after', () => {
    expect(acceptTimeUpdate({ ...seek, now: 1010, reported: Number.NaN })).toBe(false);
    expect(acceptTimeUpdate({ ...seek, now: 1400, reported: Number.NaN })).toBe(true);
  });
});

describe('clampSpeed', () => {
  it('keeps the speed between 0.3× and 3×, starting at 1×', () => {
    expect([MIN_SPEED, DEFAULT_SPEED, MAX_SPEED]).toEqual([0.3, 1, 3]);
    expect(clampSpeed(1.5)).toBe(1.5);
    expect(clampSpeed(0.1)).toBe(0.3);
    expect(clampSpeed(4)).toBe(3);
  });

  it('rounds to the slider’s 0.1 step', () => {
    expect(clampSpeed(0.30000000000000004)).toBe(0.3);
    expect(clampSpeed(1.26)).toBe(1.3);
  });

  it('makes anything unusable 1×', () => {
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(-2)).toBe(1);
  });
});

describe('formatSpeed', () => {
  it('writes the speed with a ×, no trailing zeros', () => {
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(0.3)).toBe('0.3×');
    expect(formatSpeed(2.5)).toBe('2.5×');
    expect(formatSpeed(3)).toBe('3×');
  });
});
