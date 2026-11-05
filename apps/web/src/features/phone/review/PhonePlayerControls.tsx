import { clock } from '@studio/shared';
import { MessageSquare, Mic, Pencil } from 'lucide-react';
import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import type { PlayerControlsProps } from '@/features/review/PlayerControls';
import { controlLabels, formatPlayhead, TIMELINE_LABEL } from '@/features/review/player-state';
import { cn } from '@/lib/utils';
import { PHONE_REVIEW_TEXT } from './phone-review';

export interface PhonePlayerControlsProps {
  /** What the player hands over: the playhead, the scrub handlers and play/pause. */
  controls: PlayerControlsProps;
  /** How many notes the job has: the number on the Notes button. */
  noteCount: number;
  notesOpen: boolean;
  /**
   * The row of Play, Notes, Record and Write. It goes once Send or Approve went through (board
   * MReviewDone): the job has left Review, so there is nothing left to add notes to. The timeline
   * stays, and a tap on the video still plays it. Default: shown.
   */
  showButtons?: boolean;
  /** The note box is open: Write shows pressed (board MReviewWrite). */
  writing?: boolean;
  /** The video can't start (a note is being written): Play is off. */
  playLocked?: boolean;
  onToggleNotes: () => void;
  /** Record: pauses and records a voice note pinned at the playhead (board MReviewRec). */
  onRecord?: () => void;
  /** Write: pauses, opens the notes and the note box, and brings up the keyboard (board MReviewWrite). */
  onWrite?: () => void;
}

/** An outlined 40 px button of the row: icon, word, and (Notes) the number. */
function RowButton({
  pressed,
  onClick,
  children,
}: {
  pressed?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-10 gap-1.5 rounded-md px-2.5 text-sm font-medium has-[>svg]:px-2.5 [&_svg:not([class*="size-"])]:size-4',
        pressed && 'bg-secondary dark:bg-secondary',
      )}
    >
      {children}
    </Button>
  );
}

/**
 * What goes under the video on the phone (board MReview), in place of the Mac's bar:
 *
 * - a 32 px timeline: the playhead's time, the track with the notes' blue dots (the player draws
 *   them: `controls.timelineOverlay`; a tap on one opens the notes there), and the length. The track
 *   is a slider, so a finger can scrub it: the player pauses while it is dragged and plays again
 *   after, if it was playing.
 * - a 52 px row: a 44 px Play/Pause, then the outlined Notes N, Record and Write at the right.
 *   While a note is written Write shows pressed and Play is off (the frame stays put).
 *
 * There is no volume (the phone has its own buttons) and no full screen (iPhone Safari has none
 * for an element). Presentational: the player owns the state.
 */
export function PhonePlayerControls({
  controls,
  noteCount,
  notesOpen,
  showButtons = true,
  writing = false,
  playLocked = false,
  onToggleNotes,
  onRecord,
  onWrite,
}: PhonePlayerControlsProps) {
  const { currentSec, durationSec, playing, disabled = false, timelineOverlay } = controls;
  const labels = controlLabels({ playing, soundOn: true, fullscreen: false });
  const PlayPauseIcon = playing ? Pause : Play;

  return (
    <>
      <div
        data-slot="phone-timeline"
        className="flex h-8 shrink-0 items-center gap-2.5 border-t border-white/10 bg-background px-4"
      >
        <span className="w-[30px] shrink-0 text-xs tabular-nums text-foreground">
          {formatPlayhead(currentSec, durationSec)}
        </span>
        <Slider
          aria-label={TIMELINE_LABEL}
          value={[currentSec]}
          min={0}
          max={durationSec > 0 ? durationSec : 1}
          step={0.01}
          disabled={disabled}
          onValueChange={([value]) => controls.onSeek(value ?? 0)}
          onValueCommit={([value]) => controls.onSeekCommit?.(value ?? 0)}
          className="h-7 min-w-0 flex-1"
          trackClassName="data-[orientation=horizontal]:h-1"
          rangeClassName="bg-foreground"
          thumbClassName="size-3.5 border-0 bg-foreground shadow-[0_1px_3px_rgb(0_0_0/0.6)] hover:ring-0 focus-visible:ring-0"
        >
          {timelineOverlay ? (
            <div className="pointer-events-none absolute inset-0">{timelineOverlay}</div>
          ) : null}
        </Slider>
        <span className="w-[30px] shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {clock(durationSec)}
        </span>
      </div>

      {showButtons && (
        <div
          data-slot="phone-review-controls"
          className="flex h-[52px] shrink-0 items-center gap-1.5 bg-background pr-3 pl-1.5"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={labels.play.label}
            disabled={disabled || (playLocked && !playing)}
            onClick={controls.onTogglePlay}
            className="size-11 dark:hover:bg-accent"
          >
            <PlayPauseIcon className="size-5 fill-current stroke-none" />
          </Button>
          <span className="flex-1" />
          <RowButton pressed={notesOpen} onClick={onToggleNotes}>
            <MessageSquare aria-hidden="true" />
            {PHONE_REVIEW_TEXT.notes}
            <span
              data-slot="phone-note-count"
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-700 px-1.5 text-xs tabular-nums"
            >
              {noteCount}
            </span>
          </RowButton>
          <RowButton onClick={onRecord}>
            <Mic aria-hidden="true" />
            {PHONE_REVIEW_TEXT.record}
          </RowButton>
          <RowButton pressed={writing} onClick={onWrite}>
            <Pencil aria-hidden="true" />
            {PHONE_REVIEW_TEXT.write}
          </RowButton>
        </div>
      )}
    </>
  );
}
