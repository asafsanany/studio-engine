import { clock } from '@studio/shared';

/** The volume the player starts at, and goes back to when unmuting from 0 (the board's 80 %). */
export const DEFAULT_VOLUME = 0.8;
/** How long the player waits before it draws its skeleton (a fast load never flashes one). */
export const PLAYER_SKELETON_DELAY_MS = 300;
/** The timeline thumb's width in px (the board's 12), which Radix keeps inside the track. */
export const TIMELINE_THUMB_PX = 12;
export const TIMELINE_LABEL = 'Position in the video';
export const VOLUME_LABEL = 'Volume';

/** `seconds` kept between 0 and the duration. Anything unusable is 0. */
export function clampTime(seconds: number, durationSec: number): number {
  if (!(durationSec > 0) || !Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, durationSec);
}

/** After a seek, a report within this many seconds of where we jumped counts as the player catching up. */
export const SEEK_NEAR_SEC = 0.25;
/** After a seek, reports far from the target are ignored for at most this long. */
export const SEEK_SETTLE_MS = 300;

/**
 * Whether a `timeupdate` from the player may move the playhead. The player throttles its reports,
 * and one already on its way when we seek still carries the time before the seek; taken as it is,
 * it would pull the playhead (and the time a note gets pinned at) back to the old second. So after
 * a seek (`seekTarget`, made at `seekAt`, both `null` when none is pending), a report far from the
 * target (more than SEEK_NEAR_SEC) is dropped, until one arrives near it or SEEK_SETTLE_MS have
 * passed. The caller forgets the seek as soon as a report is taken. With no seek pending, every
 * report is taken, so while playing the playhead moves as the player says.
 *
 * `seekAt` and `now` are on the same clock, in milliseconds (performance.now()).
 */
export function acceptTimeUpdate(input: {
  seekTarget: number | null;
  seekAt: number | null;
  now: number;
  reported: number;
}): boolean {
  const { seekTarget, seekAt, now, reported } = input;
  if (seekTarget === null || seekAt === null) return true;
  if (now - seekAt >= SEEK_SETTLE_MS) return true;
  return Math.abs(reported - seekTarget) <= SEEK_NEAR_SEC;
}

/**
 * The playhead as a clock: "0:00", "0:06". It floors, so it never runs ahead of the picture; but
 * within 50 ms of the end it reads the same as the length label (`clock(durationSec)`, which
 * rounds, as the Jobs page does), so a finished 5.96 s video reads "0:06 / 0:06".
 */
export function formatPlayhead(currentSec: number, durationSec: number): string {
  if (durationSec > 0 && currentSec >= durationSec - 0.05) return clock(durationSec);
  return clock(Math.floor(Math.max(0, currentSec)));
}

/**
 * The CSS `left` of a point on the timeline, for something drawn over the track (the notes' dots):
 * the centre of where Radix puts the thumb for that time. Radix keeps the thumb inside the track
 * (getThumbInBoundsOffset in @radix-ui/react-slider 1.6.1), so the position is the percentage
 * plus an offset that runs from +thumb/2 at the start to -thumb/2 at the end. Put the dot there
 * with `-translate-x-1/2`.
 */
export function timelineLeft(
  seconds: number,
  durationSec: number,
  thumbPx: number = TIMELINE_THUMB_PX,
): string {
  const ratio = durationSec > 0 && Number.isFinite(seconds) ? seconds / durationSec : 0;
  const percent = Number((Math.min(1, Math.max(0, ratio)) * 100).toFixed(3));
  const offset = Number(((thumbPx / 2) * (1 - percent / 50)).toFixed(3));
  return offset < 0
    ? `calc(${percent}% - ${Math.abs(offset)}px)`
    : `calc(${percent}% + ${offset}px)`;
}

export interface AudioState {
  muted: boolean;
  /** 0 to 1. */
  volume: number;
}

/**
 * The mute button. Muted, or at volume 0, it unmutes (from 0 it goes back to the default volume);
 * otherwise it mutes and remembers the volume.
 */
export function toggleMute(state: AudioState): AudioState {
  if (state.muted || state.volume === 0) {
    return { muted: false, volume: state.volume === 0 ? DEFAULT_VOLUME : state.volume };
  }
  return { muted: true, volume: state.volume };
}

/** The volume slider: dragging to 0 mutes, dragging up from 0 unmutes. */
export function changeVolume(volume: number): AudioState {
  const next = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
  return { volume: next, muted: next === 0 };
}

export function isSoundOn(state: AudioState): boolean {
  return !state.muted && state.volume > 0;
}

export interface ControlLabel {
  /** The button's accessible name. */
  label: string;
  /** The tooltip text, with the key. */
  tooltip: string;
}

/** The texts of the three toggling buttons, from the board. */
export function controlLabels(state: { playing: boolean; soundOn: boolean; fullscreen: boolean }): {
  play: ControlLabel;
  mute: ControlLabel;
  fullscreen: ControlLabel;
} {
  return {
    play: state.playing
      ? { label: 'Pause', tooltip: 'Pause (Space)' }
      : { label: 'Play', tooltip: 'Play (Space)' },
    mute: state.soundOn
      ? { label: 'Mute', tooltip: 'Mute (M)' }
      : { label: 'Unmute', tooltip: 'Unmute (M)' },
    fullscreen: state.fullscreen
      ? { label: 'Exit full screen', tooltip: 'Exit full screen (F or Esc)' }
      : { label: 'Full screen', tooltip: 'Full screen (F)' },
  };
}

/** The speed slider (the owner: 0.3× to 3×), in steps of 0.1×. The player starts at 1×. */
export const MIN_SPEED = 0.3;
export const MAX_SPEED = 3;
export const SPEED_STEP = 0.1;
export const DEFAULT_SPEED = 1;
export const SPEED_LABEL = 'Playback speed';
export const SPEED_RESET = { label: 'Back to normal speed', tooltip: 'Normal speed (1×)' } as const;

/** `speed` kept between MIN_SPEED and MAX_SPEED, to the step's 0.1. Anything unusable is 1×. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return DEFAULT_SPEED;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 10) / 10;
}

/** The speed as the bar writes it: "0.3×", "1×", "2.5×". */
export function formatSpeed(speed: number): string {
  return `${clampSpeed(speed)}×`;
}
