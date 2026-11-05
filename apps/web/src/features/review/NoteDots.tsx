import type { ReviewNote } from '@studio/shared';
import { cn } from '@/lib/utils';
import { noteDotLabel, noteDotSize, noteTime } from './notes-logic';
import { timelineLeft } from './player-state';
import { VOICE_TEXT } from './review-text';

interface NoteDotsProps {
  notes: readonly ReviewNote[];
  durationSec: number;
  /** The note whose card (or dot) the pointer is on. */
  hoveredId: string | null;
  isActive: (note: ReviewNote) => boolean;
  onHover: (noteId: string | null) => void;
  /** A click on a dot: seek there, pause and select the note. */
  onSelect: (note: ReviewNote) => void;
  /** Where a voice note is being recorded (W11): a red pin marks the moment. Not clickable. */
  recordingAtSec?: number | null;
  /**
   * On the phone (board MReview) the dot's hit box is 28 px, a thumb's width and more, and the
   * timeline's thumb is 14 px, so the dots are placed for that. Default: the Mac's.
   */
  variant?: 'mac' | 'phone';
}

/** The phone timeline's thumb width in px (the board's 14), for `timelineLeft`. */
export const PHONE_THUMB_PX = 14;

/**
 * The notes' blue dots on the timeline track (board P3Review): a 14 px hit box around an 8 px dot
 * (10 px when hovered or active) with a 2 px ring in the dialog's colour. Drawn inside the
 * timeline slider by PlayerControls (`timelineOverlay`), in a layer that ignores the pointer, so
 * each dot takes it back (`pointer-events-auto`) and keeps its pointer-down from the slider under
 * it, which would start a drag and seek to the pointer.
 *
 * The dots are a mouse and touch target: the time chip in the notes list does the same from the
 * keyboard (`tabIndex={-1}`). While a voice note is recorded, a 10 px red pin (#F87171) sits where it will
 * be pinned; it does not take the pointer.
 */
export function NoteDots({
  notes,
  durationSec,
  hoveredId,
  isActive,
  onHover,
  onSelect,
  recordingAtSec = null,
  variant = 'mac',
}: NoteDotsProps) {
  if (!(durationSec > 0)) return null;
  const phone = variant === 'phone';
  const thumbPx = phone ? PHONE_THUMB_PX : undefined;
  return (
    <>
      {notes.map((note) => {
        const big = noteDotSize(hoveredId === note.id, isActive(note)) === 10;
        return (
          <button
            key={note.id}
            type="button"
            tabIndex={-1}
            aria-label={noteDotLabel(note)}
            data-slot="note-dot"
            data-note-id={note.id}
            className={cn(
              'pointer-events-auto absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full outline-none',
              phone ? 'size-7' : 'size-3.5',
            )}
            style={{ left: timelineLeft(note.atSec, durationSec, thumbPx) }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseEnter={() => onHover(note.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect(note)}
          >
            <span
              aria-hidden="true"
              className={cn(
                'rounded-full bg-[#3B82F6] shadow-[0_0_0_2px_#09090B] transition-[width,height] duration-150 ease-in-out',
                big ? 'size-2.5' : 'size-2',
              )}
            />
          </button>
        );
      })}
      {recordingAtSec === null ? null : (
        <span
          role="img"
          aria-label={`${VOICE_TEXT.recordingAt} ${noteTime(recordingAtSec)}`}
          data-slot="recording-pin"
          className="absolute top-1/2 z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#F87171] shadow-[0_0_0_2px_#09090B]"
          style={{ left: timelineLeft(recordingAtSec, durationSec, thumbPx) }}
        />
      )}
    </>
  );
}
