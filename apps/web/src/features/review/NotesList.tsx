import type { ReviewNote } from '@studio/shared';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeleteNote } from '@/data';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';
import { useFontPickerCatalog } from '@/features/library-picker/use-font-picker-catalog';
import { useLibraryItems } from '@/features/library-picker/use-library-items';
import { cn } from '@/lib/utils';
import type { NoteFixLine } from './fix-lines';
import type { NoteMark } from './formats/format-logic';
import { NoteCard } from './NoteCard';
import { sortNotes } from './notes-logic';
import { PLAYER_SKELETON_DELAY_MS } from './player-state';
import { NOTES_TEXT } from './review-text';

interface NotesListProps {
  /**
   * Inside the job's chat (Draft & chat): no scroll and no padding of its own (the chat scrolls),
   * and nothing at all when there are no notes. Default: the notes column's own list.
   */
  embedded?: boolean;
  jobId: string;
  client: string;
  /** The series the job is an episode of (`useEpisodeSeriesName`); `null` for any other job. */
  seriesName: string | null;
  /** The job's unsent notes; `undefined` while they load (or failed to load). */
  notes: readonly ReviewNote[] | undefined;
  /** The first load is running. */
  loading: boolean;
  /** The load failed and there is nothing to show. */
  failed: boolean;
  onRetry: () => void;
  hoveredId: string | null;
  isActive: (note: ReviewNote) => boolean;
  onHover: (noteId: string | null) => void;
  onGo: (note: ReviewNote) => void;
  /** A note is being deleted: the dialog forgets it as hovered or selected. */
  onDeleted: (noteId: string) => void;
  cardRef: (noteId: string, element: HTMLElement | null) => void;
  /** A voice note starts playing: the dialog pauses the video. */
  onPlayVoice: () => void;
  /** On the phone (board MReviewNotes) the cards are made for a finger. Default: the Mac's. */
  variant?: 'mac' | 'phone';
  /**
   * Quick fixes (`quickFixes` on): each note's line, by note id (`useReviewFixes`). A note not in
   * the map has none. Omitted: they are off, and the cards are as they always were.
   */
  fixLines?: ReadonlyMap<string, NoteFixLine>;
  /** Undo was pressed on a fixed note's line (the fix's id). Stable, for the cards' memo. */
  onUndo?: (fixId: string) => void;
  /** An Undo is on its way. */
  undoing?: boolean;
  /**
   * Generated videos: each note's format stamp and hint line, by note id (`noteMarksOf`). A note not
   * in the map has none. Omitted: the cards are as they always were. Keep it stable, for the memo.
   */
  marks?: ReadonlyMap<string, NoteMark>;
}

/** How long the list waits before it draws skeleton cards (the same 300 ms as the player's). */
const SKELETON_DELAY_MS = PLAYER_SKELETON_DELAY_MS;

/**
 * The review dialog's notes, by time. Loading shows two skeleton cards after 300 ms (a fast load
 * never flashes them); a failed load says so with "Try again"; no notes says what to do. A delete
 * takes the note out of the list at once (W5's optimistic delete) and comes back with a toast if
 * the server refuses.
 */
export function NotesList({
  jobId,
  client,
  seriesName,
  notes,
  loading,
  failed,
  onRetry,
  hoveredId,
  isActive,
  onHover,
  onGo,
  onDeleted,
  cardRef,
  onPlayVoice,
  variant = 'mac',
  fixLines,
  onUndo,
  undoing,
  marks,
  embedded = false,
}: NotesListProps) {
  const phone = variant === 'phone';
  const showSkeleton = useDelayedFlag(loading, SKELETON_DELAY_MS);
  // The LUTs and graphics a sent note can name (empty and not asked while `lutsInEdits` is off).
  // The phone's cards are untouched.
  const library = useLibraryItems(!phone);
  const libraryItems = library.enabled ? library.items : undefined;
  // The fonts a sent note can name (empty and not asked while `fontsInNotes` is off, and on the phone).
  const fonts = useFontPickerCatalog(!phone);
  const fontCatalog = fonts.enabled ? fonts.catalog : undefined;
  const remove = useDeleteNote(jobId);
  const { mutate: removeNote } = remove;

  const onDelete = useCallback(
    (note: ReviewNote) => {
      onDeleted(note.id);
      removeNote(note.id, {
        onError: (error) => toast.error(NOTES_TEXT.deleteFailed, { description: error.message }),
      });
    },
    [onDeleted, removeNote],
  );

  return (
    <div
      data-slot="review-notes-list"
      className={cn(
        embedded ? 'flex flex-col gap-2' : 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3',
        phone && 'gap-4 overscroll-contain',
      )}
    >
      {notes === undefined ? (
        failed ? (
          <div className="mx-3 my-6 flex flex-col items-center gap-3 text-center">
            <p className="text-muted-foreground">{NOTES_TEXT.loadFailed}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {NOTES_TEXT.retry}
            </Button>
          </div>
        ) : showSkeleton ? (
          <>
            <Skeleton className="h-[68px] shrink-0 rounded-md" />
            <Skeleton className="h-[68px] shrink-0 rounded-md" />
            <span role="status" className="sr-only">
              {NOTES_TEXT.loading}
            </span>
          </>
        ) : null
      ) : notes.length === 0 ? (
        embedded ? null : (
          <p className={cn('mx-3 my-6 text-center text-muted-foreground', phone && 'text-pretty')}>
            {phone ? NOTES_TEXT.emptyPhone : NOTES_TEXT.empty}
          </p>
        )
      ) : (
        sortNotes(notes).map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            jobId={jobId}
            client={client}
            seriesName={seriesName}
            hovered={hoveredId === note.id}
            active={isActive(note)}
            onHover={onHover}
            onGo={onGo}
            onDelete={onDelete}
            cardRef={cardRef}
            onPlayVoice={onPlayVoice}
            variant={variant}
            libraryItems={libraryItems}
            fontCatalog={fontCatalog}
            fixLine={fixLines === undefined ? undefined : (fixLines.get(note.id) ?? null)}
            onUndo={onUndo}
            undoing={undoing}
            mark={marks?.get(note.id)}
          />
        ))
      )}
    </div>
  );
}
