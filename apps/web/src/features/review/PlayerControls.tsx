import { clock } from '@studio/shared';
import { Maximize, Minimize, Volume2, VolumeX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  controlLabels,
  formatPlayhead,
  formatSpeed,
  isSoundOn,
  MAX_SPEED,
  MIN_SPEED,
  SPEED_LABEL,
  SPEED_RESET,
  SPEED_STEP,
  TIMELINE_LABEL,
  VOLUME_LABEL,
} from './player-state';

export interface PlayerControlsProps {
  currentSec: number;
  durationSec: number;
  playing: boolean;
  muted: boolean;
  /** 0 to 1. */
  volume: number;
  fullscreen: boolean;
  /** The playback speed, MIN_SPEED to MAX_SPEED. With `onSpeedChange`, the bar has a speed slider. */
  speed?: number;
  /** Everything is disabled until the player is ready. */
  disabled?: boolean;
  /** Drawn over the timeline track, below the thumb: the review notes' dots. */
  timelineOverlay?: ReactNode;
  /** Drawn at the right of the buttons row, before full screen: what the video plays ("Music v2"). */
  trailing?: ReactNode;
  onTogglePlay(): void;
  /** The timeline moved (every step of a drag). */
  onSeek(seconds: number): void;
  /** The drag ended, or a click on the track landed. */
  onSeekCommit?(seconds: number): void;
  onToggleMute(): void;
  onVolumeChange(volume: number): void;
  /** The speed slider moved, or its readout was clicked (back to 1×). */
  onSpeedChange?(speed: number): void;
  onToggleFullscreen(): void;
  className?: string;
}

const SLIDER_TRACK = 'data-[orientation=horizontal]:h-1';

/** A ghost icon button with its tooltip: the board's controls, no title attributes. */
function ControlButton({
  label,
  tooltip,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The bar under the video (the board's 76 px): row 1 the playhead, the timeline and the length;
 * row 2 play/pause, mute with a volume slider, the speed (its readout, which goes back to 1×, and a
 * slider; only with `onSpeedChange`), and full screen at the right. Presentational only:
 * PreviewPlayer owns the state. There are no skip buttons.
 */
export function PlayerControls({
  currentSec,
  durationSec,
  playing,
  muted,
  volume,
  fullscreen,
  speed = 1,
  disabled = false,
  timelineOverlay,
  trailing,
  onTogglePlay,
  onSeek,
  onSeekCommit,
  onToggleMute,
  onVolumeChange,
  onSpeedChange,
  onToggleFullscreen,
  className,
}: PlayerControlsProps) {
  const soundOn = isSoundOn({ muted, volume });
  const labels = controlLabels({ playing, soundOn, fullscreen });
  const PlayPauseIcon = playing ? Pause : Play;
  const SoundIcon = soundOn ? Volume2 : VolumeX;
  const FullscreenIcon = fullscreen ? Minimize : Maximize;

  return (
    <div
      data-slot="player-controls"
      className={cn(
        '@container flex h-[76px] shrink-0 flex-col gap-1.5 border-t bg-background px-3 pt-2 pb-[9px]',
        className,
      )}
    >
      <div className="flex h-5 items-center gap-2.5">
        <span className="shrink-0 text-xs tabular-nums text-foreground">
          {formatPlayhead(currentSec, durationSec)}
        </span>
        <Slider
          aria-label={TIMELINE_LABEL}
          value={[currentSec]}
          min={0}
          max={durationSec > 0 ? durationSec : 1}
          step={0.01}
          disabled={disabled}
          onValueChange={([value]) => onSeek(value ?? 0)}
          onValueCommit={([value]) => onSeekCommit?.(value ?? 0)}
          className="h-5 min-w-0 flex-1"
          trackClassName={SLIDER_TRACK}
          rangeClassName="bg-foreground"
          thumbClassName="size-3 border-0 bg-foreground shadow-[0_1px_3px_rgb(0_0_0/0.6)] hover:ring-0"
        >
          {timelineOverlay ? (
            <div className="pointer-events-none absolute inset-0">{timelineOverlay}</div>
          ) : null}
        </Slider>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {clock(durationSec)}
        </span>
      </div>

      <div className="flex h-8 items-center gap-0.5">
        <ControlButton
          label={labels.play.label}
          tooltip={labels.play.tooltip}
          disabled={disabled}
          onClick={onTogglePlay}
        >
          <PlayPauseIcon className="size-[18px] fill-current stroke-none" />
        </ControlButton>
        <div className="ml-1 flex items-center gap-1">
          <ControlButton
            label={labels.mute.label}
            tooltip={labels.mute.tooltip}
            disabled={disabled}
            onClick={onToggleMute}
          >
            <SoundIcon className="size-[18px]" />
          </ControlButton>
          <Slider
            aria-label={VOLUME_LABEL}
            value={[muted ? 0 : volume]}
            min={0}
            max={1}
            step={0.01}
            disabled={disabled}
            onValueChange={([value]) => onVolumeChange(value ?? 0)}
            className="h-5 w-14 shrink-0"
            trackClassName={SLIDER_TRACK}
            rangeClassName="bg-foreground"
            thumbClassName="size-2.5 border-0 bg-foreground shadow-none hover:ring-0"
          />
        </div>
        {onSpeedChange ? (
          <div data-slot="player-speed" className="ml-2 flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={SPEED_RESET.label}
                  disabled={disabled}
                  onClick={() => onSpeedChange(1)}
                  className="w-11 px-0 text-xs tabular-nums"
                >
                  {formatSpeed(speed)}
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{SPEED_RESET.tooltip}</TooltipContent>
            </Tooltip>
            <Slider
              aria-label={SPEED_LABEL}
              value={[speed]}
              min={MIN_SPEED}
              max={MAX_SPEED}
              step={SPEED_STEP}
              disabled={disabled}
              onValueChange={([value]) => onSpeedChange(value ?? 1)}
              className="h-5 w-20 shrink-0"
              trackClassName={SLIDER_TRACK}
              rangeClassName="bg-foreground"
              thumbClassName="size-2.5 border-0 bg-foreground shadow-none hover:ring-0"
            />
          </div>
        ) : null}
        {/* Takes the room that is left, so a long label shortens instead of pushing full screen out;
            in a narrow bar (a 9:16 video) it is left to screen readers. */}
        <div
          data-slot="player-trailing"
          className="ml-2 flex min-w-0 flex-1 justify-end @max-[440px]:*:sr-only"
        >
          {trailing}
        </div>
        <ControlButton
          label={labels.fullscreen.label}
          tooltip={labels.fullscreen.tooltip}
          disabled={disabled}
          onClick={onToggleFullscreen}
        >
          <FullscreenIcon className="size-[18px]" />
        </ControlButton>
      </div>
    </div>
  );
}
