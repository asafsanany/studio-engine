import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { graphicLengthSec, timeLabel } from './graphic-preview-logic';

/** The bar's height. The overlay that lines the "Making v3…" chip up with the picture uses it too. */
export const GRAPHIC_CONTROLS_HEIGHT_CLASS = 'h-14';

export const GRAPHIC_TIMELINE_LABEL = 'Time';

export interface GraphicControlsProps {
  /** Where the loop is, in seconds (the whole loop: the graphic's length plus the tail). */
  currentSec: number;
  /** The whole loop's length, as the player reports it (the graphic's length plus the tail). */
  durationSec: number;
  playing: boolean;
  /** Nothing to play yet (no version, or the player is not ready): the bar is dimmed. */
  disabled?: boolean;
  onTogglePlay(): void;
  /** "Play from the start". */
  onReplay(): void;
  /** The timeline moved (every step of a drag). */
  onSeek(seconds: number): void;
  /** The drag ended, or a click on the track landed. */
  onSeekCommit?(seconds: number): void;
  className?: string;
}

function ControlButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
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
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The bar under the picture (board GRStudio): play/pause, play from the start, the timeline and
 * "1.2 / 3.0 s". It is a column 420 px wide at most, dimmed while there is nothing to play. The time
 * stops at the graphic's own length; the tail of the loop that comes after reads "3.0 / 3.0 s".
 * Presentational only: the player owns the state (PreviewPlayer's `renderControls` gives it).
 */
export function GraphicControls({
  currentSec,
  durationSec,
  playing,
  disabled = false,
  onTogglePlay,
  onReplay,
  onSeek,
  onSeekCommit,
  className,
}: GraphicControlsProps) {
  const PlayPauseIcon = playing ? Pause : Play;
  const lengthSec = graphicLengthSec(durationSec);
  return (
    <div
      data-slot="graphic-controls"
      className={cn(
        'flex shrink-0 items-start justify-center px-4 transition-opacity duration-200 ease-in-out',
        GRAPHIC_CONTROLS_HEIGHT_CLASS,
        disabled && 'opacity-40',
        className,
      )}
    >
      <div className="flex h-8 w-full max-w-[420px] items-center gap-1.5">
        <ControlButton
          label={playing ? 'Pause' : 'Play'}
          disabled={disabled}
          onClick={onTogglePlay}
        >
          <PlayPauseIcon className="size-4 fill-current stroke-none" />
        </ControlButton>
        <ControlButton label="Play from the start" disabled={disabled} onClick={onReplay}>
          <RotateCcw className="size-4" />
        </ControlButton>
        <Slider
          aria-label={GRAPHIC_TIMELINE_LABEL}
          value={[Math.min(Math.max(0, currentSec), durationSec > 0 ? durationSec : 1)]}
          min={0}
          max={durationSec > 0 ? durationSec : 1}
          step={0.01}
          disabled={disabled}
          onValueChange={([value]) => onSeek(value ?? 0)}
          onValueCommit={([value]) => onSeekCommit?.(value ?? 0)}
          className="mx-2 h-5 min-w-0 flex-1"
          trackClassName="data-[orientation=horizontal]:h-1"
          rangeClassName="bg-foreground"
          thumbClassName="size-3 border-0 bg-foreground shadow-[0_1px_3px_rgb(0_0_0/0.6)] hover:ring-0"
        />
        <span className="min-w-[78px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {timeLabel(currentSec, lengthSec)}
        </span>
      </div>
    </div>
  );
}
